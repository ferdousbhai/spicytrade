import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  brokerCredentialFromHeaders,
} from '../src/server/broker-credential'
import { handleMcpRequest, type McpExecutionContext } from '../src/server/mcp'
import { type JsonObject } from '../src/domain/json-payload'
import { stubBrokerGate } from './broker-stub'

const executionContext: McpExecutionContext = { props: undefined, waitUntil: () => undefined }

function mcpRequest(method: string, params: JsonObject, token: string): Request {
  return new Request('https://spice.test/mcp', {
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method, params }),
    headers: {
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    method: 'POST',
  })
}

async function mcpPayload(response: Response) {
  const body = await response.text()
  return JSON.parse(body.slice(body.indexOf('{')))
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('request-scoped broker credential', () => {
  it('parses a supported broker and trims its token', () => {
    const credential = brokerCredentialFromHeaders(new Headers({
      'X-Spice-Broker': 'tastytrade',
      'X-Spice-Broker-Token': '  request-token  ',
    }))

    expect(credential).toEqual({ accessToken: 'request-token', broker: 'tastytrade' })
  })

  it('reads the current header names', () => {
    const credential = brokerCredentialFromHeaders(new Headers({
      'X-Spicy-Trade-Broker': 'tastytrade',
      'X-Spicy-Trade-Broker-Token': 'request-token',
    }))

    expect(credential).toEqual({ accessToken: 'request-token', broker: 'tastytrade' })
  })

  it('accepts a header sent under both names when the values agree', () => {
    const credential = brokerCredentialFromHeaders(new Headers({
      'X-Spice-Broker': 'tastytrade',
      'X-Spice-Broker-Token': 'request-token',
      'X-Spicy-Trade-Broker': 'tastytrade',
      'X-Spicy-Trade-Broker-Token': ' request-token ',
    }))

    expect(credential).toEqual({ accessToken: 'request-token', broker: 'tastytrade' })
  })

  it.each([
    ['tokens', {
      'X-Spice-Broker-Token': 'old-token',
      'X-Spicy-Trade-Broker': 'tastytrade',
      'X-Spicy-Trade-Broker-Token': 'new-token',
    }],
    ['brokers', {
      'X-Spice-Broker': 'another-broker',
      'X-Spicy-Trade-Broker': 'tastytrade',
      'X-Spicy-Trade-Broker-Token': 'request-token',
    }],
  ])('refuses %s that disagree between the old and current names', (_label, values) => {
    expect(brokerCredentialFromHeaders(new Headers(values))).toBeUndefined()
  })

  it.each([
    ['missing broker', { 'X-Spice-Broker-Token': 'request-token' }],
    ['missing token', { 'X-Spice-Broker': 'tastytrade' }],
    ['empty broker', { 'X-Spice-Broker': ' ', 'X-Spice-Broker-Token': 'request-token' }],
    ['empty token', { 'X-Spice-Broker': 'tastytrade', 'X-Spice-Broker-Token': ' ' }],
    ['unknown broker', { 'X-Spice-Broker': 'another-broker', 'X-Spice-Broker-Token': 'request-token' }],
  ])('refuses %s', (_label, values) => {
    expect(brokerCredentialFromHeaders(new Headers(values))).toBeUndefined()
  })

  it('throws the caller-visible missing-credential error for an account path', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { tastyRequest } = await import('../src/server/tastytrade')
    const { BrokerCredentialMissingError } = await import('../src/server/broker-credential')
    const brokerGate = stubBrokerGate()

    await expect(tastyRequest(
      { BROKER_GATE: brokerGate.namespace },
      '/customers/me/accounts',
    )).rejects.toBeInstanceOf(BrokerCredentialMissingError)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(brokerGate.namespace.getByName).not.toHaveBeenCalled()
  })

  it('never reads the Worker credential for an account path', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ data: {} }))
    vi.stubGlobal('fetch', fetchMock)
    const { tastyRequest } = await import('../src/server/tastytrade')
    const { BrokerCredentialMissingError } = await import('../src/server/broker-credential')
    const brokerGate = stubBrokerGate()
    const workerSecret: SecretsStoreSecret = { get: vi.fn().mockResolvedValue('worker-secret') }
    const env = {
      BROKER_GATE: brokerGate.namespace,
      TASTYTRADE_CLIENT_SECRET: workerSecret,
      TASTYTRADE_REFRESH_TOKEN: workerSecret,
    }

    await expect(tastyRequest(env, '/accounts/MEMBER123/balances')).rejects
      .toBeInstanceOf(BrokerCredentialMissingError)
    expect(fetchMock).not.toHaveBeenCalled()

    await tastyRequest(env, '/accounts/MEMBER123/balances', {}, {
      accessToken: 'exact-request-token',
      broker: 'tastytrade',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization'))
      .toBe('Bearer exact-request-token')
    expect(workerSecret.get).not.toHaveBeenCalled()
    expect(brokerGate.namespace.getByName).toHaveBeenCalledWith('tastytrade:MEMBER123')
  })

  it('never refreshes or retries with the Worker credential after an account 401', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response('', { status: 401 }))
    vi.stubGlobal('fetch', fetchMock)
    const { tastyRequest } = await import('../src/server/tastytrade')
    const brokerGate = stubBrokerGate()
    const workerSecret: SecretsStoreSecret = { get: vi.fn().mockResolvedValue('worker-secret') }

    await expect(tastyRequest({
      BROKER_GATE: brokerGate.namespace,
      TASTYTRADE_CLIENT_SECRET: workerSecret,
      TASTYTRADE_REFRESH_TOKEN: workerSecret,
    }, '/accounts/MEMBER123/balances', {}, {
      accessToken: 'expired-request-token',
      broker: 'tastytrade',
    })).rejects.toThrow('TastytradeApi:401:/accounts/[redacted]/balances')

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get('Authorization'))
      .toBe('Bearer expired-request-token')
    expect(workerSecret.get).not.toHaveBeenCalled()
  })

  it('ignores a request credential on market paths and uses the Worker credential', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => (
      String(input).endsWith('/oauth/token')
        ? Response.json({ access_token: 'worker-market-token', expires_in: 900 })
        : Response.json({ data: {} })
    ))
    vi.stubGlobal('fetch', fetchMock)
    const { tastyRequest } = await import('../src/server/tastytrade')
    const brokerGate = stubBrokerGate()
    const workerSecret: SecretsStoreSecret = { get: vi.fn().mockResolvedValue('worker-secret') }

    await tastyRequest({
      BROKER_GATE: brokerGate.namespace,
      TASTYTRADE_CLIENT_SECRET: workerSecret,
      TASTYTRADE_REFRESH_TOKEN: workerSecret,
    }, '/api-quote-tokens', {}, {
      accessToken: 'member-account-token',
      broker: 'tastytrade',
    })

    const marketCall = fetchMock.mock.calls.find(([input]) => !String(input).endsWith('/oauth/token'))
    expect(new Headers(marketCall?.[1]?.headers).get('Authorization')).toBe('Bearer worker-market-token')
    expect(brokerGate.namespace.getByName).toHaveBeenCalledWith('tastytrade:market')
  })

  it('keeps account tools advertised and returns a missing credential as a normal tool result', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    // Every caller is a real token row now; there is no shared secret to stand in for one.
    const { migrationStore } = await import('./sqlite-d1')
    const { issueMcpToken } = await import('../src/server/mcp-tokens')
    const { OWNER_EMAIL } = await import('../src/server/auth')
    const store = await migrationStore()
    store.sqlite.prepare(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES ('owner-1', 'Owner', ?, 1, 'now', 'now')`,
    ).run(OWNER_EMAIL)
    const issued = await issueMcpToken(store.database, 'owner-1', 'laptop')
    const env = { DB: store.database }

    const listed = await mcpPayload(await handleMcpRequest(
      mcpRequest('tools/list', {}, issued.token),
      env,
      executionContext,
    ))
    const names = listed.result.tools.map((tool: { name: string }) => tool.name)
    expect(names).toContain('read_account_history')
    expect(names).toContain('read_account_snapshot')
    expect(names).toContain('place_brokerage_order')

    const called = await mcpPayload(await handleMcpRequest(
      mcpRequest('tools/call', { arguments: { type: 'orders' }, name: 'read_account_history' }, issued.token),
      env,
      executionContext,
    ))
    expect(called.error).toBeUndefined()
    expect(called.result.content).toEqual([{
      text: 'No brokerage is connected. Connect Spicytrade in your current agent conversation using https://spicy.trade/connect/guide. Account access needs the local Linux connector; research can use the remote MCP server.',
      type: 'text',
    }])
    expect(fetchMock).not.toHaveBeenCalled()
    store.close()
  })
})
