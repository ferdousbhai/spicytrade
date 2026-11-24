import { z } from 'zod'

import { ConnectVerifierSchema } from './agent-login'

/**
 * Connecting tastytrade: the wire contract between the `spicytrade` CLI on the member's machine
 * and the Worker's `/api/brokers/tastytrade/*` endpoints. The connection is started by the
 * member's approval on `/connect/agent` (`src/domain/agent-login.ts`) and collected by the CLI
 * that printed that link.
 *
 * The member's refresh token only ever passes through the Worker, in the one exchange response
 * and in each token request; it is kept in the member's keyring and nowhere here. The pending
 * consent holds who started it, until when, and, between the browser's return and the CLI's next
 * poll, the broker's one-time authorization code.
 */

/**
 * How long a started connection stays redeemable. It bounds how long a consent page may sit open
 * before its return is refused, and how long a returned code waits to be collected: long enough
 * to sign in to tastytrade with two-factor authentication, short enough that an abandoned attempt
 * does not linger. A product judgment, not a provider figure.
 */
export const BROKER_CONSENT_TTL_MS = 10 * 60_000

/**
 * Outstanding connection attempts one member may hold at once. A member connects one computer
 * at a time; a few leaves room to restart a run while an abandoned consent page is still
 * open. The bound exists so that a stolen session cannot grow the table without limit.
 */
export const MAX_PENDING_BROKER_CONSENTS_PER_USER = 3

/**
 * The `state` value is 32 random bytes in base64url: unguessable, and the only thing the
 * unauthenticated callback can look a pending row up by. Its shape follows from the byte count.
 */
export const BROKER_CONSENT_STATE_BYTES = 32
const STATE_LENGTH = Math.ceil(BROKER_CONSENT_STATE_BYTES * 4 / 3)
export const BrokerConsentStateSchema = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${STATE_LENGTH}}$`))

/**
 * The refusals a consent may record: the codes RFC 6749 §4.1.2.1 defines for a refused
 * authorization. Anything else the broker returns is recorded as `unrecognized`, since its text
 * is not ours to store or show.
 */
export const BrokerConsentRefusalSchema = z.enum([
  'access_denied', 'invalid_request', 'invalid_scope', 'server_error', 'temporarily_unavailable',
  'unauthorized_client', 'unsupported_response_type', 'unrecognized',
])

/** The verifier whose challenge the member approved; it finds the consent that approval started. */
export const BrokerExchangeRequestSchema = z.strictObject({
  codeVerifier: ConnectVerifierSchema,
})

export const BrokerTokenRequestSchema = z.strictObject({
  refreshToken: z.string().min(1),
})
