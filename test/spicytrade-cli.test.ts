import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { type IncomingMessage, type Server } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { fakeSecretTool } from './fake-secret-tool.ts'
import { closeLoopback, listenLoopback } from './loopback.ts'

/*
 * `spicytrade` end to end against a stand-in Worker, with every tool it drives replaced on PATH:
 * a file-backed `secret-tool`, an `xdg-open` that records the URL, and, where a test has an agent
 * installed, a `claude` or `codex` that only records that it was run -- the CLI looks for them and
 * never runs them. PATH holds only those and the system directories, the home directory and the
 * workspace are inside the test's own temporary directory, so a run never reaches the real
 * keyring, a real browser, or the folders and agents of the machine running the tests.
 */

const OLD_TOKEN = 'spice_0123456789abcdef_OLDOLDOLDOLDOLDOLDOL'
const NEW_TOKEN = 'spice_fedcba9876543210_NEWNEWNEWNEWNEWNEWNE'
const APP_REFRESH_TOKEN = 'app-refresh-token-that-belongs-in-the-keyring'
/** The access token the stand-in Worker mints for the app grant. */
const MINTED_ACCESS_TOKEN = 'minted-access-token'
const CLI = 'ops/spicytrade/spicytrade.mjs'
/**
 * How the CLI names itself in a message when it is run from this checkout: by its absolute path,
 * since neither PATH nor the temporary home leads to it.
 */
const SPICYTRADE = resolve(CLI)
/** The PATH every run gets: the fakes, this test's own node, and the system directories. */
const TEST_PATH = (bin: string) => `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`

/** A signed-in computer with tastytrade connected through spicytrade's app. */
const CONNECTED = { 'spicytrade/mcp-token': OLD_TOKEN, 'tastytrade/app-refresh-token': APP_REFRESH_TOKEN }

type Agent = 'claude' | 'codex'
/** Where each agent looks for a folder's skills, relative to that folder. */
const SKILL_FILES = {
  claude: join('.claude', 'skills', 'spicytrade', 'SKILL.md'),
  codex: join('.agents', 'skills', 'spicytrade', 'SKILL.md'),
} satisfies Record<Agent, string>
/** A skill a member wrote under the same name: no marker of the CLI's, so it is theirs. */
const FOREIGN_SKILL = '---\nname: spicytrade\ndescription: My own notes on the spice trade.\n---\n\nMine.\n'
/** The file a fake agent appends its command line to, if anything ever runs it. */
const AGENT_RUNS = 'agent-runs'

/** The closing lines the commands share, as the source words them. */
const ASK_YOUR_AGENT = `  Ask your agent about a quote or your positions; it runs \`${SPICYTRADE} tools\` to see what it can do.\n`
const OTHER_FOLDERS = 'If you connected from other folders too, delete the spicytrade folder under .claude/skills or .agents/skills in each.\n'
const connected = (who: string) => `Account connected and live snapshot verified. ${who}. List what it can do with \`${SPICYTRADE} tools\`.\n`
const AGENTS_CAN_USE_IT = connected('Agents started in ~/workspace can use it now')
const NO_AGENT_TO_TELL = connected('No Claude Code or Codex was found on this computer to tell about it')

const ExchangeBodySchema = z.strictObject({
  codeVerifier: z.string(),
  previousToken: z.string().optional(),
})
const McpRequestSchema = z.object({
  id: z.number().optional(),
  method: z.string(),
  params: z.object({ name: z.string().optional() }).optional(),
})

type Answer = { body?: unknown; status: number }
type ToolResult = { content: { text: string; type: 'text' }[]; isError?: boolean }
type WorkerCall = { body: string; headers: IncomingMessage['headers']; method?: string; path: string }

const servers: Server[] = []
const children: ChildProcess[] = []
const directories: string[] = []
const machines: Machine[] = []

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await Promise.all(servers.splice(0).map(closeLoopback))
  const kept = await Promise.all(machines.splice(0).map((machine) => readdir(machine.state)))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
  // Whatever the test was about, no command in it ran an agent: they are only looked for.
  for (const files of kept) expect(files).not.toContain(AGENT_RUNS)
})

async function serve(handler: (request: IncomingMessage, body: string) => Answer): Promise<number> {
  const { port, server } = await listenLoopback((request, body, response) => {
    const answer = handler(request, body)
    response.writeHead(answer.status, { 'content-type': 'application/json' })
    response.end(answer.body === undefined ? '' : JSON.stringify(answer.body))
  })
  servers.push(server)
  return port
}

/** The answer `read_account_snapshot` gives for a live account, as `connect` verifies it. */
function liveSnapshot(): ToolResult {
  const netLiquidatingValue = 1234
  return { content: [{ text: JSON.stringify({ asOf: new Date().toISOString(), balances: { netLiquidatingValue }, source: 'tastytrade' }), type: 'text' }] }
}

/**
 * A Worker that accepts `acceptedTokens` on `/mcp`, on the app-grant mint and on the collection of
 * a tastytrade grant. It answers each poll of the sign-in exchange with `exchange()`, by default a
 * member who has already approved; each poll for the grant with `grant()`, by default a browser
 * already back from tastytrade; and a tool call on `/mcp` with `snapshot()`, by default a live
 * account snapshot.
 */
async function fakeWorker(acceptedTokens: string[], { exchange, grant, snapshot = liveSnapshot }: {
  exchange?: () => Answer
  grant?: () => Answer
  snapshot?: () => ToolResult
} = {}) {
  const calls: WorkerCall[] = []
  const port = await serve((request, body) => {
    const path = request.url ?? ''
    calls.push({ body, headers: request.headers, method: request.method, path })
    if (path === '/api/agent-logins/exchange') {
      const answer = exchange?.() ?? {
        body: { token: NEW_TOKEN, tokenMetadata: { createdAt: '2026-09-28T00:00:00Z', label: 'test', tokenId: '0123456789abcdef' } },
        status: 200,
      }
      if (answer.status === 200) acceptedTokens.push(NEW_TOKEN)
      return answer
    }
    const accepted = acceptedTokens.some((token) => request.headers.authorization === `Bearer ${token}`)
    if (!accepted) return { body: { error: 'invalid_token' }, status: 401 }
    if (path === '/api/brokers/tastytrade/exchange') return grant?.() ?? { body: { refreshToken: APP_REFRESH_TOKEN }, status: 200 }
    if (path === '/api/brokers/tastytrade/token') return { body: { accessToken: MINTED_ACCESS_TOKEN, expiresIn: 900 }, status: 200 }
    if (path !== '/mcp') return { body: {}, status: 200 }
    const { id, method } = McpRequestSchema.parse(JSON.parse(body))
    return { body: { id, jsonrpc: '2.0', result: method === 'tools/call' ? snapshot() : { tools: [] } }, status: 200 }
  })
  return { calls, port }
}

/** The tool calls a Worker received: each one's tool, and the broker token that came with it. */
function toolCalls(calls: WorkerCall[]) {
  return calls.filter((call) => call.path === '/mcp')
    .map((call) => ({ brokerToken: call.headers['x-spicy-trade-broker-token'], request: McpRequestSchema.parse(JSON.parse(call.body)) }))
    .filter(({ request }) => request.method === 'tools/call')
    .map(({ brokerToken, request }) => ({ brokerToken, name: request.params?.name }))
}

type Machine = {
  bin: string
  home: string
  state: string
  workspace: string
}

/**
 * A machine: the fake tools, a home directory, and the state the fakes keep. `agents` names which
 * agent CLIs are installed. An installed agent is nothing but an executable of that name on PATH,
 * which is all the CLI looks for; run, it records its command line in `state`, and every test ends
 * by checking that none was.
 */
async function fakeMachine(keyring: Record<string, string>, agents: Agent[] = []): Promise<Machine> {
  const bin = await fakeSecretTool(keyring)
  directories.push(bin)
  const state = join(bin, 'state')
  const home = join(bin, 'home')
  const workspace = join(home, 'workspace')
  await mkdir(state)
  await mkdir(home)
  await writeFile(join(bin, 'xdg-open'), `#!/usr/bin/env bash\necho "$1" > '${state}/opened'\n`)
  for (const agent of agents) await writeFile(join(bin, agent), `#!/usr/bin/env bash\necho "${agent} $*" >> '${state}/${AGENT_RUNS}'\n`)
  for (const tool of ['xdg-open', ...agents]) await chmod(join(bin, tool), 0o755)
  const machine = { bin, home, state, workspace }
  machines.push(machine)
  return machine
}

/**
 * Runs the CLI on `machine`: its home, its PATH, the stand-in Worker, and its workspace. The tests'
 * own environment is passed on without CLAUDECODE, which is set when they run inside Claude Code.
 * `env` adds to it, an undefined value removing that variable; `cwd` is the folder the CLI is run
 * from, and `script` the copy of the CLI to run when it is not this checkout's.
 *
 * The CLI writes into its workspace and reads its home, so a run whose workspace or home would be
 * outside the machine's own temporary directory is refused before anything is started.
 */
function run(
  machine: Machine,
  workerPort: number,
  args: string[],
  { cwd, env = {}, script = SPICYTRADE }: { cwd?: string; env?: Record<string, string | undefined>; script?: string } = {},
) {
  let stdout = ''
  let stderr = ''
  const { CLAUDECODE: _inherited, ...inherited } = process.env
  const environment = {
    ...inherited,
    HOME: machine.home,
    PATH: TEST_PATH(machine.bin),
    SPICYTRADE_MCP_URL: `http://127.0.0.1:${workerPort}/mcp`,
    SPICYTRADE_WORKSPACE: machine.workspace,
    ...env,
  }
  for (const folder of [environment.HOME, environment.SPICYTRADE_WORKSPACE ?? cwd]) {
    if (!folder?.startsWith(`${machine.bin}/`)) throw new Error('a test run must keep its home and its workspace inside the test machine')
  }
  const child = spawn(process.execPath, [script, ...args], {
    cwd,
    env: Object.fromEntries(Object.entries(environment).filter(([, value]) => value !== undefined)),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  children.push(child)
  child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
  child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
  const exited = new Promise<number | null>((done) => child.on('exit', done))
  return { exited, output: () => ({ stderr, stdout }) }
}

/** The approval URL the CLI printed, once it has. */
async function approvalUrl(output: () => { stdout: string }): Promise<URL> {
  await expect.poll(() => output().stdout, { timeout: 10_000 }).toContain('Open this link in any browser')
  const printed = output().stdout.match(/^ {2}(http\S+)$/m)?.[1]
  if (!printed) throw new Error('the CLI printed no approval URL')
  return new URL(printed)
}

function skillFile(machine: Machine, agent: Agent, workspace = machine.workspace) {
  return join(workspace, SKILL_FILES[agent])
}

/** Puts a member's own skill where the CLI would write its own for `agent`. */
async function writeForeignSkill(machine: Machine, agent: Agent) {
  await mkdir(dirname(skillFile(machine, agent)), { recursive: true })
  await writeFile(skillFile(machine, agent), FOREIGN_SKILL)
}

/** Whether nothing exists at `path`. */
async function absent(path: string) {
  return stat(path).then(() => false, () => true)
}

/*
 * Signing in on its own link: tastytrade is already connected on these computers, so the link
 * `setup` prints goes no further than the sign-in.
 */
describe('signing in again', () => {
  it('prints one link, polls with its verifier until the member approves, and keeps only the token', async () => {
    const machine = await fakeMachine(CONNECTED, ['claude'])
    // The member approves between the first poll and the second.
    let polls = 0
    const worker = await fakeWorker([], {
      exchange: () => (polls++ === 0 ? { body: { pending: true }, status: 202 } : { body: { token: NEW_TOKEN }, status: 200 }),
    })
    const cli = run(machine, worker.port, ['setup'])
    const url = await approvalUrl(cli.output)

    expect(url.pathname).toBe('/connect/agent')
    // Nothing returns to this computer, so the link names no port and carries no state.
    expect([...url.searchParams.keys()].sort()).toEqual(['challenge', 'check', 'label'])
    const challenge = url.searchParams.get('challenge') ?? ''
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(url.searchParams.get('label')?.length).toBeGreaterThan(0)
    // The code is printed beside the link and is not in it: the link carries only a digest that
    // ties the code to this challenge, for the page to check what the member types.
    const printed = cli.output().stdout.match(/enter code ([0-9A-F]{4})-([0-9A-F]{4}) there:/)
    const code = `${printed?.[1]}${printed?.[2]}`
    expect(url.searchParams.get('check')).toBe(createHash('sha256').update(`${challenge}:${code}`).digest('base64url'))
    expect(url.toString()).not.toContain(code)

    expect(await cli.exited).toBe(0)
    expect(await readFile(join(machine.bin, 'store', 'spicytrade_mcp-token'), 'utf8')).toBe(NEW_TOKEN)
    const exchanges = worker.calls.filter((call) => call.path === '/api/agent-logins/exchange')
    expect(exchanges).toHaveLength(2)
    for (const exchange of exchanges) {
      const body = ExchangeBodySchema.parse(JSON.parse(exchange.body))
      // The verifier is the one whose digest was in the page address, and the old token rides
      // along so the Worker retires it rather than leaving this machine with two.
      expect(createHash('sha256').update(body.codeVerifier).digest('base64url')).toBe(challenge)
      expect(body.previousToken).toBe(OLD_TOKEN)
      expect(exchange.headers.authorization).toBeUndefined()
    }

    const { stderr, stdout } = cli.output()
    for (const secret of [NEW_TOKEN, OLD_TOKEN, ExchangeBodySchema.parse(JSON.parse(exchanges[0]!.body)).codeVerifier]) {
      expect(stdout).not.toContain(secret)
      expect(stderr).not.toContain(secret)
    }
    expect(stdout).toContain('This computer was signed out of spicytrade (revoked under Signed-in computers); signing in again.\n')
    expect(stdout).toContain('✓ Signed in.')
    // Every call reads the keyring as it stands, so nothing has to restart or reconnect.
    expect(stdout).not.toMatch(/reconnect|restart/i)
    expect(stdout).toContain(`\nAccount connected. Continue in your agent:\n${ASK_YOUR_AGENT}`)
    await expect.poll(() => readFile(join(machine.state, 'opened'), 'utf8').catch(() => '')).toContain('/connect/agent?')
  }, 60_000)

  it('opens no browser over SSH, where the member opens the link on their own device', async () => {
    const machine = await fakeMachine({ 'tastytrade/app-refresh-token': APP_REFRESH_TOKEN }, ['claude'])
    const worker = await fakeWorker([])
    const cli = run(machine, worker.port, ['setup'], { env: { SSH_CONNECTION: '203.0.113.7 50000 203.0.113.8 22' } })
    expect(await cli.exited).toBe(0)
    expect(cli.output().stdout).toContain('/connect/agent?')
    expect(cli.output().stdout).not.toContain('ssh -L')
    await expect(readFile(join(machine.state, 'opened'), 'utf8')).rejects.toThrow()
  }, 60_000)

  it.each([
    [409, { error: 'At most 5 agent tokens' }, 'Revoke one you no longer'],
    [503, { error: 'unavailable' }, 'spicytrade could not finish the sign-in (HTTP 503)'],
  ])('reports an exchange refused with %i in its own words, keeping the old token', async (status, answer, message) => {
    const machine = await fakeMachine(CONNECTED)
    const worker = await fakeWorker([], { exchange: () => ({ body: answer, status }) })
    const cli = run(machine, worker.port, ['setup'])
    expect(await cli.exited).toBe(1)
    expect(cli.output().stderr).toContain(message)
    expect(cli.output().stderr).toMatch(/: \S+ connect$/m)
    // The Worker's body is not echoed.
    expect(cli.output().stderr).not.toContain(JSON.stringify(answer))
    expect(await readFile(join(machine.bin, 'store', 'spicytrade_mcp-token'), 'utf8')).toBe(OLD_TOKEN)
  }, 30_000)
})

describe('spicytrade doctor', () => {
  it('passes every check on a machine that is fully connected', async () => {
    const machine = await fakeMachine(CONNECTED, ['claude'])
    const worker = await fakeWorker([OLD_TOKEN])
    expect(await run(machine, worker.port, ['connect']).exited).toBe(0)

    const cli = run(machine, worker.port, ['doctor'])
    expect(await cli.exited).toBe(0)
    const { stdout } = cli.output()
    expect(stdout).toBe('✓ signed in to spicytrade\n'
      + '✓ tastytrade is connected\n'
      + '✓ Claude Code has the spicytrade skill in ~/workspace\n'
      + '\nEverything is connected.\n')
    expect(stdout).not.toContain(OLD_TOKEN)
    expect(stdout).not.toContain(APP_REFRESH_TOKEN)
  }, 60_000)

  it('notes what is not connected and a folder without the skill, without calling either a problem', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN }, ['claude'])
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['doctor'])
    expect(await cli.exited).toBe(0)
    // The skill's note names the command that writes it, and the folder to run it in.
    expect(cli.output().stdout).toBe('✓ signed in to spicytrade\n'
      + '· tastytrade is not connected: market and research tools only\n'
      + `    To see positions and trade, run: ${SPICYTRADE} setup\n`
      + '· Claude Code has no spicytrade skill in ~/workspace, so an agent started here is not told about it\n'
      + `    Add it by running this in that folder: ${SPICYTRADE} connect\n`
      + '\nEverything else is working.\n')
    // It checks without changing anything: the workspace was not even created.
    expect(await absent(machine.workspace)).toBe(true)
  }, 30_000)

  it('names a mistyped command rather than only reprinting the usage', async () => {
    const machine = await fakeMachine({})
    const worker = await fakeWorker([])
    const cli = run(machine, worker.port, ['stup'])
    expect(await cli.exited).toBe(2)
    expect(cli.output().stderr).toMatch(/^spicytrade: unknown command "stup"\n\nUsage: spicytrade <command>/)
  }, 30_000)

  it.each(['login', 'connect-tastytrade', 'mcp', 'start', 'integration'])('no longer knows %s', async (removed) => {
    const machine = await fakeMachine(CONNECTED, ['claude', 'codex'])
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, [removed])
    expect(await cli.exited).toBe(2)
    expect(cli.output().stderr).toMatch(new RegExp(`^spicytrade: unknown command "${removed}"\n\nUsage: spicytrade <command>`))
    expect(cli.output().stdout).toBe('')
    expect(worker.calls).toEqual([])
    expect(await absent(machine.workspace)).toBe(true)
  }, 30_000)

  it.each(['connect', 'doctor', 'guide', 'setup', 'uninstall'])('refuses arguments to %s, which takes none, before doing anything', async (command) => {
    const machine = await fakeMachine(CONNECTED, ['claude'])
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, [command, 'extra'])
    expect(await cli.exited).toBe(2)
    expect(cli.output().stderr).toMatch(new RegExp(`^spicytrade ${command}: takes no arguments\n\nUsage: spicytrade <command>`))
    expect(worker.calls).toEqual([])
    expect(await readFile(join(machine.bin, 'store', 'spicytrade_mcp-token'), 'utf8')).toBe(OLD_TOKEN)
  }, 30_000)

  it('takes arguments for tools and call, and says how each is used when they are wrong', async () => {
    const machine = await fakeMachine(CONNECTED)
    const worker = await fakeWorker([OLD_TOKEN])
    const tools = run(machine, worker.port, ['tools', 'one', 'two'])
    expect(await tools.exited).toBe(1)
    expect(tools.output().stderr).toBe(`spicytrade tools: takes at most one tool name. Usage: ${SPICYTRADE} tools [name]\n`)
    const call = run(machine, worker.port, ['call'])
    expect(await call.exited).toBe(1)
    expect(call.output().stderr).toBe('spicytrade call: takes a tool name and its arguments as one JSON object.'
      + ` Usage: ${SPICYTRADE} call <tool> '<json arguments>'\n`)
    expect(worker.calls).toEqual([])
  }, 30_000)

  it('reports a revoked sign-in once, with the command that fixes it', async () => {
    const machine = await fakeMachine(CONNECTED, ['claude', 'codex'])
    const worker = await fakeWorker([])

    const cli = run(machine, worker.port, ['doctor'])
    expect(await cli.exited).toBe(1)
    // The tastytrade mint goes through spicytrade, so the one refused sign-in is reported once,
    // not again as a failure of the connection. A missing skill is a note beside it, not a problem.
    expect(cli.output().stdout).toBe('✗ this computer was signed out of spicytrade (revoked under Signed-in computers)\n'
      + `    Sign in again with: ${SPICYTRADE} setup\n`
      + '· Claude Code has no spicytrade skill in ~/workspace, so an agent started here is not told about it\n'
      + `    Add it by running this in that folder: ${SPICYTRADE} connect\n`
      + '· Codex has no spicytrade skill in ~/workspace, so an agent started here is not told about it\n'
      + `    Add it by running this in that folder: ${SPICYTRADE} connect\n`
      + '\n1 problem found.\n')
    expect(worker.calls.some((call) => call.path === '/api/brokers/tastytrade/token')).toBe(false)
  }, 30_000)

  it('fails on a machine with no agent', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN })
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['doctor'])
    expect(await cli.exited).toBe(1)
    expect(cli.output().stdout).toContain(`✗ no agent found (Claude Code or Codex)\n    Install one, then run: ${SPICYTRADE} setup\n`)
    expect(cli.output().stdout).toContain('\n1 problem found.\n')
  }, 30_000)
})

describe('the skill that tells an agent about spicytrade', () => {
  it('is written for each installed agent where that agent looks, and skipped on a second run', async () => {
    const machine = await fakeMachine(CONNECTED, ['claude', 'codex'])
    const worker = await fakeWorker([OLD_TOKEN])

    const first = run(machine, worker.port, ['connect'])
    expect(await first.exited).toBe(0)
    const firstOut = first.output().stdout
    expect(firstOut).toContain('✓ Claude Code: added the spicytrade skill in ~/workspace\n'
      + '✓ Codex: added the spicytrade skill in ~/workspace\n'
      + AGENTS_CAN_USE_IT)
    expect(firstOut.endsWith(AGENTS_CAN_USE_IT)).toBe(true)
    // The connection was verified by reading the account the way an agent will: one tool call
    // straight to the Worker, carrying a freshly minted broker token.
    expect(toolCalls(worker.calls)).toEqual([{ brokerToken: MINTED_ACCESS_TOKEN, name: 'read_account_snapshot' }])

    const skill = await readFile(skillFile(machine, 'claude'), 'utf8')
    expect(skill).toMatch(/^---\nname: spicytrade\ndescription: \S.*\n---\n/)
    for (const command of ['spicytrade tools', 'spicytrade call', 'spicytrade guide', 'spicytrade connect']) expect(skill).toContain(command)
    expect(await readFile(skillFile(machine, 'codex'), 'utf8')).toBe(skill)
    // Nothing else is put in the workspace, and no credential is written into it.
    expect((await readdir(machine.workspace)).sort()).toEqual(['.agents', '.claude'])
    for (const secret of [OLD_TOKEN, APP_REFRESH_TOKEN, MINTED_ACCESS_TOKEN]) {
      expect(skill).not.toContain(secret)
      expect(firstOut).not.toContain(secret)
    }

    const written = await Promise.all([stat(skillFile(machine, 'claude')), stat(skillFile(machine, 'codex'))])
    const second = run(machine, worker.port, ['connect'])
    expect(await second.exited).toBe(0)
    expect(second.output().stdout).toContain('✓ Claude Code already has the spicytrade skill in ~/workspace; skipped\n'
      + '✓ Codex already has the spicytrade skill in ~/workspace; skipped\n'
      + AGENTS_CAN_USE_IT)
    const kept = await Promise.all([stat(skillFile(machine, 'claude')), stat(skillFile(machine, 'codex'))])
    expect(kept.map((file) => file.mtimeMs)).toEqual(written.map((file) => file.mtimeMs))
    expect(await readFile(skillFile(machine, 'claude'), 'utf8')).toBe(skill)
  }, 60_000)

  it('is written for no agent that is not installed', async () => {
    const machine = await fakeMachine(CONNECTED, ['codex'])
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['connect'])
    expect(await cli.exited).toBe(0)
    const { stdout } = cli.output()
    expect(stdout).toContain(`✓ Codex: added the spicytrade skill in ~/workspace\n${AGENTS_CAN_USE_IT}`)
    expect(stdout).not.toContain('Claude Code')
    expect(await readdir(machine.workspace)).toEqual(['.agents'])
    expect(await readFile(skillFile(machine, 'codex'), 'utf8')).toMatch(/^---\nname: spicytrade\n/)
  }, 30_000)

  it('is written nowhere when no agent is installed, and connect says so', async () => {
    const machine = await fakeMachine(CONNECTED)
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['connect'])
    expect(await cli.exited).toBe(0)
    expect(cli.output().stdout.endsWith(`Verifying live account access…\n${NO_AGENT_TO_TELL}`)).toBe(true)
    expect(await absent(machine.workspace)).toBe(true)
  }, 30_000)

  it('is updated when it is the CLI\'s own from an earlier version', async () => {
    const machine = await fakeMachine(CONNECTED, ['claude', 'codex'])
    const worker = await fakeWorker([OLD_TOKEN])
    expect(await run(machine, worker.port, ['connect']).exited).toBe(0)
    const current = await readFile(skillFile(machine, 'claude'), 'utf8')
    // Still marked as the CLI's own, but not what this version writes.
    await writeFile(skillFile(machine, 'claude'), `${current}\nA line an earlier version wrote.\n`)

    const doctor = run(machine, worker.port, ['doctor'])
    expect(await doctor.exited).toBe(0)
    expect(doctor.output().stdout).toBe('✓ signed in to spicytrade\n'
      + '✓ tastytrade is connected\n'
      + '· Claude Code has an older spicytrade skill in ~/workspace\n'
      + `    Update it by running this in that folder: ${SPICYTRADE} connect\n`
      + '✓ Codex has the spicytrade skill in ~/workspace\n'
      + '\nEverything else is working.\n')

    const setup = run(machine, worker.port, ['setup'])
    expect(await setup.exited).toBe(0)
    expect(setup.output().stdout).toContain('\n== Agents\n'
      + '✓ Claude Code: updated the spicytrade skill in ~/workspace\n'
      + '✓ Codex already has the spicytrade skill in ~/workspace; skipped\n')
    expect(await readFile(skillFile(machine, 'claude'), 'utf8')).toBe(current)

    // `connect` updates it the same way.
    await writeFile(skillFile(machine, 'codex'), `${current}\nA line an earlier version wrote.\n`)
    const connect = run(machine, worker.port, ['connect'])
    expect(await connect.exited).toBe(0)
    expect(connect.output().stdout).toContain('✓ Claude Code already has the spicytrade skill in ~/workspace; skipped\n'
      + '✓ Codex: updated the spicytrade skill in ~/workspace\n')
    expect(await readFile(skillFile(machine, 'codex'), 'utf8')).toBe(current)
  }, 60_000)

  it('leaves a skill of the same name that someone else wrote, and every command says so', async () => {
    const machine = await fakeMachine(CONNECTED, ['claude', 'codex'])
    await writeForeignSkill(machine, 'claude')
    const worker = await fakeWorker([OLD_TOKEN])

    const setup = run(machine, worker.port, ['setup'])
    expect(await setup.exited).toBe(0)
    const setupOut = setup.output().stdout
    expect(setupOut).toContain('\n== Agents\n'
      + '! Claude Code has a different skill named "spicytrade" in ~/workspace; left as it is\n'
      + '✓ Codex: added the spicytrade skill in ~/workspace\n')
    // The agent that did get the skill can go on.
    expect(setupOut.endsWith(`\nAccount connected. Continue in your agent:\n${ASK_YOUR_AGENT}`)).toBe(true)

    const connect = run(machine, worker.port, ['connect'])
    expect(await connect.exited).toBe(0)
    expect(connect.output().stdout).toContain('! Claude Code has a different skill named "spicytrade" in ~/workspace; left as it is\n'
      + '✓ Codex already has the spicytrade skill in ~/workspace; skipped\n'
      + AGENTS_CAN_USE_IT)

    const doctor = run(machine, worker.port, ['doctor'])
    expect(await doctor.exited).toBe(0)
    expect(doctor.output().stdout).toBe('✓ signed in to spicytrade\n'
      + '✓ tastytrade is connected\n'
      + '· Claude Code has a different skill named "spicytrade" in ~/workspace\n'
      + '    Rename or remove it if agents started in this folder should learn about spicytrade.\n'
      + '✓ Codex has the spicytrade skill in ~/workspace\n'
      + '\nEverything else is working.\n')

    expect(await readFile(skillFile(machine, 'claude'), 'utf8')).toBe(FOREIGN_SKILL)
    expect(await readFile(skillFile(machine, 'codex'), 'utf8')).toMatch(/^---\nname: spicytrade\n/)
  }, 60_000)

  it('leaves it as it is when it belongs to the only agent installed, without failing the run', async () => {
    const machine = await fakeMachine(CONNECTED, ['claude'])
    await writeForeignSkill(machine, 'claude')
    const worker = await fakeWorker([OLD_TOKEN])
    for (const command of ['setup', 'connect']) {
      const cli = run(machine, worker.port, [command])
      expect(await cli.exited).toBe(0)
      expect(cli.output().stdout).toContain('! Claude Code has a different skill named "spicytrade" in ~/workspace; left as it is\n')
      expect(cli.output().stdout).not.toMatch(/(added|updated) the spicytrade skill/)
    }
    expect(await readFile(skillFile(machine, 'claude'), 'utf8')).toBe(FOREIGN_SKILL)
    expect(await readdir(dirname(skillFile(machine, 'claude')))).toEqual(['SKILL.md'])
  }, 60_000)

  // An agent whose own skill was left alone is installed all the same.
  it('does not say no agent was found when the one installed has a skill of its own under that name', async () => {
    const machine = await fakeMachine(CONNECTED, ['claude'])
    await writeForeignSkill(machine, 'claude')
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['connect'])
    await cli.exited
    expect(cli.output().stdout).not.toContain('No Claude Code or Codex was found on this computer')
  }, 30_000)

  it('belongs to the folder the command is run from', async () => {
    const machine = await fakeMachine(CONNECTED, ['claude'])
    await mkdir(machine.workspace)
    const worker = await fakeWorker([OLD_TOKEN])
    // No override: the folder the command runs in is the workspace, as from an agent's own shell.
    const here = { cwd: machine.workspace, env: { SPICYTRADE_WORKSPACE: undefined } }

    const before = run(machine, worker.port, ['doctor'], here)
    expect(await before.exited).toBe(0)
    expect(before.output().stdout).toContain('· Claude Code has no spicytrade skill in ~/workspace, so an agent started here is not told about it\n'
      + `    Add it by running this in that folder: ${SPICYTRADE} connect\n`)

    const connect = run(machine, worker.port, ['connect'], here)
    expect(await connect.exited).toBe(0)
    expect(connect.output().stdout).toContain(`✓ Claude Code: added the spicytrade skill in ~/workspace\n${AGENTS_CAN_USE_IT}`)
    expect(await readFile(skillFile(machine, 'claude'), 'utf8')).toMatch(/^---\nname: spicytrade\n/)

    const after = run(machine, worker.port, ['doctor'], here)
    expect(await after.exited).toBe(0)
    expect(after.output().stdout).toContain('✓ Claude Code has the spicytrade skill in ~/workspace\n')

    // From another folder the skill is not there: the same check notes it, naming that folder.
    const elsewhere = join(machine.home, 'elsewhere')
    await mkdir(elsewhere)
    const other = run(machine, worker.port, ['doctor'], { ...here, cwd: elsewhere })
    expect(await other.exited).toBe(0)
    expect(other.output().stdout).toContain('· Claude Code has no spicytrade skill in ~/elsewhere, so an agent started here is not told about it\n')
    expect(await readdir(elsewhere)).toEqual([])
  }, 60_000)

  it('is written into, found in and removed from a workspace whose path has spaces', async () => {
    const machine = await fakeMachine(CONNECTED, ['claude', 'codex'])
    const spaced = join(machine.home, 'My Trades')
    const env = { SPICYTRADE_WORKSPACE: spaced }
    const worker = await fakeWorker([OLD_TOKEN])

    const connect = run(machine, worker.port, ['connect'], { env })
    expect(await connect.exited).toBe(0)
    expect(connect.output().stdout).toContain('✓ Claude Code: added the spicytrade skill in ~/My Trades\n'
      + '✓ Codex: added the spicytrade skill in ~/My Trades\n'
      + connected('Agents started in ~/My Trades can use it now'))
    expect(await readFile(skillFile(machine, 'claude', spaced), 'utf8')).toMatch(/^---\nname: spicytrade\n/)
    expect(await readFile(skillFile(machine, 'codex', spaced), 'utf8')).toMatch(/^---\nname: spicytrade\n/)
    expect(await readdir(machine.home)).toEqual(['My Trades'])

    const doctor = run(machine, worker.port, ['doctor'], { env })
    expect(await doctor.exited).toBe(0)
    expect(doctor.output().stdout).toContain('✓ Claude Code has the spicytrade skill in ~/My Trades\n'
      + '✓ Codex has the spicytrade skill in ~/My Trades\n'
      + '\nEverything is connected.\n')

    const uninstall = run(machine, worker.port, ['uninstall'], { env })
    expect(await uninstall.exited).toBe(0)
    expect(uninstall.output().stdout).toContain('✓ Claude Code: removed the spicytrade skill from ~/My Trades\n'
      + '✓ Codex: removed the spicytrade skill from ~/My Trades\n')
    expect(await absent(dirname(skillFile(machine, 'claude', spaced)))).toBe(true)
    expect(await absent(dirname(skillFile(machine, 'codex', spaced)))).toBe(true)
  }, 60_000)

  it('is installed, checked and removed without ever running an agent', async () => {
    const machine = await fakeMachine({}, ['claude', 'codex'])
    const worker = await fakeWorker([])
    for (const command of ['setup', 'connect', 'doctor', 'disconnect-tastytrade', 'uninstall']) {
      expect(await run(machine, worker.port, [command]).exited).toBe(0)
      expect(await readdir(machine.state)).not.toContain(AGENT_RUNS)
    }
    // The fakes do record a run, so the check above -- made after every test in this file -- could fail.
    expect(spawnSync(join(machine.bin, 'claude'), ['--version'], { env: { PATH: TEST_PATH(machine.bin) } }).status).toBe(0)
    expect(await readFile(join(machine.state, AGENT_RUNS), 'utf8')).toBe('claude --version\n')
    await rm(join(machine.state, AGENT_RUNS))
  }, 120_000)
})

describe('spicytrade setup', () => {
  it('does every step once, and on a second run skips each one', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN }, ['claude'])
    const worker = await fakeWorker([OLD_TOKEN])

    const first = run(machine, worker.port, ['setup'])
    expect(await first.exited).toBe(0)
    const firstOut = first.output().stdout
    expect(firstOut).toContain('\n== Sign in\n✓ already signed in; skipped\n')
    // Only the workspace setup ran for gets the skill, and the line says which folder that is.
    // Agents come before tastytrade, so walking away from tastytrade still leaves a working agent.
    // No terminal to ask on, so trading authority is not granted; the closing block says how.
    // The closing check repeats none of what the steps just said, so with nothing wrong it has no
    // heading at all; tastytrade was not connected, so ready means market data and research.
    expect(firstOut.endsWith('\n== Agents\n✓ Claude Code: added the spicytrade skill in ~/workspace\n'
      + '\n== tastytrade\n· not connected: there is no terminal to ask on\n'
      + `\nReady for market data and research. Continue in your agent:\n${ASK_YOUR_AGENT}`
      + `To see positions and place orders, connect tastytrade: ${SPICYTRADE} connect\n`)).toBe(true)
    expect(firstOut).not.toContain('== Check')
    expect(firstOut).not.toContain('✓ signed in to spicytrade')
    expect(firstOut).not.toContain('Everything is connected.')

    const skill = await readFile(skillFile(machine, 'claude'), 'utf8')
    expect(skill).toMatch(/^---\nname: spicytrade\ndescription: \S.*\n---\n/)
    // Codex is not installed, so nothing is written where it would look.
    expect(await readdir(machine.workspace)).toEqual(['.claude'])
    // Setup verifies no snapshot and calls no tool: it only asks whether the sign-in is accepted.
    expect(toolCalls(worker.calls)).toEqual([])

    const written = await stat(skillFile(machine, 'claude'))
    const second = run(machine, worker.port, ['setup'])
    expect(await second.exited).toBe(0)
    const secondOut = second.output().stdout
    expect(secondOut).toContain('✓ already signed in; skipped')
    expect(secondOut).toContain('\n== Agents\n✓ Claude Code already has the spicytrade skill in ~/workspace; skipped\n')
    expect((await stat(skillFile(machine, 'claude'))).mtimeMs).toBe(written.mtimeMs)
    expect(await readFile(skillFile(machine, 'claude'), 'utf8')).toBe(skill)
    for (const output of [first.output(), second.output()]) {
      expect(output.stdout).not.toContain(OLD_TOKEN)
      expect(output.stderr).not.toContain(OLD_TOKEN)
    }
  }, 60_000)

  it('signs a fresh computer in and connects tastytrade on one link, asking nothing', async () => {
    const machine = await fakeMachine({}, ['claude'])
    const worker = await fakeWorker([], { exchange: () => ({ body: { token: NEW_TOKEN }, status: 200 }) })
    // No terminal: the member's answer is the approval itself, on the page and on tastytrade.
    const cli = run(machine, worker.port, ['setup'])
    expect(await cli.exited).toBe(0)
    const { stdout } = cli.output()
    expect((await approvalUrl(cli.output)).searchParams.get('broker')).toBe('tastytrade')
    expect(stdout.match(/\/connect\/agent\?/g)).toHaveLength(1)
    expect(stdout.indexOf('✓ Signed in.')).toBeLessThan(stdout.indexOf('== Agents'))
    expect(stdout).toContain('\n== Agents\n✓ Claude Code: added the spicytrade skill in ~/workspace\n')
    expect(stdout).toMatch(/== tastytrade\nWaiting for tastytrade\. To skip for now, press Ctrl-C\.\n✓ tastytrade connected\.\n/)
    expect(stdout.endsWith(`\nAccount connected. Continue in your agent:\n${ASK_YOUR_AGENT}`)).toBe(true)
    expect(stdout).not.toContain('[Y/n]')
    expect(worker.calls.filter((call) => call.path === '/api/agent-logins/exchange')).toHaveLength(1)
    expect(await readFile(join(machine.bin, 'store', 'tastytrade_app-refresh-token'), 'utf8')).toBe(APP_REFRESH_TOKEN)
  }, 60_000)

  it('says what to install when no agent is on the machine, without calling the run a failure', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN })
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['setup'])
    // Everything setup can do is done; the member was told at the start this would be the case.
    expect(await cli.exited).toBe(0)
    const { stdout } = cli.output()
    expect(stdout).toContain('· No Claude Code or Codex found; signing in anyway.\n')
    expect(stdout.endsWith(`\nSigned in. Install Claude Code or Codex, then run: ${SPICYTRADE} setup\n`)).toBe(true)
    expect(stdout).not.toContain('✗')
    // Steps with nothing to say leave no bare heading behind.
    expect(stdout).not.toContain('== Agents')
    expect(stdout).not.toContain('== Check')
    // With no agent there is nobody to continue in, and no skill to write for one.
    expect(stdout).not.toContain('Continue in your agent')
    expect(stdout).not.toContain('Ready')
    expect(await absent(machine.workspace)).toBe(true)
  }, 60_000)
})

/** A Worker that accepts any sign-in, and whose tastytrade refuses the saved connection. */
function refusingWorker() {
  return serve((request) => {
    if (request.url === '/api/brokers/tastytrade/token') return { body: { error: 'refused', tastytradeStatus: 401 }, status: 502 }
    return { body: { id: 1, jsonrpc: '2.0', result: {} }, status: 200 }
  })
}

describe('spicytrade setup and a saved tastytrade connection', () => {
  it('finds a connection tastytrade has since refused, rather than calling it connected', async () => {
    const machine = await fakeMachine(CONNECTED)
    const cli = run(machine, await refusingWorker(), ['setup'])
    expect(await cli.exited).toBe(1)
    const { stdout } = cli.output()
    expect(stdout).not.toContain('already connected')
    // No terminal to ask on, so it does not ask; the closing check reports it once, with its fix.
    expect(stdout).toContain('· tastytrade refused the saved connection; see the check below')
    expect(stdout).toContain(`\n== Check\n✗ tastytrade refused the saved connection (HTTP 401)\n    Reconnect with: ${SPICYTRADE} setup\n\n1 problem found.\n`)
    expect(stdout.match(/✗ tastytrade/g)).toHaveLength(1)
  }, 60_000)
})

describe('setup with a problem left over', () => {
  it('still says how to go on in the agent it wrote the skill for, without calling the run ready', async () => {
    const machine = await fakeMachine(CONNECTED, ['claude'])
    const cli = run(machine, await refusingWorker(), ['setup'])
    expect(await cli.exited).toBe(1)
    const { stdout } = cli.output()
    expect(stdout).toContain('✓ Claude Code: added the spicytrade skill in ~/workspace\n')
    expect(stdout.endsWith(`\n1 problem found.\n\nContinue in your agent:\n${ASK_YOUR_AGENT}`)).toBe(true)
    expect(stdout).not.toContain('Ready')
    expect(stdout).not.toContain('Account connected')
  }, 60_000)
})

describe('a keyring that answers lookups but cannot save', () => {
  it('stops before any browser step, saying why, with nothing issued', async () => {
    const machine = await fakeMachine({}, ['claude'])
    // Lookups answer "nothing stored"; every store is refused, as with no unlocked collection.
    await writeFile(join(machine.bin, 'secret-tool'), '#!/usr/bin/env bash\n[[ $1 == store ]] && { cat >/dev/null; exit 1; }\n[[ $1 == lookup ]] && exit 1\nexit 0\n')
    const worker = await fakeWorker([])
    const setup = run(machine, worker.port, ['setup'])
    expect(await setup.exited).toBe(1)
    expect(setup.output().stderr).toMatch(/spicytrade setup: your system keyring cannot save credentials here\. If you have one, unlock it\. If not, install one \(Debian\/Ubuntu: sudo apt install gnome-keyring;.* Over SSH, this computer's desktop session must also be logged in\. Then run: \S+ setup$/m)
    expect(setup.output().stdout).not.toContain('/connect/agent')

    const connect = run(machine, worker.port, ['connect'])
    expect(await connect.exited).toBe(1)
    expect(connect.output().stderr).toBe('spicytrade connect: Password storage is unavailable. Connect from a signed-in desktop session with a working system keyring.\n')
    expect(connect.output().stdout).not.toContain('/connect/agent')

    expect(worker.calls).toEqual([])
    // Nothing was connected, so no agent is told anything.
    expect(await absent(machine.workspace)).toBe(true)
  }, 30_000)
})

describe('a saved tastytrade connection that cannot trade', () => {
  it.each([
    ['half a personal grant', { 'tastytrade/client-secret': 'half-a-grant' }, 'an incomplete tastytrade connection is saved', 'Replace it'],
    [
      'two connections',
      { 'tastytrade/app-refresh-token': APP_REFRESH_TOKEN, 'tastytrade/client-secret': 'half-a-grant' },
      'two tastytrade connections are saved, so spicytrade will not guess which account trades',
      'Replace them',
    ],
  ])('is reported with its one repair when it is %s, by doctor, setup and connect, never as a crash', async (_what, saved, problem, fix) => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN, ...saved }, ['claude'])
    const worker = await fakeWorker([OLD_TOKEN])
    for (const command of ['doctor', 'setup']) {
      const cli = run(machine, worker.port, [command])
      expect(await cli.exited).toBe(1)
      const { stderr, stdout } = cli.output()
      expect(stdout).toContain(`✗ ${problem}\n    ${fix} with: ${SPICYTRADE} setup\n`)
      expect(stderr).toBe('')
      expect(stdout).not.toContain('half-a-grant')
    }
    // `connect` asks nothing, so it does not choose for the member: it sends them to setup.
    const connect = run(machine, worker.port, ['connect'])
    expect(await connect.exited).toBe(1)
    expect(connect.output().stderr).toBe(`spicytrade connect: The saved tastytrade connection needs repair. Run ${SPICYTRADE} setup in a terminal to choose whether to replace it.\n`)
    expect(connect.output().stdout).not.toContain('/connect/agent')
    expect(connect.output().stdout).not.toContain('Account connected')
    // Neither was minted from, and no tool was called with it.
    expect(worker.calls.some((call) => call.path === '/api/brokers/tastytrade/token')).toBe(false)
    expect(toolCalls(worker.calls)).toEqual([])
  }, 60_000)
})

describe('spicytrade disconnect-tastytrade', () => {
  it('removes every tastytrade credential of either kind, and nothing else', async () => {
    const machine = await fakeMachine({
      ...CONNECTED,
      'tastytrade/access-token': 'a-cached-access-token',
      'tastytrade/client-secret': 'personal-client-secret',
    }, ['claude'])
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['disconnect-tastytrade'])
    expect(await cli.exited).toBe(0)
    // One line, with nothing about reconnecting or restarting an agent: the next call reads the keyring.
    expect(cli.output().stdout).toBe('✓ tastytrade removed from this computer. Market and research tools still work.'
      + ' spicytrade kept no copy, so nothing can use that connection now; tastytrade may still list it in your'
      + ' account settings, where you can remove it.\n')
    // The short-lived access token an earlier call cached goes with the connection it came from.
    for (const key of ['access-token', 'app-refresh-token', 'client-secret', 'refresh-token']) {
      await expect(readFile(join(machine.bin, 'store', `tastytrade_${key}`), 'utf8')).rejects.toThrow()
    }
    expect(await readFile(join(machine.bin, 'store', 'spicytrade_mcp-token'), 'utf8')).toBe(OLD_TOKEN)
    expect(worker.calls).toEqual([])
  }, 30_000)

  it('removes the access token a call cached, so the next call cannot use the old connection', async () => {
    const machine = await fakeMachine(CONNECTED, ['claude'])
    const worker = await fakeWorker([OLD_TOKEN])
    expect(await run(machine, worker.port, ['connect']).exited).toBe(0)
    expect(await readFile(join(machine.bin, 'store', 'tastytrade_access-token'), 'utf8')).toContain(MINTED_ACCESS_TOKEN)

    expect(await run(machine, worker.port, ['disconnect-tastytrade']).exited).toBe(0)
    expect((await readdir(join(machine.bin, 'store'))).sort()).toEqual(['spicytrade_mcp-token'])
    // The skill stays: market and research tools still work from this folder.
    expect(await readFile(skillFile(machine, 'claude'), 'utf8')).toMatch(/^---\nname: spicytrade\n/)
  }, 60_000)

  it('says there was nothing to remove when nothing is connected', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN })
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['disconnect-tastytrade'])
    expect(await cli.exited).toBe(0)
    expect(cli.output().stdout).toBe('· tastytrade was not connected on this computer; nothing to remove.\n')
  }, 30_000)

  it('says the grant itself is ended on the member\'s own OAuth app, for a personal grant', async () => {
    const machine = await fakeMachine({
      'spicytrade/mcp-token': OLD_TOKEN,
      'tastytrade/client-secret': 'personal-client-secret',
      'tastytrade/refresh-token': 'personal-refresh-token',
    })
    const worker = await fakeWorker([OLD_TOKEN])
    const cli = run(machine, worker.port, ['disconnect-tastytrade'])
    expect(await cli.exited).toBe(0)
    expect(cli.output().stdout).toBe('✓ tastytrade removed from this computer. Market and research tools still work.'
      + ' To end the grant itself, delete it under OAuth Applications on my.tastytrade.com.\n')
  }, 30_000)
})

describe('spicytrade uninstall', () => {
  it('reports credentials left behind when the password-storage helper is missing', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN })
    await rm(join(machine.bin, 'secret-tool'))
    const worker = await fakeWorker([])
    const cli = run(machine, worker.port, ['uninstall'], { env: { PATH: machine.bin } })
    expect(await cli.exited).toBe(0)
    const { stdout } = cli.output()
    expect(stdout).toContain('could not remove this computer\'s spicytrade sign-in and tastytrade connection from password storage.')
    expect(stdout).toContain('secret-tool is missing. Install it')
    expect(stdout).toContain('      secret-tool clear service spicytrade key mcp-token\n')
    expect(stdout).toContain('      secret-tool clear service tastytrade key access-token\n')
    expect(stdout).not.toContain('✓ removed this computer\'s')
    expect(await readFile(join(machine.bin, 'store', 'spicytrade_mcp-token'), 'utf8')).toBe(OLD_TOKEN)
  }, 30_000)

  it('removes its own skill and its credentials, leaving a skill someone else wrote and a checkout alone', async () => {
    const machine = await fakeMachine(CONNECTED, ['claude', 'codex'])
    const worker = await fakeWorker([OLD_TOKEN])
    // Connected from this folder first, so the skill and the cached access token are the CLI's own.
    await writeForeignSkill(machine, 'codex')
    expect(await run(machine, worker.port, ['connect']).exited).toBe(0)
    expect((await readdir(join(machine.bin, 'store'))).sort()).toEqual(['spicytrade_mcp-token', 'tastytrade_access-token', 'tastytrade_app-refresh-token'])

    const cli = run(machine, worker.port, ['uninstall'])
    expect(await cli.exited).toBe(0)
    // Run from a checkout, the program is not touched, so nothing says it was removed.
    expect(cli.output().stdout).toBe('✓ Claude Code: removed the spicytrade skill from ~/workspace\n'
      + '✓ removed this computer\'s spicytrade sign-in and tastytrade connection from the keyring\n'
      + `\nspicytrade is removed from this computer and signed out of your account.\n${OTHER_FOLDERS}`)
    expect(await absent(dirname(skillFile(machine, 'claude')))).toBe(true)
    expect(await readFile(skillFile(machine, 'codex'), 'utf8')).toBe(FOREIGN_SKILL)
    expect(await readdir(join(machine.bin, 'store'))).toEqual([])
    expect(await readFile(CLI, 'utf8')).toContain('spicytrade')
    // It signed itself out with its own token, before clearing it.
    expect(worker.calls.some((call) => call.path === '/api/agent-logins' && call.method === 'DELETE'
      && call.headers.authorization === `Bearer ${OLD_TOKEN}`)).toBe(true)
  }, 60_000)

  it('removes its own skill for an agent that has since been uninstalled, and an outdated one', async () => {
    const machine = await fakeMachine(CONNECTED, ['claude', 'codex'])
    const worker = await fakeWorker([OLD_TOKEN])
    expect(await run(machine, worker.port, ['connect']).exited).toBe(0)
    await rm(join(machine.bin, 'claude'))
    await writeFile(skillFile(machine, 'codex'), `${await readFile(skillFile(machine, 'codex'), 'utf8')}\nA line an earlier version wrote.\n`)

    const cli = run(machine, worker.port, ['uninstall'])
    expect(await cli.exited).toBe(0)
    expect(cli.output().stdout).toContain('✓ Claude Code: removed the spicytrade skill from ~/workspace\n'
      + '✓ Codex: removed the spicytrade skill from ~/workspace\n')
    expect(await absent(dirname(skillFile(machine, 'claude')))).toBe(true)
    expect(await absent(dirname(skillFile(machine, 'codex')))).toBe(true)
  }, 60_000)

  it('counts a computer the website already revoked as signed out, rather than sending the member back to revoke it', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN })
    const worker = await fakeWorker([])
    const cli = run(machine, worker.port, ['uninstall'])
    expect(await cli.exited).toBe(0)
    // Nothing of tastytrade's was saved, so nothing of it is said to be removed; no skill was in
    // this folder, so none is said to be removed either.
    expect(cli.output().stdout).toBe('✓ removed this computer\'s spicytrade sign-in from the keyring\n'
      + `\nspicytrade is removed from this computer and signed out of your account.\n${OTHER_FOLDERS}`)
  }, 30_000)

  it('says where to sign the computer out when spicytrade did not answer', async () => {
    const machine = await fakeMachine({ 'spicytrade/mcp-token': OLD_TOKEN })
    const port = await serve(() => ({ body: { error: 'unavailable' }, status: 503 }))
    const cli = run(machine, port, ['uninstall'])
    expect(await cli.exited).toBe(0)
    expect(cli.output().stdout).toBe('✓ removed this computer\'s spicytrade sign-in from the keyring\n'
      + '\nspicytrade is removed from this computer. To sign it out of your account too, revoke it under'
      + ` Signed-in computers at http://127.0.0.1:${port}/connect.\n${OTHER_FOLDERS}`)
  }, 30_000)

  it('removes the program and its link when it is the installed copy', async () => {
    const machine = await fakeMachine({}, ['claude'])
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
    const cli = run(machine, worker.port, ['uninstall'], { env: { XDG_DATA_HOME: undefined }, script: join(share, 'spicytrade.mjs') })
    expect(await cli.exited).toBe(0)
    expect(cli.output().stdout).toContain('✓ removed the spicytrade program\n')
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

describe('connecting from the current agent without a terminal', () => {
  it('signs in and connects the brokerage on one link, then verifies a live snapshot', async () => {
    const machine = await fakeMachine({})
    // The browser comes back from tastytrade between the first poll for the grant and the second.
    let grantPolls = 0
    const worker = await fakeWorker([], {
      exchange: () => ({ body: { token: NEW_TOKEN }, status: 200 }),
      grant: () => (grantPolls++ === 0 ? { body: { pending: true }, status: 202 } : { body: { refreshToken: APP_REFRESH_TOKEN }, status: 200 }),
    })
    const cli = run(machine, worker.port, ['connect'])
    const approval = await approvalUrl(cli.output)
    expect(approval.searchParams.get('broker')).toBe('tastytrade')
    expect(await cli.exited).toBe(0)
    // No agent is installed here, so there is none to tell; the connection itself is complete.
    expect(cli.output().stdout.endsWith(`✓ tastytrade connected.\nVerifying live account access…\n${NO_AGENT_TO_TELL}`)).toBe(true)
    // One link: the member is never sent a second address.
    expect(cli.output().stdout.match(/https?:\/\//g)).toHaveLength(1)
    const grants = worker.calls.filter((call) => call.path === '/api/brokers/tastytrade/exchange')
    expect(grants).toHaveLength(2)
    const signIn = ExchangeBodySchema.parse(JSON.parse(worker.calls.find((call) => call.path === '/api/agent-logins/exchange')!.body))
    for (const grant of grants) {
      // The grant is collected by the token the sign-in issued and the verifier behind the link.
      expect(grant.headers.authorization).toBe(`Bearer ${NEW_TOKEN}`)
      expect(JSON.parse(grant.body)).toEqual({ codeVerifier: signIn.codeVerifier })
    }
    expect(createHash('sha256').update(signIn.codeVerifier).digest('base64url')).toBe(approval.searchParams.get('challenge'))
    // The snapshot is the last thing asked of the Worker, by the new sign-in and a minted token.
    expect(toolCalls(worker.calls)).toEqual([{ brokerToken: MINTED_ACCESS_TOKEN, name: 'read_account_snapshot' }])
    expect(worker.calls.at(-1)?.headers.authorization).toBe(`Bearer ${NEW_TOKEN}`)
    for (const secret of [NEW_TOKEN, APP_REFRESH_TOKEN, MINTED_ACCESS_TOKEN, signIn.codeVerifier]) expect(JSON.stringify(cli.output())).not.toContain(secret)
    expect(await readFile(join(machine.bin, 'store', 'tastytrade_app-refresh-token'), 'utf8')).toBe(APP_REFRESH_TOKEN)
    expect(await absent(machine.workspace)).toBe(true)
  }, 30_000)

  it.each([
    ['the account tool refuses', { content: [{ text: 'tastytrade refused this request.', type: 'text' }], isError: true }],
    ['the answer is not JSON', { content: [{ text: 'not a snapshot', type: 'text' }] }],
    [
      'the snapshot is not tastytrade\'s',
      { content: [{ text: JSON.stringify({ asOf: '2026-09-28T00:00:00Z', balances: { netLiquidatingValue: 1 }, source: 'elsewhere' }), type: 'text' }] },
    ],
  ] satisfies [string, ToolResult][])('does not report a connection ready, or tell any agent, when %s', async (_what, answer) => {
    const machine = await fakeMachine(CONNECTED, ['claude', 'codex'])
    const worker = await fakeWorker([OLD_TOKEN], { snapshot: () => answer })
    const cli = run(machine, worker.port, ['connect'])
    expect(await cli.exited).toBe(1)
    expect(cli.output().stdout.endsWith('Verifying live account access…\n')).toBe(true)
    expect(cli.output().stdout).not.toContain('Account connected')
    expect(cli.output().stderr).toBe(`spicytrade connect: the account snapshot could not be verified. Check the connection with: ${SPICYTRADE} doctor\n`)
    expect(toolCalls(worker.calls)).toHaveLength(1)
    // The skill is what tells an agent the account is there, so it is not written for one that is not.
    expect(await absent(machine.workspace)).toBe(true)
  }, 30_000)
})


describe('connector-only installation', () => {
  it('installs without running setup, choosing an agent, or changing harness configuration', async () => {
    const machine = await fakeMachine({}, ['claude', 'codex'])
    await writeFile(join(machine.bin, 'curl'), `#!/usr/bin/env bash
while (( $# )); do
  if [[ $1 == -o ]]; then
    printf '%s\\n' '#!/usr/bin/env node' 'throw new Error("Installer must not run setup")' > "$2"
    exit 0
  fi
  shift
done
exit 1
`)
    await chmod(join(machine.bin, 'curl'), 0o755)
    const child = spawn('bash', ['public/install.sh', '--connector-only'], {
      env: { ...process.env, HOME: machine.home, XDG_DATA_HOME: join(machine.home, '.local', 'share'), PATH: TEST_PATH(machine.bin) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    expect(await new Promise(resolve => child.once('exit', resolve))).toBe(0)
    expect(output).toContain('Connector ready. Your current agent can run:')
    expect(await readFile(join(machine.home, '.local', 'share', 'spicytrade', 'spicytrade.mjs'), 'utf8')).toContain('Installer must not run setup')
    // Neither agent on the machine was run, and nothing but the program was put in the home directory.
    expect(await readdir(machine.state)).toEqual([])
    expect(await readdir(machine.home)).toEqual(['.local'])
  })
})
