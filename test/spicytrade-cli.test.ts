import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, request as httpRequest, type IncomingMessage, type Server } from 'node:http'
import { type AddressInfo } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { fakeSecretTool } from './fake-secret-tool.ts'

/*
 * `spicytrade` end to end against a stand-in Worker, with every tool it drives replaced on PATH:
 * a file-backed `secret-tool`, an `xdg-open` that records the URL, a `systemctl` that records its
 * calls, and `claude`/`codex` whose entries are files, Claude Code's by scope. PATH holds only
 * those and the system directories, so a run never reaches the real keyring, a real browser, the
 * real user session, or the agent clients installed on the machine running the tests.
 */

const OLD_TOKEN = 'spice_0123456789abcdef_OLDOLDOLDOLDOLDOLDOL'
const NEW_TOKEN = 'spice_fedcba9876543210_NEWNEWNEWNEWNEWNEWNE'
const CODE = 'C'.repeat(43)
const APP_REFRESH_TOKEN = 'app-refresh-token-that-belongs-in-the-keyring'
const CLI = 'ops/spicytrade/spicytrade.mjs'
/**
 * The PATH every run gets: the fakes, this test's own node, and the system directories. The node
 * is needed because the agent's server starts through `#!/usr/bin/env node`, as an agent starts
 * it with the member's PATH; a build machine may have no node in the system directories at all.
 */
const TEST_PATH = (bin: string) => `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`

/** The command line `setup` registers: this CLI by absolute path, run through its shebang. */
const MCP_TARGET = `${resolve(CLI)} mcp`
const LEGACY_PROXY_URL = 'http://127.0.0.1:8787/mcp'

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

type Machine = {
  bin: string
  config: string
  home: string
  state: string
  trading: string
}

/**
 * A machine: the fake tools, a home directory, and the state the fakes keep. `clients` names which
 * agent CLIs are installed, each with the entries it already holds, by name to target -- a URL, or
 * a command line -- which is also how a test sets up a pre-rename `spicy-trade` entry. A Claude
 * Code entry's name carries its scope, `local:` for the trading folder's or `user:` for every
 * folder's; the fake answers a local entry only from inside the trading folder, and prefers it
 * there the way Claude Code does.
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
  const trading = join(home, 'trading')
  await mkdir(state)
  await mkdir(config, { recursive: true })
  await writeFile(join(bin, 'xdg-open'), `#!/usr/bin/env bash\necho "$1" > '${state}/opened'\n`)
  await writeFile(join(bin, 'systemctl'), `#!/usr/bin/env bash\nshift  # --user\necho "$*" >> '${state}/systemctl'\n`)
  for (const [client, entries] of Object.entries(clients)) {
    for (const [name, target] of Object.entries(entries)) {
      await writeFile(join(state, `${client}-${name.replace(':', '-')}-target`), target)
      if (name.startsWith('local:')) await mkdir(trading, { recursive: true })
    }
    await writeFile(join(bin, client), client === 'claude' ? `#!/usr/bin/env bash
state='${state}'
echo "$*" >> "$state/claude-calls"
here=$(pwd -P); trading=$(cd '${trading}' 2>/dev/null && pwd -P)
[[ $here == "$trading" ]] && scopes='local user' || scopes='user'
if [[ $2 == get ]]; then
  for scope in $scopes; do
    entry="$state/claude-$scope-$3-target"
    [[ -f "$entry" ]] || continue
    read -r command args < "$entry"
    if [[ $command == http* ]]; then
      printf '%s:\\n  Scope: %s config\\n  Type: http\\n  URL: %s\\n' "$3" "\${scope^}" "$command"
    else
      printf '%s:\\n  Scope: %s config\\n  Type: stdio\\n  Command: %s\\n  Args: %s\\n' "$3" "\${scope^}" "$command" "$args"
    fi
    exit 0
  done
  exit 1
elif [[ $2 == add ]]; then
  [[ $4 == local && $here != "$trading" ]] && exit 1
  scope=$4 name=$5
  shift 6
  echo "$*" > "$state/claude-$scope-$name-target"
elif [[ $2 == remove ]]; then
  rm "$state/claude-$5-$3-target"
fi
` : `#!/usr/bin/env bash
state='${state}'
echo "$*" >> "$state/codex-calls"
if [[ $2 == get ]]; then
  entry="$state/codex-$3-target"
  [[ -f "$entry" ]] || exit 1
  read -r command args < "$entry"
  if [[ $command == http* ]]; then
    printf '{"name":"%s","transport":{"type":"streamable_http","url":"%s"}}' "$3" "$command"
  else
    printf '{"name":"%s","transport":{"type":"stdio","command":"%s","args":["%s"]}}' "$3" "$command" "\${args// /\\",\\"}"
  fi
elif [[ $2 == add ]]; then
  name=$3
  shift 4
  echo "$*" > "$state/codex-$name-target"
  mkdir -p "$CODEX_HOME" && printf '[mcp_servers.%s]\\ncommand = "%s"\\n' "$name" "$1" >> "$CODEX_HOME/config.toml"
elif [[ $2 == remove ]]; then
  rm "$state/codex-$3-target"
fi
`)
  }
  for (const tool of ['xdg-open', 'systemctl', ...Object.keys(clients)]) await chmod(join(bin, tool), 0o755)
  return { bin, config, home, state, trading }
}

function run(machine: Machine, workerPort: number, args: string[]) {
  let stdout = ''
  let stderr = ''
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      ...process.env,
      CODEX_HOME: join(machine.home, '.codex'),
      HOME: machine.home,
      PATH: TEST_PATH(machine.bin),
      SPICYTRADE_MCP_URL: `http://127.0.0.1:${workerPort}/mcp`,
      SPICYTRADE_TRADING_DIR: machine.trading,
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

/** A unit the retired background proxy left behind. */
async function legacyUnit(machine: Machine, name: string) {
  await mkdir(join(machine.config, 'systemd', 'user'), { recursive: true })
  await writeFile(join(machine.config, 'systemd', 'user', name), '[Service]\nExecStart=%h/checkout/ops/spicytrade/proxy.mjs\n')
  return join(machine.config, 'systemd', 'user', name)
}

describe('spicytrade login', () => {
  it('signs in through the browser, redeems the code with its verifier, and keeps only the token', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN })
    const worker = await fakeWorker([])
    const cli = run(machine, worker.port, ['login'])
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
    expect(stdout).toContain('✓ Signed in.')
    // Nothing to restart: each agent session reads the keyring when it starts.
    expect(stdout).toContain('picks this up once it reconnects')
    await expect.poll(() => readFile(join(machine.state, 'opened'), 'utf8').catch(() => '')).toContain('/connect/agent?')
  }, 30_000)

  it('moves a token signed in before the rename to the current keyring entry', async () => {
    const machine = await fakeMachine({ 'spicy-trade/mcp-token': OLD_TOKEN })
    const worker = await fakeWorker([])
    const cli = run(machine, worker.port, ['login'])
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
    const cli = run(machine, worker.port, ['login'])
    const url = await approvalUrl(cli.output)
    const port = Number(url.searchParams.get('port'))
    expect((await visit(port, `/callback?error=access_denied&state=${url.searchParams.get('state')}`)).status).toBe(200)
    expect(await cli.exited).toBe(1)
    expect(cli.output().stderr).toMatch(/spicytrade login: sign-in cancelled in the browser\. To try again, run: \S*spicytrade(\.mjs)? setup/)
    expect(worker.calls).toEqual([])
    await expect(readFile(join(machine.bin, 'store', 'spicytrade_mcp-token'), 'utf8')).rejects.toThrow()
  }, 30_000)

  it.each([
    [400, { error: 'invalid_grant' }, 'the sign-in expired or was already used. Run: '],
    [409, { error: 'At most 5 agent tokens' }, 'Revoke one you no longer'],
  ])('reports an exchange refused with %i in its own words, keeping the old token', async (status, answer, message) => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN })
    const worker = await fakeWorker([], () => ({ body: answer, status }))
    const cli = run(machine, worker.port, ['login'])
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
    const machine = await fakeMachine(
      { 'spicytrade/mcp-token': OLD_TOKEN, 'tastytrade/app-refresh-token': APP_REFRESH_TOKEN },
      { claude: { 'local:spicytrade': MCP_TARGET } },
    )
    const worker = await fakeWorker([OLD_TOKEN])

    const cli = run(machine, worker.port, ['doctor'])
    expect(await cli.exited).toBe(0)
    const { stdout } = cli.output()
    expect(stdout).toContain('✓ signed in to spicytrade')
    expect(stdout).toContain('✓ tastytrade is connected')
    // The server was started exactly as an agent starts it, and its relay reached the Worker.
    expect(stdout).toContain('✓ your agent can reach spicytrade')
    expect(worker.calls.some((call) => call.path === '/mcp' && call.body.includes('"initialize"'))).toBe(true)
    expect(stdout).toContain('✓ Claude Code starts spicytrade')
    expect(stdout).not.toContain('✗')
    expect(stdout).toContain('Everything is connected.')
    expect(stdout).not.toContain(OLD_TOKEN)
    expect(stdout).not.toContain(APP_REFRESH_TOKEN)
  }, 30_000)

  it('does not call a computer without tastytrade fully connected', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN }, { claude: { 'local:spicytrade': MCP_TARGET } })
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['doctor'])
    expect(await cli.exited).toBe(0)
    const { stdout } = cli.output()
    expect(stdout).toContain('· tastytrade is not connected: your agent gets market and research tools only')
    expect(stdout).toContain('Everything else is working.')
    expect(stdout).not.toContain('Everything is connected.')
  }, 30_000)

  it('names a mistyped command rather than only reprinting the usage', async () => {
    const machine = await fakeMachine({})
    const worker = await fakeWorker([])
    const cli = run(machine, worker.port, ['stup'])
    expect(await cli.exited).toBe(2)
    expect(cli.output().stderr).toMatch(/^spicytrade: unknown command "stup"\n\nUsage: spicytrade <command>/)
  }, 30_000)

  it('names each broken link with the command that fixes it', async () => {
    const machine = await fakeMachine(
      { 'spicytrade/mcp-token': OLD_TOKEN, 'tastytrade/app-refresh-token': APP_REFRESH_TOKEN },
      { claude: { 'local:spicytrade': 'https://elsewhere.example/mcp?key=a-credential-in-a-url' }, codex: {} },
    )
    const worker = await fakeWorker([])

    const cli = run(machine, worker.port, ['doctor'])
    expect(await cli.exited).toBe(1)
    const { stdout } = cli.output()
    expect(stdout).toMatch(/✗ this computer was signed out of spicytrade \(revoked under Signed-in computers\)\n {4}Sign in again with: \S*spicytrade(\.mjs)? setup/)
    // The tastytrade mint and the server both go through spicytrade, so the one refused sign-in
    // is reported once, not again as a failure of each.
    expect(stdout).not.toContain('tastytrade:')
    expect(stdout).not.toContain('MCP server')
    expect(stdout).toContain('✗ Claude Code has a different server named "spicytrade"\n'
      + `    Replace it: cd ${machine.trading} && claude mcp remove spicytrade --scope local && mkdir -p ${machine.trading} && `
      + `cd ${machine.trading} && claude mcp add --scope local spicytrade -- ${MCP_TARGET}`)
    expect(stdout).toMatch(/✗ Codex has no spicytrade server\n {4}Add it with: \S+ setup/)
    expect(stdout).not.toContain('a-credential-in-a-url')
    expect(stdout).toContain('3 problems found.')
  }, 30_000)

  it('flags what an earlier install left behind', async () => {
    const machine = await fakeMachine(
      { 'spicy-trade/mcp-token': OLD_TOKEN },
      { claude: { 'local:spicytrade': LEGACY_PROXY_URL, 'user:spicytrade': LEGACY_PROXY_URL, 'user:spicy-trade': LEGACY_PROXY_URL } },
    )
    await legacyUnit(machine, 'spicytrade-proxy.service')
    const worker = await fakeWorker([OLD_TOKEN])

    const cli = run(machine, worker.port, ['doctor'])
    expect(await cli.exited).toBe(1)
    const { stdout } = cli.output()
    // The old entry still works, and is read; it is flagged so setup moves it.
    expect(stdout).toContain('✓ signed in to spicytrade')
    expect(stdout).toMatch(/✗ the sign-in is still under its old keyring entry\n {4}Move it with: \S+ setup/)
    expect(stdout).toMatch(/✗ the old background proxy is still installed \(spicytrade-proxy\.service\)\n {4}Remove it with: \S+ setup/)
    expect(stdout).toMatch(/✗ Claude Code starts spicytrade from an older install\n {4}Update it with: \S+ setup/)
    // Under either name, an entry in every folder loads trading tools in this code's own checkout.
    expect(stdout).toMatch(/✗ Claude Code loads spicytrade in every folder, not only the trading folder\n {4}Move it with: \S+ setup/)
    expect(stdout).toMatch(/✗ Claude Code loads spicy-trade in every folder, not only the trading folder\n {4}Move it with: \S+ setup/)
    expect(stdout).toContain('5 problems found.')
  }, 30_000)
})

describe('spicytrade setup', () => {
  it('does every step once, and on a second run skips each one', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN }, { claude: {} })
    const worker = await fakeWorker([OLD_TOKEN])

    const first = run(machine, worker.port, ['setup'])
    expect(await first.exited).toBe(0)
    const firstOut = first.output().stdout
    expect(firstOut).toContain('✓ already signed in; skipped')
    // No terminal to ask on, so trading authority is not granted; the member is told how.
    expect(firstOut).toMatch(/· not connected: there is no terminal to ask on\n/)
    // Only the trading folder loads the server; no other folder does.
    expect(firstOut).toContain('✓ Claude Code: added spicytrade\n')
    // Agents come before tastytrade, so walking away from tastytrade still leaves a working agent.
    expect(firstOut.indexOf('== Agents')).toBeLessThan(firstOut.indexOf('== tastytrade'))
    // The closing check repeats none of what the steps just said; it adds the one thing they
    // cannot see, the agent's server reaching spicytrade.
    expect(firstOut).toContain('== Check\nChecking that your agent can reach spicytrade…\n✓ your agent can reach spicytrade')
    expect(firstOut).not.toContain('✓ signed in to spicytrade')
    expect(firstOut).not.toContain('Everything is connected.')
    // tastytrade was not connected, so ready means market data and research, and says how to go further.
    expect(firstOut).toContain(`Ready for market data and research. Start your agent with:\n  cd ${machine.trading} && claude   (Claude Code)\n`)
    expect(firstOut).toMatch(/To see positions and place orders, run this in a terminal and connect tastytrade: \S+ setup\n/)
    // Nothing was running on an older sign-in, so there is no reconnect advice to give.
    expect(firstOut).not.toContain('reconnects')

    expect(await readFile(join(machine.state, 'claude-calls'), 'utf8')).toContain(`mcp add --scope local spicytrade -- ${MCP_TARGET}`)
    // The check reuses what the Agents step just found; each lookup starts the server, so none twice.
    const lookups = (await readFile(join(machine.state, 'claude-calls'), 'utf8')).match(/^mcp get /gm) ?? []
    expect(lookups.length).toBeLessThanOrEqual(4)
    expect(await readFile(join(machine.state, 'claude-local-spicytrade-target'), 'utf8')).toBe(`${MCP_TARGET}\n`)
    await expect(readFile(join(machine.state, 'claude-user-spicytrade-target'), 'utf8')).rejects.toThrow()
    // No background service any more: nothing is installed in systemd.
    await expect(readFile(join(machine.state, 'systemctl'), 'utf8')).rejects.toThrow()

    const second = run(machine, worker.port, ['setup'])
    expect(await second.exited).toBe(0)
    const secondOut = second.output().stdout
    expect(secondOut).toContain('✓ already signed in; skipped')
    expect(secondOut).toContain('✓ Claude Code already starts spicytrade; skipped')
    expect((await readFile(join(machine.state, 'claude-calls'), 'utf8')).match(/mcp add/g)).toHaveLength(1)
    for (const output of [first.output(), second.output()]) {
      expect(output.stdout).not.toContain(OLD_TOKEN)
      expect(output.stderr).not.toContain(OLD_TOKEN)
    }
  }, 60_000)

  it('says what to install when no agent is on the machine, without calling the run a failure', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN })
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['setup'])
    // Everything setup can do is done; the member was told at the start this would be the case.
    expect(await cli.exited).toBe(0)
    const { stdout } = cli.output()
    expect(stdout).toMatch(/· No Claude Code or Codex found; signing in anyway\./)
    expect(stdout).toMatch(/\nSigned in\. Install Claude Code or Codex, then run: \S+ setup\n$/)
    expect(stdout).not.toContain('✗')
    // Steps with nothing to say leave no bare heading behind.
    expect(stdout).not.toContain('== Agents')
    expect(stdout).not.toContain('== Check')
    // With no agent, there is no server of "your agent" to report as working.
    expect(stdout).not.toContain('your agent can reach spicytrade')
    expect(stdout).not.toContain('Ready.')
  }, 60_000)

  it('fails doctor on a machine with no agent, run on its own', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN })
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['doctor'])
    expect(await cli.exited).toBe(1)
    expect(cli.output().stdout).toMatch(/✗ no agent found \(Claude Code or Codex\)\n {4}Install one, then run: \S+ setup/)
  }, 30_000)

  it('leaves a client entry that is not spicytrade\'s as it is, and says how to replace it', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN }, { codex: { spicytrade: 'https://someone-elses.example/mcp' } })
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['setup'])
    expect(await cli.exited).toBe(1)
    const { stdout } = cli.output()
    expect(stdout).toContain('· Codex already has a different server named "spicytrade"; left as it is, see the check below')
    // The command that replaces it is given once, by the check.
    expect(stdout.match(/codex mcp remove spicytrade && codex mcp add spicytrade -- /g)).toHaveLength(1)
    expect(await readFile(join(machine.state, 'codex-spicytrade-target'), 'utf8')).toBe('https://someone-elses.example/mcp')
  }, 60_000)

  it('moves an entry in every folder into the trading folder, and leaves one that is not spicytrade', async () => {
    const machine = await fakeMachine(
      { 'spicytrade/mcp-token': OLD_TOKEN },
      { claude: { 'user:spicytrade': LEGACY_PROXY_URL, 'user:spicy-trade': 'https://someone-elses.example/mcp' } },
    )
    const worker = await fakeWorker([OLD_TOKEN])

    const cli = run(machine, worker.port, ['setup'])
    expect(await cli.exited).toBe(0)
    const { stdout } = cli.output()
    // The every-folder entry answers from the trading folder too, but does not count as its entry.
    expect(stdout).toContain('✓ Claude Code: added spicytrade\n')
    expect(stdout).toContain('✓ Claude Code (every folder): removed an old spicytrade entry')
    expect(await readFile(join(machine.state, 'claude-local-spicytrade-target'), 'utf8')).toBe(`${MCP_TARGET}\n`)
    await expect(readFile(join(machine.state, 'claude-user-spicytrade-target'), 'utf8')).rejects.toThrow()
    expect(stdout).toContain('! Claude Code (every folder) has a different server named "spicy-trade"; left as it is')
    expect(await readFile(join(machine.state, 'claude-user-spicy-trade-target'), 'utf8')).toBe('https://someone-elses.example/mcp')
    expect(stdout).not.toContain('someone-elses')
    expect(stdout).toContain('Ready for market data and research.')
  }, 60_000)

  it('moves a background-proxy install onto the command agents start, under the current names', async () => {
    const machine = await fakeMachine(
      { 'spicy-trade/mcp-token': OLD_TOKEN },
      {
        claude: { 'local:spicytrade': LEGACY_PROXY_URL },
        codex: { spicytrade: LEGACY_PROXY_URL, 'spicy-trade': 'https://someone-elses.example/mcp' },
      },
    )
    const units = [await legacyUnit(machine, 'spicytrade-proxy.service'), await legacyUnit(machine, 'spicy-trade-proxy.service')]
    const worker = await fakeWorker([OLD_TOKEN])

    const cli = run(machine, worker.port, ['setup'])
    expect(await cli.exited).toBe(0)
    const { stdout } = cli.output()

    expect(stdout).toContain('✓ already signed in; moved the token to its current keyring entry')
    expect(await readFile(join(machine.bin, 'store', 'spicytrade_mcp-token'), 'utf8')).toBe(OLD_TOKEN)
    await expect(readFile(join(machine.bin, 'store', 'spicy-trade_mcp-token'), 'utf8')).rejects.toThrow()

    // The background proxy is stopped and its units are gone.
    expect(stdout).toContain('✓ removed the old background proxy (spicytrade-proxy.service)')
    expect(stdout).toContain('✓ removed the old background proxy (spicy-trade-proxy.service)')
    for (const unit of units) await expect(readFile(unit, 'utf8')).rejects.toThrow()
    const systemctlCalls = await readFile(join(machine.state, 'systemctl'), 'utf8')
    expect(systemctlCalls).toContain('stop spicytrade-proxy.service')
    expect(systemctlCalls).toContain('disable spicy-trade-proxy.service')

    // Entries naming the proxy are replaced by the command; one naming somewhere else is someone's own.
    expect(await readFile(join(machine.state, 'claude-local-spicytrade-target'), 'utf8')).toBe(`${MCP_TARGET}\n`)
    expect(await readFile(join(machine.state, 'codex-spicytrade-target'), 'utf8')).toBe(`${MCP_TARGET}\n`)
    expect(stdout).toContain('✓ Codex: added spicytrade (on only when you start Codex with the command at the end)\n')
    expect(await readFile(join(machine.home, '.codex', 'config.toml'), 'utf8'))
      .toBe(`[mcp_servers.spicytrade]\nenabled = false\ncommand = "${resolve(CLI)}"\n`)
    expect(stdout).toContain('! Codex has a different server named "spicy-trade"; left as it is')
    expect(await readFile(join(machine.state, 'codex-spicy-trade-target'), 'utf8')).toBe('https://someone-elses.example/mcp')
    expect(stdout).not.toContain('someone-elses')
    expect(stdout).toContain('Ready for market data and research.')
  }, 60_000)
})

describe('spicytrade setup and a saved tastytrade connection', () => {
  it('finds a connection tastytrade has since refused, rather than calling it connected', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN, 'tastytrade/app-refresh-token': APP_REFRESH_TOKEN })
    const port = await serve((request) => {
      if (request.url === '/api/brokers/tastytrade/token') return { body: { error: 'refused', tastytradeStatus: 401 }, status: 502 }
      return { body: { id: 1, jsonrpc: '2.0', result: {} }, status: 200 }
    })
    const cli = run(machine, port, ['setup'])
    expect(await cli.exited).toBe(1)
    const { stdout } = cli.output()
    expect(stdout).not.toContain('already connected')
    // No terminal to ask on, so it does not ask; the closing check reports it once, with its fix.
    expect(stdout).toContain('· tastytrade refused the saved connection; see the check below')
    expect(stdout).toMatch(/✗ tastytrade refused the saved connection \(HTTP 401\)\n {4}Reconnect with: \S+ setup/)
    expect(stdout.match(/✗ tastytrade/g)).toHaveLength(1)
  }, 60_000)
})

describe('setup with a problem left over', () => {
  it('still says how to start the agent it added, without calling the run ready', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN, 'tastytrade/app-refresh-token': APP_REFRESH_TOKEN }, { claude: {} })
    const port = await serve((request) => {
      if (request.url === '/api/brokers/tastytrade/token') return { body: { error: 'refused', tastytradeStatus: 401 }, status: 502 }
      return { body: { id: 1, jsonrpc: '2.0', result: {} }, status: 200 }
    })
    const cli = run(machine, port, ['setup'])
    expect(await cli.exited).toBe(1)
    const { stdout } = cli.output()
    expect(stdout).toContain(`Start your agent with:\n  cd ${machine.trading} && claude   (Claude Code)\n`)
    expect(stdout).not.toContain('Ready')
  }, 60_000)
})

describe('a keyring that answers lookups but cannot save', () => {
  it('stops before any browser step, saying why, with nothing issued', async () => {
    const machine = await fakeMachine({})
    // Lookups answer "nothing stored"; every store is refused, as with no unlocked collection.
    await writeFile(join(machine.bin, 'secret-tool'), '#!/usr/bin/env bash\n[[ $1 == store ]] && { cat >/dev/null; exit 1; }\n[[ $1 == lookup ]] && exit 1\nexit 0\n')
    const worker = await fakeWorker([])
    const cli = run(machine, worker.port, ['setup'])
    expect(await cli.exited).toBe(1)
    expect(cli.output().stderr).toMatch(/spicytrade setup: your system keyring cannot save credentials here\. If you have one, unlock it\. If not, install one \(Debian\/Ubuntu: sudo apt install gnome-keyring;.* Over SSH, this computer's desktop session must also be logged in\. Then run: \S+ setup$/m)
    expect(cli.output().stdout).not.toContain('Sign in to spicytrade')
    expect(worker.calls).toEqual([])
  }, 30_000)
})

describe('a keyring slow to answer', () => {
  it('says why the terminal is waiting before the check answers', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN }, { claude: {} })
    // A store that waits, as one does on an unlock prompt, then succeeds.
    const real = join(machine.bin, 'secret-tool')
    await writeFile(join(machine.bin, 'secret-tool-real'), await readFile(real, 'utf8'))
    await chmod(join(machine.bin, 'secret-tool-real'), 0o755)
    await writeFile(real, `#!/usr/bin/env bash\n[[ $1 == store && $6 == write-check ]] && sleep 3\nexec '${join(machine.bin, 'secret-tool-real')}' "$@"\n`)
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['setup'])
    expect(await cli.exited).toBe(0)
    expect(cli.output().stdout).toMatch(/^Checking the system keyring\. If a password prompt appears, unlock it\.\n/)
  }, 60_000)
})

describe('half a saved personal grant', () => {
  it('is reported with its one repair, by doctor and by setup, never as a crash', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN, 'tastytrade/client-secret': 'half-a-grant' }, { claude: {} })
    const worker = await fakeWorker([OLD_TOKEN])
    for (const command of ['doctor', 'setup']) {
      const cli = run(machine, worker.port, [command])
      expect(await cli.exited).toBe(1)
      const { stderr, stdout } = cli.output()
      expect(stdout).toMatch(/✗ an incomplete tastytrade connection is saved\n {4}Replace it with: \S+ setup/)
      expect(stderr).not.toContain('TypeError')
      expect(stdout + stderr).not.toContain('half-a-grant')
    }
  }, 60_000)
})

describe('spicytrade disconnect-tastytrade', () => {
  it('removes every tastytrade credential of either kind, and nothing else', async () => {
    const machine = await fakeMachine({
      'spicytrade/mcp-token': OLD_TOKEN,
      'tastytrade/app-refresh-token': APP_REFRESH_TOKEN,
      'tastytrade/client-secret': 'personal-client-secret',
    })
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['disconnect-tastytrade'])
    expect(await cli.exited).toBe(0)
    expect(cli.output().stdout).toContain('✓ tastytrade removed from this computer.')
    for (const key of ['app-refresh-token', 'client-secret', 'refresh-token']) {
      await expect(readFile(join(machine.bin, 'store', `tastytrade_${key}`), 'utf8')).rejects.toThrow()
    }
    expect(await readFile(join(machine.bin, 'store', 'spicytrade_mcp-token'), 'utf8')).toBe(OLD_TOKEN)
  }, 30_000)
})

describe('spicytrade disconnect-tastytrade with nothing connected', () => {
  it('says there was nothing to remove, and nothing about reconnecting', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN })
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['disconnect-tastytrade'])
    expect(await cli.exited).toBe(0)
    expect(cli.output().stdout).toBe('· tastytrade was not connected on this computer; nothing to remove.\n')
  }, 30_000)
})

describe('spicytrade disconnect-tastytrade with a personal grant', () => {
  it('says the grant itself is ended on the member\'s own OAuth app', async () => {
    const machine = await fakeMachine({
      'spicytrade/mcp-token': OLD_TOKEN,
      'tastytrade/client-secret': 'personal-client-secret',
      'tastytrade/refresh-token': 'personal-refresh-token',
    })
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['disconnect-tastytrade'])
    expect(await cli.exited).toBe(0)
    expect(cli.output().stdout).toContain('To end the grant itself, delete it under OAuth Applications on my.tastytrade.com.')
  }, 30_000)
})

describe('spicytrade uninstall', () => {
  it('removes spicytrade\'s agent entries and credentials, leaving others\' and a checkout alone', async () => {
    const machine = await fakeMachine(
      { 'spicytrade/mcp-token': OLD_TOKEN, 'tastytrade/app-refresh-token': APP_REFRESH_TOKEN },
      { claude: { 'local:spicytrade': MCP_TARGET, 'user:spicy-trade': 'https://someone-elses.example/mcp' }, codex: { spicytrade: MCP_TARGET } },
    )
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['uninstall'])
    expect(await cli.exited).toBe(0)
    const { stdout } = cli.output()
    expect(stdout).toContain('✓ Claude Code: removed spicytrade')
    expect(stdout).toContain('✓ Codex: removed spicytrade')
    await expect(readFile(join(machine.state, 'claude-local-spicytrade-target'), 'utf8')).rejects.toThrow()
    await expect(readFile(join(machine.state, 'codex-spicytrade-target'), 'utf8')).rejects.toThrow()
    expect(await readFile(join(machine.state, 'claude-user-spicy-trade-target'), 'utf8')).toBe('https://someone-elses.example/mcp')
    for (const entry of ['spicytrade_mcp-token', 'tastytrade_app-refresh-token']) {
      await expect(readFile(join(machine.bin, 'store', entry), 'utf8')).rejects.toThrow()
    }
    // Run from a checkout, the program is not touched.
    expect(stdout).not.toContain('removed the spicytrade program')
    expect(await readFile(CLI, 'utf8')).toContain('spicytrade')
    // It signed itself out with its own token, before clearing it.
    expect(worker.calls.some((call) => call.path === '/api/agent-logins' && call.authorization === `Bearer ${OLD_TOKEN}`)).toBe(true)
    expect(stdout).toMatch(/spicytrade is removed from this computer and signed out of your account\.\n$/)
  }, 60_000)

  it('counts a computer the website already revoked as signed out, rather than sending the member back to revoke it', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN })
    const worker = await fakeWorker([])
    const cli = run(machine, worker.port, ['uninstall'])
    expect(await cli.exited).toBe(0)
    expect(cli.output().stdout).toMatch(/signed out of your account\.\n$/)
    expect(cli.output().stdout).not.toContain('revoke it under')
    // Nothing of tastytrade's was saved, so nothing of it is said to be removed.
    expect(cli.output().stdout).toContain("✓ removed this computer's spicytrade sign-in from the keyring\n")
  }, 30_000)

  it('removes the program and its link when it is the installed copy', async () => {
    const machine = await fakeMachine({})
    const share = join(machine.home, '.local', 'share', 'spicytrade')
    const link = join(machine.home, '.local', 'bin', 'spicytrade')
    await mkdir(share, { recursive: true })
    await mkdir(dirname(link), { recursive: true })
    // The single file the site serves, built here: CI runs the tests before the build that makes it.
    expect(spawnSync(process.execPath, ['tools/build-agent.mjs']).status).toBe(0)
    await writeFile(join(share, 'spicytrade.mjs'), await readFile('public/spicytrade.mjs', 'utf8'))
    await symlink(join(share, 'spicytrade.mjs'), link)
    const worker = await fakeWorker([])
    // Without XDG_DATA_HOME, so the installer's default location is the one in play.
    const { XDG_DATA_HOME: _ignored, ...inherited } = process.env
    const env = { ...inherited, HOME: machine.home, PATH: TEST_PATH(machine.bin), SPICYTRADE_MCP_URL: `http://127.0.0.1:${worker.port}/mcp`, XDG_CONFIG_HOME: machine.config }
    const child = spawn(process.execPath, [join(share, 'spicytrade.mjs'), 'uninstall'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    expect(await new Promise((done) => child.on('exit', done))).toBe(0)
    expect(stdout).toContain('✓ removed the spicytrade program')
    await expect(readFile(join(share, 'spicytrade.mjs'), 'utf8')).rejects.toThrow()
    await expect(readFile(link, 'utf8')).rejects.toThrow()
  }, 60_000)
})

describe('spicytrade store-personal-grant', () => {
  it('needs a terminal to prompt on, and stores nothing without one', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN })
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['store-personal-grant'])
    expect(await cli.exited).toBe(1)
    expect(cli.output().stderr).toContain('spicytrade store-personal-grant: this prompts for the grant, so it needs a terminal')
    await expect(readFile(join(machine.bin, 'store', 'tastytrade_client-secret'), 'utf8')).rejects.toThrow()
  }, 30_000)
})
