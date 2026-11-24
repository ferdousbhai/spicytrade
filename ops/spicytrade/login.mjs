import { createHash, randomBytes } from 'node:crypto'
import { hostname } from 'node:os'
import { z } from 'zod'

import { CliFailure, openBrowser, pollUntil, unexpectedTail } from './cli.mjs'
import { cliCommand, ORIGIN } from './config.mjs'
import { agentToken, KeyringUnavailable, storeAgentToken } from './keyring.mjs'
import { UPSTREAM_TIMEOUT_MS } from './token-refresh.mjs'
import { postWorker } from './worker.mjs'

/**
 * Signing this machine in to spicytrade: one link, approved in any browser, and the agent token
 * it yields kept in the OS keyring, where `spicytrade call` reads it.
 *
 * The link carries the SHA-256 of a verifier that never leaves this process (S256, as in RFC
 * 7636). The member approves on spicytrade's `/connect/agent` page, signed in there, on this
 * computer or any other device; this process polls with the verifier and is handed the token
 * once they have. Nothing has to find its way back to this computer through the browser, so the
 * same link works over SSH and from a phone. In exchange, the page cannot know its browser is the
 * member's own, so the link approves nothing by itself: the member types the code printed here,
 * which the link does not contain.
 *
 * With `tastytrade`, the same approval continues to tastytrade's consent page, and
 * `collectTastytrade` picks the grant up with the session this returns.
 *
 * Output is fixed vocabulary. No token or verifier is printed; the link is, because following
 * it is the whole point, and nothing in it grants anything on its own.
 */

/**
 * 32 random bytes, as the Worker's contract (`AGENT_LOGIN_RANDOM_BYTES` in
 * `src/domain/agent-login.ts`) expects of the verifier.
 */
const RANDOM_BYTES = 32

/**
 * How long to wait for the member to approve. It covers signing in to spicytrade with Google
 * first, the slowest thing a member does on that page, and matches how long a started tastytrade
 * connection stays redeemable (`BROKER_CONSENT_TTL_MS`). A product judgment.
 */
const APPROVAL_WAIT_MS = 10 * 60_000

/**
 * The label the Connect tab lists this machine's token under. The Worker bounds a label at
 * `MAX_MCP_TOKEN_LABEL_LENGTH` (`src/domain/mcp-tokens.ts`); this is that number, since this
 * package cannot import the Worker's source.
 */
const MAX_LABEL_LENGTH = 60
const FALLBACK_LABEL = 'This computer'

/** The brokerage the approval page continues to (`BrokerIdSchema` in `src/domain/broker.ts`). */
const TASTYTRADE_BROKER_ID = 'tastytrade'

const ExchangeResponseSchema = z.object({ token: z.string().min(1) })

function machineLabel() {
  return hostname().trim().slice(0, MAX_LABEL_LENGTH).trim() || FALLBACK_LABEL
}

/** The code is this many random bytes in hex (`CONNECT_CODE_BYTES` in `src/domain/agent-login.ts`). */
const CODE_BYTES = 4

/**
 * What the link carries in place of the code, so the Worker can check what the member types
 * without the link giving the code away; `connectCodeCheck` in `src/domain/agent-login.ts` is
 * the Worker's copy.
 */
function connectCodeCheck(challenge, code) {
  return createHash('sha256').update(`${challenge}:${code}`).digest('base64url')
}

/**
 * Ask once whether the member has approved: the token when they have, undefined while they have
 * not. One Worker call, so it gets the same budget as one MCP call. A refusal is
 * described by its status in this CLI's own words, never the answer's body.
 */
async function collect(codeVerifier, previousToken) {
  const body = { codeVerifier }
  if (previousToken) body.previousToken = previousToken
  const response = await postWorker('/api/agent-logins/exchange', body, UPSTREAM_TIMEOUT_MS)
  if (response.status === 202) return undefined
  if (response.status === 409) {
    throw new CliFailure('your account has the most signed-in computers allowed. Revoke one you no longer use under'
      + ` "Signed-in computers" at ${ORIGIN}/connect, then run: ${cliCommand('connect')}`)
  }
  if (!response.ok) throw new CliFailure(`spicytrade could not finish the sign-in (HTTP ${response.status}). Try again with: ${cliCommand('connect')}`)
  const parsed = ExchangeResponseSchema.safeParse(response.payload)
  if (!parsed.success) throw new CliFailure(`spicytrade answered the sign-in with an unreadable response. ${unexpectedTail()}`)
  return parsed.data.token
}

/**
 * Sign in and store the token; resolves the session `collectTastytrade` needs when `tastytrade`
 * was asked for. Progress goes to `out`.
 */
export async function login(out = process.stdout, { tastytrade = false } = {}) {
  // The token this machine held before, if any, goes with the exchange so the Worker can retire
  // it: signing in again replaces this machine's token instead of adding a second one.
  const previousToken = await agentToken()
  const codeVerifier = randomBytes(RANDOM_BYTES).toString('base64url')
  const challenge = createHash('sha256').update(codeVerifier).digest('base64url')
  // Printed here and typed into the page; it is never part of the link.
  const code = randomBytes(CODE_BYTES).toString('hex').toUpperCase()

  const approval = new URL('/connect/agent', ORIGIN)
  approval.searchParams.set('challenge', challenge)
  approval.searchParams.set('check', connectCodeCheck(challenge, code))
  approval.searchParams.set('label', machineLabel())
  if (tastytrade) approval.searchParams.set('broker', TASTYTRADE_BROKER_ID)

  out.write(`Open this link in any browser, on this computer or another device, and enter code ${code.slice(0, CODE_BYTES)}-${code.slice(CODE_BYTES)} there:\n  ${approval}\n\n`)
  openBrowser(approval.toString())

  const collected = await pollUntil(async () => {
    const token = await collect(codeVerifier, previousToken)
    return token && { token }
  }, APPROVAL_WAIT_MS)
  if (collected.lapsed) {
    throw new CliFailure(`the link was not approved within ${APPROVAL_WAIT_MS / 60_000} minutes. Run: ${cliCommand('connect')}`)
  }
  if (!await storeAgentToken(collected.token)) throw new KeyringUnavailable()
  out.write('✓ Signed in.\n')
  return { agentBearer: collected.token, codeVerifier }
}
