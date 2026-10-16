import { beforeEach, describe, expect, it, vi } from 'vitest'

import { serveOpsRequest, type OpsEnv } from '../ops/shared/worker-auth'

const OPS_AUTH_TOKEN = 'one-run-bootstrap-token-1234567890'
const PATHS = ['/preview', '/apply']

function opsRequest(path: string, token: string | undefined, method = 'POST'): Request {
  return new Request(`https://ops.example.workers.dev${path}`, {
    method,
    headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
  })
}

function servePreview(request: Request, env: OpsEnv): Promise<Response> {
  return serveOpsRequest(request, env, PATHS, 'Ops:operation-failed', async (path) =>
    Response.json({ mode: path.slice(1) }))
}

describe('temporary ops Worker request gate', () => {
  beforeEach(() => {
    // The Cloudflare runtime supplies SubtleCrypto.timingSafeEqual; Node does not,
    // so the gate is exercised here against an equivalent digest comparison.
    const digest = crypto.subtle.digest.bind(crypto.subtle)
    const timingSafeEqual = (left: ArrayBuffer | ArrayBufferView, right: ArrayBuffer | ArrayBufferView) => {
      const leftBytes = new Uint8Array(ArrayBuffer.isView(left) ? left.buffer : left)
      const rightBytes = new Uint8Array(ArrayBuffer.isView(right) ? right.buffer : right)
      return leftBytes.length === rightBytes.length && leftBytes.every((value, index) => value === rightBytes[index])
    }
    vi.stubGlobal('crypto', { subtle: { digest, timingSafeEqual } })
  })

  it('answers every unauthorized request with a 404 that discloses no route', async () => {
    const rejections = await Promise.all([
      servePreview(opsRequest('/preview', undefined), { OPS_AUTH_TOKEN }),
      servePreview(opsRequest('/preview', 'wrong-token-1234567890123456789012'), { OPS_AUTH_TOKEN }),
      servePreview(opsRequest('/preview', OPS_AUTH_TOKEN), {}),
      servePreview(opsRequest('/unlisted', OPS_AUTH_TOKEN), { OPS_AUTH_TOKEN }),
      servePreview(opsRequest('/preview', OPS_AUTH_TOKEN, 'GET'), { OPS_AUTH_TOKEN }),
    ])
    for (const response of rejections) {
      expect(response.status).toBe(404)
      expect(await response.text()).toBe('Not found')
      expect(response.headers.get('WWW-Authenticate')).toBeNull()
    }
  })

  it('runs the handler only for an allowlisted path with the run token', async () => {
    const response = await servePreview(opsRequest('/apply', OPS_AUTH_TOKEN), { OPS_AUTH_TOKEN })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ mode: 'apply' })
  })

  it('reports an authorized handler failure as a bounded 500 code', async () => {
    const failing = (request: Request, message: string) =>
      serveOpsRequest(request, { OPS_AUTH_TOKEN }, PATHS, 'Ops:operation-failed', async () => {
        throw message === '' ? 'not-an-error' : new Error(message)
      })

    const reported = await failing(opsRequest('/apply', OPS_AUTH_TOKEN), 'Ops:invalid-offset')
    expect(reported.status).toBe(500)
    expect(await reported.json()).toEqual({ error: 'Ops:invalid-offset' })

    const opaque = await failing(opsRequest('/apply', OPS_AUTH_TOKEN), '')
    expect(opaque.status).toBe(500)
    expect(await opaque.json()).toEqual({ error: 'Ops:operation-failed' })
  })

  it('collapses a human-readable Error message to the handler failure code', async () => {
    const failing = (request: Request, message: string) =>
      serveOpsRequest(request, { OPS_AUTH_TOKEN }, PATHS, 'Ops:operation-failed', async () => {
        throw new Error(message)
      })

    // Prose has spaces and trailing punctuation, unlike this repository's
    // `PascalCase:kebab-segments` codes, so it must not reach an ops caller verbatim.
    const prose = await failing(opsRequest('/apply', OPS_AUTH_TOKEN), 'The instrument catalog request timed out.')
    expect(prose.status).toBe(500)
    expect(await prose.json()).toEqual({ error: 'Ops:operation-failed' })
  })
})
