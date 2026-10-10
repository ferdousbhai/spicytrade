import { z } from 'zod'

import { ORIGIN, TASTYTRADE_API_BASE } from './config.mjs'
import { TOKEN_REQUEST_TIMEOUT_MS } from './token-refresh.mjs'

/**
 * Minting a 15-minute tastytrade access token from the long-lived grant in the keyring, for the
 * proxy that attaches it and for `spicytrade doctor` that checks the grant still mints. Its own
 * module because importing `proxy.mjs` starts the proxy.
 */

const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
})

// What the Worker's `/api/brokers/tastytrade/token` answers: a mint, or a refusal that carries
// tastytrade's own status when tastytrade was the one that refused.
const AppGrantResponseSchema = z.object({
  accessToken: z.string().min(1),
  expiresIn: z.number().int().positive(),
})
export const AppGrantRefusalSchema = z.object({ tastytradeStatus: z.number().int() })

// An app grant is minted by the Worker that UPSTREAM names, so it is the same origin: the agent
// token that authenticates the forwarded call is the one that authenticates the mint.
const APP_GRANT_TOKEN_URL = new URL('/api/brokers/tastytrade/token', ORIGIN)

/**
 * A refused, unreachable, or unreadable token exchange. Its `code` is tastytrade's HTTP status, a
 * fixed word of ours, or `spicytrade-` and the Worker's status when the Worker refused an app-grant
 * mint itself, and the handler logs it beside the name: a revoked grant or an unreachable broker
 * has to read as that in the log, not as a bare `Error` or `TypeError` indistinguishable from the
 * Worker failing. `transport`, when present, is the OS- or undici-level code of the failure --
 * `ENOTFOUND`, `TimeoutError` -- never a message. Nothing here carries the request or response
 * body, either of which can hold credential material. `party` is who could not be reached when
 * the code is `unreachable`: tastytrade for a personal grant, spicytrade for an app grant, which
 * is what the member is told to go and check.
 */
export class TastytradeAuthError extends Error {
  constructor(code, transport, party = 'tastytrade') {
    super(`TastytradeAuth:${code}`)
    this.name = 'TastytradeAuth'
    this.code = code
    this.transport = transport
    this.party = party
  }
}

/** A fixed-vocabulary code for a failed fetch: the cause's errno word, or the abort's name. */
function transportCode(error) {
  const candidate = error instanceof Error && error.cause instanceof Error && 'code' in error.cause
    ? String(error.cause.code)
    : error instanceof Error ? error.name : undefined
  return candidate && /^[A-Za-z0-9_]+$/.test(candidate) ? candidate : undefined
}

/** A personal grant: the member's own client secret and refresh token, straight to tastytrade. */
async function mintPersonalGrant(clientSecret, refreshToken) {
  let response
  try {
    response = await fetch(`${TASTYTRADE_API_BASE}/oauth/token`, {
      body: JSON.stringify({
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'Spicytrade-Proxy/0.1',
      },
      method: 'POST',
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    // The broker, not the Worker, could not be reached or did not answer in time.
    throw new TastytradeAuthError('unreachable', transportCode(error))
  }
  if (!response.ok) {
    // Status only. A token endpoint's body can echo credential material.
    throw new TastytradeAuthError(response.status)
  }
  // Parsed at the boundary rather than probed: a token response that does not match this
  // contract is a failure, not something to salvage a field out of.
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new TastytradeAuthError('invalid-token-response')
  }
  const grant = TokenResponseSchema.safeParse(payload)
  if (!grant.success) throw new TastytradeAuthError('invalid-token-response')
  return { lifetimeSeconds: grant.data.expires_in, token: grant.data.access_token }
}

/**
 * An app grant: the member's refresh token, minted by the Worker, which adds the app's client
 * secret. The refresh token leaves this machine only in this request's body, to spicytrade, over the
 * same authenticated channel every forwarded call uses.
 *
 * A refusal is reported by tastytrade's status when the Worker relays one, so a revoked grant
 * reads the same in this log whichever kind it is; a refusal of the Worker's own is `spicytrade-`
 * and its status.
 */
async function mintAppGrant(agentBearer, refreshToken) {
  let response
  try {
    response = await fetch(APP_GRANT_TOKEN_URL, {
      body: JSON.stringify({ refreshToken }),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${agentBearer}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Spicytrade-Proxy/0.1',
      },
      method: 'POST',
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new TastytradeAuthError('unreachable', transportCode(error), 'spicytrade')
  }
  let payload
  try {
    payload = await response.json()
  } catch {
    throw new TastytradeAuthError(response.ok ? 'invalid-token-response' : `spicytrade-${response.status}`)
  }
  if (!response.ok) {
    const refusal = AppGrantRefusalSchema.safeParse(payload)
    throw new TastytradeAuthError(refusal.success ? refusal.data.tastytradeStatus : `spicytrade-${response.status}`)
  }
  const grant = AppGrantResponseSchema.safeParse(payload)
  if (!grant.success) throw new TastytradeAuthError('invalid-token-response')
  return { lifetimeSeconds: grant.data.expiresIn, token: grant.data.accessToken }
}

/**
 * The mint for whichever grant the keyring holds (see `tastytradeCredentialKind`), or undefined
 * when it holds none that can mint alone. An ambiguous keyring is the caller's to refuse first.
 */
export function grantMinter(agentBearer, { appRefreshToken, clientSecret, refreshToken }) {
  if (appRefreshToken) return () => mintAppGrant(agentBearer, appRefreshToken)
  if (clientSecret && refreshToken) return () => mintPersonalGrant(clientSecret, refreshToken)
  return undefined
}
