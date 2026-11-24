import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { tokenRetiresAt, UPSTREAM_TIMEOUT_MS } from '../ops/spicytrade/token-refresh.mjs'
import { fakeSecretTool } from './fake-secret-tool.ts'
import { closeLoopback, listenLoopback } from './loopback.ts'

/*
 * `spicytrade call`, `spicytrade tools` and `spicytrade guide` end to end: the real CLI entry,
 * spawned once per command the way an agent runs it from its shell, against a stand-in Worker,
 * with a file-backed `secret-tool` first on PATH and a throwaway HOME and workspace. The
 * environment each run gets is built here from nothing, so no run reaches the real keyring, the
 * real home, or a live endpoint.
 */

const REFRESH_TOKEN = 'refresh-token-that-must-never-leave-this-machine'
const OTHER_REFRESH_TOKEN = 'refresh-token-of-the-connection-this-one-replaced'
const CLIENT_SECRET = 'client-secret-that-must-never-leave-this-machine'
const AGENT_TOKEN = 'spice_0123456789abcdef_AAAAAAAAAAAAAAAAAAAA'
const MINTED = 'minted-15-minute-access-token'
/** An access token an earlier run left in the keyring. */
const CACHED = 'cached-access-token-from-an-earlier-call'
/** Everything that must never be printed, checked against the output of every run in this file. */
const SECRETS = [AGENT_TOKEN, REFRESH_TOKEN, OTHER_REFRESH_TOKEN, CLIENT_SECRET, MINTED, CACHED]

/** tastytrade's access-token lifetime, as its token endpoint states it. */
const TOKEN_LIFETIME_SECONDS = 900
const MS_PER_SECOND = 1_000
const MINUTE_MS = 60_000
/** Long enough for the CLI to have read the response headers before the connection is dropped. */
const DROP_AFTER_MS = 50
/** Each test spawns the CLI, which spawns `secret-tool`, several times over. */
const TEST_TIMEOUT_MS = 30_000

const CLI = realpathSync(resolve('ops/spicytrade/spicytrade.mjs'))
/**
 * How the CLI names itself in a fix. Nothing on a run's PATH or in its HOME links to it, so that
 * is the entry script by its absolute path (`cliCommand` in `ops/spicytrade/config.mjs`).
 */
const fix = (subcommand: string) => `${CLI} ${subcommand}`

const MARKET_TOOL = 'read_price_history'
const ACCOUNT_TOOL = 'read_account_snapshot'
const ORDER_TOOL = 'place_brokerage_order'
/** Changes something, but is not a brokerage tool. */
const SAVING_TOOL = 'save_favorite'
/** Declares no annotations at all, so nothing says it is safe to repeat. */
const UNDECLARED_TOOL = 'legacy_tool'
const NEEDS_BROKERAGE = new Set([ACCOUNT_TOOL, ORDER_TOOL])

const MARKET_SCHEMA = { properties: { symbol: { type: 'string' } }, required: ['symbol'], type: 'object' }
const TOOLS = [
  {
    annotations: { readOnlyHint: true },
    description: 'Daily candles for one symbol. Adjusted for splits, never for dividends.',
    inputSchema: MARKET_SCHEMA,
    name: MARKET_TOOL,
  },
  { annotations: { readOnlyHint: true }, description: 'Balances, positions and working orders.', name: ACCOUNT_TOOL },
  { annotations: { readOnlyHint: false }, description: 'Place one defined-risk order. Runs every guard first.', name: ORDER_TOOL },
  { annotations: { readOnlyHint: false }, description: 'Save a symbol to favorites', name: SAVING_TOOL },
  { description: 'An older tool.', name: UNDECLARED_TOOL },
]
const INSTRUCTIONS = 'spicytrade answers options questions. Read spicytrade://guide before the first call.'
const GUIDE = '# spicytrade guide\n\nAsk for a chain before you ask for Greeks.'
const GUIDE_URI = 'spicytrade://guide'

/** How the Worker begins its answer to an account tool called with no broker token. */
const NO_BROKERAGE_TEXT = 'No brokerage is connected. Account access needs the spicytrade connector on the user\'s own computer.'
const NOT_CONNECTED = `tastytrade is not connected on this computer. Connect it with: ${fix('connect')}\n`
const SIGNED_OUT = `this computer was signed out of spicytrade (revoked under Signed-in computers). Sign in again with: ${fix('connect')}\n`
const NETWORK_FIX = `Check the network and try again; if it keeps failing, run: ${fix('doctor')}\n`
const MAYBE_ORDERED = 'spicytrade call: spicytrade did not finish answering, so this order may already have been placed, replaced or'
  + ` cancelled. Check working orders and positions with \`${fix('call read_account_snapshot')}\` before trying again.\n`
const MAYBE_DONE = 'spicytrade call: spicytrade did not finish answering, so this request may or may not have gone through. Check'
  + ' whether it took effect before trying again.\n'
const MAY_HAVE_HAPPENED = /may or may not have gone through|may already have been/

const McpCallSchema = z.object({
  id: z.number(),
  jsonrpc: z.literal('2.0'),
  method: z.string(),
  params: z.looseObject({
    arguments: z.record(z.string(), z.json()).optional(),
    name: z.string().optional(),
    uri: z.string().optional(),
  }),
})
type McpCall = z.infer<typeof McpCallSchema>

type Captured = { body: string; headers: IncomingMessage['headers']; path: string }
type MintAnswer = (request: IncomingMessage, response: ServerResponse) => void
type McpAnswer = (call: McpCall, request: IncomingMessage, response: ServerResponse) => void
/** What a test changes about the stand-in Worker; whatever it leaves out answers as the real one does. */
type Behaviour = { mcp?: McpAnswer; mint?: MintAnswer; toolCall?: McpAnswer; toolList?: McpAnswer }

const servers: Server[] = []
const children: ChildProcess[] = []
/** Fake keyrings hold the test's secrets in files, and each run has its own home; none may outlive the test. */
const directories: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  await Promise.all(servers.splice(0).map(closeLoopback))
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

function send(response: ServerResponse, status: number, body: string, contentType = 'application/json') {
  response.writeHead(status, { 'content-type': contentType })
  response.end(body)
}

const toolResult = (id: number, text: string) => JSON.stringify({ id, jsonrpc: '2.0', result: { content: [{ text, type: 'text' }] } })
const toolError = (id: number, text: string) => JSON.stringify({
  id, jsonrpc: '2.0', result: { content: [{ text, type: 'text' }], isError: true },
})
const answered = (tool: string) => `${tool} answered`

/** Both mints succeed: the Worker's for an app grant, tastytrade's for a personal one. */
const mintsToken: MintAnswer = (request, response) => {
  send(response, 200, JSON.stringify(request.url === '/oauth/token'
    ? { access_token: MINTED, expires_in: TOKEN_LIFETIME_SECONDS }
    : { accessToken: MINTED, expiresIn: TOKEN_LIFETIME_SECONDS }))
}

/** A tool that needs a brokerage refuses a call carrying no broker token; every other call is answered. */
const answersToolCall: McpAnswer = (call, request, response) => {
  const name = call.params.name ?? ''
  send(response, 200, NEEDS_BROKERAGE.has(name) && request.headers['x-spicy-trade-broker-token'] === undefined
    ? toolError(call.id, NO_BROKERAGE_TEXT)
    : toolResult(call.id, answered(name)))
}

const listsTools: McpAnswer = (call, _, response) => {
  send(response, 200, JSON.stringify({ id: call.id, jsonrpc: '2.0', result: { tools: TOOLS } }))
}

/**
 * A stand-in Worker: `/mcp` answers each method as the real one does unless `behaviour` says
 * otherwise, and every other path is a token mint. Every request is recorded.
 */
async function worker(behaviour: Behaviour = {}) {
  const captured: Captured[] = []
  const { port, server } = await listenLoopback((request, body, response) => {
    const path = request.url ?? ''
    captured.push({ body, headers: request.headers, path })
    if (path !== '/mcp') return (behaviour.mint ?? mintsToken)(request, response)
    const call = McpCallSchema.parse(JSON.parse(body))
    if (behaviour.mcp) return behaviour.mcp(call, request, response)
    if (call.method === 'tools/call') return (behaviour.toolCall ?? answersToolCall)(call, request, response)
    if (call.method === 'tools/list') return (behaviour.toolList ?? listsTools)(call, request, response)
    if (call.method === 'initialize') {
      return send(response, 200, JSON.stringify({
        id: call.id, jsonrpc: '2.0', result: { capabilities: { tools: {} }, instructions: INSTRUCTIONS, protocolVersion: '2025-06-18' },
      }))
    }
    if (call.method === 'resources/read') {
      return send(response, 200, JSON.stringify({
        id: call.id, jsonrpc: '2.0', result: { contents: [{ mimeType: 'text/markdown', text: `${GUIDE}\n\n`, uri: call.params.uri }] },
      }))
    }
    return send(response, 200, JSON.stringify({ error: { code: -32601, message: 'Method not found' }, id: call.id, jsonrpc: '2.0' }))
  })
  servers.push(server)
  return {
    captured,
    /** The requests that reached `/mcp`, parsed. */
    mcp: () => captured.filter((entry) => entry.path === '/mcp')
      .map((entry) => ({ call: McpCallSchema.parse(JSON.parse(entry.body)), headers: entry.headers })),
    mints: () => captured.filter((entry) => entry.path !== '/mcp'),
    port,
    toolCalls: () => captured.filter((entry) => entry.path === '/mcp')
      .filter((entry) => McpCallSchema.parse(JSON.parse(entry.body)).method === 'tools/call'),
  }
}

/** The shared `secret-tool` stand-in, tracked so its directory is removed after the test. */
async function fakeKeyring(entries: Record<string, string>): Promise<string> {
  const directory = await fakeSecretTool(entries)
  directories.push(directory)
  return directory
}

/** A `secret-tool` that is nothing but `script`, for a keyring that fails rather than answers. */
async function scriptedKeyring(script: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'spicytrade-keyring-'))
  directories.push(directory)
  await writeFile(join(directory, 'secret-tool'), `#!/usr/bin/env bash\n${script}\n`)
  await chmod(join(directory, 'secret-tool'), 0o755)
  return directory
}

const SIGNED_IN = { 'spicytrade/mcp-token': AGENT_TOKEN }
const APP_GRANT = { ...SIGNED_IN, 'tastytrade/app-refresh-token': REFRESH_TOKEN }
const PERSONAL_GRANT = { ...SIGNED_IN, 'tastytrade/client-secret': CLIENT_SECRET, 'tastytrade/refresh-token': REFRESH_TOKEN }

/** How `brokerAccessToken` names the grant a cached token came from. */
const grantDigest = (refreshToken: string) => createHash('sha256').update(refreshToken).digest('base64url')
const CachedAccessSchema = z.strictObject({ grant: z.string(), retiresAt: z.number(), token: z.string() })
const accessTokenFile = (keyring: string) => join(keyring, 'store', 'tastytrade_access-token')
async function cachedAccess(keyring: string) {
  return CachedAccessSchema.parse(JSON.parse(await readFile(accessTokenFile(keyring), 'utf8')))
}
const cacheEntry = (refreshToken: string, retiresAt: number) => JSON.stringify({ grant: grantDigest(refreshToken), retiresAt, token: CACHED })

type Run = { status: number | null; stderr: string; stdout: string }

/**
 * One run of the CLI to its exit. Its whole environment is given here: a fresh home and workspace,
 * and a PATH holding the fake keyring, this test's node and the system directories (bash and the
 * coreutils the fake `secret-tool` is written in). No run may print a credential, so every one is
 * checked for all of them before its output is handed back.
 */
async function spicytrade(args: string[], keyring: string, port: number, stdin = ''): Promise<Run> {
  const sandbox = await mkdtemp(join(tmpdir(), 'spicytrade-call-'))
  directories.push(sandbox)
  await mkdir(join(sandbox, 'home'))
  await mkdir(join(sandbox, 'workspace'))
  const child = spawn(process.execPath, [CLI, ...args], {
    env: {
      HOME: join(sandbox, 'home'),
      PATH: `${keyring}:${dirname(process.execPath)}:/usr/bin:/bin`,
      SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      SPICYTRADE_WORKSPACE: join(sandbox, 'workspace'),
      TASTYTRADE_API_BASE: `http://127.0.0.1:${port}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  const run: Run = { status: null, stderr: '', stdout: '' }
  child.stdout.on('data', (chunk: Buffer) => { run.stdout += chunk.toString() })
  child.stderr.on('data', (chunk: Buffer) => { run.stderr += chunk.toString() })
  child.stdin.end(stdin)
  run.status = await new Promise<number | null>((done) => child.on('close', done))
  for (const secret of SECRETS) expect(run.stdout + run.stderr).not.toContain(secret)
  return run
}

/** A port nothing listens on: one that was listening and is closed again. */
async function closedPort(): Promise<number> {
  const { port, server } = await listenLoopback(() => {})
  await closeLoopback(server)
  return port
}

const progress = (step: number) => JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: step } })

describe('spicytrade call', () => {
  it('attaches a freshly minted broker token and the agent bearer, never the long-lived credential, and prints only the answer', async () => {
    const { mcp, mints, port } = await worker()
    const run = await spicytrade(['call', ACCOUNT_TOOL, '{"symbol":"SPY"}'], await fakeKeyring(PERSONAL_GRANT), port)
    expect(run).toEqual({ status: 0, stderr: '', stdout: `${answered(ACCOUNT_TOOL)}\n` })

    const sent = mcp()
    expect(sent).toHaveLength(1)
    expect(sent[0]!.call).toEqual({ id: 1, jsonrpc: '2.0', method: 'tools/call', params: { arguments: { symbol: 'SPY' }, name: ACCOUNT_TOOL } })
    expect(sent[0]!.headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`)
    expect(sent[0]!.headers['x-spicy-trade-broker']).toBe('tastytrade')
    expect(sent[0]!.headers['x-spicy-trade-broker-token']).toBe(MINTED)
    // The whole reason the mint happens on this computer: the permanent credential stays here.
    expect(JSON.stringify(sent)).not.toContain(REFRESH_TOKEN)
    expect(JSON.stringify(sent)).not.toContain(CLIENT_SECRET)

    // A personal grant is exchanged with tastytrade itself, and carries no spicytrade credential.
    expect(mints()).toHaveLength(1)
    expect(mints()[0]!.path).toBe('/oauth/token')
    expect(JSON.parse(mints()[0]!.body)).toEqual({ client_secret: CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: REFRESH_TOKEN })
    expect(mints()[0]!.headers.authorization).toBeUndefined()
  }, TEST_TIMEOUT_MS)

  it('mints an app grant through the Worker, and sends the Worker only the access token on the call', async () => {
    const { mcp, mints, port } = await worker()
    const run = await spicytrade(['call', ACCOUNT_TOOL], await fakeKeyring(APP_GRANT), port)
    expect(run).toEqual({ status: 0, stderr: '', stdout: `${answered(ACCOUNT_TOOL)}\n` })

    // Minted by the Worker, with the agent token and the refresh token and nothing else; an app
    // grant never goes to tastytrade directly, having no client secret to send.
    expect(mints().map((mint) => mint.path)).toEqual(['/api/brokers/tastytrade/token'])
    expect(mints()[0]!.headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`)
    expect(JSON.parse(mints()[0]!.body)).toEqual({ refreshToken: REFRESH_TOKEN })
    expect(mcp()).toHaveLength(1)
    expect(mcp()[0]!.headers['x-spicy-trade-broker-token']).toBe(MINTED)
    expect(JSON.stringify(mcp())).not.toContain(REFRESH_TOKEN)
  }, TEST_TIMEOUT_MS)

  it('keeps the minted token in the keyring, and a second call within its life does not mint again', async () => {
    const { mcp, mints, port } = await worker()
    const keyring = await fakeKeyring(APP_GRANT)
    const before = Date.now()
    expect((await spicytrade(['call', ACCOUNT_TOOL], keyring, port)).status).toBe(0)
    const after = Date.now()

    // Named by its grant's digest, never the grant, and retired a margin before it expires.
    const kept = await cachedAccess(keyring)
    expect(kept.token).toBe(MINTED)
    expect(kept.grant).toBe(grantDigest(REFRESH_TOKEN))
    expect(kept.retiresAt).toBeGreaterThanOrEqual(tokenRetiresAt(before, TOKEN_LIFETIME_SECONDS * MS_PER_SECOND))
    expect(kept.retiresAt).toBeLessThanOrEqual(tokenRetiresAt(after, TOKEN_LIFETIME_SECONDS * MS_PER_SECOND))

    expect((await spicytrade(['call', ACCOUNT_TOOL], keyring, port)).status).toBe(0)
    expect(mints()).toHaveLength(1)
    expect(mcp().map((sent) => sent.headers['x-spicy-trade-broker-token'])).toEqual([MINTED, MINTED])
  }, TEST_TIMEOUT_MS)

  it('uses a live cached token from the same grant without minting', async () => {
    const { mcp, mints, port } = await worker()
    const keyring = await fakeKeyring({ ...PERSONAL_GRANT, 'tastytrade/access-token': cacheEntry(REFRESH_TOKEN, Date.now() + MINUTE_MS) })
    expect((await spicytrade(['call', ACCOUNT_TOOL], keyring, port)).status).toBe(0)
    expect(mints()).toHaveLength(0)
    expect(mcp()[0]!.headers['x-spicy-trade-broker-token']).toBe(CACHED)
  }, TEST_TIMEOUT_MS)

  it('never answers a replaced connection with the token cached from the old one', async () => {
    const { mcp, mints, port } = await worker()
    const keyring = await fakeKeyring({ ...APP_GRANT, 'tastytrade/access-token': cacheEntry(OTHER_REFRESH_TOKEN, Date.now() + MINUTE_MS) })
    expect((await spicytrade(['call', ACCOUNT_TOOL], keyring, port)).status).toBe(0)
    expect(mints()).toHaveLength(1)
    expect(mcp()[0]!.headers['x-spicy-trade-broker-token']).toBe(MINTED)
    // The entry now belongs to the grant in the keyring.
    expect(await cachedAccess(keyring)).toMatchObject({ grant: grantDigest(REFRESH_TOKEN), token: MINTED })
  }, TEST_TIMEOUT_MS)

  it('does not use a cached token past its retirement', async () => {
    const { mcp, mints, port } = await worker()
    const keyring = await fakeKeyring({ ...APP_GRANT, 'tastytrade/access-token': cacheEntry(REFRESH_TOKEN, Date.now() - 1) })
    expect((await spicytrade(['call', ACCOUNT_TOOL], keyring, port)).status).toBe(0)
    expect(mints()).toHaveLength(1)
    expect(mcp()[0]!.headers['x-spicy-trade-broker-token']).toBe(MINTED)
  }, TEST_TIMEOUT_MS)

  it.each([
    ['is not JSON', 'not json'],
    ['is JSON of another kind', JSON.stringify({ grant: grantDigest(REFRESH_TOKEN), retiresAt: 'later', token: CACHED })],
    ['holds an empty token', JSON.stringify({ grant: grantDigest(REFRESH_TOKEN), retiresAt: Date.now() + MINUTE_MS, token: '' })],
  ])('mints afresh over a cache entry that %s', async (_, entry) => {
    const { mcp, mints, port } = await worker()
    const keyring = await fakeKeyring({ ...APP_GRANT, 'tastytrade/access-token': entry })
    expect((await spicytrade(['call', ACCOUNT_TOOL], keyring, port)).status).toBe(0)
    expect(mints()).toHaveLength(1)
    expect(mcp()[0]!.headers['x-spicy-trade-broker-token']).toBe(MINTED)
  }, TEST_TIMEOUT_MS)

  it('attaches no cached token once no brokerage is saved', async () => {
    const { mcp, mints, port } = await worker()
    const keyring = await fakeKeyring({ ...SIGNED_IN, 'tastytrade/access-token': cacheEntry(REFRESH_TOKEN, Date.now() + MINUTE_MS) })
    const run = await spicytrade(['call', ACCOUNT_TOOL], keyring, port)
    expect(run).toEqual({ status: 1, stderr: NOT_CONNECTED, stdout: '' })
    expect(mints()).toHaveLength(0)
    expect(mcp()[0]!.headers['x-spicy-trade-broker-token']).toBeUndefined()
  }, TEST_TIMEOUT_MS)

  it('still answers when the keyring will not keep the minted token', async () => {
    const { mcp, mints, port } = await worker()
    const keyring = await fakeKeyring(APP_GRANT)
    // Reads as before; refuses every write, as a keyring reached over SSH does.
    await writeFile(join(keyring, 'secret-tool'), `#!/usr/bin/env bash
if [[ $1 == lookup ]]; then
  [[ -f '${join(keyring, 'store')}'/$3_$5 ]] || exit 1
  cat '${join(keyring, 'store')}'/$3_$5
else
  echo 'Cannot create an item in a locked collection' >&2
  exit 1
fi
`)
    const run = await spicytrade(['call', ACCOUNT_TOOL], keyring, port)
    expect(run).toEqual({ status: 0, stderr: '', stdout: `${answered(ACCOUNT_TOOL)}\n` })
    expect(mcp()[0]!.headers['x-spicy-trade-broker-token']).toBe(MINTED)
    // Nothing was kept, so the next call pays for its own mint.
    expect((await spicytrade(['call', ACCOUNT_TOOL], keyring, port)).status).toBe(0)
    expect(mints()).toHaveLength(2)
  }, TEST_TIMEOUT_MS)

  it('calls a market tool with no broker headers when no brokerage is saved', async () => {
    const { mcp, mints, port } = await worker()
    const run = await spicytrade(['call', MARKET_TOOL, '{"symbol":"SPY"}'], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({ status: 0, stderr: '', stdout: `${answered(MARKET_TOOL)}\n` })
    expect(mints()).toHaveLength(0)
    expect(mcp()[0]!.headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`)
    // No broker headers at all, rather than a half-configured credential.
    expect(mcp()[0]!.headers['x-spicy-trade-broker']).toBeUndefined()
    expect(mcp()[0]!.headers['x-spicy-trade-broker-token']).toBeUndefined()
  }, TEST_TIMEOUT_MS)

  it("gives this computer's own fix when an account call finds no brokerage connected", async () => {
    const { port } = await worker()
    const run = await spicytrade(['call', ACCOUNT_TOOL], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({ status: 1, stderr: NOT_CONNECTED, stdout: '' })
  }, TEST_TIMEOUT_MS)

  it("prints the Worker's own words when it reports no brokerage despite a token, or outside a refusal", async () => {
    // A refusal that came back although a broker token went out is not this computer's to explain.
    const refusing = await worker({ toolCall: (call, _, response) => send(response, 200, toolError(call.id, NO_BROKERAGE_TEXT)) })
    expect(await spicytrade(['call', ACCOUNT_TOOL], await fakeKeyring(APP_GRANT), refusing.port))
      .toEqual({ status: 1, stderr: `${NO_BROKERAGE_TEXT}\n`, stdout: '' })
    // And an answer that merely begins that way is an answer.
    const answering = await worker({ toolCall: (call, _, response) => send(response, 200, toolResult(call.id, NO_BROKERAGE_TEXT)) })
    expect(await spicytrade(['call', MARKET_TOOL], await fakeKeyring(SIGNED_IN), answering.port))
      .toEqual({ status: 0, stderr: '', stdout: `${NO_BROKERAGE_TEXT}\n` })
  }, TEST_TIMEOUT_MS)

  it('keeps market tools working when tastytrade refuses a personal grant, failing only the account call', async () => {
    const { mcp, mints, port } = await worker({
      mint: (_, response) => {
        // A revoked grant. The body echoes the credential, which must not be printed.
        send(response, 401, JSON.stringify({ error: 'invalid_grant', refresh_token: REFRESH_TOKEN }))
      },
    })
    const keyring = await fakeKeyring(PERSONAL_GRANT)
    expect(await spicytrade(['call', MARKET_TOOL], keyring, port)).toEqual({ status: 0, stderr: '', stdout: `${answered(MARKET_TOOL)}\n` })
    expect(await spicytrade(['call', ACCOUNT_TOOL], keyring, port)).toEqual({
      status: 1,
      stderr: "tastytrade refused this computer's personal grant (HTTP 401). Create a new grant on my.tastytrade.com,"
        + ` then run this in a terminal: ${fix('store-personal-grant')}\n`,
      stdout: '',
    })
    // Both calls went out, neither with a broker token, and a refusal left nothing in the keyring.
    expect(mcp()).toHaveLength(2)
    expect(mcp().every((sent) => sent.headers['x-spicy-trade-broker-token'] === undefined)).toBe(true)
    expect(mints()).toHaveLength(2)
    await expect(access(accessTokenFile(keyring))).rejects.toThrow()
  }, TEST_TIMEOUT_MS)

  it('answers a refused app grant with the command that reconnects, and keeps market tools working', async () => {
    const { mcp, port } = await worker({
      // tastytrade refused the grant, relayed by the Worker with tastytrade's own status.
      mint: (_, response) => send(response, 502, JSON.stringify({ error: REFRESH_TOKEN, tastytradeStatus: 401 })),
    })
    const keyring = await fakeKeyring(APP_GRANT)
    expect(await spicytrade(['call', MARKET_TOOL], keyring, port)).toEqual({ status: 0, stderr: '', stdout: `${answered(MARKET_TOOL)}\n` })
    expect(await spicytrade(['call', ACCOUNT_TOOL], keyring, port)).toEqual({
      status: 1,
      stderr: `tastytrade refused this computer's brokerage connection (HTTP 401). Reconnect with: ${fix('connect')}\n`,
      stdout: '',
    })
    expect(mcp().every((sent) => sent.headers['x-spicy-trade-broker-token'] === undefined)).toBe(true)
  }, TEST_TIMEOUT_MS)

  it.each([
    ['an app grant when tastytrade is down', APP_GRANT, 502, { error: 'tastytrade is down', tastytradeStatus: 503 }, 503],
    ['an app grant when tastytrade throttles', APP_GRANT, 502, { error: 'slow down', tastytradeStatus: 429 }, 429],
    ['a personal grant when tastytrade is down', PERSONAL_GRANT, 500, { error: 'oops' }, 500],
    ['a personal grant when tastytrade throttles', PERSONAL_GRANT, 429, { error: 'slow down' }, 429],
  ])('answers %s as an outage to wait out, not a connection to replace', async (_, grant, status, body, reported) => {
    const { port } = await worker({ mint: (__, response) => send(response, status, JSON.stringify(body)) })
    const keyring = await fakeKeyring(grant)
    expect(await spicytrade(['call', ACCOUNT_TOOL], keyring, port)).toEqual({
      status: 1, stderr: `tastytrade is not answering right now (HTTP ${reported}). Try again in a few minutes.\n`, stdout: '',
    })
    expect((await spicytrade(['call', MARKET_TOOL], keyring, port)).status).toBe(0)
  }, TEST_TIMEOUT_MS)

  it.each([
    ['tastytrade', PERSONAL_GRANT],
    ['spicytrade', APP_GRANT],
  ])('answers a mint that cannot reach %s as a network failure to retry, not a reconnect', async (party, grant) => {
    const { mcp, port } = await worker({
      // The connection drops before any status: a transport failure, like an unreachable host.
      mint: (_, response) => { response.destroy() },
    })
    const keyring = await fakeKeyring(grant)
    const run = await spicytrade(['call', ACCOUNT_TOOL], keyring, port)
    expect(run.status).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr.startsWith(`${party} could not be reached from this computer`)).toBe(true)
    expect(run.stderr.endsWith(`. ${NETWORK_FIX}`)).toBe(true)
    expect(run.stderr).toMatch(/^\w+ could not be reached from this computer( \([A-Za-z0-9_]+\))?\. Check the network/)
    expect(run.stderr).not.toMatch(/Reconnect| connect\b|store-personal-grant/)
    // The call itself went out, without a broker token, and a market tool is unaffected.
    expect(mcp()).toHaveLength(1)
    expect(mcp()[0]!.headers['x-spicy-trade-broker-token']).toBeUndefined()
    expect(await spicytrade(['call', MARKET_TOOL], keyring, port)).toEqual({ status: 0, stderr: '', stdout: `${answered(MARKET_TOOL)}\n` })
  }, TEST_TIMEOUT_MS)

  it.each([
    // A 2xx that is not a token, as a captive portal answers.
    ['a personal mint answered with a page', PERSONAL_GRANT, 200, `<html>${REFRESH_TOKEN}</html>`],
    ['a personal mint answered without a token', PERSONAL_GRANT, 200, JSON.stringify({ access_token: '' })],
    ['an app mint answered with a page', APP_GRANT, 200, `<html>${REFRESH_TOKEN}</html>`],
    ['an app mint the Worker could not do', APP_GRANT, 503, JSON.stringify({ error: 'unavailable' })],
    ['an app mint the Worker failed with a page', APP_GRANT, 500, '<html>oops</html>'],
  ])('answers %s as a wait, and keeps market tools working', async (_, grant, status, body) => {
    const { port } = await worker({ mint: (__, response) => send(response, status, body, 'text/html') })
    const keyring = await fakeKeyring(grant)
    expect(await spicytrade(['call', ACCOUNT_TOOL], keyring, port)).toEqual({
      status: 1,
      stderr: 'spicytrade could not get a tastytrade access token just now. Market and research tools still work;'
        + ' try account tools again in a few minutes.\n',
      stdout: '',
    })
    expect((await spicytrade(['call', MARKET_TOOL], keyring, port)).status).toBe(0)
  }, TEST_TIMEOUT_MS)

  it('answers a sign-in the Worker refuses at the app-grant mint as signed out, without sending the call', async () => {
    const { mcp, port } = await worker({ mint: (_, response) => send(response, 401, JSON.stringify({ error: 'Unauthorized' })) })
    const run = await spicytrade(['call', MARKET_TOOL], await fakeKeyring(APP_GRANT), port)
    expect(run).toEqual({ status: 1, stderr: `spicytrade call: ${SIGNED_OUT}`, stdout: '' })
    expect(mcp()).toHaveLength(0)
  }, TEST_TIMEOUT_MS)

  it.each([
    ['call', [MARKET_TOOL]],
    ['tools', []],
    ['guide', []],
  ])('tells an unsigned-in computer how to sign in, without reaching the Worker (%s)', async (command, rest) => {
    const { captured, port } = await worker()
    const run = await spicytrade([command, ...rest], await fakeKeyring({}), port)
    expect(run).toEqual({
      status: 1, stderr: `spicytrade ${command}: this computer is not signed in to spicytrade. Sign in with: ${fix('connect')}\n`, stdout: '',
    })
    expect(captured).toHaveLength(0)
  }, TEST_TIMEOUT_MS)

  it.each([
    ['a whole personal grant', { 'tastytrade/client-secret': CLIENT_SECRET, 'tastytrade/refresh-token': REFRESH_TOKEN }],
    // Even half a personal grant beside an app grant is ambiguous, not a partial one to ignore.
    ['half a personal grant', { 'tastytrade/client-secret': CLIENT_SECRET }],
  ])('refuses to guess which account trades when an app grant is saved beside %s', async (_, personal) => {
    const { captured, port } = await worker()
    const keyring = await fakeKeyring({ ...SIGNED_IN, 'tastytrade/app-refresh-token': OTHER_REFRESH_TOKEN, ...personal })
    // Even a market tool: which account a later order would use must not rest on a guess.
    const run = await spicytrade(['call', MARKET_TOOL], keyring, port)
    expect(run).toEqual({
      status: 1,
      stderr: 'spicytrade call: two tastytrade connections are saved on this computer, so spicytrade will not guess which account'
        + ` trades. Run this in a terminal to replace them: ${fix('setup')}\n`,
      stdout: '',
    })
    expect(captured).toHaveLength(0)
  }, TEST_TIMEOUT_MS)

  it.each([
    ['only a refresh token', { 'tastytrade/refresh-token': REFRESH_TOKEN }],
    ['only a client secret', { 'tastytrade/client-secret': CLIENT_SECRET }],
  ])('answers half a saved personal grant (%s) with the one repair, rather than calling market-only', async (_, half) => {
    const { captured, port } = await worker()
    const run = await spicytrade(['call', MARKET_TOOL], await fakeKeyring({ ...SIGNED_IN, ...half }), port)
    expect(run).toEqual({
      status: 1,
      stderr: `spicytrade call: an incomplete tastytrade connection is saved on this computer. Run this in a terminal to replace it: ${fix('setup')}\n`,
      stdout: '',
    })
    expect(captured).toHaveLength(0)
  }, TEST_TIMEOUT_MS)

  it('answers a locked keyring with what to unlock, rather than calling market-only', async () => {
    // The agent token reads; the brokerage entries sit in a collection that is locked.
    const keyring = await scriptedKeyring(`case "$3/$5" in
  spicytrade/mcp-token) printf '%s' '${AGENT_TOKEN}' ;;
  *) echo 'Cannot create an item in a locked collection' >&2; exit 1 ;;
esac`)
    const { captured, port } = await worker()
    const run = await spicytrade(['call', MARKET_TOOL], keyring, port)
    expect(run).toEqual({
      status: 1,
      stderr: 'spicytrade call: Your password storage is locked. Unlock it in the desktop password dialog when setup asks.'
        + ` Run: ${fix('setup')}\n`,
      stdout: '',
    })
    expect(captured).toHaveLength(0)
  }, TEST_TIMEOUT_MS)

  it.each(['call', 'tools', 'guide'])('distinguishes an unreachable desktop session from a locked keyring (%s)', async (command) => {
    const keyring = await scriptedKeyring("echo 'Cannot autolaunch D-Bus without X11 $DISPLAY' >&2\nexit 1")
    const { captured, port } = await worker()
    const run = await spicytrade(command === 'call' ? [command, MARKET_TOOL] : [command], keyring, port)
    expect(run.status).toBe(1)
    expect(run.stdout).toBe('')
    expect(run.stderr.startsWith(`spicytrade ${command}: Your desktop session bus could not be reached.`)).toBe(true)
    expect(run.stderr).not.toContain('Your password storage is locked.')
    expect(captured).toHaveLength(0)
  }, TEST_TIMEOUT_MS)

  it('answers a keyring that fails for a reason it does not know with the keyring message', async () => {
    const keyring = await scriptedKeyring("echo 'something this CLI has never seen' >&2\nexit 1")
    const { captured, port } = await worker()
    const run = await spicytrade(['call', MARKET_TOOL], keyring, port)
    expect(run.status).toBe(1)
    expect(run.stderr.startsWith('spicytrade call: Your system keyring could not be opened. ')).toBe(true)
    expect(run.stderr.endsWith(` Run: ${fix('setup')}\n`)).toBe(true)
    // The helper's own words are not this CLI's to repeat.
    expect(run.stderr).not.toContain('never seen')
    expect(captured).toHaveLength(0)
  }, TEST_TIMEOUT_MS)

  it('answers a Worker refusal of the agent token with the command that signs in again', async () => {
    const { toolCalls, mcp, port } = await worker({
      mcp: (_, __, response) => {
        response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
        response.end(JSON.stringify({ error: 'invalid_token' }))
      },
    })
    // An order tool: a refused call did not happen, so nothing says it may have.
    const run = await spicytrade(['call', ORDER_TOOL], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({ status: 1, stderr: `spicytrade call: ${SIGNED_OUT}`, stdout: '' })
    expect(toolCalls()).toHaveLength(1)
    expect(mcp()).toHaveLength(1)
  }, TEST_TIMEOUT_MS)

  it.each([
    ['call', [ORDER_TOOL]],
    ['tools', []],
    ['tools', [MARKET_TOOL]],
    ['guide', []],
  ])("waits out a fault on spicytrade's side instead of calling it a sign-out (%s %s)", async (command, rest) => {
    const { port } = await worker({
      mcp: (_, __, response) => {
        response.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer error="invalid_token", error_description="spicytrade could not verify this request."',
        })
        response.end(JSON.stringify({ error: 'invalid_token' }))
      },
    })
    const run = await spicytrade([command, ...rest], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({
      status: 1, stderr: `spicytrade ${command}: spicytrade could not check this computer's sign-in just now. Try again in a minute.\n`, stdout: '',
    })
  }, TEST_TIMEOUT_MS)

  /*
   * Every way the answer to a call that reached the Worker can fail to come back. `readOnly` is
   * what a tool the Worker declares read-only is told: an ordinary failure, safe to try again.
   */
  const LOST_ANSWERS: Array<{ how: string; lose: McpAnswer; readOnly: RegExp }> = [
    {
      how: 'the stream drops before its result',
      lose: (_, __, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' })
        response.write(`data: ${progress(1)}\n\n`)
        setTimeout(() => response.destroy(), DROP_AFTER_MS)
      },
      readOnly: /^spicytrade call: spicytrade could not (be reached from this computer \([A-Za-z0-9_]+\)|complete this request)\. Check the network/,
    },
    {
      how: 'the connection drops before any status',
      lose: (_, __, response) => { response.destroy() },
      readOnly: /^spicytrade call: spicytrade could not (be reached from this computer \([A-Za-z0-9_]+\)|complete this request)\. Check the network/,
    },
    {
      how: 'the stream ends without a result',
      lose: (_, __, response) => send(response, 200, `: keep-alive\n\ndata: ${progress(1)}\n\n`, 'text/event-stream'),
      readOnly: /^spicytrade call: spicytrade had a problem answering\. Try again in a few minutes\.\n$/,
    },
    {
      how: 'the body is empty',
      lose: (_, __, response) => send(response, 200, ''),
      readOnly: /^spicytrade call: spicytrade had a problem answering\. Try again in a few minutes\.\n$/,
    },
    {
      how: 'the body is a page, not MCP',
      lose: (_, __, response) => send(response, 200, '<html>hello</html>', 'text/html'),
      readOnly: /^spicytrade call: spicytrade had a problem answering\. Try again in a few minutes\.\n$/,
    },
    {
      how: 'the Worker fails with an error page',
      lose: (_, __, response) => send(response, 500, '<html>oops</html>', 'text/html'),
      readOnly: /^spicytrade call: spicytrade had a problem answering \(HTTP 500\)\. Try again in a few minutes\.\n$/,
    },
    {
      how: 'the Worker fails with JSON that is not a reply',
      lose: (_, __, response) => send(response, 503, JSON.stringify({ error: 'unavailable' })),
      readOnly: /^spicytrade call: spicytrade had a problem answering \(HTTP 503\)\. Try again in a few minutes\.\n$/,
    },
    {
      how: 'the reply answers some other request',
      lose: (call, _, response) => send(response, 200, toolResult(call.id + 1, 'not yours')),
      readOnly: /^spicytrade call: spicytrade had a problem answering\. Try again in a few minutes\.\n$/,
    },
    {
      how: 'the reply carries neither a result nor an error',
      lose: (call, _, response) => send(response, 200, JSON.stringify({ id: call.id, jsonrpc: '2.0' })),
      readOnly: /^spicytrade call: spicytrade had a problem answering\. Try again in a few minutes\.\n$/,
    },
    {
      how: 'the result is not a tool result',
      lose: (call, _, response) => send(response, 200, JSON.stringify({ id: call.id, jsonrpc: '2.0', result: { ok: true } })),
      readOnly: /^spicytrade call: spicytrade had a problem answering\. Try again in a few minutes\.\n$/,
    },
  ]

  it.each(LOST_ANSWERS)('never tells the agent to retry a call that may have changed something when $how', async ({ lose, readOnly }) => {
    const { toolCalls, port } = await worker({ toolCall: lose })
    const keyring = await fakeKeyring(SIGNED_IN)

    // A brokerage tool: the order may be working, so the fix is to look, never to send it again.
    expect(await spicytrade(['call', ORDER_TOOL], keyring, port)).toEqual({ status: 1, stderr: MAYBE_ORDERED, stdout: '' })
    // And it was sent once: an ambiguous mutation is never retried by this CLI either.
    expect(toolCalls()).toHaveLength(1)

    // Anything else that changes something may also have gone through, but it placed no order.
    const saving = await spicytrade(['call', SAVING_TOOL], keyring, port)
    expect(saving).toEqual({ status: 1, stderr: MAYBE_DONE, stdout: '' })
    expect(saving.stderr).not.toContain('order')
    // A tool that declares nothing is not known to be safe to repeat.
    expect((await spicytrade(['call', UNDECLARED_TOOL], keyring, port)).stderr).toBe(MAYBE_DONE)

    // A tool the Worker declares read-only is an ordinary failure.
    const reading = await spicytrade(['call', MARKET_TOOL], keyring, port)
    expect(reading.status).toBe(1)
    expect(reading.stdout).toBe('')
    expect(reading.stderr).toMatch(readOnly)
    expect(reading.stderr).not.toMatch(MAY_HAVE_HAPPENED)
  }, TEST_TIMEOUT_MS)

  it('stays cautious when it cannot ask whether the tool is read-only, or the Worker does not list it', async () => {
    const lose: McpAnswer = (_, __, response) => send(response, 500, '<html>oops</html>', 'text/html')
    const unlisted = await worker({ toolCall: lose })
    expect((await spicytrade(['call', 'read_something_unlisted'], await fakeKeyring(SIGNED_IN), unlisted.port)).stderr).toBe(MAYBE_DONE)
    // The same fault answers the question too: a name that sounds read-only settles nothing.
    const silent = await worker({ toolCall: lose, toolList: lose })
    expect((await spicytrade(['call', MARKET_TOOL], await fakeKeyring(SIGNED_IN), silent.port)).stderr).toBe(MAYBE_DONE)
    expect((await spicytrade(['call', ORDER_TOOL], await fakeKeyring(SIGNED_IN), silent.port)).stderr).toBe(MAYBE_ORDERED)
  }, TEST_TIMEOUT_MS)

  it('answers a request that never left this computer as an ordinary failure, even for an order', async () => {
    const run = await spicytrade(['call', ORDER_TOOL], await fakeKeyring(SIGNED_IN), await closedPort())
    expect(run).toEqual({
      status: 1, stderr: `spicytrade call: spicytrade could not be reached from this computer (ECONNREFUSED). ${NETWORK_FIX}`, stdout: '',
    })
  }, TEST_TIMEOUT_MS)

  it("writes a tool's own refusal to stderr and exits 1", async () => {
    const refusal = 'The market is closed. Orders open at 09:30 New York time.'
    const { port } = await worker({ toolCall: (call, _, response) => send(response, 200, toolError(call.id, refusal)) })
    // The Worker answered: a refused order did not go through, and nothing says it may have.
    const run = await spicytrade(['call', ORDER_TOOL], await fakeKeyring(APP_GRANT), port)
    expect(run).toEqual({ status: 1, stderr: `${refusal}\n`, stdout: '' })
  }, TEST_TIMEOUT_MS)

  it('answers a JSON-RPC error with its message and exits 1', async () => {
    const { mcp, port } = await worker({
      toolCall: (call, _, response) => {
        send(response, 200, JSON.stringify({ error: { code: -32602, message: 'Unknown tool: place_brokerage_order' }, id: call.id, jsonrpc: '2.0' }))
      },
    })
    const run = await spicytrade(['call', ORDER_TOOL], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({ status: 1, stderr: 'spicytrade call: Unknown tool: place_brokerage_order\n', stdout: '' })
    // An answer, so there is nothing to look up about the tool.
    expect(mcp()).toHaveLength(1)
  }, TEST_TIMEOUT_MS)

  it('prints every text item of an answer on its own line, and nothing else', async () => {
    const { port } = await worker({
      toolCall: (call, _, response) => {
        send(response, 200, JSON.stringify({
          id: call.id,
          jsonrpc: '2.0',
          result: {
            content: [{ text: 'first', type: 'text' }, { data: 'aGk=', mimeType: 'image/png', type: 'image' }, { text: 'second', type: 'text' }],
            isError: false,
            structuredContent: { ignored: true },
          },
        }))
      },
    })
    const run = await spicytrade(['call', MARKET_TOOL], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({ status: 0, stderr: '', stdout: 'first\nsecond\n' })
  }, TEST_TIMEOUT_MS)

  it('reads the result out of an event stream that carries progress notifications first', async () => {
    const { port } = await worker({
      toolCall: (call, _, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8' })
        response.write(`event: message\ndata: ${progress(1)}\n\n`)
        // Later events arrive after a pause, behind a keep-alive, with CRLF line ends and no space
        // after the field name, all of which the event-stream format allows.
        setTimeout(() => response.end(`: keep-alive\n\nevent: message\r\ndata:${progress(2)}\r\n\r\n`
          + `event: message\nid: 7\ndata: ${toolResult(call.id, 'streamed answer')}\n\n`), DROP_AFTER_MS)
      },
    })
    const run = await spicytrade(['call', MARKET_TOOL], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({ status: 0, stderr: '', stdout: 'streamed answer\n' })
  }, TEST_TIMEOUT_MS)

  it('reads the result out of a batched JSON body', async () => {
    const { port } = await worker({
      toolCall: (call, _, response) => send(response, 200, `[${progress(1)},${toolResult(call.id, 'batched answer')}]`),
    })
    const run = await spicytrade(['call', MARKET_TOOL], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({ status: 0, stderr: '', stdout: 'batched answer\n' })
  }, TEST_TIMEOUT_MS)

  it('sends the method and target headers the 2026-07-28 revision requires beside the body', async () => {
    const { mcp, port } = await worker()
    const keyring = await fakeKeyring(SIGNED_IN)
    await spicytrade(['call', MARKET_TOOL], keyring, port)
    await spicytrade(['guide'], keyring, port)
    await spicytrade(['tools', MARKET_TOOL], keyring, port)
    expect(mcp().map((sent) => [sent.headers['mcp-method'], sent.headers['mcp-name']])).toEqual([
      ['tools/call', MARKET_TOOL],
      ['resources/read', GUIDE_URI],
      ['tools/list', undefined],
    ])
    for (const sent of mcp()) {
      expect(sent.headers.accept).toBe('application/json, text/event-stream')
      expect(sent.headers['content-type']).toBe('application/json')
      // One request, no session: nothing is carried from an earlier run.
      expect(sent.headers['mcp-session-id']).toBeUndefined()
    }
  }, TEST_TIMEOUT_MS)

  it('leaves out the target header for a name that cannot be one, and still makes the call', async () => {
    const { mcp, port } = await worker()
    const run = await spicytrade(['call', 'tøøl'], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({ status: 0, stderr: '', stdout: `${answered('tøøl')}\n` })
    expect(mcp()[0]!.call.params.name).toBe('tøøl')
    expect(mcp()[0]!.headers['mcp-method']).toBe('tools/call')
    expect(mcp()[0]!.headers['mcp-name']).toBeUndefined()
  }, TEST_TIMEOUT_MS)

  it.each([
    ['no tool name', []],
    ['more than a name and one JSON value', [MARKET_TOOL, '{}', '{}']],
  ])('refuses %s with the usage, before reading the keyring', async (_, rest) => {
    const { captured, port } = await worker()
    // A keyring that fails every read: reaching it would change the message.
    const run = await spicytrade(['call', ...rest], await scriptedKeyring("echo 'locked collection' >&2\nexit 1"), port)
    expect(run).toEqual({
      status: 1,
      stderr: `spicytrade call: takes a tool name and its arguments as one JSON object. Usage: ${fix("call <tool> '<json arguments>'")}\n`,
      stdout: '',
    })
    expect(captured).toHaveLength(0)
  }, TEST_TIMEOUT_MS)

  it.each([
    ['an array', '[1]'],
    ['a string', '"SPY"'],
    ['null', 'null'],
    ['a number', '7'],
    ['not JSON', '{symbol: SPY}'],
    ['empty', ''],
  ])('refuses arguments that are %s, without making the call', async (_, json) => {
    const { captured, port } = await worker()
    const run = await spicytrade(['call', MARKET_TOOL, json], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({
      status: 1, stderr: `spicytrade call: the arguments are not a JSON object. Usage: ${fix("call <tool> '<json arguments>'")}\n`, stdout: '',
    })
    expect(captured).toHaveLength(0)
  }, TEST_TIMEOUT_MS)

  it('reads the arguments from stdin for -, and refuses a stdin that holds no JSON object', async () => {
    const { mcp, port } = await worker()
    const keyring = await fakeKeyring(SIGNED_IN)
    const run = await spicytrade(['call', MARKET_TOOL, '-'], keyring, port, '{"symbol":"SPY",\n "days": 30, "note": "it\'s quoted"}\n')
    expect(run).toEqual({ status: 0, stderr: '', stdout: `${answered(MARKET_TOOL)}\n` })
    expect(mcp()).toHaveLength(1)
    expect(mcp()[0]!.call.params).toEqual({ arguments: { days: 30, note: "it's quoted", symbol: 'SPY' }, name: MARKET_TOOL })

    const empty = await spicytrade(['call', MARKET_TOOL, '-'], keyring, port)
    expect(empty.status).toBe(1)
    expect(empty.stderr.startsWith('spicytrade call: the arguments are not a JSON object.')).toBe(true)
    expect(mcp()).toHaveLength(1)
  }, TEST_TIMEOUT_MS)

  it('calls with no arguments when no JSON is given', async () => {
    const { mcp, port } = await worker()
    const run = await spicytrade(['call', MARKET_TOOL], await fakeKeyring(SIGNED_IN), port)
    expect(run.status).toBe(0)
    expect(mcp()[0]!.call.params).toEqual({ arguments: {}, name: MARKET_TOOL })
  }, TEST_TIMEOUT_MS)

  it('prints no credential when the Worker echoes every one of them back', async () => {
    const echoed = SECRETS.join(' ')
    const { port } = await worker({
      mcp: (_, __, response) => send(response, 500, `<html>${echoed}</html>`, 'text/html'),
      mint: (_, response) => send(response, 400, JSON.stringify({ error: echoed, error_description: echoed })),
    })
    // `spicytrade` itself fails the test on any credential in a run's output.
    for (const grant of [SIGNED_IN, APP_GRANT, PERSONAL_GRANT]) {
      const keyring = await fakeKeyring(grant)
      expect((await spicytrade(['call', ORDER_TOOL], keyring, port)).status).toBe(1)
      expect((await spicytrade(['tools'], keyring, port)).status).toBe(1)
      expect((await spicytrade(['guide'], keyring, port)).status).toBe(1)
    }
  }, TEST_TIMEOUT_MS)
})

describe('spicytrade tools', () => {
  it("prints the Worker's instructions, then every tool, marking the ones that may change something", async () => {
    const { mcp, mints, port } = await worker()
    const run = await spicytrade(['tools'], await fakeKeyring(APP_GRANT), port)
    expect(run.status).toBe(0)
    expect(run.stderr).toBe('')
    const width = Math.max(...TOOLS.map((tool) => tool.name.length))
    // Each tool by its description's first sentence; anything not declared read-only is marked.
    expect(run.stdout).toBe(`${INSTRUCTIONS}

Tools. For one tool's arguments: ${fix('tools <name>')}. To use one: ${fix("call <name> '<json arguments>'")}

  ${MARKET_TOOL.padEnd(width)}  Daily candles for one symbol.
  ${ACCOUNT_TOOL.padEnd(width)}  Balances, positions and working orders.
  ${ORDER_TOOL.padEnd(width)}  Place one defined-risk order. [changes things]
  ${SAVING_TOOL.padEnd(width)}  Save a symbol to favorites [changes things]
  ${UNDECLARED_TOOL.padEnd(width)}  An older tool. [changes things]
`)
    // Listing asks who the caller is and nothing of their brokerage: no mint, no broker token.
    expect(mints()).toHaveLength(0)
    expect(mcp().map((sent) => sent.call.method).sort()).toEqual(['initialize', 'tools/list'])
    for (const sent of mcp()) {
      expect(sent.headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`)
      expect(sent.headers['x-spicy-trade-broker-token']).toBeUndefined()
    }
  }, TEST_TIMEOUT_MS)

  it('lists the tools alone when the Worker gives no instructions', async () => {
    const { port } = await worker({
      mcp: (call, _, response) => {
        send(response, 200, JSON.stringify({
          id: call.id,
          jsonrpc: '2.0',
          result: call.method === 'initialize' ? { protocolVersion: '2025-06-18' } : { tools: [{ annotations: { readOnlyHint: true }, name: MARKET_TOOL }] },
        }))
      },
    })
    const run = await spicytrade(['tools'], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({
      status: 0,
      stderr: '',
      stdout: `Tools. For one tool's arguments: ${fix('tools <name>')}. To use one: ${fix("call <name> '<json arguments>'")}\n\n  ${MARKET_TOOL}  \n`,
    })
  }, TEST_TIMEOUT_MS)

  it("prints one tool's whole description and the arguments call takes", async () => {
    const { mcp, port } = await worker()
    const run = await spicytrade(['tools', MARKET_TOOL], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({
      status: 0,
      stderr: '',
      stdout: `${MARKET_TOOL}

Daily candles for one symbol. Adjusted for splits, never for dividends.

Arguments (JSON Schema):
${JSON.stringify(MARKET_SCHEMA, null, 2)}

Call it with: ${fix(`call ${MARKET_TOOL} '<json arguments>'`)}
`,
    })
    // One tool is found in the list; the instructions are not asked for again.
    expect(mcp().map((sent) => sent.call.method)).toEqual(['tools/list'])
  }, TEST_TIMEOUT_MS)

  it('prints an empty schema for a tool that declares none', async () => {
    const { port } = await worker()
    const run = await spicytrade(['tools', ACCOUNT_TOOL], await fakeKeyring(SIGNED_IN), port)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('\n\nBalances, positions and working orders.\n\nArguments (JSON Schema):\n{}\n\n')
  }, TEST_TIMEOUT_MS)

  it('fails on a name the Worker does not offer this caller', async () => {
    const { port } = await worker()
    const run = await spicytrade(['tools', 'remove_watchlist_symbol'], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({
      status: 1, stderr: `spicytrade tools: there is no tool named "remove_watchlist_symbol". List them with: ${fix('tools')}\n`, stdout: '',
    })
  }, TEST_TIMEOUT_MS)

  it('takes at most one name', async () => {
    const { captured, port } = await worker()
    const run = await spicytrade(['tools', MARKET_TOOL, ACCOUNT_TOOL], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({ status: 1, stderr: `spicytrade tools: takes at most one tool name. Usage: ${fix('tools [name]')}\n`, stdout: '' })
    expect(captured).toHaveLength(0)
  }, TEST_TIMEOUT_MS)

  it.each([
    ['tools', []],
    ['tools', [MARKET_TOOL]],
    ['guide', []],
  ])('answers a Worker refusal of the agent token with the command that signs in again (%s %s)', async (command, rest) => {
    const { port } = await worker({
      mcp: (_, __, response) => {
        response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
        response.end(JSON.stringify({ error: 'invalid_token' }))
      },
    })
    const run = await spicytrade([command, ...rest], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({ status: 1, stderr: `spicytrade ${command}: ${SIGNED_OUT}`, stdout: '' })
  }, TEST_TIMEOUT_MS)

  it.each(['tools', 'guide'])('names an unreachable Worker and the transport failure (%s)', async (command) => {
    const run = await spicytrade([command], await fakeKeyring(SIGNED_IN), await closedPort())
    expect(run).toEqual({
      status: 1, stderr: `spicytrade ${command}: spicytrade could not be reached from this computer (ECONNREFUSED). ${NETWORK_FIX}`, stdout: '',
    })
  }, TEST_TIMEOUT_MS)

  it.each(['tools', 'guide'])('answers a Worker error page as trouble on its side, never as something that may have happened (%s)', async (command) => {
    const { port } = await worker({ mcp: (_, __, response) => send(response, 502, '<html>bad gateway</html>', 'text/html') })
    const run = await spicytrade([command], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({
      status: 1, stderr: `spicytrade ${command}: spicytrade had a problem answering (HTTP 502). Try again in a few minutes.\n`, stdout: '',
    })
  }, TEST_TIMEOUT_MS)
})

describe('spicytrade guide', () => {
  it("prints the guide resource's text and nothing else", async () => {
    const { mcp, mints, port } = await worker()
    const run = await spicytrade(['guide'], await fakeKeyring(APP_GRANT), port)
    expect(run).toEqual({ status: 0, stderr: '', stdout: `${GUIDE}\n` })
    expect(mcp()).toHaveLength(1)
    expect(mcp()[0]!.call).toEqual({ id: 1, jsonrpc: '2.0', method: 'resources/read', params: { uri: GUIDE_URI } })
    expect(mcp()[0]!.headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`)
    // Reading the guide needs no brokerage, so none is minted for it.
    expect(mints()).toHaveLength(0)
    expect(mcp()[0]!.headers['x-spicy-trade-broker-token']).toBeUndefined()
  }, TEST_TIMEOUT_MS)

  it('answers a JSON-RPC error with its message', async () => {
    const { port } = await worker({
      mcp: (call, _, response) => {
        send(response, 200, JSON.stringify({ error: { code: -32002, message: 'Resource not found' }, id: call.id, jsonrpc: '2.0' }))
      },
    })
    const run = await spicytrade(['guide'], await fakeKeyring(SIGNED_IN), port)
    expect(run).toEqual({ status: 1, stderr: 'spicytrade guide: Resource not found\n', stdout: '' })
  }, TEST_TIMEOUT_MS)
})

describe('broker token retirement', () => {
  it('retires a token one upstream timeout before expiry, so no request it rides on outlives it', () => {
    // tastytrade's 15-minute token: a tenth is 90 s, so the whole 60 s timeout is spared. A fixed
    // 30 s margin let a placement sent 45 s before expiry run on a token that died under it.
    const lifetimeMs = TOKEN_LIFETIME_SECONDS * MS_PER_SECOND
    expect(tokenRetiresAt(0, lifetimeMs)).toBe(lifetimeMs - UPSTREAM_TIMEOUT_MS)
  })

  it('keeps a token too short-lived to spare a whole timeout for nine tenths of its life', () => {
    expect(tokenRetiresAt(1_000, 100_000)).toBe(1_000 + 90_000)
  })
})
