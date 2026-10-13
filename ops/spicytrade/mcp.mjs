import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { z } from 'zod'

import { grantMinter, grantRefused, mintUnavailable, TastytradeAuthError, tastytradeUnavailable } from './broker-grants.mjs'
import { CLI_PATH, cliCommand, UPSTREAM, workerFault } from './config.mjs'
import { agentToken, KeyringUnavailable, TASTYTRADE, tastytradeCredentialKind } from './keyring.mjs'
import { tokenRetiresAt, UPSTREAM_TIMEOUT_MS } from './token-refresh.mjs'

/**
 * `spicytrade mcp`: the MCP server an agent client launches itself, one process per session,
 * speaking MCP's stdio transport on this process's stdin and stdout and relaying each message to
 * the Worker's streamable-HTTP endpoint with this machine's credentials attached.
 *
 * spicytrade holds no member's brokerage credential, so one has to reach the Worker on each
 * request. It must not reach it through the agent's configuration: an MCP config's `${VAR}`
 * interpolation reads the agent process's own environment, which its shell tool inherits. So the
 * credentials stay in the OS keyring, this process reads them there, exchanges the long-lived
 * tastytrade grant for a 15-minute access token, and attaches only that to forwarded requests.
 * The client's entry is a command line and nothing else.
 *
 * The agent launching this per session, rather than a background service, is what removes the
 * service, the port, and the restart after every credential change: each session reads the
 * keyring as it stands when it starts.
 *
 * stdout carries nothing but JSON-RPC messages, one per line, as the transport requires; every
 * diagnostic goes to stderr, which clients keep in their MCP logs.
 *
 * A tastytrade credential comes in one of two kinds, a personal grant or an app grant (see
 * `keyring.mjs`). A keyring holding both is refused rather than resolved by a precedence rule:
 * which account the agent trades would otherwise turn on an ordering nobody chose.
 */

/** The only broker with an adapter that can place orders; also its keyring service name. */
const BROKER = TASTYTRADE
const PROGRAM = 'SpicytradeMcp'
/** How long a mint that failed for want of an answer is not retried: a named budget, the owner's judgment. */
const MINT_RETRY_AFTER_MS = 60_000

/**
 * JSON-RPC reserves -32000 to -32099 for implementation-defined server errors (JSON-RPC 2.0
 * §5.1). One code per fix the member has to make, so a client or a test can tell them apart
 * without reading the message.
 */
const FAILURE_CODES = {
  agentToken: -32001,
  brokerGrant: -32002,
  other: -32000,
  unreachable: -32003,
}

/**
 * Transport failures that happen before a request leaves this computer: nothing reached the
 * Worker, so trying again cannot repeat anything.
 */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])
function neverSent(error) {
  return error instanceof TypeError && error.cause instanceof Error && 'code' in error.cause
    && NOT_SENT_CODES.has(String(error.cause.code))
}

/**
 * What the agent is told when a tool call that may change something -- an order placed, replaced
 * or cancelled -- went out and its answer never came back. It may have gone through, so "try
 * again" could place it twice: an ambiguous broker mutation is never to be retried blindly.
 */
const MAYBE_DONE = 'spicytrade did not finish answering, so this request may or may not have gone through. Check whether'
  + ' it took effect before trying again.'
/** In place of that for the brokerage tools -- the only ones that can place, replace or cancel an order. */
const MAYBE_ORDERED = 'spicytrade did not finish answering, so this order may already have been placed, replaced or cancelled.'
  + ' Check working orders and positions with read_account_snapshot before trying again.'
const BROKERAGE_TOOL = /brokerage/

/** spicytrade could not check this computer's token on its own side; the token itself is fine. */
class WorkerFault extends Error {
  constructor() {
    super('WorkerFault')
    this.name = 'WorkerFault'
  }
}

/** The Worker answered over HTTP but with no usable reply: its own trouble, to be waited out. */
class WorkerNoReply extends Error {
  constructor(status) {
    super(`WorkerNoReply:${status}`)
    this.name = 'WorkerNoReply'
    this.code = status
  }
}

/** The Worker refused the agent token on a forwarded call, as distinct from on a mint. */
class AgentTokenRefused extends Error {
  constructor(status) {
    super(`AgentTokenRefused:${status}`)
    this.name = 'AgentTokenRefused'
    this.code = status
  }
}

/**
 * What the agent is told when a request cannot be completed: which credential or party failed,
 * and the one command that fixes it. Every word is ours -- a status, an OS transport code, a
 * command -- never a value from a request or response, which can hold credential material.
 */
function failureFor(error, grantKind) {
  const network = `Check the network and try again; if it keeps failing, run this in a terminal: ${cliCommand('setup')}`
  if (error instanceof AgentTokenRefused || (error instanceof TastytradeAuthError && error.code === 'spicytrade-401')) {
    return {
      code: FAILURE_CODES.agentToken,
      message: `This computer was signed out of spicytrade (revoked under Signed-in computers). ${repair(cliCommand('setup'))}`,
    }
  }
  if (tastytradeUnavailable(error)) {
    return {
      code: FAILURE_CODES.unreachable,
      message: `tastytrade is not answering right now (HTTP ${error.code}). Try again in a few minutes.`,
    }
  }
  if (grantRefused(error)) {
    return {
      code: FAILURE_CODES.brokerGrant,
      message: grantKind === 'personal'
        ? `tastytrade refused this computer's personal grant (HTTP ${error.code}). Create a new grant on`
          + ` my.tastytrade.com. ${repair(cliCommand('store-personal-grant'))}`
        : `tastytrade refused this computer's brokerage connection (HTTP ${error.code}). ${repair(cliCommand('setup'))}`,
    }
  }
  if (error instanceof WorkerNoReply) {
    const status = error.code >= 400 ? ` (HTTP ${error.code})` : ''
    return { code: FAILURE_CODES.other, message: `spicytrade had a problem answering${status}. Try again in a few minutes.` }
  }
  if (error instanceof WorkerFault) {
    return { code: FAILURE_CODES.unreachable, message: 'spicytrade could not check this computer\'s sign-in just now. Try again in a minute.' }
  }
  if (error instanceof TastytradeAuthError && error.code === 'unreachable') {
    return {
      code: FAILURE_CODES.unreachable,
      message: `${error.party} could not be reached from this computer${error.transport ? ` (${error.transport})` : ''}.`
        + ` ${network}`,
    }
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return {
      code: FAILURE_CODES.unreachable,
      message: `spicytrade did not answer within ${UPSTREAM_TIMEOUT_MS / 1_000} seconds. ${network}`,
    }
  }
  if (error instanceof TypeError && error.cause instanceof Error && 'code' in error.cause) {
    return {
      code: FAILURE_CODES.unreachable,
      message: `spicytrade could not be reached from this computer (${String(error.cause.code)}). ${network}`,
    }
  }
  if (mintUnavailable(error)) {
    return {
      code: FAILURE_CODES.unreachable,
      message: 'spicytrade could not get a tastytrade access token just now. Market and research tools still work;'
        + ' try account tools again in a few minutes.',
    }
  }
  return { code: FAILURE_CODES.other, message: `spicytrade could not complete this request. ${network}` }
}

/** Credential changes are reloaded explicitly inside this MCP session. */
function repairInPlace(command) {
  return `Use connect_spicytrade with action=start to connect in this conversation. If you prefer a terminal, run ${command}. Then call setup_required to reload the connection.`
}

function repair(command) {
  return command.endsWith('store-personal-grant')
    ? `Run this in a terminal: ${command}. Then call setup_required to reload the connection.`
    : repairInPlace(cliCommand('connect'))
}

/**
 * What the 2026-07-28 revision of streamable HTTP requires in headers beside the body: the method,
 * and the name of what a call targets -- a tool or prompt `name`, or a resource `uri` -- which the
 * Worker checks agree with the body. Earlier revisions accept them too, so they are always sent.
 * Only printable ASCII can be a header value; anything else is left for the Worker to refuse.
 */
const NamedParamsSchema = z.looseObject({ name: z.string().optional(), uri: z.string().optional() })
function routingHeaders(message, headers) {
  if (message.method === undefined) return
  headers.set('Mcp-Method', message.method)
  const params = NamedParamsSchema.safeParse(message.params).data
  const name = params?.name ?? params?.uri
  if (name !== undefined && /^[\x20-\x7e]*$/.test(name)) headers.set('Mcp-Name', name)
}

/** The protocol revision a local answer to `initialize` speaks when the client names none. */
const LOCAL_PROTOCOL_VERSION = '2025-06-18'
/** The one tool a session that needs setup offers, so the agent reads the fix when asked anything. */
const SETUP_TOOL = 'setup_required'
const CONNECT_TOOL = {
  name: 'connect_spicytrade',
  description: 'Connect Spicytrade and tastytrade from the current conversation. Call action=start only when the user requests account connection. The browser and desktop keyring collect approval; never request passwords or tokens in chat. Use action=status after approval. When connected, call setup_required to reload credentials, then read_account_snapshot. Never places orders or launches an agent.',
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'status'] } }, required: ['action'], additionalProperties: false },
}
const ConnectInput = z.strictObject({ action: z.enum(['start', 'status']) })
function setupTool(fix = 'Reload saved credentials after connecting or repairing this computer. Never retry an ambiguous order automatically.') {
  return {
    name: SETUP_TOOL,
    description: `${fix} Call this tool to recheck the connection without restarting your agent.`,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    inputSchema: { properties: {}, type: 'object' },
  }
}
/** How a local answer begins; `doctor` reads it to tell such a session from one the Worker served. */
export const NOT_READY = 'spicytrade is not ready on this computer.'

/**
 * The answer to `message` when this computer cannot be relayed for at all -- not signed in, the
 * keyring unreadable, a broken tastytrade connection, a revoked sign-in. Failing `initialize`
 * instead would leave the agent with a server that "failed to connect" and the fix in a status
 * panel the model never reads; answering lets the agent tell the member exactly what to run.
 * Undefined for a notification, which is never answered.
 */
function localAnswer(message, fix) {
  if (message.id === undefined || message.method === undefined) return undefined
  const ok = (result) => ({ id: message.id, jsonrpc: '2.0', result })
  switch (message.method) {
    case 'initialize': {
      const requested = z.object({ protocolVersion: z.string() }).safeParse(message.params).data
      return ok({
        capabilities: { tools: { listChanged: true } },
        instructions: `${NOT_READY} ${fix}`,
        protocolVersion: requested?.protocolVersion ?? LOCAL_PROTOCOL_VERSION,
        serverInfo: { name: 'spicytrade', version: '1' },
      })
    }
    case 'ping': return ok({})
    case 'tools/list': return ok({
      tools: [setupTool(`${NOT_READY} ${fix}`), CONNECT_TOOL],
    })
    case 'tools/call': return ok({ content: [{ text: fix, type: 'text' }], isError: true })
    // Anything else -- `server/discover` among them, which a client falls back from to `initialize`
    // -- is not served here; method-not-found is what tells a client to fall back.
    default: return { error: { code: -32601, message: 'Method not found' }, id: message.id, jsonrpc: '2.0' }
  }
}

/** A JSON-RPC message: a request or notification has a method, a request or response an id. */
const MessageSchema = z.looseObject({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string().optional(),
})
/**
 * How the Worker begins the tool result it gives a call that needs a brokerage when none was
 * presented (`BrokerCredentialMissingError` in `src/server/broker-credential.ts`). Its text serves
 * every caller, installed or not, so it names both paths; this process knows which it is.
 */
const NO_BROKERAGE_PREFIX = 'No brokerage is connected.'
const ToolListResultSchema = z.looseObject({
  result: z.looseObject({
    tools: z.array(z.looseObject({ annotations: z.looseObject({ readOnlyHint: z.boolean().optional() }).optional(), name: z.string() })),
  }),
})
const ToolCallParamsSchema = z.looseObject({ name: z.string() })

const ToolErrorResultSchema = z.looseObject({
  result: z.looseObject({
    content: z.tuple([z.looseObject({ text: z.string(), type: z.literal('text') })]),
    isError: z.literal(true),
  }),
})

const InitializeResultSchema = z.looseObject({
  result: z.looseObject({ protocolVersion: z.string(), instructions: z.string().optional() }),
})

/**
 * The JSON-RPC messages in one streamable-HTTP answer: a JSON body holds one message or a batch;
 * an event stream holds one per event, in its `data` lines. Each is passed to `emit` as it
 * arrives, so a long tool call's progress is not held until the call finishes.
 */
async function readMessages(response, emit) {
  if (!response.body) return
  if (!(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    const text = await response.text()
    if (!text.trim()) return
    const body = JSON.parse(text)
    for (const message of Array.isArray(body) ? body : [body]) emit(message)
    return
  }
  const decoder = new TextDecoder()
  let buffer = ''
  let data = []
  const line = (raw) => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (text === '') {
      // The end of an event. One with no data -- a keep-alive, a retry hint -- carries no message.
      if (data.length) emit(JSON.parse(data.join('\n')))
      data = []
    } else if (text.startsWith('data:')) {
      data.push(text.slice(text.startsWith('data: ') ? 6 : 5))
    }
  }
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true })
    let end
    while ((end = buffer.indexOf('\n')) >= 0) {
      line(buffer.slice(0, end))
      buffer = buffer.slice(end + 1)
    }
  }
  line(buffer)
  line('')
}

/** Starts the server; resolves once the client closes stdin and every relayed call has settled. */
export async function serveMcp({ input = process.stdin, output = process.stdout } = {}) {
  const write = (message) => { output.write(`${JSON.stringify(message)}\n`) }

  // A machine that cannot be relayed for still answers, so the agent can tell the member what to
  // run rather than show a server that failed to start with the reason buried in a log.
  let setupRequired
  let agentBearer
  let credential = { kind: 'none' }
  try {
    agentBearer = await agentToken()
    credential = await tastytradeCredentialKind()
  } catch (error) {
    // Not relayed market-only: a keyring that cannot be read may hold a brokerage connection, and
    // carrying on without it would answer account tools as though none were connected.
    if (!(error instanceof KeyringUnavailable)) throw error
    setupRequired = () => `${error.recovery}. ${repairInPlace(cliCommand('connect'))}`
  }
  if (setupRequired === undefined && !agentBearer) {
    setupRequired = () => `This computer is not signed in to spicytrade. ${repairInPlace(cliCommand('connect'))}`
  } else if (setupRequired === undefined && (credential.kind === 'ambiguous' || credential.kind === 'incomplete')) {
    setupRequired = () => `${credential.kind === 'ambiguous'
      ? 'Two tastytrade connections are saved on this computer, so spicytrade will not guess which account trades.'
      : 'An incomplete tastytrade connection is saved on this computer.'} ${repairInPlace(cliCommand('connect'))}`
  }
  if (setupRequired) process.stderr.write(`${PROGRAM}: ${setupRequired()}\n`)

  // Brokerage credentials are optional: without them this still relays the market and research
  // surface, and the Worker answers account tools with its own connect-a-brokerage message.
  let mint = setupRequired ? undefined : grantMinter(agentBearer, credential)
  let cachedAccess
  /** The tools the Worker declares read-only: a call to one that went unanswered is safe to try again. */
  const readOnlyTools = new Set()
  /** A failed mint this session still answers with instead of minting again, and until when. */
  let mintHeld
  const brokerAccessToken = async () => {
    if (cachedAccess && Date.now() < cachedAccess.expiresAt) return cachedAccess.token
    const { lifetimeSeconds, token } = await mint()
    cachedAccess = { expiresAt: tokenRetiresAt(Date.now(), lifetimeSeconds * 1_000), token }
    return token
  }

  // Streamable HTTP's per-session state, learned from the Worker's answer to `initialize`. A
  // client waits for that answer before sending anything else, so both are set before they are read.
  let sessionId
  let protocolVersion

  let connectionChild
  let connectionState = { status: 'not_started', message: 'Ask to connect your account to begin browser authorization.' }
  const connectionCall = (message) => {
    const parsed = ConnectInput.safeParse(message.params?.arguments)
    if (!parsed.success) return { error: { code: -32602, message: 'Choose action=start or action=status.' }, id: message.id, jsonrpc: '2.0' }
    if (parsed.data.action === 'start' && !connectionChild) {
      connectionState = { status: 'pending', message: 'Connecting. Complete any desktop password dialog and browser approvals, then check status.' }
      // This child owns browser callbacks. Only our progress text and approval URLs return;
      // credentials never cross argv or the harness environment. No agent is launched.
      const child = spawn(process.execPath, [CLI_PATH, 'connect'], {
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, SPICYTRADE_DEBUG: '' },
      })
      connectionChild = child
      let progress = ''
      child.stdout.on('data', (chunk) => { progress += chunk; connectionState.message = progress })
      child.stderr.on('data', (chunk) => { progress += chunk; connectionState.message = progress })
      child.once('error', () => {
        connectionState = { status: 'failed', message: 'The local connector could not start. Reinstall it and try again.' }
        connectionChild = undefined
      })
      child.once('close', (code) => {
        connectionState = { status: code === 0 ? 'connected' : 'failed', message: progress || 'Connection stopped before finishing.' }
        connectionChild = undefined
      })
    }
    return { id: message.id, jsonrpc: '2.0', result: { content: [{ type: 'text', text: JSON.stringify(connectionState) }] } }
  }
  let opening
  let recovering = false
  async function relay(message, emit = write) {
    const id = message.id ?? null
    const isRequest = message.method !== undefined && id !== null
    let answered = false
    // A mint that failed for this call: the call still goes out without a broker token, so market
    // and research tools keep working, and an account tool's refusal is answered with this instead.
    let mintFailure
    // Whether the request left for the Worker: after that, a call that changes something may have happened.
    let sent = false
    if (message.method === 'initialize' || message.method === 'server/discover') {
      opening = message
    }
    const localTool = message.method === 'tools/call' ? ToolCallParamsSchema.safeParse(message.params).data?.name : undefined
    if (localTool === CONNECT_TOOL.name) {
      emit(connectionCall(message))
      return
    }
    const recheck = message.method === 'tools/call'
      && ToolCallParamsSchema.safeParse(message.params).data?.name === SETUP_TOOL
    if (recheck && (recovering || inFlight.size > 0 || connectionChild)) {
      emit({ id, jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'Wait for the connection and outstanding calls to finish, then recheck.' }], isError: true } })
      return
    }
    if (recheck && !recovering && inFlight.size === 0) {
      recovering = true
      try {
        const nextBearer = await agentToken()
        const nextCredential = await tastytradeCredentialKind()
        setupRequired = () => `The saved connection is missing or incomplete. ${repairInPlace(cliCommand('connect'))}`
        if (nextBearer && !['ambiguous', 'incomplete'].includes(nextCredential.kind)) {
          // Recovery is explicit and only runs with no outstanding calls. Never replay the
          // user's failed tool or carry a cached broker token into a new credential context.
          agentBearer = nextBearer
          credential = nextCredential
          mint = grantMinter(agentBearer, credential)
          cachedAccess = undefined
          mintHeld = undefined
          sessionId = undefined
          protocolVersion = undefined
          readOnlyTools.clear()
          setupRequired = undefined
          let initialized = false
          let instructions
          await relay({ ...opening, method: 'initialize' }, (reply) => {
            const parsed = InitializeResultSchema.safeParse(reply)
            initialized = parsed.success
            instructions = parsed.data?.result.instructions
          })
          if (initialized && !setupRequired) {
            await relay({ jsonrpc: '2.0', method: 'notifications/initialized' }, () => {})
            emit({ id, jsonrpc: '2.0', result: { content: [{ type: 'text', text: instructions ? `Connected. Retry your original request.\n\n${instructions}` : 'Connected. Retry your original request.' }] } })
            emit({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' })
            return
          }
          setupRequired ??= () => `The connection could not be checked. Try this tool again in a minute.`
        }
      } catch (error) {
        if (!(error instanceof KeyringUnavailable)) throw error
        setupRequired = () => `${error.recovery}. ${repairInPlace(cliCommand('connect'))}`
      } finally {
        recovering = false
      }
    } else if (recovering && emit === write) {
      if (isRequest) emit({ id, jsonrpc: '2.0', error: { code: FAILURE_CODES.other, message: 'Connection check in progress. Try again when it finishes.' } })
      return
    }
    if (setupRequired) {
      const answer = localAnswer(message, setupRequired())
      if (answer) emit(answer)
      return
    }
    try {
      const headers = new Headers({
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${agentBearer}`,
        'Content-Type': 'application/json',
      })
      routingHeaders(message, headers)
      if (sessionId) headers.set('mcp-session-id', sessionId)
      if (protocolVersion) headers.set('mcp-protocol-version', protocolVersion)
      // Only a tool call can spend a broker token, so only a tool call mints one: a revoked
      // tastytrade grant then fails the account tool that needs it, with its fix, rather than
      // the session's handshake -- which would take market data and research down with it.
      if (mint && message.method === 'tools/call') {
        let token
        if (mintHeld && Date.now() < mintHeld.until) {
          mintFailure = mintHeld.error
        } else {
          try {
            token = await brokerAccessToken()
          } catch (error) {
            // Not a refusal of this computer's sign-in: the Worker would refuse that call outright.
            if (error instanceof TastytradeAuthError && error.code === 'spicytrade-401') throw error
            if (!(error instanceof TastytradeAuthError)) throw error
            mintFailure = error
            // A refusal stands for the session -- its fix is a reconnect -- and an outage is not
            // retried for a while, so every market call does not wait out a mint first.
            mintHeld = { error, until: grantRefused(error) ? Infinity : Date.now() + MINT_RETRY_AFTER_MS }
            process.stderr.write(`${PROGRAM}: tools/call TastytradeAuth ${String(error.code)}${error.transport ? ` ${error.transport}` : ''}\n`)
          }
        }
        if (token) {
          // Still the pre-rename header names: the Worker accepts both, and moving these waits until
          // every installed CLI has been replaced by one that sends the current names.
          headers.set('X-Spice-Broker', BROKER)
          headers.set('X-Spice-Broker-Token', token)
        }
      }
      sent = true
      const upstream = await fetch(UPSTREAM, {
        body: JSON.stringify(message),
        headers,
        method: 'POST',
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
      // A 401 refuses this computer's own token, not anything the client sent; relayed as-is it
      // would send the client hunting for an OAuth flow this server does not have.
      // spicytrade's own fault, not a sign-out: waited out, never answered with "sign in again".
      if (workerFault(upstream)) {
        await upstream.body?.cancel()
        if (message.method === 'initialize') {
          // Refused before the session began: it still connects, so the agent can say to come back.
          setupRequired = () => `spicytrade could not check this computer's sign-in just now. Ask your agent to recheck the connection in a minute.`
          process.stderr.write(`${PROGRAM}: initialize WorkerFault 401\n`)
          emit(localAnswer(message, setupRequired()))
          return
        }
        throw new WorkerFault()
      }
      if (upstream.status === 401) {
        await upstream.body?.cancel()
        if (message.method === 'initialize') {
          // Refused before the session began: serve it as one that needs setup, so the agent hears why.
          // Revoking is also how a member stops using spicytrade, so the way out is named beside the way back.
          setupRequired = () => 'This computer was signed out of spicytrade (revoked under Signed-in computers). If you no'
            + ` longer use spicytrade here, remove it with \`${cliCommand('uninstall')}\`. To keep using it, ${repairInPlace(cliCommand('connect')).replace(/^Use/, 'use')}`
          process.stderr.write(`${PROGRAM}: initialize AgentTokenRefused 401\n`)
          emit(localAnswer(message, setupRequired()))
          return
        }
        throw new AgentTokenRefused(upstream.status)
      }
      if (message.method === 'initialize') sessionId = upstream.headers.get('mcp-session-id') ?? undefined
      try {
        await readMessages(upstream, (reply) => {
          if (message.method === 'initialize' && reply.id === id) {
            const parsed = InitializeResultSchema.safeParse(reply)
            if (parsed.success) {
              protocolVersion = parsed.data.result.protocolVersion
              const result = reply.result
              reply = { ...reply, result: { ...result, capabilities: { ...result.capabilities, tools: { ...result.capabilities?.tools, listChanged: true } } } }
            }
          }
          if (reply.id === id && (reply.result !== undefined || reply.error !== undefined)) answered = true
          if (message.method === 'tools/list' && reply.id === id) {
            const listed = ToolListResultSchema.safeParse(reply)
            if (listed.success) reply = { ...reply, result: { ...reply.result, tools: [
              ...listed.data.result.tools.filter((tool) => tool.name !== SETUP_TOOL && tool.name !== CONNECT_TOOL.name),
              setupTool(), CONNECT_TOOL,
            ] } }

            for (const tool of ToolListResultSchema.safeParse(reply).data?.result.tools ?? []) {
              if (tool.annotations?.readOnlyHint === true) readOnlyTools.add(tool.name)
            }
          }
          // Only a call this computer sent without a broker token, answered with the Worker's own
          // fixed sentence: the fix for this computer is setup, by the name that reaches it here.
          const missing = (!mint || mintFailure) && message.method === 'tools/call' && reply.id === id
            ? ToolErrorResultSchema.safeParse(reply).data
            : undefined
          if (missing?.result.content[0].text.startsWith(NO_BROKERAGE_PREFIX)) {
            const text = mintFailure
              ? failureFor(mintFailure, credential.kind).message
              : `tastytrade is not connected on this computer. ${repair(cliCommand('setup'))}`
            emit({ ...reply, result: { ...missing.result, content: [{ text, type: 'text' }] } })
            return
          }
          emit(reply)
        })
      } catch (error) {
        // A body that is not MCP at all -- an error page -- is the Worker's trouble, as no reply is.
        if (error instanceof SyntaxError) throw new WorkerNoReply(upstream.status)
        throw error
      }
      if (isRequest && !answered) throw new WorkerNoReply(upstream.status)
    } catch (error) {
      // Name and, for a transport failure, the OS-level cause code -- `ENOTFOUND`, `ECONNREFUSED`,
      // `UND_ERR_CONNECT_TIMEOUT` -- or a token exchange's status or fixed code. All are fixed
      // vocabulary, never content, and they are what separates "this computer could not reach the
      // Worker" or "the broker refused the grant" from a bug in here.
      const name = error instanceof Error ? error.name : 'UnknownError'
      const detail = error instanceof TastytradeAuthError || error instanceof AgentTokenRefused
        ? ` ${String(error.code)}${error.transport ? ` ${error.transport}` : ''}`
        : error instanceof Error && error.cause instanceof Error && 'code' in error.cause
          ? ` ${String(error.cause.code)}`
          : ''
      process.stderr.write(`${PROGRAM}: ${message.method ?? 'reply'} ${name}${detail}\n`)
      // A notification or a reply to the server has no one to tell; a request that already has
      // its answer -- a stream that failed after the result -- needs no second one.
      if (!isRequest || answered) return
      const tool = message.method === 'tools/call' ? ToolCallParamsSchema.safeParse(message.params).data?.name : undefined
      const maybeDone = tool !== undefined && sent && !readOnlyTools.has(tool)
        && !(error instanceof AgentTokenRefused) && !(error instanceof WorkerFault) && !neverSent(error)
      emit({
        error: maybeDone
          ? { code: FAILURE_CODES.other, message: BROKERAGE_TOOL.test(tool) ? MAYBE_ORDERED : MAYBE_DONE }
          : failureFor(error, credential.kind),
        id,
        jsonrpc: '2.0',
      })
    }
  }

  const inFlight = new Set()
  const lines = createInterface({ crlfDelay: Infinity, input })
  for await (const line of lines) {
    if (!line.trim()) continue
    let parsed
    try {
      parsed = MessageSchema.safeParse(JSON.parse(line))
    } catch {
      parsed = undefined
    }
    if (!parsed?.success) {
      write({ error: { code: -32700, message: 'Parse error' }, id: null, jsonrpc: '2.0' })
      continue
    }
    // Relayed concurrently: a long tool call must not hold up a ping or a cancellation behind it.
    const pending = relay(parsed.data).finally(() => inFlight.delete(pending))
    inFlight.add(pending)
  }
  // Disconnecting the harness ends its pending browser flow too.
  connectionChild?.kill()
  await Promise.all(inFlight)
}
