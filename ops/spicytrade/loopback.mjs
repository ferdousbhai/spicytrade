import { spawn } from 'node:child_process'
import { timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { hostname } from 'node:os'

import { cliCommand, LISTEN_HOST, reconnectHow } from './config.mjs'

/**
 * The browser round trip both sign-ins share: `spicytrade login` (spicytrade approves this
 * machine) and `connect-tastytrade` (tastytrade approves spicytrade). The member approves in a
 * browser, and the browser is sent back to a one-shot listener here on the loopback address with
 * a code and the state this run chose or was given.
 */

const CALLBACK_PATH = '/callback'

// The codes RFC 6749 §4.1.2.1 defines for a refused authorization. Anything else a return
// carries is reported without its text, since the text is not ours.
const OAUTH_ERRORS = new Set([
  'access_denied', 'invalid_request', 'invalid_scope', 'server_error', 'temporarily_unavailable',
  'unauthorized_client', 'unsupported_response_type',
])

/**
 * Each agent session reads the keyring when it launches `spicytrade mcp`, so a credential change
 * reaches a session already running only once it reconnects.
 */
export function reconnectNote(clients) {
  return `An agent session that is already running picks this up once it reconnects: ${reconnectHow(clients)}.\n`
}

/** The port the last listener in this run bound; the next one tries it first (see `remoteNote`). */
let lastPort
/** The port `remoteNote` last told the member to forward. */
let forwardedPort

/**
 * The end of a failure this CLI cannot explain -- an answer it could not read -- so the member
 * still has a next step. The site's support address is `SUPPORT_EMAIL` in `src/domain/site.ts`.
 */
export function unexpectedTail() {
  return `Try again with: ${cliCommand('setup')} -- if it happens again, write to support@spicy.trade`
}

/** A command-line failure: its message is printed after the program's name, and the run exits 1. */
export class CliFailure extends Error {
  constructor(message) {
    super(message)
    this.name = 'CliFailure'
  }
}

/** Constant-time equality for two strings, so a probe cannot learn the state a byte at a time. */
function sameState(presented, expected) {
  const left = Buffer.from(presented ?? '')
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

function page(response, status, text) {
  response.writeHead(status, {
    'cache-control': 'no-store',
    // One return is all this listener serves, so no browser connection is kept open past it.
    connection: 'close',
    'content-type': 'text/plain; charset=utf-8',
    'referrer-policy': 'no-referrer',
  })
  response.end(`${text}\n`)
}

/**
 * Listen on an ephemeral loopback port and resolve with the port and a promise of the browser's
 * return: `{ code }` or `{ error }`. `expectedState` is set once it is known -- chosen here for a
 * login, issued by the Worker for a broker connection. `pages` is what the browser tab reads:
 * `{ forbidden, received, refused }`. `program` prefixes the one line a mismatched return logs.
 */
export async function loopbackListener(program, pages) {
  let expectedState
  let settle
  const returned = new Promise((resolve) => { settle = resolve })
  let port
  const server = createServer((request, response) => {
    // DNS rebinding: a page can resolve its own name to 127.0.0.1 and reach this
    // port from the browser. The real return is a top-level navigation to this address, which
    // names it as Host and carries no Origin.
    const allowedHosts = new Set([`${LISTEN_HOST}:${port}`, `localhost:${port}`])
    if (!allowedHosts.has(request.headers.host ?? '') || request.headers.origin !== undefined) {
      request.resume()
      page(response, 403, pages.forbidden)
      return
    }
    const url = new URL(request.url ?? '/', `http://${LISTEN_HOST}:${port}`)
    if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH || !expectedState) {
      page(response, 404, 'Not found.')
      return
    }
    if (!sameState(url.searchParams.get('state'), expectedState)) {
      // Not this run's return. Refused, and the real one can still arrive.
      process.stderr.write(`${program}: ignored a return whose state did not match this run\n`)
      page(response, 400, 'This return does not belong to the sign-in in progress.')
      return
    }
    const error = url.searchParams.get('error')
    const code = url.searchParams.get('code')
    if (error || !code) {
      page(response, 200, pages.refused)
      settle({ error: error && OAUTH_ERRORS.has(error) ? error : 'unrecognized' })
      return
    }
    page(response, 200, pages.received)
    settle({ code })
  })
  const listen = (wanted) => new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(wanted, LISTEN_HOST, () => {
      server.off('error', reject)
      resolve()
    })
  })
  // The port an earlier sign-in in this run used, if it is free, so one SSH forward serves both.
  if (!lastPort || await listen(lastPort).then(() => false, () => true)) await listen(0)
  port = server.address().port
  lastPort = port
  return {
    close: () => {
      server.close()
      server.closeAllConnections()
    },
    expect: (state) => { expectedState = state },
    port,
    returned,
  }
}

/**
 * Wait for the browser's return, but no longer than `waitMs`; resolves `{ lapsed: true }` then.
 * The listener is closed either way.
 */
export async function awaitReturn(listener, waitMs, { skippable = false } = {}) {
  let timer
  const lapsed = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ lapsed: true }), Math.max(0, waitMs))
  })
  // A wait the member may walk away from: Ctrl-C ends the wait, not the program.
  let onInterrupt
  const skipped = new Promise((resolve) => {
    onInterrupt = () => resolve({ skipped: true })
    if (skippable) process.once('SIGINT', onInterrupt)
  })
  try {
    return await Promise.race([listener.returned, lapsed, skipped])
  } finally {
    clearTimeout(timer)
    process.off('SIGINT', onInterrupt)
    listener.close()
  }
}

/**
 * Over SSH, the approval returns to `127.0.0.1:<port>` in whichever browser opens the link -- on
 * the member's own computer, that computer's loopback, not this one's. Forwarding the listener's
 * port makes the link work there; the port is known only once the listener is up, so it is named.
 */
export function remoteNote(port) {
  if (!process.env.SSH_CONNECTION) return ''
  if (port === forwardedPort) return 'Over SSH: this uses the port you already forwarded; open the link below on your own computer.\n'
  forwardedPort = port
  return `Over SSH, first forward the approval back here -- in a new terminal on your own computer, run:\n`
    + `  ssh -L ${port}:127.0.0.1:${port} ${hostname()}\n(or the address you SSH to), then open the link below there.\n`
}

/** Best effort: the printed URL is the path, so failing to open a browser is not a failure. */
export function openBrowser(url) {
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(opener, [url], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The URL is already on screen.
  }
}
