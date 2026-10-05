import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { fakeSecretTool } from './fake-secret-tool.ts'

/*
 * `spicytrade` end to end against a stand-in Worker, with every tool it drives replaced on PATH:
 * a file-backed `secret-tool`, an `xdg-open` that records the URL, a `systemctl` whose unit state
 * is files in a directory, and `claude`/`codex` whose entries are files. PATH holds only
 * those and the system directories, so a run never reaches the real keyring, a real browser, the
 * real user session, or the agent clients installed on the machine running the tests.
 */

const OLD_TOKEN = 'spice_0123456789abcdef_OLDOLDOLDOLDOLDOLDOL'
const NEW_TOKEN = 'spice_fedcba9876543210_NEWNEWNEWNEWNEWNEWNE'
const CODE = 'C'.repeat(43)
const APP_REFRESH_TOKEN = 'app-refresh-token-that-belongs-in-the-keyring'
const CLI = 'ops/spicytrade/spicytrade.mjs'
const PROXY_PATH = resolve('ops/spicytrade/proxy.mjs')

const ExchangeBodySchema = z.strictObject({
  code: z.string(),
  codeVerifier: z.string(),
  previousToken: z.string().optional(),
})

type WorkerCall = { authorization?: string; body: string; path: string }

const servers: Server[] = []
const children: ChildProcess[] = []
const directories: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((done) => {
    server.closeAllConnections()
    server.close(() => done())
  })))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

async function serve(handler: (request: IncomingMessage, body: string) => { body?: unknown; status: number }): Promise<number> {
  const server = createServer((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const answer = handler(request, Buffer.concat(chunks).toString())
      response.writeHead(answer.status, { 'content-type': 'application/json' })
      response.end(answer.body === undefined ? '' : JSON.stringify(answer.body))
    })
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  // SAFETY: this server was just listened on a TCP port, which is the case where Node returns
  // an AddressInfo rather than a pipe path or null.
  return (server.address() as AddressInfo).port
}

/**
 * A Worker that accepts `acceptedTokens` on `/mcp` and on the app-grant mint, and answers the
 * sign-in exchange with `exchange()`.
 */
async function fakeWorker(acceptedTokens: string[], exchange: () => { body: unknown; status: number } = () => ({
  body: { token: NEW_TOKEN, tokenMetadata: { createdAt: '2026-09-28T00:00:00Z', label: 'test', tokenId: '0123456789abcdef' } },
  status: 200,
})) {
  const calls: WorkerCall[] = []
  const port = await serve((request, body) => {
    const path = request.url ?? ''
    calls.push({ authorization: request.headers.authorization, body, path })
    if (path === '/api/agent-logins/exchange') {
      const answer = exchange()
      if (answer.status === 200) acceptedTokens.push(NEW_TOKEN)
      return answer
    }
    const accepted = acceptedTokens.some((token) => request.headers.authorization === `Bearer ${token}`)
    if (!accepted) return { body: { error: 'invalid_token' }, status: 401 }
    if (path === '/api/brokers/tastytrade/token') return { body: { accessToken: 'minted', expiresIn: 900 }, status: 200 }
    return { body: { id: 1, jsonrpc: '2.0', result: { tools: [] } }, status: 200 }
  })
  return { calls, port }
}

/** A stand-in for a running proxy: anything that answers 200 on the proxy's address. */
async function fakeProxy(): Promise<number> {
  return serve(() => ({ body: { id: 1, jsonrpc: '2.0', result: {} }, status: 200 }))
}

type Machine = {
  bin: string
  config: string
  home: string
  state: string
}

/**
 * A machine: the fake tools, a home directory, and the state the fakes keep. `clients` names which
 * agent CLIs are installed, each with the entries it already holds, by name to URL -- which is also
 * how a test sets up a pre-rename `spicy-trade` entry.
 */
async function fakeMachine(
  keyring: Record<string, string>,
  clients: Record<string, Record<string, string>> = {},
): Promise<Machine> {
  const bin = await fakeSecretTool(keyring)
  directories.push(bin)
  const state = join(bin, 'state')
  const home = join(bin, 'home')
  const config = join(home, '.config')
  await mkdir(state)
  await mkdir(config, { recursive: true })
  await writeFile(join(bin, 'xdg-open'), `#!/usr/bin/env bash\necho "$1" > '${state}/opened'\n`)
  await writeFile(join(bin, 'systemctl'), `#!/usr/bin/env bash
state='${state}'
shift  # --user
echo "$*" >> "$state/systemctl"
case $1 in
  show-environment|daemon-reload|stop|disable) exit 0 ;;
  is-enabled) [[ -f "$state/enabled" ]] ;;
  is-active) [[ -f "$state/active" ]] ;;
  enable) touch "$state/enabled" "$state/active" ;;
  restart) touch "$state/active" ;;
  *) exit 1 ;;
esac
`)
  for (const [client, entries] of Object.entries(clients)) {
    for (const [name, url] of Object.entries(entries)) await writeFile(join(state, `${client}-${name}-url`), url)
    // `claude mcp get` prints a URL line; `codex mcp get --json` prints the transport.
    const get = client === 'claude'
      ? `printf '%s:\\n  Type: http\\n  URL: %s\\n' "$3" "$(cat "$entry")"`
      : `printf '{"name":"%s","transport":{"type":"streamable_http","url":"%s"}}' "$3" "$(cat "$entry")"`
    await writeFile(join(bin, client), `#!/usr/bin/env bash
state='${state}'
echo "$*" >> "$state/${client}-calls"
if [[ $2 == get ]]; then
  entry="$state/${client}-$3-url"
  [[ -f "$entry" ]] || exit 1
  ${get}
elif [[ $2 == add ]]; then
  ${client === 'claude' ? 'name="${@: -2:1}"; url="${@: -1}"' : 'name="$3"; url="$5"'}
  echo "$url" > "$state/${client}-$name-url"
  ${client === 'codex' ? 'mkdir -p "$CODEX_HOME" && printf \'[mcp_servers.%s]\\nurl = "%s"\\n\' "$name" "$url" >> "$CODEX_HOME/config.toml"' : ''}
elif [[ $2 == remove ]]; then
  rm "$state/${client}-$3-url"
fi
`)
  }
  for (const tool of ['xdg-open', 'systemctl', ...Object.keys(clients)]) await chmod(join(bin, tool), 0o755)
  return { bin, config, home, state }
}

function run(machine: Machine, workerPort: number, proxyPort: number, args: string[]) {
  let stdout = ''
  let stderr = ''
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      CODEX_HOME: join(machine.home, '.codex'),
      HOME: machine.home,
      PATH: `${machine.bin}:/usr/bin:/bin`,
      SPICYTRADE_PROXY_PORT: String(proxyPort),
      SPICYTRADE_MCP_URL: `http://127.0.0.1:${workerPort}/mcp`,
      XDG_CONFIG_HOME: machine.config,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const exited = new Promise<number | null>((done) => child.on('exit', done))
  return { exited, output: () => ({ stderr, stdout }) }
}

/** A browser-shaped GET to the loopback listener; `host` lets a test imitate a rebound page. */
function visit(port: number, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ body: string; status: number }>((done, reject) => {
    const outgoing = httpRequest({ headers: { host: `127.0.0.1:${port}`, ...headers }, host: '127.0.0.1', path, port }, (reply) => {
      let body = ''
      reply.on('data', (chunk: Buffer) => { body += chunk.toString() })
      reply.on('end', () => done({ body, status: reply.statusCode ?? 0 }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

/** The approval URL the CLI printed, once it has. */
async function approvalUrl(output: () => { stdout: string }): Promise<URL> {
  await expect.poll(() => output().stdout, { timeout: 10_000 }).toContain('Sign in to spicytrade and approve this computer')
  const printed = output().stdout.match(/^ {2}(http\S+)$/m)?.[1]
  if (!printed) throw new Error('the CLI printed no approval URL')
  return new URL(printed)
}

const unitFile = (machine: Machine) => join(machine.config, 'systemd', 'user', 'spicytrade-proxy.service')
const legacyUnitFile = (machine: Machine) => join(machine.config, 'systemd', 'user', 'spicy-trade-proxy.service')

describe('spicytrade login', () => {
  it('signs in through the browser, redeems the code with its verifier, and keeps only the token', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN })
    const worker = await fakeWorker([])
    const cli = run(machine, worker.port, await fakeProxy(), ['login'])
    const url = await approvalUrl(cli.output)

    expect(url.pathname).toBe('/connect/agent')
    const port = Number(url.searchParams.get('port'))
    const state = url.searchParams.get('state') ?? ''
    const challenge = url.searchParams.get('challenge') ?? ''
    expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get('label')?.length).toBeGreaterThan(0)

    // A rebound page and a return that is not this run's are refused, and the run goes on.
    expect((await visit(port, `/callback?code=${CODE}&state=${state}`, { host: `attacker.example:${port}` })).status).toBe(403)
    expect((await visit(port, `/callback?code=${CODE}&state=${state}`, { origin: 'http://attacker.example' })).status).toBe(403)
    expect((await visit(port, `/callback?code=${CODE}&state=${'T'.repeat(43)}`)).status).toBe(400)
    const returned = await visit(port, `/callback?code=${CODE}&state=${state}`)
    expect(returned.status).toBe(200)
    expect(returned.body).not.toContain(CODE)

    expect(await cli.exited).toBe(0)
    expect(await readFile(join(machine.bin, 'store', 'spicytrade_mcp-token'), 'utf8')).toBe(NEW_TOKEN)
    const exchanges = worker.calls.filter((call) => call.path === '/api/agent-logins/exchange')
    expect(exchanges).toHaveLength(1)
    const body = ExchangeBodySchema.parse(JSON.parse(exchanges[0]!.body))
    // The verifier is the one whose digest was in the page address, and the old token rides
    // along so the Worker retires it rather than leaving this machine with two.
    expect(body.code).toBe(CODE)
    expect(createHash('sha256').update(body.codeVerifier).digest('base64url')).toBe(challenge)
    expect(body.previousToken).toBe(OLD_TOKEN)
    expect(exchanges[0]!.authorization).toBeUndefined()

    const { stderr, stdout } = cli.output()
    for (const secret of [NEW_TOKEN, OLD_TOKEN, CODE, body.codeVerifier]) {
      expect(stdout).not.toContain(secret)
      expect(stderr).not.toContain(secret)
    }
    expect(stdout).toContain('Signed in. Stored spicytrade/mcp-token.')
    // No unit installed yet, so the proxy is not restarted; the member is told how to install it.
    expect(stdout).toMatch(/not installed yet[\s\S]*spicytrade(\.mjs)? setup/)
    await expect.poll(() => readFile(join(machine.state, 'opened'), 'utf8').catch(() => '')).toContain('/connect/agent?')
  }, 30_000)

  it('moves a token signed in before the rename to the current keyring entry', async () => {
    const machine = await fakeMachine({ 'spicy-trade/mcp-token': OLD_TOKEN })
    const worker = await fakeWorker([])
    const cli = run(machine, worker.port, await fakeProxy(), ['login'])
    const url = await approvalUrl(cli.output)
    await visit(Number(url.searchParams.get('port')), `/callback?code=${CODE}&state=${url.searchParams.get('state')}`)

    expect(await cli.exited).toBe(0)
    // The old token still rides along, so the Worker retires it.
    const exchange = worker.calls.find((call) => call.path === '/api/agent-logins/exchange')
    expect(ExchangeBodySchema.parse(JSON.parse(exchange!.body)).previousToken).toBe(OLD_TOKEN)
    expect(await readFile(join(machine.bin, 'store', 'spicytrade_mcp-token'), 'utf8')).toBe(NEW_TOKEN)
    await expect(readFile(join(machine.bin, 'store', 'spicy-trade_mcp-token'), 'utf8')).rejects.toThrow()
  }, 30_000)

  it('reports a refusal by its OAuth code and redeems nothing', async () => {
    const machine = await fakeMachine({})
    const worker = await fakeWorker([])
    const cli = run(machine, worker.port, await fakeProxy(), ['login'])
    const url = await approvalUrl(cli.output)
    const port = Number(url.searchParams.get('port'))
    expect((await visit(port, `/callback?error=access_denied&state=${url.searchParams.get('state')}`)).status).toBe(200)
    expect(await cli.exited).toBe(1)
    expect(cli.output().stderr).toContain('spicytrade login: spicytrade did not approve this computer (access_denied)')
    expect(worker.calls).toEqual([])
    await expect(readFile(join(machine.bin, 'store', 'spicytrade_mcp-token'), 'utf8')).rejects.toThrow()
  }, 30_000)

  it.each([
    [400, { error: 'invalid_grant' }, 'the sign-in expired or was already used; run login again'],
    [409, { error: 'At most 5 agent tokens' }, 'Revoke one you no longer'],
  ])('reports an exchange refused with %i in its own words, keeping the old token', async (status, answer, message) => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN })
    const worker = await fakeWorker([], () => ({ body: answer, status }))
    const cli = run(machine, worker.port, await fakeProxy(), ['login'])
    const url = await approvalUrl(cli.output)
    await visit(Number(url.searchParams.get('port')), `/callback?code=${CODE}&state=${url.searchParams.get('state')}`)
    expect(await cli.exited).toBe(1)
    expect(cli.output().stderr).toContain(message)
    // The Worker's body is not echoed.
    expect(cli.output().stderr).not.toContain(JSON.stringify(answer))
    expect(await readFile(join(machine.bin, 'store', 'spicytrade_mcp-token'), 'utf8')).toBe(OLD_TOKEN)
  }, 30_000)
})

describe('spicytrade doctor', () => {
  it('passes every check on a machine that is fully connected', async () => {
    const proxyPort = await fakeProxy()
    const machine = await fakeMachine(
      { 'spicytrade/mcp-token': OLD_TOKEN, 'tastytrade/app-refresh-token': APP_REFRESH_TOKEN },
      { claude: { 'spicytrade': `http://127.0.0.1:${proxyPort}/mcp` } },
    )
    await mkdir(join(machine.config, 'systemd', 'user'), { recursive: true })
    await writeFile(unitFile(machine), `[Service]\nExecStart=${process.execPath} ${PROXY_PATH}\n`)
    await writeFile(join(machine.state, 'enabled'), '')
    await writeFile(join(machine.state, 'active'), '')
    const worker = await fakeWorker([OLD_TOKEN])

    const cli = run(machine, worker.port, proxyPort, ['doctor'])
    expect(await cli.exited).toBe(0)
    const { stdout } = cli.output()
    expect(stdout).toContain('✓ spicytrade accepts the agent token')
    expect(stdout).toContain('✓ tastytrade connection mints an access token')
    expect(stdout).toContain('✓ the proxy service is installed, enabled and running')
    expect(stdout).toContain(`✓ the proxy answers at http://127.0.0.1:${proxyPort}/mcp`)
    expect(stdout).toContain('✓ Claude Code points at the proxy')
    expect(stdout).not.toContain('✗')
    expect(stdout).toContain('Everything is connected.')
    expect(stdout).not.toContain(OLD_TOKEN)
    expect(stdout).not.toContain(APP_REFRESH_TOKEN)
  }, 30_000)

  it('names each broken link with the command that fixes it', async () => {
    const proxyPort = await fakeProxy()
    const machine = await fakeMachine(
      { 'spicytrade/mcp-token': OLD_TOKEN, 'tastytrade/app-refresh-token': APP_REFRESH_TOKEN },
      { claude: { 'spicytrade': 'https://elsewhere.example/mcp?key=a-credential-in-a-url' }, codex: {} },
    )
    // A unit from an older checkout: installed and running, but not this install's proxy.
    await mkdir(join(machine.config, 'systemd', 'user'), { recursive: true })
    await writeFile(unitFile(machine), '[Service]\nExecStart=%h/old-checkout/ops/spicytrade/proxy.mjs\n')
    await writeFile(join(machine.state, 'enabled'), '')
    await writeFile(join(machine.state, 'active'), '')
    const worker = await fakeWorker([])

    const cli = run(machine, worker.port, proxyPort, ['doctor'])
    expect(await cli.exited).toBe(1)
    const { stdout } = cli.output()
    expect(stdout).toMatch(/✗ spicytrade rejected the agent token\n {4}Sign in again with: \S*spicytrade(\.mjs)? login/)
    // The refused mint is a symptom of the refused token, so its fix is the same sign-in.
    expect(stdout).toMatch(/✗ tastytrade connection: spicytrade rejected the agent token while minting\n {4}Sign in again with: \S+ login/)
    expect(stdout).toMatch(/✗ the proxy service runs a different install[^\n]*\n {4}Rewrite it with: \S+ setup/)
    expect(stdout).toMatch(/✗ Claude Code points spicytrade somewhere other than the proxy\n {4}Replace it: claude mcp remove spicytrade && claude mcp add --scope user --transport http spicytrade/)
    expect(stdout).toMatch(/✗ Codex has no spicytrade server\n {4}Add it with: \S+ setup/)
    expect(stdout).not.toContain('a-credential-in-a-url')
    expect(stdout).toContain('5 problems found.')
  }, 30_000)
  it('flags what an install from before the rename left behind', async () => {
    const proxyPort = await fakeProxy()
    const proxyUrl = `http://127.0.0.1:${proxyPort}/mcp`
    const machine = await fakeMachine({ 'spicy-trade/mcp-token': OLD_TOKEN }, { claude: { 'spicy-trade': proxyUrl, 'spicytrade': proxyUrl } })
    await mkdir(join(machine.config, 'systemd', 'user'), { recursive: true })
    await writeFile(unitFile(machine), `[Service]\nExecStart=${process.execPath} ${PROXY_PATH}\n`)
    await writeFile(legacyUnitFile(machine), '[Service]\nExecStart=%h/checkout/ops/spicy-trade/proxy.mjs\n')
    await writeFile(join(machine.state, 'enabled'), '')
    await writeFile(join(machine.state, 'active'), '')
    const worker = await fakeWorker([OLD_TOKEN])

    const cli = run(machine, worker.port, proxyPort, ['doctor'])
    expect(await cli.exited).toBe(1)
    const { stdout } = cli.output()
    // The old entry still works, and is read; it is flagged so setup moves it.
    expect(stdout).toContain('✓ spicytrade accepts the agent token')
    expect(stdout).toMatch(/✗ the agent token is still under its old keyring entry \(spicy-trade\/mcp-token\)\n {4}Move it with: \S+ setup/)
    expect(stdout).toMatch(/✗ the old spicy-trade-proxy\.service is still installed\n {4}Replace it with: \S+ setup/)
    expect(stdout).toMatch(/✗ Claude Code still has the old spicy-trade entry\n {4}Replace it with: \S+ setup/)
    expect(stdout).toContain('3 problems found.')
  }, 30_000)
})

describe('spicytrade setup', () => {
  it('does every step once, and on a second run skips each one', async () => {
    const proxyPort = await fakeProxy()
    const proxyUrl = `http://127.0.0.1:${proxyPort}/mcp`
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN }, { claude: {} })
    const worker = await fakeWorker([OLD_TOKEN])

    const first = run(machine, worker.port, proxyPort, ['setup'])
    expect(await first.exited).toBe(0)
    const firstOut = first.output().stdout
    expect(firstOut).toContain('✓ already signed in; skipped')
    expect(firstOut).toContain(`✓ installed and started at ${proxyUrl}`)
    // No terminal to ask on, so trading authority is not granted; the member is told how.
    expect(firstOut).toMatch(/· not connected, and there is no terminal to ask on\. Connect later with:\n {4}\S+ connect-tastytrade/)
    expect(firstOut).toContain(`✓ Claude Code: added spicytrade at ${proxyUrl}`)
    expect(firstOut).toContain('Everything is connected.')

    expect(await readFile(unitFile(machine), 'utf8')).toContain(`\nExecStart=${process.execPath} ${PROXY_PATH}\n`)
    expect(await readFile(join(machine.state, 'claude-calls'), 'utf8'))
      .toContain(`mcp add --scope user --transport http spicytrade ${proxyUrl}`)
    const systemctlCalls = await readFile(join(machine.state, 'systemctl'), 'utf8')
    expect(systemctlCalls).toContain('daemon-reload')
    expect(systemctlCalls).toContain('enable --now spicytrade-proxy.service')

    const second = run(machine, worker.port, proxyPort, ['setup'])
    expect(await second.exited).toBe(0)
    const secondOut = second.output().stdout
    expect(secondOut).toContain('✓ already signed in; skipped')
    expect(secondOut).toContain('✓ already installed and running; skipped')
    expect(secondOut).toContain('✓ Claude Code already points at the proxy; skipped')
    const secondSystemctl = (await readFile(join(machine.state, 'systemctl'), 'utf8')).slice(systemctlCalls.length)
    expect(secondSystemctl).not.toMatch(/^(daemon-reload|enable|restart)\b/m)
    expect((await readFile(join(machine.state, 'claude-calls'), 'utf8')).match(/mcp add/g)).toHaveLength(1)
    for (const output of [first.output(), second.output()]) {
      expect(output.stdout).not.toContain(OLD_TOKEN)
      expect(output.stderr).not.toContain(OLD_TOKEN)
    }
  }, 60_000)

  it('leaves a client entry that points elsewhere as it is, and says how to replace it', async () => {
    const proxyPort = await fakeProxy()
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN }, { codex: { 'spicytrade': 'https://spicy.trade/mcp' } })
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, proxyPort, ['setup'])
    expect(await cli.exited).toBe(1)
    expect(cli.output().stdout).toMatch(/! Codex already has a spicytrade server pointing elsewhere; left as it is\. To replace it:\n {4}codex mcp remove spicytrade && codex mcp add spicytrade --url /)
    expect(await readFile(join(machine.state, 'codex-spicytrade-url'), 'utf8')).toBe('https://spicy.trade/mcp')
  }, 60_000)
  it('moves an install from before the rename onto the current names', async () => {
    const proxyPort = await fakeProxy()
    const proxyUrl = `http://127.0.0.1:${proxyPort}/mcp`
    const machine = await fakeMachine(
      { 'spicy-trade/mcp-token': OLD_TOKEN },
      { claude: { 'spicy-trade': proxyUrl }, codex: { 'spicy-trade': 'https://someone-elses.example/mcp' } },
    )
    await mkdir(join(machine.config, 'systemd', 'user'), { recursive: true })
    await writeFile(legacyUnitFile(machine), '[Service]\nExecStart=%h/checkout/ops/spicy-trade/proxy.mjs\n')
    await writeFile(join(machine.state, 'enabled'), '')
    await writeFile(join(machine.state, 'active'), '')
    const worker = await fakeWorker([OLD_TOKEN])

    const cli = run(machine, worker.port, proxyPort, ['setup'])
    expect(await cli.exited).toBe(0)
    const { stdout } = cli.output()

    expect(stdout).toContain('✓ already signed in; moved the token from spicy-trade/mcp-token to spicytrade/mcp-token')
    expect(await readFile(join(machine.bin, 'store', 'spicytrade_mcp-token'), 'utf8')).toBe(OLD_TOKEN)
    await expect(readFile(join(machine.bin, 'store', 'spicy-trade_mcp-token'), 'utf8')).rejects.toThrow()

    // The old unit runs a proxy on the same port, so it is stopped before the new one starts.
    expect(stdout).toContain('✓ removed the old spicy-trade-proxy.service')
    await expect(readFile(legacyUnitFile(machine), 'utf8')).rejects.toThrow()
    const systemctlCalls = await readFile(join(machine.state, 'systemctl'), 'utf8')
    expect(systemctlCalls.indexOf('stop spicy-trade-proxy.service'))
      .toBeLessThan(systemctlCalls.indexOf('enable --now spicytrade-proxy.service'))
    expect(systemctlCalls).toContain('disable spicy-trade-proxy.service')
    expect(await readFile(unitFile(machine), 'utf8')).toContain(`\nExecStart=${process.execPath} ${PROXY_PATH}\n`)

    // An old entry naming the proxy is replaced; one naming somewhere else is someone's own.
    expect(stdout).toContain(`✓ Claude Code: added spicytrade at ${proxyUrl}`)
    expect(stdout).toContain('✓ Claude Code: removed the old spicy-trade entry; the server is spicytrade now')
    await expect(readFile(join(machine.state, 'claude-spicy-trade-url'), 'utf8')).rejects.toThrow()
    expect(stdout).toContain(`✓ Codex: added spicytrade at ${proxyUrl}; switched off`)
    expect(await readFile(join(machine.home, '.codex', 'config.toml'), 'utf8'))
      .toBe(`[mcp_servers.spicytrade]\nenabled = false\nurl = "${proxyUrl}"\n`)
    expect(stdout).toContain("! Codex has a spicy-trade server that is not spicytrade's; left as it is")
    expect(await readFile(join(machine.state, 'codex-spicy-trade-url'), 'utf8')).toBe('https://someone-elses.example/mcp')
    expect(stdout).not.toContain('someone-elses')
    expect(stdout).toContain('Everything is connected.')
  }, 60_000)
})

describe('store-credentials.sh', () => {
  function storeToken(machine: Machine, workerPort: number, token: string) {
    return new Promise<{ status: number | null; stderr: string; stdout: string }>((done) => {
      let stdout = ''
      let stderr = ''
      const child = spawn('bash', ['ops/spicytrade/store-credentials.sh', 'mcp-token'], {
        env: {
          ...process.env,
          HOME: machine.home,
          PATH: `${machine.bin}:/usr/bin:/bin`,
          SPICYTRADE_MCP_URL: `http://127.0.0.1:${workerPort}/mcp`,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      children.push(child)
      child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
      child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
      child.on('exit', (status) => done({ status, stderr, stdout }))
      child.stdin.end(token)
    })
  }

  it('keeps a token spicytrade accepts, and clears one it rejects', async () => {
    const machine = await fakeMachine({})
    const worker = await fakeWorker([NEW_TOKEN])

    const accepted = await storeToken(machine, worker.port, NEW_TOKEN)
    expect(accepted.status).toBe(0)
    expect(accepted.stdout).toContain('spicytrade accepted the token')
    expect(await readFile(join(machine.bin, 'store', 'spicytrade_mcp-token'), 'utf8')).toBe(NEW_TOKEN)
    // The token reached spicytrade in the header, sent over curl's stdin rather than its argv.
    expect(worker.calls.at(-1)?.authorization).toBe(`Bearer ${NEW_TOKEN}`)

    const rejected = await storeToken(machine, worker.port, 'not-a-token')
    expect(rejected.status).toBe(1)
    expect(rejected.stderr).toMatch(/spicytrade rejected that token, so it was not kept[\s\S]*spicytrade\.mjs login/)
    await expect(readFile(join(machine.bin, 'store', 'spicytrade_mcp-token'), 'utf8')).rejects.toThrow()
    for (const output of [accepted, rejected]) {
      expect(output.stdout + output.stderr).not.toContain(NEW_TOKEN)
    }
  }, 30_000)
})
