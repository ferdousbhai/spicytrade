import { failureCode, toError } from '../../src/domain/failure'
import { type AppEnv } from '../../src/server/env'
import { presentedBearer } from '../../src/server/mcp-tokens'

type CloudflareSubtleCrypto = SubtleCrypto & {
  timingSafeEqual(left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView): boolean
}

export type OpsEnv = AppEnv & { OPS_AUTH_TOKEN?: string }

async function authorizedOpsRequest(request: Request, expected: string | undefined): Promise<boolean> {
  const provided = presentedBearer(request)
  if (!expected || !provided) return false
  const encoder = new TextEncoder()
  const [providedHash, expectedHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  // SAFETY: these temporary Workers run on Cloudflare, whose SubtleCrypto extension
  // provides constant-time comparison for equally sized SHA-256 digests.
  return (crypto.subtle as CloudflareSubtleCrypto).timingSafeEqual(providedHash, expectedHash)
}

/**
 * The single request gate for every temporary ops Worker. A non-POST method, an
 * unlisted path, and a failed bearer check are answered identically with a bare
 * 404 — never 401 or 403, and never a body naming the route — so an unauthorized
 * caller cannot learn that these owner-only bootstrap endpoints exist at all.
 * Only a caller that already proved the token can observe a handler's failure,
 * and that failure reports a stable code rather than an unbounded cause.
 */
export async function serveOpsRequest(
  request: Request,
  env: OpsEnv,
  paths: readonly string[],
  fallbackCode: string,
  handle: (path: string) => Promise<Response>,
): Promise<Response> {
  const path = new URL(request.url).pathname
  if (request.method !== 'POST'
    || !paths.includes(path)
    || !await authorizedOpsRequest(request, env.OPS_AUTH_TOKEN)) {
    return new Response('Not found', { status: 404 })
  }
  try {
    return await handle(path)
  } catch (cause) {
    return Response.json({ error: failureCode(toError(cause)) ?? fallbackCode }, { status: 500 })
  }
}
