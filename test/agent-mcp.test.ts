import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo } from 'node:net'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { afterEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import { tokenRetiresAt, UPSTREAM_TIMEOUT_MS } from '../ops/spicytrade/token-refresh.mjs'
import { fakeSecretTool } from './fake-secret-tool.ts'

/*
 * `spicytrade mcp` end to end: spawned the way an agent client launches it, spoken to over stdin
 * and stdout, relaying to a stand-in Worker, with a file-backed `secret-tool` on PATH.
 */

const REFRESH_TOKEN = 'refresh-token-that-must-never-leave-this-machine'
const CLIENT_SECRET = 'client-secret-that-must-never-leave-this-machine'
const AGENT_TOKEN = 'spice_0123456789abcdef_AAAAAAAAAAAAAAAAAAAA'
const MINTED = 'minted-15-minute-access-token'

type Captured = { body: string; headers: IncomingMessage['headers'] }

const children: ChildProcess[] = []
let upstream: Server | undefined
/** Each fake keyring holds the test's secrets in an executable script; none may outlive the run. */
const keyrings: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) child.kill('SIGKILL')
  const server = upstream
  await new Promise<void>((resolve) => {
    if (server) {
      server.closeAllConnections()
      server.close(() => resolve())
    } else {
      resolve()
    }
  })
  upstream = undefined
  await Promise.all(keyrings.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

async function listen(handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<number> {
  upstream = createServer(handler)
  await new Promise<void>((resolve) => upstream!.listen(0, '127.0.0.1', resolve))
  // SAFETY: this server was just listened on a TCP port, which is the case where Node returns
  // an AddressInfo rather than a pipe path or null.
  return (upstream.address() as AddressInfo).port
}

/** A Worker that records each request and answers it with `answer`, JSON by default. */
async function worker(answer: (request: IncomingMessage, body: string, response: ServerResponse) => void = (_, body, response) => {
  const { id } = z.object({ id: z.unknown() }).parse(JSON.parse(body))
  response.writeHead(id === undefined ? 202 : 200, { 'content-type': 'application/json' })
  response.end(id === undefined ? '' : JSON.stringify({ id, jsonrpc: '2.0', result: { ok: true } }))
}) {
  const captured: Captured[] = []
  const port = await listen((request, response) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString()
      if (request.url === '/mcp') captured.push({ body, headers: request.headers })
      answer(request, body, response)
    })
  })
  return { captured, port }
}

/** The shared `secret-tool` stand-in, tracked here so its directory is cleaned up after each test. */
async function fakeKeyring(entries: Record<string, string>): Promise<string> {
  const directory = await fakeSecretTool(entries)
  keyrings.push(directory)
  return directory
}

/** What a test writes to the server: a request when it has an id, a notification when it does not. */
type JsonRpcMessage = {
  id?: number | string
  jsonrpc: '2.0'
  method: string
  params?: {
    _meta?: { 'io.modelcontextprotocol/clientInfo': { name: string } }
    clientInfo?: { name: string }
    name?: string
    protocolVersion?: string
    uri?: string
    arguments?: { action: string }
  }
}

/** A running `spicytrade mcp`, with each stdout line parsed as it arrives and stderr kept. */
function startServer(keyring: string, port: number) {
  const child = spawn(process.execPath, ['ops/spicytrade/spicytrade.mjs', 'mcp'], {
    env: {
      ...process.env,
      PATH: `${keyring}:${process.env.PATH ?? ''}`,
      SPICYTRADE_MCP_URL: `http://127.0.0.1:${port}/mcp`,
      TASTYTRADE_API_BASE: `http://127.0.0.1:${port}`,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  children.push(child)
  const replies: unknown[] = []
  createInterface({ input: child.stdout! }).on('line', (line) => replies.push(JSON.parse(line)))
  const log = { stderr: '' }
  child.stderr!.on('data', (chunk: Buffer) => { log.stderr += chunk.toString() })
  return {
    log,
    replies,
    send: (message: JsonRpcMessage) => { child.stdin!.write(`${JSON.stringify(message)}\n`) },
    /** The next reply after the `count` already read. */
    reply: async (count: number) => {
      await expect.poll(() => replies.length, { timeout: 10_000 }).toBeGreaterThan(count)
      return replies[count]
    },
  }
}

/** The JSON-RPC error the server answers a failed request with; any other shape fails the parse. */
const FailureSchema = z.strictObject({
  error: z.strictObject({ code: z.number().int(), message: z.string() }),
  id: z.union([z.number(), z.string(), z.null()]),
  jsonrpc: z.literal('2.0'),
})

/** What the stand-in Worker answers the app-grant mint with, changed between calls. */
type WorkerAnswer = { body: { error: string; tastytradeStatus?: number }; status: number }

/**
 * A session that needs setup still connects, so the agent can relay the fix: `initialize`
 * succeeds with the fix as its instructions, the one tool it lists carries it, and calling that
 * tool returns it. Resolves with the fix, shaped as the error message the tests compare.
 */
async function notReady(server: ReturnType<typeof startServer>) {
  server.send({ ...request(1, 'initialize'), params: { protocolVersion: '2025-06-18' } })
  // A client sends nothing else until the handshake is answered.
  await server.reply(0)
  server.send(request(2, 'tools/list'))
  server.send(request(3, 'tools/call'))
  await server.reply(2)
  const byId = new Map(server.replies.map((reply) => {
    const parsed = NotReadyReplySchema.parse(reply)
    return [parsed.id, parsed.result] as const
  }))
  const instructions = InitializeSchema.parse(byId.get(1)).instructions
  expect(instructions.startsWith('spicytrade is not ready on this computer. ')).toBe(true)
  const fix = instructions.slice('spicytrade is not ready on this computer. '.length)
  const { tools } = ToolListSchema.parse(byId.get(2))
  expect(tools.map((tool) => tool.name)).toEqual(['setup_required', 'connect_spicytrade'])
  expect(tools[0]!.description).toContain(fix)
  expect(ToolCallSchema.parse(byId.get(3))).toEqual({ content: [{ text: fix, type: 'text' }], isError: true })
  return { error: { message: fix } }
}

const ConnectionReplySchema = z.object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) })
const ConnectionStatusSchema = z.object({ status: z.enum(['not_started', 'pending', 'connected', 'failed']) })
const NotReadyReplySchema = z.object({ id: z.number(), result: z.unknown() })
const InitializeSchema = z.object({ instructions: z.string(), protocolVersion: z.literal('2025-06-18') })
const ToolListSchema = z.object({ tools: z.array(z.object({ description: z.string(), name: z.string() })) })
const ToolCallSchema = z.object({ content: z.array(z.object({ text: z.string(), type: z.literal('text') })), isError: z.literal(true) })

/** What the Worker answers an account tool called with no broker token. */
const NO_BROKERAGE_TEXT = 'No brokerage is connected. To see positions and place orders, connect tastytrade from a terminal on your computer.'

/**
 * A Worker whose `/mcp` answers like the real one: a tool call carrying a broker token succeeds, one
 * without it gets the no-brokerage tool error, anything else succeeds. Every other path -- the
 * mints -- is `mint`'s to answer.
 */
async function accountWorker(mint: (request: IncomingMessage, response: ServerResponse) => void) {
  return worker((incoming, body, response) => {
    if (incoming.url !== '/mcp') {
      mint(incoming, response)
      return
    }
    const { id, method } = JSON.parse(body)
    const brokered = incoming.headers['x-spice-broker-token'] !== undefined
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(method === 'tools/call' && !brokered
      ? { id, jsonrpc: '2.0', result: { content: [{ text: NO_BROKERAGE_TEXT, type: 'text' }], isError: true } }
      : { id, jsonrpc: '2.0', result: { ok: true } }))
  })
}

/** A tool error result; anything else fails the parse. */
const ToolErrorReplySchema = z.object({ result: ToolCallSchema })

const request = (id: number | string, method = 'tools/call'): JsonRpcMessage => ({ id, jsonrpc: '2.0', method })

describe('spicytrade mcp', () => {
  it('attaches a freshly minted broker token and never forwards the long-lived credential', async () => {
    let tokenRequests = 0
    const { captured, port } = await worker((incoming, body, response) => {
      if (incoming.url?.endsWith('/oauth/token')) {
        tokenRequests += 1
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ access_token: MINTED, expires_in: 900 }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: JSON.parse(body).id, jsonrpc: '2.0', result: { ok: true } }))
    })
    const server = startServer(await fakeKeyring({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/client-secret': CLIENT_SECRET,
      'tastytrade/refresh-token': REFRESH_TOKEN,
    }), port)

    server.send(request(1))
    expect(await server.reply(0)).toEqual({ id: 1, jsonrpc: '2.0', result: { ok: true } })
    server.send(request(2))
    expect(await server.reply(1)).toEqual({ id: 2, jsonrpc: '2.0', result: { ok: true } })

    expect(captured).toHaveLength(2)
    for (const call of captured) {
      expect(call.headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`)
      expect(call.headers['x-spice-broker']).toBe('tastytrade')
      expect(call.headers['x-spice-broker-token']).toBe(MINTED)
      // The whole reason this process exists: the permanent credential stays here.
      expect(JSON.stringify(call)).not.toContain(REFRESH_TOKEN)
      expect(JSON.stringify(call)).not.toContain(CLIENT_SECRET)
    }
    // Minted once and reused inside its lifetime, not re-fetched per request.
    expect(tokenRequests).toBe(1)
    // stdout carries the replies and nothing else.
    expect(server.replies).toHaveLength(2)
  }, 30_000)

  it('keeps the session and its market tools when tastytrade refuses the grant, failing only the account call', async () => {
    let mints = 0
    const { captured, port } = await accountWorker((_, response) => {
      mints += 1
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'invalid_grant' }))
    })
    const server = startServer(await fakeKeyring({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/client-secret': CLIENT_SECRET,
      'tastytrade/refresh-token': REFRESH_TOKEN,
    }), port)
    // The handshake and the tool list need no broker token, so a revoked grant cannot fail them.
    server.send(request(1, 'initialize'))
    expect(await server.reply(0)).toEqual({ id: 1, jsonrpc: '2.0', result: { ok: true } })
    server.send(request(2, 'tools/list'))
    expect(await server.reply(1)).toEqual({ id: 2, jsonrpc: '2.0', result: { ok: true } })
    expect(mints).toBe(0)
    // A tool call still goes out, without a broker token, so market and research tools keep
    // working; an account tool's refusal is answered with what actually went wrong.
    server.send(request(3))
    expect(ToolErrorReplySchema.parse(await server.reply(2)).result.content[0]!.text).toMatch(/^tastytrade refused this computer's personal grant \(HTTP 401\)\./)
    expect(captured.every((call) => call.headers['x-spice-broker-token'] === undefined)).toBe(true)
    expect(captured).toHaveLength(3)
  }, 30_000)

  it('serves a sign-in the Worker refuses at the handshake as a session that needs setup', async () => {
    const { port } = await worker((_, __, response) => {
      response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
      response.end(JSON.stringify({ error: 'invalid_token' }))
    })
    const server = startServer(await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN }), port)
    const failure = await notReady(server)
    expect(failure.error.message).toMatch(/^This computer was signed out of spicytrade \(revoked under Signed-in computers\)\. .*\S*spicytrade(\.mjs)? connect\. Then call setup_required to reload the connection\.$/)
    expect(failure.error.message).toMatch(/If you no longer use spicytrade here, remove it with `\S*spicytrade(\.mjs)? uninstall`\. To keep using it, use connect_spicytrade/)
    expect(JSON.stringify(server.replies) + server.log.stderr).not.toContain(AGENT_TOKEN)
  }, 30_000)

  it('relays the market surface when no brokerage credential is configured', async () => {
    const { captured, port } = await worker()
    const server = startServer(await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN }), port)
    server.send(request(1))
    await server.reply(0)
    // No broker headers at all: the Worker then answers account tools with its own
    // connect-a-brokerage message rather than being handed a half-configured credential.
    expect(captured[0]?.headers['x-spice-broker']).toBeUndefined()
    expect(captured[0]?.headers['x-spice-broker-token']).toBeUndefined()
  }, 30_000)

  it("gives this computer's own fix when an account call finds no brokerage connected", async () => {
    const workerText = 'No brokerage is connected. To see positions and place orders, connect tastytrade from a terminal on your computer.'
    const { port } = await worker((_, body, response) => {
      const { id, method } = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(method === 'tools/call'
        ? { id, jsonrpc: '2.0', result: { content: [{ text: workerText, type: 'text' }], isError: true } }
        : { id, jsonrpc: '2.0', result: { content: [{ text: workerText, type: 'text' }] } }))
    })
    const server = startServer(await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN }), port)
    server.send(request(1))
    expect(await server.reply(0)).toEqual({
      id: 1,
      jsonrpc: '2.0',
      result: {
        content: [{ text: expect.stringMatching(/^tastytrade is not connected on this computer\. Use connect_spicytrade with action=start.*connect\. Then call setup_required to reload the connection\.$/), type: 'text' }],
        isError: true,
      },
    })
    // Anything else -- here, a reply that is not a tool error -- is relayed as the Worker sent it.
    server.send(request(2, 'tools/list'))
    expect(await server.reply(1)).toEqual({ id: 2, jsonrpc: '2.0', result: { content: [{ text: workerText, type: 'text' }] } })
  }, 30_000)

  it('still runs an install from before the rename: old keyring entry', async () => {
    const { captured, port } = await worker()
    const server = startServer(await fakeKeyring({ 'spicy-trade/mcp-token': AGENT_TOKEN }), port)
    server.send(request(1))
    await server.reply(0)
    expect(captured[0]?.headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`)
  }, 30_000)

  it('keeps the session the Worker assigns and the protocol version it negotiates', async () => {
    const { captured, port } = await worker((_, body, response) => {
      const { id, method } = JSON.parse(body)
      response.writeHead(id === undefined ? 202 : 200, { 'content-type': 'application/json', 'mcp-session-id': 'session-from-worker' })
      response.end(id === undefined
        ? ''
        : JSON.stringify({ id, jsonrpc: '2.0', result: method === 'initialize' ? { protocolVersion: '2025-06-18' } : {} }))
    })
    const server = startServer(await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN }), port)
    server.send({ ...request(1, 'initialize'), params: { protocolVersion: '2025-06-18' } })
    await server.reply(0)
    server.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    server.send(request(2))
    await server.reply(1)

    expect(captured[0]?.headers['mcp-session-id']).toBeUndefined()
    for (const call of captured.slice(1)) {
      expect(call.headers['mcp-session-id']).toBe('session-from-worker')
      expect(call.headers['mcp-protocol-version']).toBe('2025-06-18')
    }
    // A notification is relayed and, as JSON-RPC requires, never answered.
    expect(captured).toHaveLength(3)
    expect(server.replies).toHaveLength(2)
  }, 30_000)

  it('relays each message of an event stream as it arrives', async () => {
    const { port } = await worker((_, body, response) => {
      const { id } = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })}\n\n`)
      setTimeout(() => response.end(`: keep-alive\n\nevent: message\ndata: ${JSON.stringify({ id, jsonrpc: '2.0', result: { done: true } })}\n\n`), 50)
    })
    const server = startServer(await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN }), port)
    server.send(request(9, 'tools/call'))
    expect(await server.reply(0)).toEqual({ jsonrpc: '2.0', method: 'notifications/progress', params: { progress: 1 } })
    expect(await server.reply(1)).toEqual({ id: 9, jsonrpc: '2.0', result: { done: true } })
  }, 30_000)

  it('answers a request whose stream fails before its result, and never a second time', async () => {
    let failBeforeResult = true
    const { port } = await worker((_, body, response) => {
      const { id } = JSON.parse(body)
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      if (failBeforeResult) {
        response.write(`data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: {} })}\n\n`)
      } else {
        response.write(`data: ${JSON.stringify({ id, jsonrpc: '2.0', result: {} })}\n\n`)
      }
      // The Worker's connection drops with the event stream under way.
      setTimeout(() => response.destroy(), 50)
    })
    const server = startServer(await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN }), port)

    server.send(request(1, 'tools/call'))
    await server.reply(0)
    const failure = FailureSchema.parse(await server.reply(1))
    expect(failure.id).toBe(1)

    failBeforeResult = false
    server.send(request(2, 'tools/call'))
    expect(await server.reply(2)).toEqual({ id: 2, jsonrpc: '2.0', result: {} })
    await expect.poll(() => server.log.stderr).toContain('tools/call')
    expect(server.replies).toHaveLength(3)
  }, 30_000)

  it('never tells the agent to retry a call that may have changed something, only a read-only one', async () => {
    const { port } = await worker((_, body, response) => {
      const { id, method } = JSON.parse(body)
      if (method === 'tools/list') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id, jsonrpc: '2.0', result: { tools: [
          { annotations: { readOnlyHint: true }, name: 'read_price_history' },
          { annotations: { readOnlyHint: false }, name: 'place_brokerage_order' },
        ] } }))
        return
      }
      // The call reached the Worker; its answer never comes back.
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      setTimeout(() => response.destroy(), 50)
    })
    const server = startServer(await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN }), port)
    server.send(request(1, 'tools/list'))
    await server.reply(0)
    server.send({ ...request(2), params: { name: 'place_brokerage_order' } })
    expect(FailureSchema.parse(await server.reply(1)).error.message).toMatch(/^spicytrade did not finish answering, so this order may already have been placed, replaced or cancelled\. Check working orders and positions with read_account_snapshot before trying again\.$/)
    server.send({ ...request(3), params: { name: 'read_price_history' } })
    expect(FailureSchema.parse(await server.reply(2)).error.message).not.toMatch(/may or may not have gone through|this order may already/)
  }, 30_000)

  it('names orders only for the brokerage tools, and a server fault as spicytrade\'s', async () => {
    const { port } = await worker((_, body, response) => {
      const { id, method, params } = JSON.parse(body)
      if (method === 'tools/list') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ id, jsonrpc: '2.0', result: { tools: [
          { annotations: { readOnlyHint: true }, name: 'read_price_history' },
          { annotations: { readOnlyHint: false }, name: 'search_symbols' },
        ] } }))
        return
      }
      if (params?.name === 'read_price_history') {
        // An error page rather than MCP.
        response.writeHead(500, { 'content-type': 'text/html' })
        response.end('<html>oops</html>')
        return
      }
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      setTimeout(() => response.destroy(), 50)
    })
    const server = startServer(await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN }), port)
    server.send(request(1, 'tools/list'))
    await server.reply(0)
    server.send({ ...request(2), params: { name: 'search_symbols' } })
    const search = FailureSchema.parse(await server.reply(1)).error.message
    expect(search).toMatch(/may or may not have gone through\. Check whether it took effect before trying again\.$/)
    expect(search).not.toContain('order')
    server.send({ ...request(3), params: { name: 'read_price_history' } })
    expect(FailureSchema.parse(await server.reply(2)).error.message).toBe('spicytrade had a problem answering (HTTP 500). Try again in a few minutes.')
  }, 30_000)

  it('logs a refused token exchange as TastytradeAuth with its status, never the credential', async () => {
    const { port } = await accountWorker((_, response) => {
      // A revoked grant. The body echoes the credential, which must not reach the log.
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'invalid_grant', refresh_token: REFRESH_TOKEN }))
    })
    const server = startServer(await fakeKeyring({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/client-secret': CLIENT_SECRET,
      'tastytrade/refresh-token': REFRESH_TOKEN,
    }), port)
    server.send(request(1))
    const text = ToolErrorReplySchema.parse(await server.reply(0)).result.content[0]!.text
    expect(text).toMatch(/personal grant \(HTTP 401\).* \S*spicytrade(\.mjs)? store-personal-grant\. Then call setup_required to reload the connection\.$/)
    await expect.poll(() => server.log.stderr).toContain('SpicytradeMcp: tools/call TastytradeAuth 401\n')
    expect(server.log.stderr + text).not.toContain(REFRESH_TOKEN)
    expect(server.log.stderr + text).not.toContain(CLIENT_SECRET)
  }, 30_000)

  it('logs an unreachable or unreadable token exchange as TastytradeAuth, not as a Worker failure', async () => {
    for (const tokenAnswer of ['html', 'refuse'] as const) {
      const { port } = await accountWorker((_, response) => {
        if (tokenAnswer === 'refuse') {
          // The connection drops before any status: a transport failure, like an unreachable host.
          response.destroy()
          return
        }
        // A 2xx that is not JSON, as a captive portal answers.
        response.writeHead(200, { 'content-type': 'text/html' })
        response.end(`<html>${REFRESH_TOKEN}</html>`)
      })
      const server = startServer(await fakeKeyring({
        'spicytrade/mcp-token': AGENT_TOKEN,
        'tastytrade/client-secret': CLIENT_SECRET,
        'tastytrade/refresh-token': REFRESH_TOKEN,
      }), port)
      server.send(request(1))
      const text = ToolErrorReplySchema.parse(await server.reply(0)).result.content[0]!.text
      if (tokenAnswer === 'html') {
        expect(text).toMatch(/^spicytrade could not get a tastytrade access token just now\./)
        await expect.poll(() => server.log.stderr).toContain('SpicytradeMcp: tools/call TastytradeAuth invalid-token-response\n')
      } else {
        expect(text).toMatch(/^tastytrade could not be reached from this computer.* Check the network/)
        await expect.poll(() => server.log.stderr).toMatch(/SpicytradeMcp: tools\/call TastytradeAuth unreachable( [A-Za-z0-9_]+)?\n/)
      }
      expect(server.log.stderr).not.toContain('TypeError')
      expect(server.log.stderr).not.toContain(REFRESH_TOKEN)
      await new Promise<void>((resolve) => upstream!.close(() => resolve()))
    }
  }, 30_000)

  it('does not mint again after tastytrade refuses, for the rest of the session', async () => {
    let mints = 0
    const { port } = await accountWorker((_, response) => {
      mints += 1
      response.writeHead(401, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'invalid_grant' }))
    })
    const server = startServer(await fakeKeyring({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/client-secret': CLIENT_SECRET,
      'tastytrade/refresh-token': REFRESH_TOKEN,
    }), port)
    for (const id of [1, 2, 3]) {
      server.send(request(id))
      expect(ToolErrorReplySchema.parse(await server.reply(id - 1)).result.content[0]!.text).toMatch(/^tastytrade refused this computer's personal grant/)
    }
    expect(mints).toBe(1)
  }, 30_000)

  it('answers with what to fix when the keyring cannot be read, rather than relaying market-only', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'spicytrade-keyring-'))
    keyrings.push(directory)
    await writeFile(join(directory, 'secret-tool'), `#!/usr/bin/env bash
case "$3/$5" in
  spicytrade/mcp-token) printf '%s' '${AGENT_TOKEN}' ;;
  *) echo 'Cannot create an item in a locked collection' >&2; exit 1 ;;
esac
`)
    await chmod(join(directory, 'secret-tool'), 0o755)
    const { captured, port } = await worker()
    const server = startServer(directory, port)
    const failure = await notReady(server)
    expect(failure.error.message).toMatch(/^Your password storage is locked\..* Use connect_spicytrade with action=start.*run \S*spicytrade(\.mjs)? connect\. Then call setup_required to reload the connection\.$/)
    expect(captured).toHaveLength(0)
  }, 30_000)

  it('mints an app grant through the Worker and relays only the access token', async () => {
    const mints: Captured[] = []
    let directMints = 0
    const { captured, port } = await worker((incoming, body, response) => {
      if (incoming.url?.endsWith('/oauth/token')) {
        // An app grant never goes to tastytrade directly: it has no client secret to send.
        directMints += 1
        response.writeHead(500)
        response.end()
        return
      }
      if (incoming.url === '/api/brokers/tastytrade/token') {
        mints.push({ body, headers: incoming.headers })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ accessToken: MINTED, expiresIn: 900 }))
        return
      }
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: JSON.parse(body).id, jsonrpc: '2.0', result: {} }))
    })
    const server = startServer(await fakeKeyring({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/app-refresh-token': REFRESH_TOKEN,
    }), port)
    server.send(request(1))
    await server.reply(0)
    server.send(request(2))
    await server.reply(1)

    // Minted once, by the Worker, with the agent token and the refresh token and nothing else.
    expect(mints).toHaveLength(1)
    expect(directMints).toBe(0)
    expect(mints[0]?.headers.authorization).toBe(`Bearer ${AGENT_TOKEN}`)
    expect(JSON.parse(mints[0]!.body)).toEqual({ refreshToken: REFRESH_TOKEN })
    expect(captured).toHaveLength(2)
    for (const call of captured) {
      expect(call.headers['x-spice-broker-token']).toBe(MINTED)
      expect(JSON.stringify(call)).not.toContain(REFRESH_TOKEN)
    }
  }, 30_000)

  it('answers every request with what to fix when the keyring holds both kinds of grant', async () => {
    const personalGrants: Array<Record<string, string>> = [
      { 'tastytrade/client-secret': CLIENT_SECRET, 'tastytrade/refresh-token': REFRESH_TOKEN },
      // Even half a personal grant beside an app grant is ambiguous, not a partial one to ignore.
      { 'tastytrade/client-secret': CLIENT_SECRET },
    ]
    for (const personal of personalGrants) {
      const { captured, port } = await worker()
      const server = startServer(await fakeKeyring({
        'spicytrade/mcp-token': AGENT_TOKEN,
        'tastytrade/app-refresh-token': 'app-refresh-token-value',
        ...personal,
      }), port)
      const failure = await notReady(server)
      expect(failure.error.message).toMatch(/^Two tastytrade connections are saved.* Use connect_spicytrade with action=start.*run \S*spicytrade(\.mjs)? connect\. Then call setup_required to reload the connection\.$/)
      expect(JSON.stringify(failure) + server.log.stderr).not.toContain(CLIENT_SECRET)
      expect(JSON.stringify(failure) + server.log.stderr).not.toContain('app-refresh-token-value')
      expect(captured).toHaveLength(0)
      await new Promise<void>((resolve) => upstream!.close(() => resolve()))
    }
  }, 30_000)

  it('answers half a saved personal grant with the one repair, rather than relaying market-only', async () => {
    const { captured, port } = await worker()
    const server = startServer(await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN, 'tastytrade/refresh-token': REFRESH_TOKEN }), port)
    const failure = await notReady(server)
    expect(failure.error.message).toMatch(/^An incomplete tastytrade connection is saved on this computer\. Use connect_spicytrade with action=start.*run \S*spicytrade(\.mjs)? connect\. Then call setup_required to reload the connection\.$/)
    expect(captured).toHaveLength(0)
  }, 30_000)

  it("offers recovery in the current session", async () => {
    const { port } = await worker()
    const server = startServer(await fakeKeyring({}), port)
    server.send({ ...request(1, 'initialize'), params: { clientInfo: { name: 'claude-code' }, protocolVersion: '2025-06-18' } })
    const { instructions } = InitializeSchema.parse(NotReadyReplySchema.parse(await server.reply(0)).result)
    expect(instructions).toMatch(/\S*spicytrade(\.mjs)? connect\. Then call setup_required to reload the connection\.$/)
    expect(instructions).not.toContain('Codex')
  }, 30_000)

  it('sends the method and target headers the 2026-07-28 revision requires beside the body', async () => {
    const { captured, port } = await worker()
    const server = startServer(await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN }), port)
    server.send({ ...request(1), params: { name: 'read_price_history' } })
    await server.reply(0)
    server.send({ ...request(2, 'resources/read'), params: { uri: 'spicytrade://guide' } })
    await server.reply(1)
    server.send(request(3, 'tools/list'))
    await server.reply(2)
    expect(captured.map((call) => [call.headers['mcp-method'], call.headers['mcp-name']])).toEqual([
      ['tools/call', 'read_price_history'],
      ['resources/read', 'spicytrade://guide'],
      ['tools/list', undefined],
    ])
  }, 30_000)

  it('answers the newer server/discover with method-not-found while not ready, so the client falls back', async () => {
    const { port } = await worker()
    const server = startServer(await fakeKeyring({}), port)
    // Both handshake revisions offer recovery inside the current session.
    server.send({ ...request(1, 'server/discover'), params: { _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'codex-mcp-client' } } } })
    expect(FailureSchema.parse(await server.reply(0)).error.code).toBe(-32601)
    server.send({ ...request(2, 'initialize'), params: { protocolVersion: '2025-06-18' } })
    const { instructions } = InitializeSchema.parse(NotReadyReplySchema.parse(await server.reply(1)).result)
    expect(instructions).toMatch(/\S*spicytrade(\.mjs)? connect\. Then call setup_required to reload the connection\.$/)
    expect(instructions).not.toContain('Claude Code')
  }, 30_000)

  it('waits out a fault on spicytrade\'s side instead of calling it a sign-out', async () => {
    const { port } = await worker((_, __, response) => {
      response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer error="invalid_token", error_description="spicytrade could not verify this request."' })
      response.end(JSON.stringify({ error: 'invalid_token' }))
    })
    const server = startServer(await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN }), port)
    const failure = await notReady(server)
    expect(failure.error.message).toMatch(/^spicytrade could not check this computer's sign-in just now\. Ask your agent to recheck the connection in a minute/)
    expect(failure.error.message).not.toContain('signed out')
  }, 30_000)

  it('tells an unsigned-in computer to run setup, without reaching the Worker', async () => {
    const { captured, port } = await worker()
    const server = startServer(await fakeKeyring({}), port)
    const failure = await notReady(server)
    expect(failure.error.message).toMatch(/not signed in to spicytrade\. Use connect_spicytrade with action=start.*run \S*spicytrade(\.mjs)? connect\. Then call setup_required to reload the connection\.$/)
    expect(captured).toHaveLength(0)
  }, 30_000)

  it('answers a Worker refusal of the agent token with the command that signs in again', async () => {
    const { port } = await worker((_, __, response) => {
      // The Worker's own 401 challenge, which must not reach the client as one.
      response.writeHead(401, { 'content-type': 'application/json', 'www-authenticate': 'Bearer' })
      response.end(JSON.stringify({ error: 'invalid_token' }))
    })
    const server = startServer(await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN }), port)
    server.send(request(7))
    const failure = FailureSchema.parse(await server.reply(0))
    expect(failure.id).toBe(7)
    expect(failure.error.code).toBe(-32001)
    expect(failure.error.message).toMatch(/^This computer was signed out of spicytrade \(revoked under Signed-in computers\)\. .*Use connect_spicytrade with action=start.*connect\. Then call setup_required to reload the connection\.$/)
    await expect.poll(() => server.log.stderr).toContain('SpicytradeMcp: tools/call AgentTokenRefused 401\n')
    expect(JSON.stringify(failure) + server.log.stderr).not.toContain(AGENT_TOKEN)
  }, 30_000)

  it('answers a tastytrade outage as one to wait out, not a revoked connection to replace', async () => {
    const { port } = await accountWorker((_, response) => {
      response.writeHead(502, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'tastytrade is down', tastytradeStatus: 503 }))
    })
    const server = startServer(await fakeKeyring({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/app-refresh-token': REFRESH_TOKEN,
    }), port)
    server.send(request(1))
    const text = ToolErrorReplySchema.parse(await server.reply(0)).result.content[0]!.text
    expect(text).toBe('tastytrade is not answering right now (HTTP 503). Try again in a few minutes.')
  }, 30_000)

  it('answers a refused app-grant mint by what was refused', async () => {
    let refusal: WorkerAnswer = { body: { error: 'Unauthorized' }, status: 401 }
    const { port } = await accountWorker((_, response) => {
      response.writeHead(refusal.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(refusal.body))
    })
    const server = startServer(await fakeKeyring({
      'spicytrade/mcp-token': AGENT_TOKEN,
      'tastytrade/app-refresh-token': REFRESH_TOKEN,
    }), port)

    // The Worker refused the agent token on the mint itself: the call cannot go out at all.
    server.send(request('a'))
    const tokenRefused = FailureSchema.parse(await server.reply(0))
    expect(tokenRefused.id).toBe('a')
    expect(tokenRefused.error.code).toBe(-32001)

    // tastytrade refused the grant, relayed by the Worker: reconnect, not sign in.
    refusal = { body: { error: 'tastytrade refused the grant', tastytradeStatus: 401 }, status: 502 }
    server.send(request('b'))
    const text = ToolErrorReplySchema.parse(await server.reply(1)).result.content[0]!.text
    expect(text).toMatch(/^tastytrade refused this computer's brokerage connection \(HTTP 401\)\. Use connect_spicytrade with action=start.*connect\. Then call setup_required to reload the connection\.$/)
    expect(text).not.toContain(REFRESH_TOKEN)
  }, 30_000)

  it('answers an unreachable Worker by naming it and the transport failure', async () => {
    // A port that was listening and is closed again, so nothing answers on it.
    const { port } = await worker()
    await new Promise<void>((resolve) => upstream!.close(() => resolve()))
    upstream = undefined
    const server = startServer(await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN }), port)
    server.send(request(1))
    const failure = FailureSchema.parse(await server.reply(0))
    expect(failure.error.code).toBe(-32003)
    expect(failure.error.message).toMatch(/^spicytrade could not be reached from this computer \(ECONNREFUSED\)\. Check the network and try again; if it keeps failing, run this in a terminal: \S*spicytrade(\.mjs)? setup$/)
  }, 30_000)

  it('answers a line that is not JSON-RPC with a parse error and keeps serving', async () => {
    const { port } = await worker()
    const server = startServer(await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN }), port)
    children.at(-1)!.stdin!.write('not json\n')
    expect(FailureSchema.parse(await server.reply(0)).error.code).toBe(-32700)
    server.send(request(1))
    expect(await server.reply(1)).toEqual({ id: 1, jsonrpc: '2.0', result: { ok: true } })
  }, 30_000)
})

describe('broker token retirement', () => {
  it('retires a token one upstream timeout before expiry, so no relayed request outlives it', () => {
    // tastytrade's 15-minute token: a tenth is 90 s, so the whole 60 s timeout is spared. A fixed
    // 30 s margin let a placement relayed 45 s before expiry run on a token that died under it.
    const lifetimeMs = 15 * 60_000
    expect(tokenRetiresAt(0, lifetimeMs)).toBe(lifetimeMs - UPSTREAM_TIMEOUT_MS)
  })

  it('keeps a token too short-lived to spare a whole timeout for nine tenths of its life', () => {
    expect(tokenRetiresAt(1_000, 100_000)).toBe(1_000 + 90_000)
  })
})


describe('repairing an existing MCP session', () => {
  it('rechecks saved credentials and discovers tools without replaying the original request', async () => {
    const directory = await fakeKeyring({})
    const { captured, port } = await worker((_, body, response) => {
      const { id, method } = JSON.parse(body)
      response.writeHead(id === undefined ? 202 : 200, { 'content-type': 'application/json' })
      response.end(id === undefined ? '' : JSON.stringify({ id, jsonrpc: '2.0', result: method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } }
        : { tools: [{ name: 'read_account_snapshot' }] } }))
    })
    const server = startServer(directory, port)
    await notReady(server)
    await writeFile(join(directory, 'store', 'spicytrade_mcp-token'), AGENT_TOKEN)
    server.send({ ...request(4), params: { name: 'setup_required' } })
    expect(await server.reply(3)).toEqual({ id: 4, jsonrpc: '2.0', result: {
      content: [{ type: 'text', text: 'Connected. Retry your original request.' }],
    } })
    expect(await server.reply(4)).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    server.send(request(5, 'tools/list'))
    expect(await server.reply(5)).toMatchObject({ id: 5, jsonrpc: '2.0', result: { tools: [{ name: 'read_account_snapshot' }, { name: 'setup_required' }, { name: 'connect_spicytrade' }] } })
    expect(captured.map((call) => JSON.parse(call.body).method)).toEqual([
      'initialize', 'notifications/initialized', 'tools/list',
    ])
    expect(JSON.stringify(server.replies) + server.log.stderr).not.toContain(AGENT_TOKEN)
  })
})


describe('in-conversation onboarding tools', () => {
  it('connects through an MCP tool, reloads credentials, and continues the same session', async () => {
    const { captured, port } = await worker((incoming, body, response) => {
      if (incoming.url === '/api/brokers/tastytrade/token') {
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ accessToken: MINTED, expiresIn: 900 }))
        return
      }
      const { id, method, params } = JSON.parse(body)
      if (method === 'tools/call') expect(params.name).toBe('read_account_snapshot')
      response.writeHead(id === undefined ? 202 : 200, { 'content-type': 'application/json' })
      response.end(id === undefined ? '' : JSON.stringify({ id, jsonrpc: '2.0', result: method === 'initialize'
        ? { protocolVersion: '2025-06-18', capabilities: { tools: {} } }
        : method === 'tools/list' ? { tools: [{ name: 'read_account_snapshot' }] }
        : { content: [{ type: 'text', text: JSON.stringify({ asOf: new Date().toISOString(), source: 'tastytrade', balances: { netLiquidatingValue: 1234 } }) }] } }))
    })
    const server = startServer(await fakeKeyring({ 'spicytrade/mcp-token': AGENT_TOKEN, 'tastytrade/app-refresh-token': REFRESH_TOKEN }), port)
    server.send({ ...request(1, 'initialize'), params: { protocolVersion: '2025-06-18' } })
    await server.reply(0)
    const statusOf = (reply: z.infer<typeof ConnectionReplySchema>) => ConnectionStatusSchema.parse(JSON.parse(reply.result.content[0]!.text)).status
    server.send({ ...request(2), params: { name: 'connect_spicytrade', arguments: { action: 'start' } } })
    expect(statusOf(ConnectionReplySchema.parse(await server.reply(1)))).toBe('pending')
    let sequence = 2
    await expect.poll(async () => {
      const count = server.replies.length
      server.send({ ...request(++sequence), params: { name: 'connect_spicytrade', arguments: { action: 'status' } } })
      return statusOf(ConnectionReplySchema.parse(await server.reply(count)))
    }, { timeout: 10_000 }).toBe('connected')
    const count = server.replies.length
    server.send({ ...request(++sequence), params: { name: 'setup_required' } })
    await server.reply(count + 1)
    expect(server.replies[count]).toMatchObject({ result: { content: [{ text: expect.stringContaining('Connected.') }] } })
    expect(server.replies[count + 1]).toEqual({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
    expect(captured.filter(call => JSON.parse(call.body).method === 'tools/call')).toHaveLength(1)
    expect(JSON.stringify(server.replies) + server.log.stderr).not.toContain(REFRESH_TOKEN)
  })

  it('can report status and reject invalid actions before sign-in without browser or network side effects', async () => {
    const { captured, port } = await worker()
    const server = startServer(await fakeKeyring({}), port)
    server.send({ ...request(1), params: { name: 'connect_spicytrade', arguments: { action: 'status' } } })
    const reply = z.object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) }).parse(await server.reply(0))
    expect(JSON.parse(reply.result.content[0]!.text).status).toBe('not_started')
    server.send({ ...request(2), params: { name: 'connect_spicytrade', arguments: { action: 'trade' } } })
    expect(FailureSchema.parse(await server.reply(1)).error.code).toBe(-32602)
    expect(captured).toHaveLength(0)
  })
})
