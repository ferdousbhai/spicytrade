import { z } from 'zod'

/**
 * The one-click tastytrade connection: the wire contract between `connect-tastytrade.mjs` on the
 * member's machine and the Worker's `/api/brokers/tastytrade/*` endpoints.
 *
 * The member's refresh token only ever passes through the Worker, in the one exchange response
 * and in each token request; it is kept in the member's keyring and nowhere here. The pending
 * authorization this file describes carries no credential at all -- only who started it, where
 * the browser should be returned to, and until when.
 */

/**
 * How long a started connection stays redeemable. It bounds how long a consent page may sit open
 * before its return is refused: long enough to sign in to tastytrade with two-factor
 * authentication, short enough that an abandoned attempt does not linger. A product judgment,
 * not a provider figure.
 */
export const BROKER_AUTHORIZATION_TTL_MS = 10 * 60_000

/**
 * Outstanding connection attempts one member may hold at once. A member connects from one
 * terminal at a time; a few leaves room to restart a run while an abandoned consent page is still
 * open. The bound exists so that a leaked agent token cannot grow the table without limit.
 */
export const MAX_PENDING_BROKER_AUTHORIZATIONS_PER_USER = 3

/**
 * The loopback port the browser is returned to. The CLI binds an ephemeral port, which no OS
 * allocates below the unprivileged range, so anything under 1024 is not a port this flow ever
 * produces; 65535 is the largest TCP port.
 */
const MIN_LOOPBACK_PORT = 1024
const MAX_LOOPBACK_PORT = 65_535

/**
 * The `state` value is 32 random bytes in base64url: unguessable, and the only thing the
 * unauthenticated callback can look a pending row up by. Its shape follows from the byte count.
 */
export const BROKER_AUTHORIZATION_STATE_BYTES = 32
const STATE_LENGTH = Math.ceil(BROKER_AUTHORIZATION_STATE_BYTES * 4 / 3)
export const BrokerAuthorizationStateSchema = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${STATE_LENGTH}}$`))

/** A loopback port a CLI posts as a number. */
export const LoopbackPortSchema = z.number().int().min(MIN_LOOPBACK_PORT).max(MAX_LOOPBACK_PORT)

export const BrokerAuthorizeRequestSchema = z.strictObject({
  port: LoopbackPortSchema,
})

export const BrokerExchangeRequestSchema = z.strictObject({
  code: z.string().min(1),
  state: BrokerAuthorizationStateSchema,
})

export const BrokerTokenRequestSchema = z.strictObject({
  refreshToken: z.string().min(1),
})
