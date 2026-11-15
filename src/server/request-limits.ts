import { type AppEnv, type RequestLimiter } from './env'
import { MCP_PATH } from '../domain/site'

/**
 * Per-address limits applied before a request reaches anything that does work for it. Each
 * limiter's allowance and period are configured on its binding in `cloudflare.config.ts`, which is
 * where the reason for each number is recorded; this only decides which requests each one counts.
 * A missing binding closes the path it guards rather than leaving it unlimited.
 */
const OAUTH_REGISTRATION_PATH = '/api/auth/oauth2/register'

function limiterFor(request: Request, env: AppEnv): [RequestLimiter | undefined, string] | null {
  const { pathname } = new URL(request.url)
  if (pathname === '/api/public-symbol-search' || (pathname === MCP_PATH && !request.headers.has('Authorization'))) {
    return [env.PUBLIC_READ_LIMITER, 'Public request limiter unavailable']
  }
  // Registration is open to anyone, because that is how an MCP client bootstraps, and every
  // registration is a stored row. better-auth's own limiter counts per isolate in memory, which on
  // Workers bounds nothing, so the address-wide count lives on a Cloudflare binding instead.
  if (pathname === OAUTH_REGISTRATION_PATH && request.method === 'POST') {
    return [env.OAUTH_REGISTRATION_LIMITER, 'Client registration limiter unavailable']
  }
  return null
}

export async function limitRequest(request: Request, env: AppEnv): Promise<Response | null> {
  const rule = limiterFor(request, env)
  if (!rule) return null
  const [limiter, unavailable] = rule
  if (!limiter) return Response.json({ error: unavailable }, { status: 503 })
  const allowed = await limiter.limit({ key: request.headers.get('CF-Connecting-IP') ?? 'unknown' })
  if (allowed.success) return null
  return Response.json({ error: 'Too many requests' }, { status: 429, headers: { 'Retry-After': '60', 'Cache-Control': 'no-store' } })
}
