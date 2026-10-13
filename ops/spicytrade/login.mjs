import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { z } from 'zod'

import { transportCode } from './broker-grants.mjs'
import { cliCommand, ORIGIN } from './config.mjs'
import { agentToken, KeyringUnavailable, storeAgentToken } from './keyring.mjs'
import { awaitReturn, CliFailure, loopbackListener, openBrowser, remoteNote, unexpectedTail } from './loopback.mjs'
import { UPSTREAM_TIMEOUT_MS } from './token-refresh.mjs'

/**
 * `spicytrade login`: sign this machine in to spicytrade from a browser, and keep the agent
 * token it is issued in the OS keyring, where `spicytrade mcp` reads it.
 *
 * The member approves on spicytrade's `/connect/agent` page, already signed in there; the page
 * sends the browser back to a listener here with a one-time code; this process redeems the code
 * for the token. The token itself never rides in a URL or the browser's history -- only the code
 * does, and the code is bound to a verifier that never leaves this process (PKCE, RFC 7636, with
 * S256), so a code read out of an address bar or a log is worth nothing. The state guards the
 * listener: a return this run did not start is refused.
 *
 * Output is fixed vocabulary. No token, code, verifier or state is printed; the approval URL is,
 * because following it is the whole point, and nothing in it grants anything on its own.
 */

const PROGRAM = 'SpicytradeLogin'

/**
 * 32 random bytes, as the Worker's contract (`AGENT_LOGIN_RANDOM_BYTES` in
 * `src/domain/agent-login.ts`) expects of the state and the verifier.
 */
const RANDOM_BYTES = 32

/**
 * How long to wait for the member to approve. It covers signing in to spicytrade with Google
 * first, the slowest thing a member does on that page, and matches how long a started tastytrade
 * connection stays redeemable (`BROKER_AUTHORIZATION_TTL_MS`). A product judgment.
 */
const APPROVAL_WAIT_MS = 10 * 60_000

/**
 * The label the Connect tab lists this machine's token under. The Worker bounds a label at
 * `MAX_MCP_TOKEN_LABEL_LENGTH` (`src/domain/mcp-tokens.ts`); this is that number, since this
 * package cannot import the Worker's source.
 */
const MAX_LABEL_LENGTH = 60
const FALLBACK_LABEL = 'This computer'

const ExchangeResponseSchema = z.object({ token: z.string().min(1) })

function machineLabel() {
  return hostname().trim().slice(0, MAX_LABEL_LENGTH).trim() || FALLBACK_LABEL
}

/**
 * Redeem the code. One Worker call, so it gets the same budget as one forwarded MCP call. A
 * refusal is described by its status in this CLI's own words, never the answer's body.
 */
async function exchange(code, codeVerifier, previousToken) {
  const body = { code, codeVerifier }
  if (previousToken) body.previousToken = previousToken
  let response
  try {
    response = await fetch(new URL('/api/agent-logins/exchange', ORIGIN), {
      body: JSON.stringify(body),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      method: 'POST',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (error) {
    // The cause's own word -- ENOTFOUND, ECONNREFUSED, TimeoutError -- not fetch's bare TypeError.
    const cause = transportCode(error)
    throw new CliFailure(`spicytrade could not be reached${cause ? ` (${cause})` : ''}. Check your internet connection, then run: ${cliCommand('setup')}`)
  }
  const payload = await response.json().catch(() => undefined)
  if (response.status === 400) {
    throw new CliFailure(`the sign-in expired or was already used. Run: ${cliCommand('setup')}`)
  }
  if (response.status === 409) {
    throw new CliFailure('your account has the most signed-in computers allowed. Revoke one you no longer use under'
      + ` "Signed-in computers" at ${ORIGIN}/connect, then run: ${cliCommand('setup')}`)
  }
  if (!response.ok) throw new CliFailure(`spicytrade could not finish the sign-in (HTTP ${response.status}). Try again with: ${cliCommand('setup')}`)
  const parsed = ExchangeResponseSchema.safeParse(payload)
  if (!parsed.success) throw new CliFailure(`spicytrade answered the sign-in with an unreadable response. ${unexpectedTail()}`)
  return parsed.data.token
}

/** Sign in and store the token. Progress goes to `out`. */
export async function login(out = process.stdout) {
  // The token this machine held before, if any, goes with the exchange so the Worker can retire
  // it: signing in again replaces this machine's token instead of adding a second one.
  const previousToken = await agentToken()
  const state = randomBytes(RANDOM_BYTES).toString('base64url')
  const codeVerifier = randomBytes(RANDOM_BYTES).toString('base64url')
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url')

  const listener = await loopbackListener(PROGRAM, {
    forbidden: 'This listener only answers the spicytrade sign-in.',
    // Said before the code is redeemed, so it promises nothing the terminal may yet refuse.
    received: 'Approved. Return to the terminal to finish.',
    refused: 'Sign-in cancelled. You can close this tab.',
  })
  listener.expect(state)
  const approval = new URL('/connect/agent', ORIGIN)
  approval.search = new URLSearchParams({
    challenge,
    label: machineLabel(),
    port: String(listener.port),
    state,
  }).toString()

  out.write(`Sign in to spicytrade and approve this computer:\n${remoteNote(listener.port)}\n  ${approval}\n\n`)
  openBrowser(approval.toString())

  const outcome = await awaitReturn(listener, APPROVAL_WAIT_MS)
  if (outcome.lapsed) {
    throw new CliFailure(`the sign-in was not approved within ${APPROVAL_WAIT_MS / 60_000} minutes. Run: ${cliCommand('setup')}`)
  }
  if (outcome.error === 'access_denied') {
    throw new CliFailure(`sign-in cancelled in the browser. To try again, run: ${cliCommand('setup')}`)
  }
  if (outcome.error) throw new CliFailure(`spicytrade did not approve this computer (${outcome.error}). Try again with: ${cliCommand('setup')}`)

  const token = await exchange(outcome.code, codeVerifier, previousToken)
  if (!await storeAgentToken(token)) throw new KeyringUnavailable()
  out.write('✓ Signed in.\n')
}
