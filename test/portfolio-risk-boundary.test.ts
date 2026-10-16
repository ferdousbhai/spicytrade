import { describe, expect, it, vi } from 'vitest'

import { executeOrderPlacement } from '../src/server/brokerage'
import { type AppEnv } from '../src/server/env'
import { brokerCredential, stubBrokerGate, tastytradeBalances as balances } from './broker-stub'
import { unsupportedDatabase } from './fake-d1'

function secret(value: string): SecretsStoreSecret {
  return { get: async () => value }
}

describe('brokerage dispatch portfolio guard', () => {
  it('fails before dry-run or submission when fresh positions contain unbounded exposure', async () => {
    const calls: Array<{ method: string; url: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ method, url })
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 900 })
      if (url.endsWith('/customers/me/accounts')) return Response.json({ data: { items: [{ account: { 'account-number': 'TEST123' } }] } })
      if (url.includes('/positions')) return Response.json({ data: { items: [{
        symbol: 'SPY   260918C00700000', 'underlying-symbol': 'SPY',
        'instrument-type': 'Equity Option', 'quantity-direction': 'Short', quantity: '1',
      }] } })
      if (url.includes('/balances')) return Response.json({ data: balances })
      if (url.includes('/complex-orders/live')) return Response.json({ data: { items: [] } })
      if (url.includes('/orders/live')) return Response.json({ data: { items: [] } })
      if (url.includes('/option-chains/')) return Response.json({ data: { items: [{
        symbol: 'SPY   260918C00700000', 'instrument-type': 'Equity Option', active: true,
        'underlying-symbol': 'SPY', 'root-symbol': 'SPY', 'option-chain-type': 'Standard',
        'shares-per-contract': 100, 'expiration-date': '2026-09-18', 'strike-price': '700',
        'option-type': 'C', 'is-closing-only': false,
      }] } })
      throw new Error(`Unexpected request: ${method} ${url}`)
    }))
    const brokerGate = stubBrokerGate()
    const env: AppEnv = {
      BROKER_GATE: brokerGate.namespace,
      DB: unsupportedDatabase(),
      TASTYTRADE_CLIENT_SECRET: secret('client'),
      TASTYTRADE_REFRESH_TOKEN: secret('refresh'),
    }

    await expect(executeOrderPlacement(env, {
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: '2026-09-18', action: 'Buy to Open', quantity: 1, limitPrice: 5,
      priceEffect: 'Debit',
    }, brokerCredential, 'TEST123')).rejects.toThrow('Existing short, futures, or unsupported exposure')

    expect(calls.some((call) => call.url.includes('/orders/dry-run'))).toBe(false)
    expect(calls.some((call) => call.method === 'POST' && /\/accounts\/[^/]+\/orders$/.test(call.url))).toBe(false)
  })

  it('fails before dry-run when the live-order response is incomplete', async () => {
    const calls: Array<{ method: string; url: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ method, url })
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 900 })
      if (url.endsWith('/customers/me/accounts')) return Response.json({ data: { items: [{ account: { 'account-number': 'TEST123' } }] } })
      if (url.includes('/positions')) return Response.json({ data: { items: [] } })
      if (url.includes('/balances')) return Response.json({ data: balances })
      if (url.includes('/complex-orders/live')) return Response.json({ data: { items: [] } })
      if (url.includes('/orders/live')) {
        return Response.json({ data: { items: [] }, pagination: { 'total-items': 1 } })
      }
      throw new Error(`Unexpected request: ${method} ${url}`)
    }))
    const brokerGate = stubBrokerGate()
    const env: AppEnv = {
      BROKER_GATE: brokerGate.namespace,
      DB: unsupportedDatabase(),
      TASTYTRADE_CLIENT_SECRET: secret('client'),
      TASTYTRADE_REFRESH_TOKEN: secret('refresh'),
    }

    await expect(executeOrderPlacement(env, {
      kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open', quantity: 1,
      limitPrice: 700, priceEffect: 'Debit',
    }, brokerCredential, 'TEST123')).rejects.toThrow('could not verify every ordinary live order')

    expect(calls.some((call) => call.url.includes('/orders/dry-run'))).toBe(false)
    expect(calls.some((call) => call.method === 'POST' && /\/accounts\/[^/]+\/orders$/.test(call.url))).toBe(false)
  })

  it('fails before dry-run when the open-position response is incomplete', async () => {
    const calls: Array<{ method: string; url: string }> = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ method, url })
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'token', expires_in: 900 })
      if (url.endsWith('/customers/me/accounts')) return Response.json({ data: { items: [{ account: { 'account-number': 'TEST123' } }] } })
      if (url.includes('/positions')) {
        return Response.json({ data: { items: [{
          symbol: 'SPY', 'underlying-symbol': 'SPY', 'instrument-type': 'Equity',
          'quantity-direction': 'Long', quantity: '1',
        }] }, pagination: { 'total-items': 2 } })
      }
      if (url.includes('/balances')) return Response.json({ data: balances })
      if (url.includes('/complex-orders/live')) return Response.json({ data: { items: [] } })
      if (url.includes('/orders/live')) return Response.json({ data: { items: [] } })
      throw new Error(`Unexpected request: ${method} ${url}`)
    }))
    const brokerGate = stubBrokerGate()
    const env: AppEnv = {
      BROKER_GATE: brokerGate.namespace,
      DB: unsupportedDatabase(),
      TASTYTRADE_CLIENT_SECRET: secret('client'),
      TASTYTRADE_REFRESH_TOKEN: secret('refresh'),
    }

    await expect(executeOrderPlacement(env, {
      kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open', quantity: 1,
      limitPrice: 700, priceEffect: 'Debit',
    }, brokerCredential, 'TEST123')).rejects.toThrow('could not verify every open position')

    expect(calls.some((call) => call.url.includes('/positions?per-page=200'))).toBe(true)
    expect(calls.some((call) => call.url.includes('/orders/dry-run'))).toBe(false)
    expect(calls.some((call) => call.method === 'POST' && /\/accounts\/[^/]+\/orders$/.test(call.url))).toBe(false)
  })
})
