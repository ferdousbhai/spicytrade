import { z } from 'zod'

/**
 * Supplies the `application_type` a local MCP client leaves out of its registration.
 *
 * RFC 7591 defaults an omitted `application_type` to `web`, and better-auth enforces that a web
 * client may not redirect to a loopback address. But no MCP SDK sends the field at all, and a local
 * agent receives its code on `http://127.0.0.1:<port>`, so every stock client was refused at
 * registration and could never reach the consent page. RFC 8252 is explicit that a client whose
 * redirects are loopback or private-use schemes is a native app, so that is the value supplied.
 *
 * This only fills an omitted optional field, and only when every redirect says the same thing: a
 * provided `application_type` is never touched, and a registration mixing a website redirect in is
 * passed through for the provider to judge under its own default. Nothing is relaxed -- a native
 * client still faces the provider's exact-loopback-host and reverse-domain scheme rules, and still
 * holds nothing until a member approves it on a page that names where the approval goes.
 */
export const OAUTH_REGISTRATION_PATH = '/api/auth/oauth2/register'

/** RFC 8252 §7.3: http on exactly these hosts. The provider enforces the same three. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

function isNativeRedirect(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol === 'http:') return LOOPBACK_HOSTS.has(url.hostname)
  // RFC 8252 §7.1 private-use schemes. Whether one is well-formed is the provider's check.
  return url.protocol !== 'https:'
}

/**
 * Only the two fields this reads. Every other field passes through as the client sent it, and a
 * body this does not match is forwarded untouched for the provider's own validation to report.
 */
const OmittedApplicationTypeSchema = z.looseObject({
  application_type: z.undefined().optional(),
  redirect_uris: z.array(z.string()).min(1),
})

function withNativeApplicationType(text: string): string | null {
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return null
  }
  const registration = OmittedApplicationTypeSchema.safeParse(body)
  if (!registration.success || !registration.data.redirect_uris.every(isNativeRedirect)) return null
  return JSON.stringify({ ...registration.data, application_type: 'native' })
}

/**
 * The request to hand the provider. Anything this does not recognise -- another path, a body that
 * is not a JSON object -- goes through unchanged, so the provider's own validation reports it.
 */
export async function prepareOAuthRegistration(request: Request): Promise<Request> {
  if (request.method !== 'POST' || new URL(request.url).pathname !== OAUTH_REGISTRATION_PATH) return request
  const text = await request.text()
  const native = withNativeApplicationType(text)
  const headers = new Headers(request.headers)
  // The body is rebuilt, so its length is recomputed rather than carried over.
  headers.delete('content-length')
  return new Request(request.url, { body: native ?? text, headers, method: 'POST' })
}
