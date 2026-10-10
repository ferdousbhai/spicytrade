import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type JsonValue } from '../src/domain/json-payload'

import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { brokerCredential, stubBroker } from './broker-stub'
import { loadBrokerageContext } from '../src/server/brokerage-context'
import { BROKER_ACCOUNT_PAGE_SIZE } from '../src/server/brokers/tastytrade-payload'

const tastytrade = stubBroker()

beforeEach(() => setBrokerApi(tastytrade))
afterEach(() => resetBrokerApi())

const balance = {
  'account-number': 'A1',
  'available-trading-funds': '61000',
  'cash-available-to-withdraw': '65000',
  'cash-balance': '70000',
  'day-trading-buying-power': '320000',
  'derivative-buying-power': '80000',
  'equity-buying-power': '160000',
  'net-liquidating-value': '100000',
}

type BrokerPage = { data: { items: JsonValue[] } }

function pageFor(path: string): BrokerPage {
  if (path.includes('/positions')) return { data: { items: [{
    symbol: 'SPY option',
    'underlying-symbol': 'SPY',
    quantity: '2',
    'quantity-direction': 'Long',
    'instrument-type': 'Equity Option',
    'average-open-price': '1.1',
    'mark-price': '1.25',
    'expires-at': '2026-09-18T20:00:00Z',
  }] } }
  if (path.includes('/complex-orders/live')) return { data: { items: [] } }
  if (path.includes('/orders/live')) return { data: { items: [{
    id: '101', status: 'Live', 'order-type': 'Limit', price: '1.20',
    'price-effect': 'Debit', 'time-in-force': 'Day',
    legs: [
      { action: 'Buy to Open', quantity: '1', symbol: 'SPY call', 'instrument-type': 'Equity Option' },
      { action: 'Sell to Open', quantity: '1', symbol: 'SPY call short', 'instrument-type': 'Equity Option' },
    ],
  }] } }
  throw new Error(`Unexpected path: ${path}`)
}

function payloadFor(path: string): JsonValue {
  return path.endsWith('/balances') ? { data: balance } : pageFor(path)
}

describe('brokerage context', () => {
  beforeEach(() => {
    tastytrade.resolveAccountNumber.mockReset().mockResolvedValue('A1')
    tastytrade.tastyRequest.mockReset().mockImplementation((_env, path: string) => Promise.resolve(payloadFor(path)))
  })

  it('loads accurately named balances and compact account state', async () => {
    const context = await loadBrokerageContext({}, brokerCredential)

    expect(context.balances).toMatchObject({
      cashBalance: 70_000,
      cashAvailableToWithdraw: 65_000,
      availableTradingFunds: 61_000,
      equityBuyingPower: 160_000,
      derivativeBuyingPower: 80_000,
      dayTradingBuyingPower: 320_000,
      netLiquidatingValue: 100_000,
    })
    expect(context.positions[0]).toMatchObject({
      averageOpenPrice: 1.1, expiresAt: '2026-09-18T20:00:00Z',
    })
    expect(context.positions[0]).not.toHaveProperty('markPrice')
    expect(context.orders[0]?.legs).toHaveLength(2)
    expect(context.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(context.source).toBe('tastytrade')
    expect(context.orders).toMatchObject([
      { id: '101', legs: [{ symbol: 'SPY call' }, { symbol: 'SPY call short' }] },
    ])
    expect(tastytrade.tastyRequest).toHaveBeenCalledTimes(4)
  })

  it('rejects malformed account collections instead of treating them as empty', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/positions') || path.includes('/orders/live')) {
        return Promise.resolve({ data: { unexpected: [] } })
      }
      return Promise.resolve(payloadFor(path))
    })

    await expect(loadBrokerageContext({}, brokerCredential)).rejects.toThrow('invalid-positions-collection')
  })

  it('fails working-order completeness closed when the broker reports another page', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/orders/live')) {
        const base = pageFor(path)
        return Promise.resolve({ ...base, pagination: { 'total-items': 2 } })
      }
      return Promise.resolve(payloadFor(path))
    })

    await expect(loadBrokerageContext({}, brokerCredential)).rejects.toThrow('incomplete-orders')
  })

  it('fails position completeness closed when the broker reports another page', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/positions')) {
        const base = pageFor(path)
        return Promise.resolve({ ...base, pagination: { 'total-items': 2 } })
      }
      return Promise.resolve(payloadFor(path))
    })

    await expect(loadBrokerageContext({}, brokerCredential)).rejects.toThrow('incomplete-positions')
  })

  it('fails position completeness closed on a full page without pagination metadata', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/positions')) {
        return Promise.resolve({ data: { items: Array.from({ length: BROKER_ACCOUNT_PAGE_SIZE }, (_, index) => ({
          symbol: `POS${index}`, 'underlying-symbol': 'SPY', quantity: '1',
          'quantity-direction': 'Long', 'instrument-type': 'Equity',
        })) } })
      }
      return Promise.resolve(payloadFor(path))
    })

    await expect(loadBrokerageContext({}, brokerCredential)).rejects.toThrow('incomplete-positions')
  })

  it('fails working-order completeness closed on a full page without pagination metadata', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/orders/live')) {
        return Promise.resolve({ data: { items: Array.from({ length: BROKER_ACCOUNT_PAGE_SIZE }, (_, index) => ({
          id: String(index + 1), status: 'Filled', 'terminal-at': '2026-08-13T12:00:00Z',
        })) } })
      }
      return Promise.resolve(payloadFor(path))
    })

    await expect(loadBrokerageContext({}, brokerCredential)).rejects.toThrow('incomplete-orders')
  })

  it('rejects a malformed declared pagination total', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/positions')) {
        return Promise.resolve({ ...pageFor(path), pagination: { 'total-items': 'unknown' } })
      }
      return Promise.resolve(payloadFor(path))
    })

    await expect(loadBrokerageContext({}, brokerCredential)).rejects.toThrow('invalid-positions-pagination')
  })

  it('rejects a declared total smaller than the returned page', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/positions')) {
        return Promise.resolve({ ...pageFor(path), pagination: { 'total-items': 0 } })
      }
      return Promise.resolve(payloadFor(path))
    })

    await expect(loadBrokerageContext({}, brokerCredential)).rejects.toThrow('incomplete-positions')
  })
})
