import {
  AGENT_LOGIN_TTL_MS,
  AgentLoginApproveRequestSchema,
  AgentLoginExchangeRequestSchema,
  MAX_PENDING_AGENT_LOGINS_PER_USER,
} from '../domain/agent-login'
import { getAuthenticatedIdentity } from './auth'
import { openTastytradeConsent } from './broker-authorizations'
import { sha256Base64Url } from './digest'
import { type AppEnv } from './env'
import { authenticateRequest, jsonNoStore } from './http'
import {
  authenticateMcpToken,
  issueMcpToken,
  McpTokenLimitError,
  presentedBearer,
  revokeMcpToken,
} from './mcp-tokens'
import { ConfigurationError } from './secrets'
import { errorName, toError } from '../domain/failure'

/*
 * Connecting a member's computer; the wire contract and what replaces a return to that computer
 * are in `src/domain/agent-login.ts`.
 *
 *   approve   the signed-in member, on `/connect/agent`, records the approval under the
 *             challenge in the link, and starts the brokerage consent when the link asks for one;
 *   exchange  the CLI, polling with the verifier, collects a fresh agent token;
 *   sign out  the CLI, uninstalling, revokes the token it presents -- that token and no other.
 *
 * Approval is the member's session and nothing else: the page posts it same-origin, so a site
 * that links a signed-in member to `/connect/agent` still needs them to press Approve. Collection
 * is unauthenticated by design -- the CLI has no credential yet, which is the point of the flow --
 * and is bound instead by the verifier, which only the CLI that printed the link ever held.
 */

const unavailable = () => jsonNoStore({ error: "spicytrade can't sign in computers right now. Try again in a minute." }, { status: 503 })

/**
 * Record the signed-in member's approval. With a brokerage, its consent is opened first and its
 * address returned: a consent that cannot be opened leaves nothing approved, so the member is
 * never signed in on a link that promised a brokerage and could not deliver one.
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
  const { broker, codeChallenge, label } = parsed.data
  try {
    const authorizationUrl = broker ? await openTastytradeConsent(env, userId, codeChallenge, now) : undefined
    if (authorizationUrl instanceof Response) return authorizationUrl
    const nowIso = now.toISOString()
    // The member's lapsed approvals go first so they never count against the cap, and the cap is
    // checked inside the insert: two concurrent approvals that each counted a free slot would
    // otherwise both insert. Approving one link twice replaces the first approval.
    const [, , inserted] = await env.DB.batch([
      env.DB.prepare('DELETE FROM agent_approvals WHERE user_id = ? AND expires_at <= ?').bind(userId, nowIso),
      env.DB.prepare('DELETE FROM agent_approvals WHERE challenge = ?').bind(codeChallenge),
      env.DB.prepare(
        `INSERT INTO agent_approvals (challenge, user_id, label, created_at, expires_at)
         SELECT ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM agent_approvals WHERE user_id = ?) < ?`,
      ).bind(
        codeChallenge,
        userId,
        label,
        nowIso,
        new Date(now.getTime() + AGENT_LOGIN_TTL_MS).toISOString(),
        userId,
        MAX_PENDING_AGENT_LOGINS_PER_USER,
      ),
    ])
    if (!inserted?.meta.changes) {
      return jsonNoStore({
        error: `At most ${MAX_PENDING_AGENT_LOGINS_PER_USER} computer sign-ins may be pending at once. Wait a few minutes and try again.`,
      }, { status: 409 })
    }
    return jsonNoStore(authorizationUrl ? { authorizationUrl } : {})
  } catch (error) {
    console.error('AgentLoginApproveFailed', errorName(toError(error)))
    return unavailable()
  }
}

/**
 * Collect an approved sign-in's agent token, once. The row is found by the digest of the
 * verifier presented, so only the CLI that printed the link can collect it, and a poll before
 * the member approves is indistinguishable from one for a link nobody will ever approve: both
 * are pending, which says nothing about which challenges exist.
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
      `DELETE FROM agent_approvals
        WHERE challenge = ? AND expires_at > ?
        RETURNING user_id, label`,
    ).bind(await sha256Base64Url(parsed.data.codeVerifier), now.toISOString())
      .first<{ label: string; user_id: string }>()
    if (!consumed) return jsonNoStore({ pending: true }, { status: 202 })
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
 * A computer signing itself out: the bearer token it presents is revoked, and only that one, so
 * holding a token is authority over nothing but itself. An unknown or already revoked token is the
 * same 401 as any refused token.
 */
export async function signOutAgentLogin(request: Request, env: AppEnv, now = new Date()): Promise<Response> {
  if (!env.DB) return unavailable()
  const presented = presentedBearer(request)
  try {
    const identity = presented ? await authenticateMcpToken(env.DB, presented, now) : undefined
    if (!identity) return jsonNoStore({ error: 'This computer is not signed in.' }, { status: 401 })
    await revokeMcpToken(env.DB, identity.userId, identity.tokenId)
    return new Response(null, { headers: { 'cache-control': 'no-store' }, status: 204 })
  } catch (error) {
    console.error('AgentSignOutFailed', errorName(toError(error)))
    return unavailable()
  }
}

/**
 * Drop approvals that lapsed uncollected. A member's own lapsed rows also go whenever they approve
 * another; this catches the ones whose CLI never came back. A lapsed row can no longer be
 * collected, so deleting it loses nothing.
 */
export async function sweepExpiredAgentLogins(env: AppEnv, now = new Date()): Promise<number> {
  // Scheduled only: a missing binding is a misconfiguration to name, not a sweep of zero rows.
  if (!env.DB) throw new ConfigurationError('BindingMissing', 'DB')
  const result = await env.DB.prepare('DELETE FROM agent_approvals WHERE expires_at <= ?').bind(now.toISOString()).run()
  return result.meta.changes ?? 0
}
