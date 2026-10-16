import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { authIssuerFor, getAuthRuntime, mcpResourceIdentifier } from '../src/server/auth'
import { type AppEnv } from '../src/server/env'
import { handleMcpRequest } from '../src/server/mcp'
import { issueMcpToken, revokeMcpToken } from '../src/server/mcp-tokens'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { executionContext, mcpRequest, TOOLS_LIST } from './mcp-harness'
import { migrationStore, seedMember, type SqliteD1Store } from './sqlite-d1'

/*
 * The OAuth way in, end to end: the real auth runtime over the migration schema, and an access
 * token it signed itself with the same issuer and audience a real authorization would carry.
 * The runtime is cached per isolate, so the file shares one store.
 */
const BASE_URL = 'https://spicy.trade'

let store: SqliteD1Store
let env: AppEnv

beforeAll(async () => {
  store = await migrationStore()
  env = {
    AUTH_BASE_URL: BASE_URL,
    BETTER_AUTH_SECRET: 'test-secret-that-is-long-enough-32',
    DB: store.database,
    GOOGLE_CLIENT_ID: 'google-client-id',
    GOOGLE_CLIENT_SECRET: { get: async () => 'google-client-secret' },
  }
})

afterAll(() => store.close())

afterEach(() => {
  resetBrokerApi()
})

async function accessTokenFor(sub: string): Promise<string> {
  const { auth } = await getAuthRuntime(env)
  const { token } = await auth.api.signJWT({
    body: { payload: { aud: mcpResourceIdentifier(BASE_URL), iss: authIssuerFor(BASE_URL), sub } },
  })
  return token
}

describe('MCP OAuth callers', () => {
  it('serves a verified subject who is a member', async () => {
    seedMember(store, 'oauth-member')
    setBrokerApi(stubBroker())
    const response = await handleMcpRequest(mcpRequest(TOOLS_LIST, await accessTokenFor('oauth-member')), env, executionContext)
    expect(response.status).toBe(200)
  })

  it('refuses a validly signed token whose user has been deleted', async () => {
    seedMember(store, 'deleted-member')
    // Signed while the account existed; the signature, issuer, audience and expiry all still hold.
    const token = await accessTokenFor('deleted-member')
    store.sqlite.prepare('DELETE FROM "user" WHERE id = ?').run('deleted-member')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await handleMcpRequest(mcpRequest(TOOLS_LIST, token), env, executionContext)
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toContain('invalid_token')
    expect(response.headers.get('WWW-Authenticate'))
      .toContain(`resource_metadata="${BASE_URL}/.well-known/oauth-protected-resource/mcp"`)
    expect(logged).toHaveBeenCalledWith('McpAuthRejected')
  })

  it('answers a failing member lookup with a challenge and a named log, never an escaped throw', async () => {
    seedMember(store, 'lookup-member')
    const token = await accessTokenFor('lookup-member')
    const prepare = store.database.prepare.bind(store.database)
    vi.spyOn(store.database, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('FROM "user"')) {
        const error = new Error('D1_ERROR: read failed')
        error.name = 'D1Error'
        throw error
      }
      return prepare(sql)
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const response = await handleMcpRequest(mcpRequest(TOOLS_LIST, token), env, executionContext)
    expect(response.status).toBe(401)
    expect(response.headers.get('WWW-Authenticate')).toContain('spicytrade could not verify this request.')
    expect(logged.mock.calls).toEqual([['McpCallerLookupFailed', 'D1Error']])
  })

  it('decides a minted token by its own table, whatever case the scheme is in, and never as a JWT', async () => {
    seedMember(store, 'minted-member')
    setBrokerApi(stubBroker())
    const issued = await issueMcpToken(store.database, 'minted-member', 'laptop')
    const live = await handleMcpRequest(mcpRequest(TOOLS_LIST, issued.token, 'bearer'), env, executionContext)
    expect(live.status).toBe(200)

    await revokeMcpToken(store.database, 'minted-member', issued.tokenMetadata.tokenId)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    for (const scheme of ['Bearer', 'bearer', 'BEARER']) {
      const revoked = await handleMcpRequest(mcpRequest(TOOLS_LIST, issued.token, scheme), env, executionContext)
      expect(revoked.status).toBe(401)
      expect(revoked.headers.get('WWW-Authenticate')).toContain('invalid_token')
    }
    // Refused as the token it is, not as a JWT that failed to verify.
    const events = logged.mock.calls.map(([event]) => event)
    expect(events).toEqual(['McpTokenRejected', 'McpTokenRejected', 'McpTokenRejected'])
  })
})
