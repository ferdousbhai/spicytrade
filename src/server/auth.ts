import { mcp } from '@better-auth/mcp'
import { betterAuth } from 'better-auth'
import { jwt } from 'better-auth/plugins/jwt'

import { type AppEnv } from './env'
import { ConfigurationError, readBoundSecret, readStoredSecret } from './secrets'
import { MCP_PATH, SITE_NAME } from '../domain/site'
import { errorName, toError } from '../domain/failure'

export const OWNER_EMAIL = 'ferdousbd@gmail.com'

/**
 * Where the provider sends a browser mid-authorization. These must be real routes: they were
 * first pointed at `/connect`, which is a tab inside the application rather than a route, so the
 * browser reached a 404 holding a live authorization request and the flow ended there. A test
 * checks each one against the route files, because nothing else connects the two.
 */
export const MCP_LOGIN_PAGE = '/authorize'
export const MCP_CONSENT_PAGE = '/authorize/consent'

export function isOwnerEmail(email: string): boolean {
  return email.toLowerCase() === OWNER_EMAIL
}

export type AuthenticatedIdentity = { email: string; id: string; image?: string; name: string }

/**
 * Google's profile image URL, as better-auth stores it verbatim from the provider. It is
 * untrusted provider data — never coerced or repaired — so anything that does not parse as an
 * https URL is dropped rather than passed through malformed.
 */
export function parseTrustedProfileImage(image: string | null | undefined): string | undefined {
  if (!image) return undefined
  try {
    return new URL(image).protocol === 'https:' ? image : undefined
  } catch {
    return undefined
  }
}

export function requireProductionOrigin(value: string | undefined): string {
  if (!value) throw new ConfigurationError('AuthBaseUrlMissing')
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash) {
    throw new ConfigurationError('AuthBaseUrlInvalid')
  }
  return url.origin
}

export function configureAuth(
  database: D1Database,
  baseURL: string,
  secret: string,
  googleClientId: string,
  googleClientSecret: string,
) {
  return betterAuth({
    appName: SITE_NAME,
    baseURL,
    database,
    secret,
    trustedOrigins: [baseURL],
    socialProviders: {
      google: {
        clientId: googleClientId,
        clientSecret: googleClientSecret,
        prompt: 'select_account',
      },
    },
    account: {
      encryptOAuthTokens: true,
    },
    plugins: [
      // Access tokens are signed JWTs, so the provider needs somewhere to keep signing keys and a
      // JWKS to publish. Private keys live in `jwks` and no read path may return one.
      jwt(),
      /*
       * The authorization server that lets an MCP client connect without anyone copying a token.
       *
       * spicytrade issues its own tokens rather than pointing clients at Google, because Google offers
       * neither dynamic client registration nor the loopback redirect URIs an MCP client registers
       * for itself. Google stays the identity; this only decides who mints the token in front of it.
       *
       * Registration is open by necessity -- that is how a client bootstraps -- so consent is what
       * stands between a registered client and an account. Every newly registered client is
       * consented to explicitly; nothing here is trusted by default.
       */
      mcp({
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
        consentPage: MCP_CONSENT_PAGE,
        loginPage: MCP_LOGIN_PAGE,
        // Audience-binds every issued token to this endpoint (RFC 8707), so a token minted for
        // spicytrade cannot be replayed against another resource that trusts the same issuer.
        resource: mcpResourceIdentifier(baseURL),
      }),
    ],
  })
}

/**
 * The MCP endpoint as an OAuth protected-resource identifier (RFC 8707).
 *
 * Every issued token is audience-bound to this exact string, and verification checks it, so the
 * two must be derived from one definition or a token minted for spicytrade would be accepted for
 * something else that trusts the same issuer -- or, more likely, nothing would authenticate.
 */
export function mcpResourceIdentifier(baseURL: string): string {
  return `${baseURL}${MCP_PATH}`
}

/**
 * The issuer every access token carries, which is better-auth's base path rather than the site
 * origin. Verification compares against this exact string, so it is derived here once instead of
 * being rebuilt at the point of use.
 */
export function authIssuerFor(baseURL: string): string {
  return `${baseURL}/api/auth`
}

/**
 * better-auth's own floor for BETTER_AUTH_SECRET: below 32 characters it warns that the secret is
 * too short "for adequate security" (`context/create-context.mjs`) and then carries on. A warning
 * nobody reads is not a floor, so this refuses to build the runtime instead.
 */
const MIN_AUTH_SECRET_LENGTH = 32

type AuthRuntime = {
  auth: ReturnType<typeof configureAuth>
  authIssuer: string
  /** The store the auth server reads, and so the one its tokens' subjects are users in. */
  database: D1Database
  mcpResource: string
}

let cachedRuntime: Promise<AuthRuntime> | undefined

async function createAuthRuntime(env: AppEnv): Promise<AuthRuntime> {
  if (!env.DB) throw new ConfigurationError('AuthDatabaseMissing')
  const secret = readBoundSecret(env.BETTER_AUTH_SECRET, 'BETTER_AUTH_SECRET')
  const googleClientId = readBoundSecret(env.GOOGLE_CLIENT_ID, 'GOOGLE_CLIENT_ID')
  const googleClientSecret = await readStoredSecret(env.GOOGLE_CLIENT_SECRET, 'GOOGLE_CLIENT_SECRET')
  if (secret.length < MIN_AUTH_SECRET_LENGTH) throw new ConfigurationError('AuthSecretTooShort')
  const baseURL = requireProductionOrigin(env.AUTH_BASE_URL)

  const auth = configureAuth(env.DB, baseURL, secret, googleClientId, googleClientSecret)

  return { auth, authIssuer: authIssuerFor(baseURL), database: env.DB, mcpResource: mcpResourceIdentifier(baseURL) }
}

/** A failed build must not stay cached, so the next request retries from scratch. */
async function buildAuthRuntime(env: AppEnv): Promise<AuthRuntime> {
  try {
    return await createAuthRuntime(env)
  } catch (error) {
    cachedRuntime = undefined
    throw error
  }
}

export function getAuthRuntime(env: AppEnv): Promise<AuthRuntime> {
  cachedRuntime ??= buildAuthRuntime(env)
  return cachedRuntime
}

/**
 * The name better-auth gives its session cookie, prefix and `__Secure-` aside. Only its
 * presence is read here, never its value.
 */
const SESSION_COOKIE_NAME = 'session_token'

/**
 * Google identity is available to favorite sync; it grants no brokerage or agent authority.
 *
 * A request carrying no session cookie has no session, and is answered without building the
 * auth runtime: that build is the slowest part of an anonymous visitor's first request, and
 * every visitor's boot waits on this answer before the market is drawn. A cookie that is
 * present goes through the full check whatever it holds, so nothing here can admit anyone.
 */
export async function getAuthenticatedIdentity(
  request: Request,
  env: AppEnv,
): Promise<AuthenticatedIdentity | null> {
  if (!request.headers.get('cookie')?.includes(SESSION_COOKIE_NAME)) return null
  const runtime = await getAuthRuntime(env)
  const session = await runtime.auth.api.getSession({ headers: request.headers })
  if (!session) return null
  return {
    email: session.user.email,
    id: session.user.id,
    image: parseTrustedProfileImage(session.user.image),
    name: session.user.name,
  }
}

/**
 * The OAuth discovery documents an MCP client fetches before it can authenticate.
 *
 * RFC 9728 and RFC 8414 define these as root-relative, so a client only ever looks for them at
 * the origin. better-auth does not publish them uniformly: the protected-resource document is
 * already served at the root (with or without the resource path suffix), while the authorization
 * server metadata lives under the auth base path. Both shapes are named here rather than guessed,
 * because a 404 on either one reads to a client as "this server has no OAuth" and the whole flow
 * stops before it starts.
 *
 * Only these names are handled, and each maps to one fixed path, so this cannot become a second
 * unintended mount of the auth surface.
 */
const ROOT_DISCOVERY_DOCUMENT = 'oauth-protected-resource'
const BASE_PATH_DISCOVERY_DOCUMENTS = new Set(['oauth-authorization-server', 'openid-configuration'])

export async function handleWellKnownDiscovery(
  request: Request,
  env: AppEnv,
): Promise<Response | undefined> {
  const url = new URL(request.url)
  const prefix = '/.well-known/'
  if (!url.pathname.startsWith(prefix)) return undefined
  const document = url.pathname.slice(prefix.length).split('/')[0] ?? ''
  const rootServed = document === ROOT_DISCOVERY_DOCUMENT
  if (!rootServed && !BASE_PATH_DISCOVERY_DOCUMENTS.has(document)) return undefined
  try {
    const { auth } = await getAuthRuntime(env)
    const forwarded = rootServed ? url : new URL(`/api/auth${url.pathname}${url.search}`, url.origin)
    return await auth.handler(new Request(forwarded, { headers: request.headers, method: 'GET' }))
  } catch (error) {
    console.error('AuthDiscoveryUnavailable', errorName(toError(error)))
    return Response.json({ error: 'Discovery is temporarily unavailable' }, {
      headers: { 'Cache-Control': 'no-store' },
      status: 503,
    })
  }
}
