import {
  AGENT_LOGIN_INVALID_GRANT,
  AGENT_LOGIN_RANDOM_BYTES,
  AGENT_LOGIN_TTL_MS,
  AgentLoginApproveRequestSchema,
  AgentLoginExchangeRequestSchema,
  MAX_PENDING_AGENT_LOGINS_PER_USER,
} from '../domain/agent-login'
import { getAuthenticatedIdentity } from './auth'
import { randomBase64Url, sha256Base64Url } from './digest'
import { type AppEnv } from './env'
import { authenticateRequest, jsonNoStore } from './http'
import {
  authenticateMcpToken,
  constantTimeDigestMatch,
  issueMcpToken,
  McpTokenLimitError,
  revokeMcpToken,
} from './mcp-tokens'
import { ConfigurationError } from './secrets'
import { errorName, toError } from '../domain/failure'

/*
 * The browser sign-in for a member's terminal (`spicytrade login`); the wire contract and why it
 * keeps the token out of every URL are in `src/domain/agent-login.ts`.
 *
 *   approve   the signed-in member, on `/connect/agent`, opens a pending row and gets a one-time
 *             code for the page to hand to the CLI's loopback listener;
 *   exchange  the CLI redeems code and verifier for a fresh agent token.
 *
 * Approval is the member's session and nothing else: the page posts it same-origin, so a site
 * that links a signed-in member to `/connect/agent` still needs them to press Approve, and the
 * code it yields goes only to the loopback port on the member's own machine. Redemption is
 * unauthenticated by design -- the CLI has no credential yet, which is the point of the flow --
 * and is bound instead by the verifier, which only the CLI that opened the page ever held.
 */

const unavailable = () => jsonNoStore({ error: 'Agent sign-in is unavailable' }, { status: 503 })
const invalidGrant = () => jsonNoStore({ error: AGENT_LOGIN_INVALID_GRANT }, { status: 400 })


/**
 * Record the signed-in member's approval and return the one-time code. Only the code's digest is
 * kept, so a database read cannot be redeemed.
 */
export async function approveAgentLogin(
  request: Request,
  env: AppEnv,
  now = new Date(),
  readIdentity = getAuthenticatedIdentity,
): Promise<Response> {
  const authenticated = await authenticateRequest(request, env, true, readIdentity)
  if ('response' in authenticated) return authenticated.response
  if (!env.DB) return unavailable()
  const parsed = AgentLoginApproveRequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return jsonNoStore({ error: 'Invalid agent sign-in request' }, { status: 400 })
  const userId = authenticated.identity.id
  try {
    const code = randomBase64Url(AGENT_LOGIN_RANDOM_BYTES)
    const nowIso = now.toISOString()
    // The member's lapsed approvals go first so they never count against the cap, and the cap is
    // checked inside the insert: two concurrent approvals that each counted a free slot would
    // otherwise both insert.
    const [, inserted] = await env.DB.batch([
      env.DB.prepare('DELETE FROM agent_logins WHERE user_id = ? AND expires_at <= ?').bind(userId, nowIso),
      env.DB.prepare(
        `INSERT INTO agent_logins (code_digest, user_id, code_challenge, label, created_at, expires_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM agent_logins WHERE user_id = ?) < ?`,
      ).bind(
        await sha256Base64Url(code),
        userId,
        parsed.data.codeChallenge,
        parsed.data.label,
        nowIso,
        new Date(now.getTime() + AGENT_LOGIN_TTL_MS).toISOString(),
        userId,
        MAX_PENDING_AGENT_LOGINS_PER_USER,
      ),
    ])
    if (!inserted?.meta.changes) {
      return jsonNoStore({
        error: `At most ${MAX_PENDING_AGENT_LOGINS_PER_USER} terminal sign-ins may be pending at once. Wait a few minutes and try again.`,
      }, { status: 409 })
    }
    return jsonNoStore({ code })
  } catch (error) {
    console.error('AgentLoginApproveFailed', errorName(toError(error)))
    return unavailable()
  }
}

/**
 * Redeem a code for an agent token, once. The row is consumed before the verifier is checked, so
 * a wrong verifier spends the code: guessing gets one try per approval the member made.
 *
 * `previousToken` is the token the CLI already held for this machine. When it is the same
 * member's, it is revoked, so signing in again replaces a machine's token rather than adding one
 * until the per-member cap refuses. Anything else presented there -- malformed, revoked, another
 * member's -- is ignored rather than refused: it grants nothing, and refusing would cost the
 * member a sign-in they approved over a token they are trying to replace. It is revoked after
 * the new token exists, unless the cap leaves no room for the new one first.
 */
export async function exchangeAgentLogin(request: Request, env: AppEnv, now = new Date()): Promise<Response> {
  if (!env.DB) return unavailable()
  const database = env.DB
  const parsed = AgentLoginExchangeRequestSchema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return jsonNoStore({ error: 'Invalid agent sign-in exchange' }, { status: 400 })
  try {
    const consumed = await database.prepare(
      `DELETE FROM agent_logins
        WHERE code_digest = ? AND expires_at > ?
        RETURNING user_id, code_challenge, label`,
    ).bind(await sha256Base64Url(parsed.data.code), now.toISOString())
      .first<{ code_challenge: string; label: string; user_id: string }>()
    if (!consumed) return invalidGrant()
    if (!await constantTimeDigestMatch(await sha256Base64Url(parsed.data.codeVerifier), consumed.code_challenge)) {
      return invalidGrant()
    }
    const userId = consumed.user_id

    const previous = parsed.data.previousToken
      ? await authenticateMcpToken(database, parsed.data.previousToken, now)
      : undefined
    const replaced = previous?.userId === userId ? previous.tokenId : undefined

    let issued: Awaited<ReturnType<typeof issueMcpToken>>
    try {
      issued = await issueMcpToken(database, userId, consumed.label, now)
    } catch (error) {
      if (!(error instanceof McpTokenLimitError) || !replaced) throw error
      await revokeMcpToken(database, userId, replaced)
      issued = await issueMcpToken(database, userId, consumed.label, now)
    }
    if (replaced) await revokeMcpToken(database, userId, replaced)
    // The plaintext token is in this response and nowhere else, ever again.
    return jsonNoStore(issued)
  } catch (error) {
    console.error('AgentLoginExchangeFailed', errorName(toError(error)))
    if (error instanceof McpTokenLimitError) return jsonNoStore({ error: error.message }, { status: 409 })
    return unavailable()
  }
}

/**
 * Drop approvals that lapsed unredeemed. A member's own lapsed rows also go whenever they approve
 * another; this catches the ones whose CLI never came back. A lapsed row can no longer be
 * redeemed, so deleting it loses nothing.
 */
export async function sweepExpiredAgentLogins(env: AppEnv, now = new Date()): Promise<number> {
  // Scheduled only: a missing binding is a misconfiguration to name, not a sweep of zero rows.
  if (!env.DB) throw new ConfigurationError('BindingMissing', 'DB')
  const result = await env.DB.prepare('DELETE FROM agent_logins WHERE expires_at <= ?').bind(now.toISOString()).run()
  return result.meta.changes ?? 0
}
