import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { AUTHORIZATION_REQUEST_LIFETIME_SECONDS, configureAuth } from '../src/server/auth'
import { sweepUnconsentedOAuthClients } from '../src/server/oauth-client-sweep'
import { limitRequest } from '../src/server/request-limits'
import { migrationStore, seedMember, type SqliteD1Store } from './sqlite-d1'

const BASE_URL = 'https://spicy.trade'
const LIFETIME_MS = AUTHORIZATION_REQUEST_LIFETIME_SECONDS * 1000

/** A registration exactly as an anonymous caller makes one, through the real provider. */
async function register(store: SqliteD1Store): Promise<string> {
  const auth = configureAuth(store.database, BASE_URL, 'test-secret-that-is-long-enough-32', 'g', 'g-secret')
  const response = await auth.handler(new Request(`${BASE_URL}/api/auth/oauth2/register`, {
    body: JSON.stringify({ application_type: 'native', client_name: 'Probe', redirect_uris: ['http://127.0.0.1:43210/callback'], token_endpoint_auth_method: 'none' }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  }))
  if (response.status >= 300) throw new Error(await response.text())
  return z.object({ client_id: z.string() }).parse(await response.json()).client_id
}

const clientIds = (store: SqliteD1Store) => store.sqlite.prepare('SELECT "clientId" FROM "oauthClient"').all().map((row) => row.clientId)

describe('sweeping abandoned client registrations', () => {
  it('drops a self-registered client nobody approved once its first request has lapsed', async () => {
    const store = await migrationStore()
    try {
      const clientId = await register(store)
      // Read through the real provider, so the cutoff is compared against the format it writes.
      expect(await sweepUnconsentedOAuthClients({ DB: store.database }, new Date(Date.now() + LIFETIME_MS - 60_000))).toBe(0)
      expect(clientIds(store)).toEqual([clientId])
      expect(await sweepUnconsentedOAuthClients({ DB: store.database }, new Date(Date.now() + LIFETIME_MS + 60_000))).toBe(1)
      expect(clientIds(store)).toEqual([])
    } finally {
      store.close()
    }
  })

  it('keeps a client a member approved, and one holding a token', async () => {
    const store = await migrationStore()
    try {
      seedMember(store, 'member-a')
      const consented = await register(store)
      const tokened = await register(store)
      const at = new Date().toISOString()
      store.sqlite.prepare(
        `INSERT INTO "oauthConsent" ("id", "clientId", "userId", "scopes", "createdAt", "updatedAt") VALUES ('k', ?, 'member-a', '', ?, ?)`,
      ).run(consented, at, at)
      store.sqlite.prepare(
        `INSERT INTO "oauthRefreshToken" ("id", "token", "clientId", "userId", "expiresAt", "createdAt", "scopes") VALUES ('r', 't', ?, 'member-a', ?, ?, '')`,
      ).run(tokened, at, at)
      expect(await sweepUnconsentedOAuthClients({ DB: store.database }, new Date(Date.now() + LIFETIME_MS * 10))).toBe(0)
      expect(clientIds(store).sort()).toEqual([consented, tokened].sort())
    } finally {
      store.close()
    }
  })

  it('names a missing database rather than reporting nothing swept', async () => {
    await expect(sweepUnconsentedOAuthClients({})).rejects.toMatchObject({ name: 'BindingMissing' })
  })
})

describe('request limits', () => {
  const registration = () => new Request(`${BASE_URL}/api/auth/oauth2/register`, {
    headers: { 'CF-Connecting-IP': '203.0.113.7' },
    method: 'POST',
  })

  it('counts client registrations per address on their own limiter', async () => {
    const limit = vi.fn(async () => ({ success: false }))
    const publicLimit = vi.fn(async () => ({ success: true }))
    const refused = await limitRequest(registration(), { OAUTH_REGISTRATION_LIMITER: { limit }, PUBLIC_READ_LIMITER: { limit: publicLimit } })
    expect(refused?.status).toBe(429)
    expect(limit).toHaveBeenCalledWith({ key: '203.0.113.7' })
    expect(publicLimit).not.toHaveBeenCalled()
  })

  it('closes registration when its limiter is not bound', async () => {
    expect((await limitRequest(registration(), {}))?.status).toBe(503)
  })

  it('leaves other auth requests to the provider', async () => {
    const limit = vi.fn(async () => ({ success: false }))
    expect(await limitRequest(new Request(`${BASE_URL}/api/auth/oauth2/token`, { method: 'POST' }), { OAUTH_REGISTRATION_LIMITER: { limit } })).toBeNull()
    expect(await limitRequest(new Request(`${BASE_URL}/api/auth/oauth2/register`), { OAUTH_REGISTRATION_LIMITER: { limit } })).toBeNull()
    expect(limit).not.toHaveBeenCalled()
  })
})
