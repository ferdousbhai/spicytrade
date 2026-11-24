import { z } from 'zod'

import { BrokerIdSchema } from './broker'
import { McpTokenLabelSchema } from './mcp-tokens'

/**
 * Connecting a member's computer: the wire contract between the `spicytrade` CLI on that
 * computer, the `/connect/agent` approval page, and the Worker's `/api/agent-logins*` endpoints.
 *
 *   the CLI    prints a short code, and a `/connect/agent` link carrying the SHA-256 of a verifier
 *              only it holds, the computer's label, and the brokerage to connect, if any;
 *   the page   has the signed-in member type that code and approve, in any browser on any
 *              device; with a brokerage, it goes on to that broker's consent;
 *   exchange   the CLI, polling with the verifier, collects an agent token in the response body.
 *
 * Nothing returns to the computer through the browser, so the link works from a phone or over
 * SSH. The cost is that the browser no longer proves it runs on that computer: a link someone
 * else started could be approved by mistake. So a link cannot be approved on its own. The code
 * is printed beside it in the terminal and is not in it; the member types the code into the
 * page, and a link they did not start comes with no terminal to read one from. Someone who sends
 * a link has to send a code and a reason to type it as well, which is what the page warns of.
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

/** The code is this many random bytes, typed as hex: eight characters, short enough to type on a phone. */
export const CONNECT_CODE_BYTES = 4
const CONNECT_CODE_LENGTH = CONNECT_CODE_BYTES * 2

/**
 * The code as the member types it: case, spaces and the dash the terminal prints between its two
 * groups do not matter, so they are dropped before it is checked.
 */
export const ConnectCodeSchema = z.string()
  .transform((typed) => typed.replaceAll(/[\s-]/g, '').toUpperCase())
  .pipe(z.string().regex(new RegExp(`^[0-9A-F]{${CONNECT_CODE_LENGTH}}$`)))

/**
 * What the link carries in place of the code: the SHA-256, in base64url, of the challenge and the
 * code together. The Worker recomputes it from what the member typed, so a wrong code is refused
 * at once, and tying it to the challenge keeps one link's code from approving another.
 * `connectCodeCheck` in `ops/spicytrade/login.mjs` is the CLI's copy.
 */
export async function connectCodeCheck(challenge: string, code: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${challenge}:${code}`)))
  return btoa(String.fromCharCode(...digest)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

/** What the CLI puts in the `/connect/agent` address. */
export const AgentLoginPageQuerySchema = z.object({
  broker: BrokerIdSchema.optional(),
  challenge: ConnectChallengeSchema,
  check: ConnectChallengeSchema,
  label: McpTokenLabelSchema,
})

export const AgentLoginApproveRequestSchema = z.strictObject({
  broker: BrokerIdSchema.optional(),
  /** The code the member typed, and the check the link carried for it. */
  code: ConnectCodeSchema,
  codeChallenge: ConnectChallengeSchema,
  codeCheck: ConnectChallengeSchema,
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
