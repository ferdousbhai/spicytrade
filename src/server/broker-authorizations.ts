import { type z } from 'zod'

import {
  BROKER_AUTHORIZATION_STATE_BYTES,
  BROKER_AUTHORIZATION_TTL_MS,
  BrokerAuthorizationStateSchema,
  BrokerAuthorizeRequestSchema,
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
 * The one-click tastytrade connection, driven by `ops/spicytrade/connect-tastytrade.mjs`.
 *
 *   authorize  the CLI, holding the member's agent token, opens a pending row and gets the
 *              consent URL;
 *   callback   tastytrade returns the browser here, and it is sent straight on to the CLI's
 *              loopback listener with the code;
 *   exchange   the CLI, with the same agent token, redeems the code for the member's refresh
 *              token, which goes into their keyring;
 *   token      the local proxy trades that refresh token for a 15-minute access token.
 *
 * The Worker never stores the member's refresh token: it crosses this Worker in the exchange
 * response and in each token request, and is in memory only for as long as either takes. What
 * the Worker contributes is the app's client secret, which tastytrade requires on every token
 * request and which therefore never has to sit in a member's keyring.
 */

const BROKER: BrokerId = 'tastytrade'
/** tastytrade's consent page (developer.tastytrade.com, OAuth2 authorization). */
const TASTYTRADE_AUTHORIZATION_URL = 'https://my.tastytrade.com/auth.html'
/** Account reads and order placement: what the member's proxy spends the token on. */
const TASTYTRADE_SCOPES = 'read trade'
/** Registered with tastytrade as the app's redirect URI, so it must match the route exactly. */
export const TASTYTRADE_CALLBACK_PATH = '/api/brokers/tastytrade/callback'
/**
 * Where the CLI listens. The literal address rather than `localhost`, which a resolver may map
 * elsewhere; the callback redirects to nothing but this host and the stored port.
 */
const LOOPBACK_HOST = '127.0.0.1'
const LOOPBACK_CALLBACK_PATH = '/callback'

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
 * return. Every endpoint but the callback, which the browser reaches unauthenticated, opens so.
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
 * Open a pending connection and return tastytrade's consent URL. Only the state's digest is
 * kept, so a database read cannot be replayed through the callback.
 */
export async function authorizeTastytrade(request: Request, env: AppEnv, now = new Date()): Promise<Response> {
  const config = connectConfig(env)
  if (!config) return unavailable()
  try {
    const parsed = await agentRequest(request, config.database, BrokerAuthorizeRequestSchema, 'Invalid loopback port')
    if (parsed instanceof Response) return parsed
    const { userId } = parsed

    const state = randomBase64Url(BROKER_AUTHORIZATION_STATE_BYTES)
    const nowIso = now.toISOString()
    const expiresAt = new Date(now.getTime() + BROKER_AUTHORIZATION_TTL_MS).toISOString()
    // The member's lapsed attempts go first so they never count against the cap, and the cap is
    // checked inside the insert: two concurrent starts that each counted a free slot would
    // otherwise both insert.
    const [, inserted] = await config.database.batch([
      config.database.prepare(
        'DELETE FROM broker_authorizations WHERE user_id = ? AND expires_at <= ?',
      ).bind(userId, nowIso),
      config.database.prepare(
        `INSERT INTO broker_authorizations (state_digest, user_id, broker, loopback_port, created_at, expires_at)
         SELECT ?, ?, ?, ?, ?, ?
         WHERE (SELECT COUNT(*) FROM broker_authorizations WHERE user_id = ?) < ?`,
      ).bind(
        await sha256Base64Url(state),
        userId,
        BROKER,
        parsed.data.port,
        nowIso,
        expiresAt,
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
    return jsonNoStore({ authorizationUrl: authorizationUrl.toString(), expiresAt, state })
  } catch (error) {
    console.error('TastytradeAuthorizeFailed', errorName(toError(error)))
    return unavailable()
  }
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
 * code alone is useless: redeeming it takes the app's client secret, which only this Worker
 * holds, and `exchange` requires the same member's agent token besides, so a code seen in a
 * request log grants nothing. So the browser is sent on to the member's own CLI, and only ever
 * to the loopback address and the port that member's CLI registered -- never to a destination
 * read from the request.
 *
 * The row is looked up, not consumed: `exchange` consumes it, bound to the member.
 */
export async function tastytradeCallback(request: Request, env: AppEnv, now = new Date()): Promise<Response> {
  const config = connectConfig(env)
  if (!config) return plainNoStore('Connecting tastytrade is unavailable right now.', 503)
  const params = new URL(request.url).searchParams
  const state = BrokerAuthorizationStateSchema.safeParse(params.get('state'))
  const code = params.get('code')
  const error = params.get('error')
  const expired = 'This tastytrade connection has expired or is unknown. Run connect-tastytrade.mjs again.'
  if (!state.success) return plainNoStore(expired, 400)
  if (!code && !error) return plainNoStore('tastytrade returned neither an authorization nor a refusal.', 400)

  let row: { loopback_port: number } | null
  try {
    row = await config.database.prepare(
      `SELECT loopback_port FROM broker_authorizations
        WHERE state_digest = ? AND broker = ? AND expires_at > ?`,
    ).bind(await sha256Base64Url(state.data), BROKER, now.toISOString()).first<{ loopback_port: number }>()
  } catch (cause) {
    console.error('TastytradeCallbackFailed', errorName(toError(cause)))
    return plainNoStore('Connecting tastytrade is unavailable right now.', 503)
  }
  if (!row) return plainNoStore(expired, 400)

  const destination = new URL(`http://${LOOPBACK_HOST}:${row.loopback_port}${LOOPBACK_CALLBACK_PATH}`)
  // tastytrade's `error` is forwarded as a parameter and never rendered here; the CLI prints
  // only codes from its own list, and treats any return carrying one as a refusal.
  if (code) destination.searchParams.set('code', code)
  if (error) destination.searchParams.set('error', error)
  destination.searchParams.set('state', state.data)
  return new Response(null, {
    headers: {
      'Cache-Control': 'no-store',
      Location: destination.toString(),
      'Referrer-Policy': 'no-referrer',
    },
    status: 302,
  })
}

/**
 * Redeem the code for the member's refresh token and hand it to their CLI, once. The row is
 * consumed in the same statement that checks it belongs to this member and has not lapsed, so a
 * state is single-use and cannot be redeemed with another member's agent token.
 */
export async function exchangeTastytrade(request: Request, env: AppEnv, now = new Date()): Promise<Response> {
  const config = connectConfig(env)
  if (!config) return unavailable()
  try {
    const parsed = await agentRequest(request, config.database, BrokerExchangeRequestSchema, 'Invalid authorization')
    if (parsed instanceof Response) return parsed
    const { userId } = parsed
    // Read before the row is consumed, so a misconfigured secret does not burn the attempt.
    const clientSecret = await readStoredSecret(config.clientSecret, 'TASTYTRADE_OAUTH_CLIENT_SECRET')

    const consumed = await config.database.prepare(
      `DELETE FROM broker_authorizations
        WHERE state_digest = ? AND user_id = ? AND broker = ? AND expires_at > ?
        RETURNING loopback_port`,
    ).bind(await sha256Base64Url(parsed.data.state), userId, BROKER, now.toISOString()).first()
    if (!consumed) {
      return jsonNoStore({ error: 'No pending tastytrade connection matches this authorization' }, { status: 404 })
    }

    const refreshToken = await exchangeTastytradeAuthorizationCode(env, {
      clientId: config.clientId,
      clientSecret,
      code: parsed.data.code,
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
    'DELETE FROM broker_authorizations WHERE expires_at <= ?',
  ).bind(now.toISOString()).run()
  return result.meta.changes ?? 0
}
