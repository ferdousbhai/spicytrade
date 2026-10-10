#!/usr/bin/env node
import { createServer } from 'node:http'
import { z } from 'zod'

import { grantMinter, TastytradeAuthError } from './broker-grants.mjs'
import {
  cliCommand, LISTEN_HOST, PROXY_PORT, PROXY_URL, storeCredentialsCommand, UPSTREAM,
} from './config.mjs'
import { agentToken, APP_REFRESH_TOKEN_KEY, CLIENT_SECRET_KEY, REFRESH_TOKEN_KEY, TASTYTRADE, tastytradeCredentialKind } from './keyring.mjs'
import { tokenRetiresAt, UPSTREAM_TIMEOUT_MS } from './token-refresh.mjs'

/**
 * The brokerage credential broker for a local agent.
 *
 * spicytrade holds no member's brokerage credential, so one has to reach the Worker on each request.
 * It must not reach it through the agent: an MCP config's `${VAR}` interpolation reads the agent
 * process's own environment, which its Bash tool inherits, and a tastytrade refresh token never
 * expires and bypasses every spicytrade guard. One prompt-injected `printenv | curl` out of the
 * untrusted-content pipeline would be permanent, unguarded trading authority.
 *
 * So this runs as its own process. It reads the long-lived credential from the OS keyring,
 * exchanges it for a 15-minute access token, and attaches that to requests it forwards. The
 * agent points at this address and holds nothing secret at all.
 *
 * It is also why the 15-minute lifetime never surfaces: tastytrade sets it and it cannot be
 * raised, but re-minting happens here, ahead of expiry, so a long session never re-authenticates.
 *
 * A tastytrade credential comes in one of two kinds, a personal grant or an app grant (see
 * `keyring.mjs`). Either way only the 15-minute access token is attached to forwarded requests.
 * A keyring holding both is refused rather than resolved by a precedence rule: which account the
 * agent trades would otherwise turn on an ordering nobody chose.
 */

/** The only broker with an adapter that can place orders; also its keyring service name. */
const BROKER = TASTYTRADE
const PROGRAM = 'SpicytradeProxy'
// UPSTREAM_TIMEOUT_MS and TOKEN_REQUEST_TIMEOUT_MS live in token-refresh.mjs because importing
// this file starts the proxy (`await main()`), so the retirement test takes them from there.
// A mint runs before, and in addition to, the forwarded call's own UPSTREAM_TIMEOUT_MS, so a call
// that also mints can take up to the sum of the two.

let cachedAccess

/** The cached access token, or a fresh one from `mint`, retired ahead of its expiry. */
async function brokerAccessToken(mint) {
  if (cachedAccess && Date.now() < cachedAccess.expiresAt) return cachedAccess.token
  const { lifetimeSeconds, token } = await mint()
  cachedAccess = { expiresAt: tokenRetiresAt(Date.now(), lifetimeSeconds * 1_000), token }
  return token
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
 * What the agent is told when a request cannot be completed: which credential or party failed,
 * and the one command that fixes it. Every word is ours -- a status, an OS transport code, a
 * command -- never a value from a request or response, which can hold credential material.
 */
function failureFor(error, grantKind) {
  const doctor = cliCommand('doctor')
  if (error instanceof AgentTokenRefused || (error instanceof TastytradeAuthError && error.code === 'spicytrade-401')) {
    return {
      code: FAILURE_CODES.agentToken,
      message: `spicytrade rejected the agent token in this machine's keyring. Run: ${cliCommand('login')}`,
    }
  }
  if (error instanceof TastytradeAuthError && Number.isInteger(error.code)) {
    return {
      code: FAILURE_CODES.brokerGrant,
      message: grantKind === 'personal'
        ? `tastytrade refused this machine's personal grant (HTTP ${error.code}). Create a new grant on`
          + ` my.tastytrade.com and store it with: ${storeCredentialsCommand('tastytrade')}`
        : `tastytrade refused this machine's brokerage connection (HTTP ${error.code}). Reconnect with:`
          + ` ${cliCommand('connect-tastytrade')}`,
    }
  }
  if (error instanceof TastytradeAuthError && error.code === 'unreachable') {
    return {
      code: FAILURE_CODES.unreachable,
      message: `${error.party} could not be reached from this machine${error.transport ? ` (${error.transport})` : ''}.`
        + ` Check the network, then run: ${doctor}`,
    }
  }
  if (error instanceof Error && error.name === 'TimeoutError') {
    return {
      code: FAILURE_CODES.unreachable,
      message: `spicytrade did not answer within ${UPSTREAM_TIMEOUT_MS / 1_000} seconds. Run: ${doctor}`,
    }
  }
  if (error instanceof TypeError && error.cause instanceof Error && 'code' in error.cause) {
    return {
      code: FAILURE_CODES.unreachable,
      message: `spicytrade could not be reached from this machine (${String(error.cause.code)}).`
        + ` Check the network, then run: ${doctor}`,
    }
  }
  return { code: FAILURE_CODES.other, message: `The spicytrade proxy could not complete this request. Run: ${doctor}` }
}

/** A single JSON-RPC request: all this needs of one is its id, so the error can answer it. */
const JsonRpcRequestSchema = z.object({ id: z.union([z.string(), z.number()]) })

/** The JSON-RPC id of a single request body; null for a notification, a batch, or no body. */
function requestId(body) {
  if (!body?.length) return null
  let message
  try {
    message = JSON.parse(body.toString())
  } catch {
    return null
  }
  const parsed = JsonRpcRequestSchema.safeParse(message)
  return parsed.success ? parsed.data.id : null
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  return Buffer.concat(chunks)
}

async function main() {
  const agentBearer = await agentToken(PROGRAM)
  if (!agentBearer) {
    process.stderr.write(`${PROGRAM}: no spicytrade token in the keyring. Sign this machine in with:\n`
      + `  ${cliCommand('login')}\n`)
    process.exit(1)
  }
  const credential = await tastytradeCredentialKind(PROGRAM)
  if (credential.kind === 'ambiguous') {
    process.stderr.write(
      `${PROGRAM}: the keyring holds both a tastytrade app grant (${BROKER}/${APP_REFRESH_TOKEN_KEY})\n`
      + `and a personal grant (${BROKER}/${CLIENT_SECRET_KEY}, ${BROKER}/${REFRESH_TOKEN_KEY}). Remove one kind:\n`
      + `  secret-tool clear service ${BROKER} key ${APP_REFRESH_TOKEN_KEY}\n`
      + 'or\n'
      + `  secret-tool clear service ${BROKER} key ${CLIENT_SECRET_KEY}\n`
      + `  secret-tool clear service ${BROKER} key ${REFRESH_TOKEN_KEY}\n`,
    )
    process.exit(1)
  }
  // Brokerage credentials are optional: without them this still forwards the market and
  // research surface, and the Worker answers account tools with its own connect-a-brokerage
  // message. Starting anyway beats refusing to run for a capability the user may not want.
  const mint = grantMinter(agentBearer, credential)
  if (!mint) {
    process.stderr.write(`${PROGRAM}: no brokerage credential in the keyring; forwarding market tools only\n`)
  }

  // DNS rebinding: a web page can resolve its own name to 127.0.0.1 and reach this port from the
  // browser, and every request here leaves carrying the spicytrade token and a broker token. A
  // browser always sends that page's name as Host, and sends Origin on a cross-origin request;
  // an MCP client does neither, so a request naming any other host, or carrying an Origin at
  // all, is refused before anything is attached.
  const allowedHosts = new Set([`${LISTEN_HOST}:${PROXY_PORT}`, `localhost:${PROXY_PORT}`])

  const server = createServer((request, response) => {
    if (!allowedHosts.has(request.headers.host ?? '') || request.headers.origin !== undefined) {
      request.resume()
      response.writeHead(403, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'The spicytrade proxy only answers local MCP clients' }))
      return
    }
    void (async () => {
      let body
      try {
        body = request.method === 'GET' || request.method === 'HEAD'
          ? undefined
          : await readBody(request)
        const headers = new Headers({ Authorization: `Bearer ${agentBearer}` })
        // Node gives a repeated header as an array; MCP sends none of these more than once,
        // so the first value is the whole value.
        for (const name of ['accept', 'content-type', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']) {
          const raw = request.headers[name]
          const value = Array.isArray(raw) ? raw[0] : raw
          if (value) headers.set(name, value)
        }
        if (mint) {
          // Still the pre-rename header names: a member's proxy can update before the Worker that
          // reads `X-Spicy-Trade-Broker*` is deployed, and the Worker accepts both. Switch these
          // once that Worker is live; the Worker drops the old names after proxies have moved.
          headers.set('X-Spice-Broker', BROKER)
          headers.set('X-Spice-Broker-Token', await brokerAccessToken(mint))
        }
        const upstream = await fetch(UPSTREAM, {
          body,
          headers,
          method: request.method,
          signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        })
        // A 401 here refuses this process's own token, not anything the client sent. Relayed
        // as-is it would read to an MCP client as "authenticate to this server", and send it
        // hunting for an OAuth flow the proxy does not have, instead of saying what to run.
        if (upstream.status === 401) {
          await upstream.body?.cancel()
          throw new AgentTokenRefused(upstream.status)
        }
        const responseHeaders = { 'content-type': upstream.headers.get('content-type') ?? 'application/json' }
        for (const name of ['mcp-session-id', 'mcp-protocol-version']) {
          const value = upstream.headers.get(name)
          if (value) responseHeaders[name] = value
        }
        response.writeHead(upstream.status, responseHeaders)
        // Streamed rather than buffered: MCP replies over text/event-stream and a buffered
        // proxy would hold a long tool call's response until it finished.
        if (upstream.body) {
          for await (const chunk of upstream.body) response.write(chunk)
        }
        response.end()
      } catch (error) {
        // Name and, for a transport failure, the OS-level cause code -- `ENOTFOUND`,
        // `ECONNREFUSED`, `UND_ERR_CONNECT_TIMEOUT` -- or a token exchange's status or fixed code.
        // All are fixed vocabulary, never content, and they are what separates "this machine
        // could not reach the Worker" or "the broker refused the grant" from a bug in here:
        // undici reports every network failure as an indistinguishable `TypeError`.
        const name = error instanceof Error ? error.name : 'UnknownError'
        const detail = error instanceof TastytradeAuthError || error instanceof AgentTokenRefused
          ? ` ${String(error.code)}${error.transport ? ` ${error.transport}` : ''}`
          : error instanceof Error && error.cause instanceof Error && 'code' in error.cause
            ? ` ${String(error.cause.code)}`
            : ''
        process.stderr.write(`${PROGRAM}: ${request.method} ${name}${detail}\n`)
        // Once the upstream status and headers are relayed -- an event stream already under way,
        // then the timeout or a dropped connection -- a JSON error written now would arrive as the
        // tail of that stream and end it cleanly, reading as a complete reply. Cutting the
        // connection is the only signal left that the reply is incomplete.
        if (response.headersSent) {
          response.destroy()
          return
        }
        // A JSON-RPC error, so an MCP client shows the agent the message -- the credential that
        // failed and the command that fixes it -- rather than a bare status. Always 502: this
        // process is the gateway, and whatever failed was upstream of it or a credential it holds,
        // never something the client can correct by authenticating (see the 401 note above).
        response.writeHead(502, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: failureFor(error, credential.kind), id: requestId(body), jsonrpc: '2.0' }))
      }
    })()
  })

  // Loopback only. This process holds a credential that grants trading, so it must never be
  // reachable from the network, only from processes on this machine.
  server.listen(PROXY_PORT, LISTEN_HOST, () => {
    process.stdout.write(`${PROGRAM}: ${PROXY_URL} -> ${UPSTREAM}\n`)
  })
}

await main()
