import { type z } from 'zod'

import {
  BROKER_AUTHORIZATION_STATE_BYTES,
  BROKER_AUTHORIZATION_TTL_MS,
  BrokerAuthorizationStateSchema,
  BrokerConsentRefusalSchema,
  BrokerExchangeRequestSchema,
  BrokerTokenRequestSchema,
  MAX_PENDING_BROKER_AUTHORIZATIONS_PER_USER,
} from '../domain/broker-authorization'
import { type BrokerId } from '../domain/broker'
import { errorName, toError } from '../domain/failure'
import { requireProductionOrigin } from './auth'
import { randomBase64Url, sha256Base64Url } from './digest'
import { type AppEnv } from './env'
import { jsonNoStore } from './http'
import { authenticateMcpToken, isMintedMcpToken, presentedBearer } from './mcp-tokens'
import { ConfigurationError, readBoundSecret, readStoredSecret } from './secrets'
import {
  exchangeTastytradeAuthorizationCode,
  refreshTastytradeMemberAccess,
  TastytradeMemberGrantError,
} from './tastytrade-member-grant'

/*
 * Connecting tastytrade, started by the member's approval on `/connect/agent` and collected by
 * the `spicytrade` CLI that printed that link (`ops/spicytrade/`).
 *
 *   consent    the approval, made under the member's session, opens a pending row bound to the
 *              link's challenge and sends the browser to tastytrade's consent page;
 *   callback   tastytrade returns the browser here, and the one-time code waits in that row;
 *   exchange   the CLI, polling with its agent token and its verifier, has the code redeemed for
 *              the member's refresh token, which goes into their keyring;
 *   token      `spicytrade mcp` on the member's machine trades that refresh token for a 15-minute access token.
 *
 * The Worker never stores the member's refresh token: it crosses this Worker in the exchange
 * response and in each token request, and is in memory only for as long as either takes. What
 * the Worker contributes is the app's client secret, which tastytrade requires on every token
 * request and which therefore never has to sit in a member's keyring.
 */

const BROKER: BrokerId = 'tastytrade'
/** tastytrade's consent page (developer.tastytrade.com, OAuth2 authorization). */
const TASTYTRADE_AUTHORIZATION_URL = 'https://my.tastytrade.com/auth.html'
/** Account reads and order placement: what the member's `spicytrade mcp` spends the token on. */
const TASTYTRADE_SCOPES = 'read trade'
/** Registered with tastytrade as the app's redirect URI, so it must match the route exactly. */
export const TASTYTRADE_CALLBACK_PATH = '/api/brokers/tastytrade/callback'
type ConnectConfig = {
  clientId: string
  clientSecret: SecretsStoreSecret
  database: D1Database
  redirectUri: string
}

/**
 * Every piece this flow needs, or undefined. A missing piece closes every endpoint, not only
 * the one that spends it: a consent the Worker could not later redeem would send a member
 * through tastytrade for nothing. The client id is a `cloudflare.config.ts` text binding, and empty or
 * whitespace there reads as missing; the client secret is a Secrets Store binding. Only binding names are logged.
 */
function connectConfig(env: AppEnv): ConnectConfig | undefined {
  if (!env.DB) return unconfigured('DB')
  if (!env.TASTYTRADE_OAUTH_CLIENT_SECRET) return unconfigured('TASTYTRADE_OAUTH_CLIENT_SECRET')
  let clientId: string
  let origin: string
  try {
    clientId = readBoundSecret(env.TASTYTRADE_OAUTH_CLIENT_ID, 'TASTYTRADE_OAUTH_CLIENT_ID')
    origin = requireProductionOrigin(env.AUTH_BASE_URL)
  } catch (error) {
    return unconfigured(errorName(toError(error)))
  }
  return {
    clientId,
    clientSecret: env.TASTYTRADE_OAUTH_CLIENT_SECRET,
    database: env.DB,
    redirectUri: `${origin}${TASTYTRADE_CALLBACK_PATH}`,
  }
}

function unconfigured(missing: string): undefined {
  console.error('TastytradeConnectUnconfigured', missing)
  return undefined
}

/** What the browser is told when the callback cannot reach its configuration or its row. */
const CALLBACK_UNAVAILABLE = 'Connecting tastytrade is unavailable right now. Go back to the terminal and press Ctrl-C to skip it, then run spicytrade setup later to connect.'
const CALLBACK_APPROVED = 'tastytrade approved. Return to your terminal or agent; you can close this tab.'
const CALLBACK_REFUSED = 'Not connected. You can close this tab.'

const unavailable = () => jsonNoStore({ error: 'Connecting tastytrade is unavailable' }, { status: 503 })

/**
 * The member a minted agent token names, or undefined. Only a minted token: this flow runs from
 * the member's terminal, where the CLI reads that token from the keyring, and an OAuth access
 * token issued to some MCP client is not what should be able to attach a brokerage.
 */
async function agentUserId(request: Request, database: D1Database): Promise<string | undefined> {
  const presented = presentedBearer(request)
  if (!presented || !isMintedMcpToken(presented)) return undefined
  return (await authenticateMcpToken(database, presented))?.userId
}

/**
 * The member a minted agent token names and the body parsed against `schema`, or the refusal to
 * return. The CLI's two endpoints, `exchange` and `token`, open so.
 */
async function agentRequest<T>(
  request: Request,
  database: D1Database,
  schema: z.ZodType<T>,
  invalid: string,
): Promise<{ data: T; userId: string } | Response> {
  const userId = await agentUserId(request, database)
  if (!userId) return jsonNoStore({ error: 'A spicytrade agent token is required' }, { status: 401 })
  const parsed = schema.safeParse(await request.json().catch(() => null))
  if (!parsed.success) return jsonNoStore({ error: invalid }, { status: 400 })
  return { data: parsed.data, userId }
}

/** The response for a token request tastytrade did not complete: our words, its status. */
function grantFailure(error: TastytradeMemberGrantError): Response {
  const message = error.reason === 'refused'
    ? 'tastytrade refused the grant'
    : error.reason === 'unreachable'
      ? 'tastytrade could not be reached'
      : 'tastytrade answered with an unreadable token response'
  return jsonNoStore(
    error.status === undefined ? { error: message } : { error: message, tastytradeStatus: error.status },
    { status: 502 },
  )
}


/**
 * Open a pending consent for the member whose session approved `challenge`, and return
 * tastytrade's consent URL, or the refusal to answer the approval with. Only the state's digest
 * is kept, so a database read cannot be replayed through the callback.
 */
export async function openTastytradeConsent(
  env: AppEnv,
  userId: string,
  challenge: string,
  now = new Date(),
): Promise<string | Response> {
  const config = connectConfig(env)
  if (!config) return unavailable()
  const state = randomBase64Url(BROKER_AUTHORIZATION_STATE_BYTES)
  const nowIso = now.toISOString()
  // The member's lapsed attempts go first so they never count against the cap, and the cap is
  // checked inside the insert: two concurrent starts that each counted a free slot would
  // otherwise both insert. Approving one link twice replaces the consent the first approval
  // opened, so one challenge never has two.
  const [, , inserted] = await config.database.batch([
    config.database.prepare(
      'DELETE FROM broker_consents WHERE user_id = ? AND expires_at <= ?',
    ).bind(userId, nowIso),
    config.database.prepare(
      'DELETE FROM broker_consents WHERE challenge = ? AND user_id = ? AND broker = ?',
    ).bind(challenge, userId, BROKER),
    config.database.prepare(
      `INSERT INTO broker_consents (state_digest, challenge, user_id, broker, created_at, expires_at)
       SELECT ?, ?, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM broker_consents WHERE user_id = ?) < ?`,
    ).bind(
      await sha256Base64Url(state),
      challenge,
      userId,
      BROKER,
      nowIso,
      new Date(now.getTime() + BROKER_AUTHORIZATION_TTL_MS).toISOString(),
      userId,
      MAX_PENDING_BROKER_AUTHORIZATIONS_PER_USER,
    ),
  ])
  if (!inserted?.meta.changes) {
    return jsonNoStore({
      error: `At most ${MAX_PENDING_BROKER_AUTHORIZATIONS_PER_USER} tastytrade connections may be pending at once. Finish one or wait for it to expire.`,
    }, { status: 409 })
  }

  const authorizationUrl = new URL(TASTYTRADE_AUTHORIZATION_URL)
  authorizationUrl.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: TASTYTRADE_SCOPES,
    state,
  }).toString()
  return authorizationUrl.toString()
}

function plainNoStore(text: string, status: number): Response {
  return new Response(`${text}\n`, {
    headers: {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain; charset=utf-8',
      'Referrer-Policy': 'no-referrer',
    },
    status,
  })
}

/**
 * The browser returning from tastytrade. Unauthenticated, because nothing the browser carries
 * identifies the member to this endpoint; the state is what binds the return to a pending row.
 *
 * It does not redeem the code. Redeeming here would leave the Worker holding the member's
 * refresh token with nowhere to put it but storage, which is exactly what must not happen. The
 * code waits in the row instead, for the CLI's next poll, and is useless on its own: redeeming
 * it takes the app's client secret, which only this Worker holds, and `exchange` requires the
 * same member's agent token and the CLI's verifier besides. A return is recorded once, so a
 * replayed address cannot swap the code a row already holds.
 *
 * tastytrade's `error` is never rendered or stored as text: it is recorded only as one of this
 * repository's own refusal codes.
 */
export async function tastytradeCallback(request: Request, env: AppEnv, now = new Date()): Promise<Response> {
  const config = connectConfig(env)
  if (!config) return plainNoStore(CALLBACK_UNAVAILABLE, 503)
  const params = new URL(request.url).searchParams
  const state = BrokerAuthorizationStateSchema.safeParse(params.get('state'))
  const error = params.get('error')
  const code = error ? null : params.get('code')
  const expired = 'This tastytrade connection has expired or is unknown. Run spicytrade setup again.'
  if (!state.success) return plainNoStore(expired, 400)
  if (!code && !error) return plainNoStore('tastytrade returned neither an approval nor a refusal. Go back to the terminal, press Ctrl-C to skip, then run spicytrade setup again.', 400)
  const refusal = error ? BrokerConsentRefusalSchema.catch('unrecognized').parse(error) : null

  try {
    const recorded = await config.database.prepare(
      `UPDATE broker_consents SET code = ?, refusal = ?
        WHERE state_digest = ? AND broker = ? AND expires_at > ? AND code IS NULL AND refusal IS NULL`,
    ).bind(code, refusal, await sha256Base64Url(state.data), BROKER, now.toISOString()).run()
    if (!recorded.meta.changes) return plainNoStore(expired, 400)
  } catch (cause) {
    console.error('TastytradeCallbackFailed', errorName(toError(cause)))
    return plainNoStore(CALLBACK_UNAVAILABLE, 503)
  }
  return plainNoStore(refusal ? CALLBACK_REFUSED : CALLBACK_APPROVED, 200)
}

/**
 * Redeem the consent's code for the member's refresh token and hand it to their CLI, once. The
 * consent is found by the digest of the verifier presented and must belong to the member the
 * agent token names, so only the CLI that printed the approved link, signed in as the member who
 * approved it, can collect. Until the browser returns from tastytrade the answer is pending; a
 * consent that lapsed or never existed is 404.
 */
export async function exchangeTastytrade(request: Request, env: AppEnv, now = new Date()): Promise<Response> {
  const config = connectConfig(env)
  if (!config) return unavailable()
  try {
    const parsed = await agentRequest(request, config.database, BrokerExchangeRequestSchema, 'Invalid authorization')
    if (parsed instanceof Response) return parsed
    const { userId } = parsed
    const consent = [await sha256Base64Url(parsed.data.codeVerifier), userId, BROKER, now.toISOString()]
    const pending = await config.database.prepare(
      `SELECT code IS NULL AND refusal IS NULL AS waiting FROM broker_consents
        WHERE challenge = ? AND user_id = ? AND broker = ? AND expires_at > ?`,
    ).bind(...consent).first<{ waiting: number }>()
    if (!pending) {
      return jsonNoStore({ error: 'No pending tastytrade connection matches this authorization' }, { status: 404 })
    }
    if (pending.waiting) return jsonNoStore({ pending: true }, { status: 202 })
    // Read before the row is consumed, so a misconfigured secret does not burn the attempt.
    const clientSecret = await readStoredSecret(config.clientSecret, 'TASTYTRADE_OAUTH_CLIENT_SECRET')

    const consumed = await config.database.prepare(
      `DELETE FROM broker_consents
        WHERE challenge = ? AND user_id = ? AND broker = ? AND expires_at > ?
        RETURNING code, refusal`,
    ).bind(...consent).first<{ code: string | null; refusal: string | null }>()
    if (!consumed) {
      return jsonNoStore({ error: 'No pending tastytrade connection matches this authorization' }, { status: 404 })
    }
    if (!consumed.code) {
      return jsonNoStore({ refusal: BrokerConsentRefusalSchema.catch('unrecognized').parse(consumed.refusal) }, { status: 403 })
    }

    const refreshToken = await exchangeTastytradeAuthorizationCode(env, {
      clientId: config.clientId,
      clientSecret,
      code: consumed.code,
      redirectUri: config.redirectUri,
    })
    // The member's permanent credential, in this response and nowhere else on this side.
    return jsonNoStore({ refreshToken })
  } catch (error) {
    console.error('TastytradeExchangeFailed', errorName(toError(error)))
    if (error instanceof TastytradeMemberGrantError) return grantFailure(error)
    return unavailable()
  }
}

/**
 * Mint an access token from the member's refresh token under the app's client secret. The
 * caller must hold a live agent token, so the app secret cannot be spent by anyone who merely
 * holds some tastytrade refresh token. Nothing is cached or stored.
 */
export async function tastytradeAccessToken(request: Request, env: AppEnv): Promise<Response> {
  const config = connectConfig(env)
  if (!config) return unavailable()
  try {
    const parsed = await agentRequest(request, config.database, BrokerTokenRequestSchema, 'Invalid refresh token')
    if (parsed instanceof Response) return parsed
    const clientSecret = await readStoredSecret(config.clientSecret, 'TASTYTRADE_OAUTH_CLIENT_SECRET')
    const access = await refreshTastytradeMemberAccess(env, { clientSecret, refreshToken: parsed.data.refreshToken })
    return jsonNoStore(access)
  } catch (error) {
    console.error('TastytradeMemberTokenFailed', errorName(toError(error)))
    if (error instanceof TastytradeMemberGrantError) return grantFailure(error)
    return unavailable()
  }
}

/**
 * Drop pending connections that have lapsed. A member's own lapsed rows also go whenever they
 * start another; this catches the ones whose member never came back. A lapsed row can no longer
 * be redeemed or followed, so deleting it loses nothing.
 */
export async function sweepExpiredBrokerAuthorizations(env: AppEnv, now = new Date()): Promise<number> {
  // Scheduled only: a missing binding is a misconfiguration to name, not a sweep of zero rows.
  if (!env.DB) throw new ConfigurationError('BindingMissing', 'DB')
  const result = await env.DB.prepare(
    'DELETE FROM broker_consents WHERE expires_at <= ?',
  ).bind(now.toISOString()).run()
  return result.meta.changes ?? 0
}
