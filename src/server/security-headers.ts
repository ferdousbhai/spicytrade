/**
 * Where a signed-in browser may submit a form. Sign-in and the brokerage connection are both
 * driven by script today (`authClient.signIn.social`, the CLI's consent link), so nothing posts
 * a native form off the origin; the two OAuth hosts are listed so a provider's own form hop,
 * such as better-auth falling back to a form post, is never the thing that breaks sign-in.
 */
const FORM_ACTION_HOSTS = [
  // Google sign-in (better-auth's Google provider authorization endpoint).
  'https://accounts.google.com',
  // tastytrade's consent page (`TASTYTRADE_AUTHORIZATION_URL` in `broker-authorizations.ts`).
  'https://my.tastytrade.com',
] as const

/** Google profile photos, which `top-bar.tsx` shows as the account avatar. */
const IMAGE_HOSTS = ['https://*.googleusercontent.com'] as const

/** A fresh value for each document, so a script tag only runs if the Worker wrote it. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return btoa(String.fromCharCode(...bytes))
}

/**
 * The document policy. Scripts run only when they carry this document's nonce, and whatever
 * those load (`'strict-dynamic'`): the router's entry module, its stream parts, and the boot
 * guard in `__root.tsx`. No other origin can ever run code here, so a tag added by a dependency
 * or injected at the edge (Web Analytics, Zaraz, Rocket Loader) is refused rather than handed
 * the session. `'self'` stays as the fallback for browsers that predate `'strict-dynamic'`.
 * The nonce is required: a document without one would fail to boot, which is the visible failure
 * a forgotten nonce should produce, rather than a quieter policy.
 */
export function documentContentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    "worker-src 'self'",
    // Same-origin API reads and the `/api/stream` WebSocket only.
    "connect-src 'self'",
    `img-src 'self' data: ${IMAGE_HOSTS.join(' ')}`,
    // React and the UI kit set inline style attributes; styles cannot run code.
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' data:",
    "manifest-src 'self'",
    "frame-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    `form-action 'self' ${FORM_ACTION_HOSTS.join(' ')}`,
  ].join('; ')
}

/** Shared document defenses. Keep game asset sandbox policies and API responses intact. */
export function secureDocument(response: Response, nonce: string): Response {
  if (!response.headers.get('content-type')?.includes('text/html')) return response
  const headers = new Headers(response.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  headers.set('Referrer-Policy', 'no-referrer')
  headers.set('Strict-Transport-Security', 'max-age=31536000')
  // A route that sets its own policy keeps it.
  if (!headers.has('Content-Security-Policy')) {
    headers.set('Content-Security-Policy', documentContentSecurityPolicy(nonce))
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
