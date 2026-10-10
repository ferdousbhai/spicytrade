import { z } from 'zod'

import { LoopbackPortSchema } from './broker-authorization'
import { McpTokenLabelSchema } from './mcp-tokens'

/**
 * The browser sign-in for a member's terminal: the wire contract between `spicytrade login` on
 * the member's machine, the `/connect/agent` approval page, and the Worker's
 * `/api/agent-logins*` endpoints.
 *
 *   the CLI    listens on a loopback port and opens `/connect/agent` with that port, the SHA-256
 *              of a verifier only it holds, a state only it checks, and the machine's label;
 *   the page   has the signed-in member approve, posts the port, challenge and label, and sends
 *              the browser to the loopback listener with the one-time code it was given;
 *   exchange   the CLI redeems code and verifier for an agent token, in the response body.
 *
 * The agent token never rides in a URL, a redirect or the browser's history: only the code does,
 * and the code is useless without the verifier, which never leaves the member's terminal. The
 * pending row holds the code's digest, the challenge and the label -- no credential at all.
 */

/**
 * How long an approved code stays redeemable. The CLI redeems it the moment its listener sees
 * the redirect, so this only has to cover a slow loopback round trip; it is short so that a code
 * copied out of a browser's address bar is dead long before anyone could use it. A product
 * judgment, not a provider figure.
 */
export const AGENT_LOGIN_TTL_MS = 5 * 60_000

/**
 * Approved but unredeemed codes one member may hold at once. A member signs in one terminal at a
 * time; a few leaves room to approve again after a CLI that died before redeeming. The bound
 * exists so that a stolen session cannot grow the table without limit.
 */
export const MAX_PENDING_AGENT_LOGINS_PER_USER = 3

/**
 * The state, the verifier and the code are each 32 random bytes in base64url, and the challenge
 * is a SHA-256 digest in the same alphabet: all four are 32 bytes and so the same 43 characters.
 * The shape follows from the byte count; nothing else about them is checked by shape.
 */
export const AGENT_LOGIN_RANDOM_BYTES = 32
const ENCODED_LENGTH = Math.ceil(AGENT_LOGIN_RANDOM_BYTES * 4 / 3)
const Base64Url32Schema = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${ENCODED_LENGTH}}$`))

const AgentLoginPortSchema = z.coerce.number().pipe(LoopbackPortSchema)

/** What the CLI puts in the `/connect/agent` address. The state is the CLI's and is never posted. */
export const AgentLoginPageQuerySchema = z.object({
  challenge: Base64Url32Schema,
  label: McpTokenLabelSchema,
  port: AgentLoginPortSchema,
  state: Base64Url32Schema,
})

export const AgentLoginApproveRequestSchema = z.strictObject({
  codeChallenge: Base64Url32Schema,
  label: McpTokenLabelSchema,
  port: LoopbackPortSchema,
})

export const AgentLoginApproveResponseSchema = z.strictObject({ code: Base64Url32Schema })

export const AgentLoginExchangeRequestSchema = z.strictObject({
  code: Base64Url32Schema,
  codeVerifier: Base64Url32Schema,
  /** The token this machine held before, revoked once the new one exists when it is the same member's. */
  previousToken: z.string().min(1).optional(),
})

/**
 * The single refusal for a code that cannot be redeemed: unknown, spent, lapsed, or presented
 * with the wrong verifier. They are one answer on purpose -- telling them apart would say which
 * codes exist -- and the CLI's remedy for all of them is the same: sign in again.
 */
export const AGENT_LOGIN_INVALID_GRANT = 'invalid_grant'
