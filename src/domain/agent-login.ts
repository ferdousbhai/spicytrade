import { z } from 'zod'

import { BrokerIdSchema } from './broker'
import { McpTokenLabelSchema } from './mcp-tokens'

/**
 * Connecting a member's computer: the wire contract between the `spicytrade` CLI on that
 * computer, the `/connect/agent` approval page, and the Worker's `/api/agent-logins*` endpoints.
 *
 *   the CLI    prints a `/connect/agent` link carrying the SHA-256 of a verifier only it holds,
 *              the computer's label, and the brokerage to connect, if any;
 *   the page   has the signed-in member approve, in any browser on any device, and posts the
 *              challenge and label; with a brokerage, it goes on to that broker's consent;
 *   exchange   the CLI, polling with the verifier, collects an agent token in the response body.
 *
 * Nothing returns to the computer through the browser, so the link works from a phone or over
 * SSH. The cost is that the browser no longer proves it runs on that computer: a link someone
 * else started could be approved by mistake. The page therefore shows `connectCode`, which the
 * member matches against the terminal that printed the link; a link they did not start has no
 * terminal to match.
 *
 * The agent token never rides in a URL or the browser's history. The link carries only the
 * challenge, which is useless without the verifier, and the pending row holds no credential.
 */

/**
 * How long an approval stays collectable. The CLI is polling when the member approves, so this
 * only has to outlast one poll and a slow network; it is short so an approval whose CLI has
 * gone away does not linger. A product judgment, not a provider figure.
 */
export const AGENT_LOGIN_TTL_MS = 5 * 60_000

/**
 * Approved but uncollected sign-ins one member may hold at once. A member connects one computer
 * at a time; a few leaves room to approve again after a CLI that died before collecting. The
 * bound exists so that a stolen session cannot grow the table without limit.
 */
export const MAX_PENDING_AGENT_LOGINS_PER_USER = 3

/**
 * The verifier is 32 random bytes in base64url and the challenge is its SHA-256 digest in the
 * same alphabet: both are 32 bytes and so the same 43 characters. The shape follows from the
 * byte count; nothing else about them is checked by shape.
 */
export const AGENT_LOGIN_RANDOM_BYTES = 32
const ENCODED_LENGTH = Math.ceil(AGENT_LOGIN_RANDOM_BYTES * 4 / 3)
export const ConnectVerifierSchema = z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${ENCODED_LENGTH}}$`))
const ConnectChallengeSchema = ConnectVerifierSchema

/** How many of the challenge's leading bytes the code shows: eight hex digits, read at a glance. */
const CONNECT_CODE_BYTES = 4

/**
 * The code the member matches between the page and the terminal: the challenge's first bytes in
 * hex, as two groups. Derived rather than issued, so both sides compute it from what they
 * already hold; `connectCode` in `ops/spicytrade/login.mjs` is the CLI's copy.
 */
export function connectCode(challenge: string): string {
  const binary = atob(challenge.replaceAll('-', '+').replaceAll('_', '/'))
  let hex = ''
  for (let index = 0; index < CONNECT_CODE_BYTES; index += 1) hex += binary.charCodeAt(index).toString(16).padStart(2, '0')
  return `${hex.slice(0, CONNECT_CODE_BYTES)}-${hex.slice(CONNECT_CODE_BYTES)}`.toUpperCase()
}

/** What the CLI puts in the `/connect/agent` address. */
export const AgentLoginPageQuerySchema = z.object({
  broker: BrokerIdSchema.optional(),
  challenge: ConnectChallengeSchema,
  label: McpTokenLabelSchema,
})

export const AgentLoginApproveRequestSchema = z.strictObject({
  broker: BrokerIdSchema.optional(),
  codeChallenge: ConnectChallengeSchema,
  label: McpTokenLabelSchema,
})

/** The broker's consent page, when the approval asked for a brokerage; the page goes there next. */
export const AgentLoginApproveResponseSchema = z.strictObject({
  authorizationUrl: z.url({ protocol: /^https$/ }).optional(),
})

export const AgentLoginExchangeRequestSchema = z.strictObject({
  codeVerifier: ConnectVerifierSchema,
  /** The token this machine held before, revoked once the new one exists when it is the same member's. */
  previousToken: z.string().min(1).optional(),
})
