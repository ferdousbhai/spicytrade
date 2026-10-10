import { createLocalJWKSet, jwtVerify } from 'jose'
import { z } from 'zod'

const JwksSchema = z.object({ keys: z.array(z.record(z.string(), z.unknown())).min(1) })

const ClaimsSchema = z.object({
  /**
   * Proof-of-possession confirmation. spicytrade issues plain bearer tokens and implements no DPoP
   * check, so a token that carries one is refused rather than accepted as a bearer: honouring
   * half of a sender-constrained token is weaker than the constraint promised.
   */
  cnf: z.unknown().optional(),
  sub: z.string().min(1),
})

type McpAccessTokenClaims = z.infer<typeof ClaimsSchema>

class McpTokenVerificationError extends Error {
  constructor(reason: string) {
    super(reason)
    this.name = 'McpTokenVerificationError'
  }
}

/**
 * Just the JWKS endpoint. Naming the slice keeps this independent of the rest of the auth
 * instance and lets a test hand in a key set without building one.
 */
type JwksReader = { api: { getJwks: () => Promise<{ keys: unknown[] }> } }

/**
 * Verify an OAuth access token against this server's own signing keys, in process.
 *
 * `requireMcpAuth` verifies by fetching the published JWKS over HTTP. On Workers that URL is this
 * very Worker, and a Worker cannot reliably call itself: every verification failed with
 * `Jwks failed`, so a token the authorization flow had just issued authenticated nothing. The
 * whole point of the flow is the token, and it did not work.
 *
 * The keys are already here. `auth.api.getJwks()` is the same endpoint the published document
 * serves, called directly, so this verifies against exactly what a remote verifier would fetch
 * without leaving the isolate. Issuer and audience are still checked, and the audience is the MCP
 * resource, so a token minted for something else that trusts the same issuer is refused.
 */
export async function verifyMcpAccessToken(
  auth: JwksReader,
  token: string,
  expected: { audience: string; issuer: string },
): Promise<McpAccessTokenClaims> {
  const jwks = JwksSchema.parse(await auth.api.getJwks())
  // SAFETY: `JwksSchema` has already established that this is an object with a non-empty `keys`
  // array, which is the shape `createLocalJWKSet` documents; jose validates each key itself.
  const keys = createLocalJWKSet(jwks as Parameters<typeof createLocalJWKSet>[0])
  const { payload } = await jwtVerify(token, keys, {
    audience: expected.audience,
    issuer: expected.issuer,
  })
  const claims = ClaimsSchema.parse(payload)
  if (claims.cnf !== undefined) throw new McpTokenVerificationError('sender-constrained-token')
  return claims
}
