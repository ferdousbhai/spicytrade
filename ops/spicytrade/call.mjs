import { createHash } from 'node:crypto'
import { z } from 'zod'

import {
  grantMinter, grantRefused, mintUnavailable, TastytradeAuthError, tastytradeUnavailable, transportCode,
} from './broker-grants.mjs'
import { CliFailure } from './cli.mjs'
import { cliCommand, MCP_PROTOCOL_VERSION, UPSTREAM, workerFault } from './config.mjs'
import {
  ACCESS_TOKEN_KEY, agentToken, keyringSecret, keyringStore, KeyringUnavailable, TASTYTRADE, tastytradeCredentialKind,
} from './keyring.mjs'
import { tokenRetiresAt, UPSTREAM_TIMEOUT_MS } from './token-refresh.mjs'

/**
 * `spicytrade tools` and `spicytrade call`: how an agent uses spicytrade from its own shell. Each
 * run is one request to the Worker's MCP endpoint, which answers a single call with no session,
 * carrying this machine's credentials from the OS keyring.
 *
 * spicytrade holds no member's brokerage credential, so one has to reach the Worker on each call.
 * The long-lived tastytrade grant stays in the keyring; this process exchanges it for a 15-minute
 * access token and attaches only that. Every run reads the keyring as it stands, so a credential
 * replaced by `spicytrade connect` is used by the very next call, with nothing to restart.
 *
 * stdout carries a tool's answer and nothing else. No credential is printed, and every failure is
 * in this CLI's own words -- a status, a transport code, a command -- never a value from a request
 * or response, which can hold credential material.
 */

/** The only broker with an adapter that can place orders; also its keyring service name. */
const BROKER = TASTYTRADE

/**
 * What the agent is told when a call that may change something -- an order placed, replaced or
 * cancelled -- went out and its answer never came back. It may have gone through, so "try again"
 * could place it twice: an ambiguous broker mutation is never to be retried blindly.
 */
const MAYBE_DONE = 'spicytrade did not finish answering, so this request may or may not have gone through. Check whether'
  + ' it took effect before trying again.'
/** In place of that for the brokerage tools -- the only ones that can place, replace or cancel an order. */
const MAYBE_ORDERED = 'spicytrade did not finish answering, so this order may already have been placed, replaced or cancelled.'
  + ` Check working orders and positions with \`${cliCommand('call read_account_snapshot')}\` before trying again.`
const BROKERAGE_TOOL = /brokerage/

/**
 * Transport failures that happen before a request leaves this computer: nothing reached the
 * Worker, so trying again cannot repeat anything.
 */
const NOT_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])
function neverSent(error) {
  return error instanceof TypeError && error.cause instanceof Error && 'code' in error.cause
    && NOT_SENT_CODES.has(String(error.cause.code))
}

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

/** The Worker refused this computer's agent token. */
class AgentTokenRefused extends Error {
  constructor() {
    super('AgentTokenRefused')
    this.name = 'AgentTokenRefused'
  }
}

const SIGNED_OUT = `this computer was signed out of spicytrade (revoked under Signed-in computers). Sign in again with: ${cliCommand('connect')}`

/** Which credential or party failed, and the one command that fixes it. */
function describeFailure(error, grantKind) {
  const network = `Check the network and try again; if it keeps failing, run: ${cliCommand('doctor')}`
  if (error instanceof AgentTokenRefused || (error instanceof TastytradeAuthError && error.code === 'spicytrade-401')) return SIGNED_OUT
  if (tastytradeUnavailable(error)) return `tastytrade is not answering right now (HTTP ${error.code}). Try again in a few minutes.`
  if (grantRefused(error)) {
    return grantKind === 'personal'
      ? `tastytrade refused this computer's personal grant (HTTP ${error.code}). Create a new grant on`
        + ` my.tastytrade.com, then run this in a terminal: ${cliCommand('store-personal-grant')}`
      : `tastytrade refused this computer's brokerage connection (HTTP ${error.code}). Reconnect with: ${cliCommand('connect')}`
  }
  if (error instanceof WorkerNoReply) {
    return `spicytrade had a problem answering${error.code >= 400 ? ` (HTTP ${error.code})` : ''}. Try again in a few minutes.`
  }
  if (error instanceof WorkerFault) return 'spicytrade could not check this computer\'s sign-in just now. Try again in a minute.'
  if (error instanceof TastytradeAuthError && error.code === 'unreachable') {
    return `${error.party} could not be reached from this computer${error.transport ? ` (${error.transport})` : ''}. ${network}`
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return `spicytrade did not answer within ${UPSTREAM_TIMEOUT_MS / 1_000} seconds. ${network}`
  }
  if (error instanceof TypeError && error.cause instanceof Error && 'code' in error.cause) {
    return `spicytrade could not be reached from this computer (${transportCode(error) ?? 'UnknownError'}). ${network}`
  }
  if (mintUnavailable(error)) {
    return 'spicytrade could not get a tastytrade access token just now. Market and research tools still work;'
      + ' try account tools again in a few minutes.'
  }
  return `spicytrade could not complete this request. ${network}`
}

/**
 * The JSON-RPC messages in one streamable-HTTP answer: a JSON body holds one message or a batch;
 * an event stream holds one per event, in its `data` lines.
 */
async function readMessages(response) {
  const text = await response.text()
  if (!text.trim()) return []
  if (!(response.headers.get('content-type') ?? '').startsWith('text/event-stream')) {
    const body = JSON.parse(text)
    return Array.isArray(body) ? body : [body]
  }
  const messages = []
  for (const event of text.split(/\r?\n\r?\n/)) {
    const data = event.split(/\r?\n/).filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(line.startsWith('data: ') ? 6 : 5))
    // An event with no data -- a keep-alive, a retry hint -- carries no message.
    if (data.length) messages.push(JSON.parse(data.join('\n')))
  }
  return messages
}

const REQUEST_ID = 1
const ReplySchema = z.looseObject({
  error: z.looseObject({ message: z.string() }).optional(),
  id: z.literal(REQUEST_ID),
  result: z.unknown().optional(),
})

/**
 * One MCP request to the Worker and its reply. `sent` is called as the request leaves, after
 * which a call that changes something may have happened whatever comes back.
 */
async function request(method, params, { bearer, brokerToken, sent = () => {} }) {
  const headers = new Headers({
    Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${bearer}`,
    'Content-Type': 'application/json',
    // The 2026-07-28 revision of streamable HTTP wants the method, and the name a call targets,
    // beside the body; earlier revisions accept them too. Only printable ASCII can be a header.
    'Mcp-Method': method,
  })
  const target = params.name ?? params.uri
  if (target !== undefined && /^[\x20-\x7e]*$/.test(target)) headers.set('Mcp-Name', target)
  if (brokerToken) {
    headers.set('X-Spicy-Trade-Broker', BROKER)
    headers.set('X-Spicy-Trade-Broker-Token', brokerToken)
  }
  sent()
  const response = await fetch(UPSTREAM, {
    body: JSON.stringify({ id: REQUEST_ID, jsonrpc: '2.0', method, params }),
    headers,
    method: 'POST',
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  })
  // spicytrade's own fault, not a sign-out: waited out, never answered with "sign in again".
  if (workerFault(response)) {
    await response.body?.cancel()
    throw new WorkerFault()
  }
  if (response.status === 401) {
    await response.body?.cancel()
    throw new AgentTokenRefused()
  }
  let messages
  try {
    messages = await readMessages(response)
  } catch (error) {
    // A body that is not MCP at all -- an error page -- is the Worker's trouble, as no reply is.
    if (error instanceof SyntaxError) throw new WorkerNoReply(response.status)
    throw error
  }
  // Progress notifications share the stream; the reply is the message that carries this id.
  const reply = messages.map((message) => ReplySchema.safeParse(message).data).find(Boolean)
  if (!reply || (reply.result === undefined) === (reply.error === undefined)) throw new WorkerNoReply(response.status)
  return reply
}

/**
 * This computer's credentials as the keyring holds them now. A computer that cannot be called for
 * at all -- not signed in, a saved tastytrade connection that cannot trade -- fails here, with the
 * command that fixes it.
 */
async function credentials() {
  const bearer = await agentToken()
  if (!bearer) throw new CliFailure(`this computer is not signed in to spicytrade. Sign in with: ${cliCommand('connect')}`)
  const credential = await tastytradeCredentialKind()
  if (credential.kind === 'ambiguous') {
    throw new CliFailure('two tastytrade connections are saved on this computer, so spicytrade will not guess which account'
      + ` trades. Run this in a terminal to replace them: ${cliCommand('setup')}`)
  }
  if (credential.kind === 'incomplete') {
    throw new CliFailure(`an incomplete tastytrade connection is saved on this computer. Run this in a terminal to replace it: ${cliCommand('setup')}`)
  }
  return { bearer, credential }
}

const CachedAccessSchema = z.object({ grant: z.string(), retiresAt: z.number(), token: z.string().min(1) })

/**
 * A tastytrade access token for this call: the one an earlier call left in the keyring while it
 * is still live, otherwise a fresh mint, kept there for the calls that follow. An agent makes
 * calls in runs, and each would otherwise wait on its own exchange with tastytrade first.
 *
 * The cached token names the grant it came from by digest, so a replaced connection is never
 * answered with the old account's token. Undefined when no brokerage is connected. Keeping the
 * token is best effort: a keyring that will not take it costs the next call a mint, nothing more.
 */
async function brokerAccessToken(bearer, credential) {
  const mint = grantMinter(bearer, credential)
  if (!mint) return undefined
  const grant = createHash('sha256').update(credential.appRefreshToken ?? credential.refreshToken).digest('base64url')
  let cached
  try {
    cached = CachedAccessSchema.safeParse(JSON.parse(await keyringSecret(BROKER, ACCESS_TOKEN_KEY) ?? 'null')).data
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  if (cached?.grant === grant && Date.now() < cached.retiresAt) return cached.token
  const issuedAt = Date.now()
  const { lifetimeSeconds, token } = await mint()
  const kept = JSON.stringify({ grant, retiresAt: tokenRetiresAt(issuedAt, lifetimeSeconds * 1_000), token })
  await keyringStore(BROKER, ACCESS_TOKEN_KEY, 'tastytrade access token (short-lived)', kept).catch((error) => {
    if (!(error instanceof KeyringUnavailable)) throw error
  })
  return token
}

const ToolSchema = z.looseObject({
  annotations: z.looseObject({ readOnlyHint: z.boolean().optional() }).optional(),
  description: z.string().optional(),
  inputSchema: z.unknown().optional(),
  name: z.string(),
})
const ToolListSchema = z.looseObject({ tools: z.array(ToolSchema) })
const InstructionsSchema = z.looseObject({ instructions: z.string().optional() })
const ToolResultSchema = z.looseObject({
  content: z.array(z.looseObject({ text: z.string().optional(), type: z.string() })),
  isError: z.boolean().optional(),
})

/** A reply's result, or the failure its JSON-RPC error names in the Worker's own words for the caller. */
function resultOf(reply, schema) {
  if (reply.error) throw new CliFailure(reply.error.message)
  const parsed = schema.safeParse(reply.result)
  if (!parsed.success) throw new WorkerNoReply(0)
  return parsed.data
}

async function listTools(bearer) {
  return resultOf(await request('tools/list', {}, { bearer }), ToolListSchema).tools
}

/**
 * How the Worker begins the result it gives a call that needs a brokerage when none was presented
 * (`BrokerCredentialMissingError` in `src/server/broker-credential.ts`). Its text serves every
 * caller, installed or not; this computer has its own, shorter fix.
 */
const NO_BROKERAGE_PREFIX = 'No brokerage is connected.'

/**
 * Call one tool: `{ text, isError }` as the Worker answered it. A failure to get an answer at all
 * is thrown as a `CliFailure` saying what failed and, for a call that may have changed something,
 * that it may have gone through.
 */
export async function callTool(name, args = {}) {
  const { bearer, credential } = await credentials()
  // A mint that failed: the call still goes out without a broker token, so market and research
  // tools keep working, and an account tool's refusal is answered with this instead.
  let mintFailure
  let brokerToken
  try {
    brokerToken = await brokerAccessToken(bearer, credential)
  } catch (error) {
    if (!(error instanceof TastytradeAuthError)) throw error
    // A refused sign-in fails the app-grant mint too, and would fail the call the same way.
    if (error.code === 'spicytrade-401') throw new CliFailure(SIGNED_OUT)
    mintFailure = error
  }
  let sent = false
  let result
  try {
    result = resultOf(await request('tools/call', { arguments: args, name }, { bearer, brokerToken, sent: () => { sent = true } }), ToolResultSchema)
  } catch (error) {
    if (error instanceof CliFailure) throw error
    const mayHaveHappened = sent && !(error instanceof AgentTokenRefused) && !(error instanceof WorkerFault) && !neverSent(error)
    // Only a tool the Worker declares read-only is safe to try again; when that cannot be asked
    // either, the cautious answer stands.
    if (mayHaveHappened && !await listTools(bearer).then((tools) => tools.find((tool) => tool.name === name)?.annotations?.readOnlyHint === true, () => false)) {
      throw new CliFailure(BROKERAGE_TOOL.test(name) ? MAYBE_ORDERED : MAYBE_DONE)
    }
    throw new CliFailure(describeFailure(error, credential.kind))
  }
  const text = result.content.map((item) => item.text).filter((item) => item !== undefined).join('\n')
  if (result.isError && !brokerToken && text.startsWith(NO_BROKERAGE_PREFIX)) {
    return {
      isError: true,
      text: mintFailure
        ? describeFailure(mintFailure, credential.kind)
        : `tastytrade is not connected on this computer. Connect it with: ${cliCommand('connect')}`,
    }
  }
  return { isError: result.isError === true, text }
}

/** A description's first sentence: what a list of tools has room for. */
function firstSentence(description = '') {
  const end = description.search(/\.(\s|$)/)
  return end < 0 ? description : description.slice(0, end + 1)
}

/**
 * `spicytrade tools`: what the Worker told this caller about using it, then every tool it offers
 * them. `spicytrade tools <name>` is one tool in full, with the arguments `call` takes.
 */
export async function tools([name, ...extra], out = process.stdout) {
  if (extra.length) throw new CliFailure(`takes at most one tool name. Usage: ${cliCommand('tools [name]')}`)
  const { bearer } = await credentials()
  let listed
  let instructions
  try {
    [listed, instructions] = await Promise.all([
      listTools(bearer),
      name === undefined
        ? request('initialize', {
          capabilities: {}, clientInfo: { name: 'spicytrade', version: '1' }, protocolVersion: MCP_PROTOCOL_VERSION,
        }, { bearer }).then((reply) => resultOf(reply, InstructionsSchema).instructions)
        : undefined,
    ])
  } catch (error) {
    if (error instanceof CliFailure) throw error
    throw new CliFailure(describeFailure(error))
  }
  if (name === undefined) {
    if (instructions) out.write(`${instructions.trim()}\n\n`)
    out.write(`Tools. For one tool's arguments: ${cliCommand('tools <name>')}. To use one: ${cliCommand('call <name> \'<json arguments>\'')}\n\n`)
    const width = Math.max(...listed.map((tool) => tool.name.length))
    for (const tool of listed) {
      // Anything not declared read-only may change something: an order, a saved symbol.
      const changes = tool.annotations?.readOnlyHint === true ? '' : ' [changes things]'
      out.write(`  ${tool.name.padEnd(width)}  ${firstSentence(tool.description)}${changes}\n`)
    }
    return
  }
  const tool = listed.find((candidate) => candidate.name === name)
  if (!tool) throw new CliFailure(`there is no tool named "${name}". List them with: ${cliCommand('tools')}`)
  out.write(`${tool.name}\n\n${tool.description ?? ''}\n\nArguments (JSON Schema):\n${JSON.stringify(tool.inputSchema ?? {}, null, 2)}\n\n`
    + `Call it with: ${cliCommand(`call ${tool.name} '<json arguments>'`)}\n`)
}

/** The resource the Worker's instructions send every caller to (`GUIDE_URI` in `src/server/mcp.ts`). */
const GUIDE_URI = 'spicytrade://guide'
const ResourceSchema = z.looseObject({ contents: z.array(z.looseObject({ text: z.string().optional() })) })

/** `spicytrade guide`: the Worker's own guide to what it can answer, which its instructions point to. */
export async function guide(_args, out = process.stdout) {
  const { bearer } = await credentials()
  let read
  try {
    read = resultOf(await request('resources/read', { uri: GUIDE_URI }, { bearer }), ResourceSchema)
  } catch (error) {
    if (error instanceof CliFailure) throw error
    throw new CliFailure(describeFailure(error))
  }
  out.write(`${read.contents.map((item) => item.text).filter((item) => item !== undefined).join('\n').trim()}\n`)
}

async function readStdin() {
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text
}

/**
 * `spicytrade call <tool> [json]`: one tool call, its answer on stdout. The arguments are a JSON
 * object, `-` to read one from stdin, or nothing for a tool that takes none. A tool's own refusal
 * is its answer, written to stderr with exit status 1.
 */
export async function call([name, json = '{}', ...extra], out = process.stdout) {
  const usage = `Usage: ${cliCommand('call <tool> \'<json arguments>\'')}`
  if (name === undefined || extra.length) throw new CliFailure(`takes a tool name and its arguments as one JSON object. ${usage}`)
  let args
  try {
    args = z.record(z.string(), z.unknown()).parse(JSON.parse(json === '-' ? await readStdin() : json))
  } catch {
    throw new CliFailure(`the arguments are not a JSON object. ${usage}`)
  }
  const { isError, text } = await callTool(name, args)
  if (isError) {
    process.stderr.write(`${text}\n`)
    process.exitCode = 1
  } else {
    out.write(`${text}\n`)
  }
}
