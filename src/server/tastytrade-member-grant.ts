import { z } from 'zod'

import { type AppEnv } from './env'
import { readBoundedJson } from './bounded-response'
import { apiBase, TASTYTRADE_REQUEST_TIMEOUT_MS, USER_AGENT } from './tastytrade'

// A named budget for the buffered parse of one OAuth token response. The real response is a handful
// of short fields, a few KB with a JWT access token; about a hundredfold headroom means a longer
// token never trips it, while a runaway or hostile body is still refused before it is buffered.
const MAX_TASTYTRADE_AUTH_RESPONSE_BYTES = 256_000

/*
 * Token requests on a member's behalf, under spicytrade's tastytrade OAuth app.
 *
 * Deliberately apart from the market lane in `tastytrade.ts` (`laneClient`, `marketTokens`), which spends
 * the Worker's own market-data grant (`TASTYTRADE_CLIENT_SECRET` / `TASTYTRADE_REFRESH_TOKEN`),
 * which is reachable from exactly one line behind a non-account-path check. This module never
 * reads either binding and keeps no state: the member's refresh token arrives in the request,
 * the minted access token leaves in the response, and nothing is cached across requests,
 * because module state is shared by every member an isolate serves. The only thing it holds
 * that the member does not is the app's client secret, which is why the member's keyring no
 * longer needs one.
 */

const GRANT_FAILURE_NAMES = {
  'invalid-response': 'TastytradeMemberGrantInvalidResponse',
  refused: 'TastytradeMemberGrantRefused',
  unreachable: 'TastytradeMemberGrantUnreachable',
} as const

type TastytradeMemberGrantFailure = keyof typeof GRANT_FAILURE_NAMES

/**
 * A refused, unreachable, or unreadable token request. The name says which, because a failure
 * log records only the name; tastytrade's status, for a refusal, is kept for the caller's
 * response. Never the body: a token endpoint's body can echo credential material.
 */
export class TastytradeMemberGrantError extends Error {
  readonly reason: TastytradeMemberGrantFailure
  readonly status?: number

  constructor(reason: TastytradeMemberGrantFailure, status?: number) {
    super(`TastytradeMemberGrant:${reason}`)
    this.name = GRANT_FAILURE_NAMES[reason]
    this.reason = reason
    if (status !== undefined) this.status = status
  }
}

// Other fields (`id_token` under `openid`, `scope`) may accompany these; only these are relied on.
const AccessGrantSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
})

const CodeGrantSchema = AccessGrantSchema.extend({
  refresh_token: z.string().min(1),
})

/** One token request, parsed at the boundary against the grant it is expected to return. */
async function tokenRequest<T>(env: AppEnv, body: Record<string, string>, schema: z.ZodType<T>): Promise<T> {
  let response: Response
  try {
    response = await fetch(`${apiBase(env)}/oauth/token`, {
      body: JSON.stringify(body),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': USER_AGENT,
      },
      method: 'POST',
      signal: AbortSignal.timeout(TASTYTRADE_REQUEST_TIMEOUT_MS),
    })
  } catch {
    throw new TastytradeMemberGrantError('unreachable')
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new TastytradeMemberGrantError('refused', response.status)
  }
  let payload
  try {
    payload = await readBoundedJson(response, MAX_TASTYTRADE_AUTH_RESPONSE_BYTES, 'TastytradeMemberGrant')
  } catch {
    throw new TastytradeMemberGrantError('invalid-response')
  }
  const parsed = schema.safeParse(payload)
  if (!parsed.success) throw new TastytradeMemberGrantError('invalid-response')
  return parsed.data
}

/**
 * Redeem an authorization code for the member's refresh token. The access token that comes
 * with it is dropped: the local proxy mints its own on first use, and returning one here would
 * be a second credential in a response that already carries the permanent one.
 *
 * The encoding is assumed from the refresh grant, which tastytrade accepts as JSON; its
 * documentation does not show the code grant's body, so confirm this against the sandbox.
 */
export async function exchangeTastytradeAuthorizationCode(
  env: AppEnv,
  grant: { clientId: string; clientSecret: string; code: string; redirectUri: string },
): Promise<string> {
  const issued = await tokenRequest(env, {
    client_id: grant.clientId,
    client_secret: grant.clientSecret,
    code: grant.code,
    grant_type: 'authorization_code',
    redirect_uri: grant.redirectUri,
  }, CodeGrantSchema)
  return issued.refresh_token
}

/**
 * Mint a 15-minute access token from a member's refresh token and the app's client secret.
 * tastytrade does not rotate the refresh token on this grant, so nothing comes back for the
 * keyring and nothing here has to be written anywhere.
 */
export async function refreshTastytradeMemberAccess(
  env: AppEnv,
  grant: { clientSecret: string; refreshToken: string },
): Promise<{ accessToken: string; expiresIn: number }> {
  const issued = await tokenRequest(env, {
    client_secret: grant.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: grant.refreshToken,
  }, AccessGrantSchema)
  return { accessToken: issued.access_token, expiresIn: issued.expires_in }
}
