import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { BrokerageSubmissionUnknownError, executeOrderPlacement } from '../src/server/brokerage'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { resetTradeGuards, setTradeGuards, type TradeGuards } from '../src/server/trade-guards'
import { brokerCredential, stubBroker } from './broker-stub'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

const guards = {
  assertOrderMarketSafe: vi.fn(),
  assertPortfolioActionAllowed: vi.fn(),
} satisfies TradeGuards

const broker = stubBroker()

const mocks = { ...broker, ...guards }

beforeEach(() => {
  setBrokerApi(broker)
  setTradeGuards(guards)
})

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => {
  resetBrokerApi()
  resetTradeGuards()
  store.close()
})

const place = () => executeOrderPlacement({ DB: store.database }, action, brokerCredential, 'TEST123')

const action = {
  action: 'Buy to Open' as const,
  kind: 'place_equity_order' as const,
  limitPrice: 700,
  priceEffect: 'Debit' as const,
  quantity: 1,
  symbol: 'SPY',
}

function response(warnings: Array<{ message: string }> = [], id = 123) {
  return { data: {
    'buying-power-effect': { effect: 'Debit' },
    order: {
      id,
      legs: [{
        action: 'Buy to Open',
        'instrument-type': 'Equity',
        quantity: 1,
        symbol: 'SPY',
      }],
      'order-type': 'Limit',
      price: '700.00',
      'price-effect': 'Debit',
      'time-in-force': 'Day',
    },
    warnings,
  } }
}

describe('brokerage dispatch warnings', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.assertPortfolioActionAllowed.mockResolvedValue(undefined)
    mocks.assertOrderMarketSafe.mockResolvedValue({})
  })

  it('does not place an order after a dry-run warning', async () => {
    mocks.tastyRequest.mockResolvedValue(response([{ message: 'Review position effect' }]))

    await expect(place()).rejects.toThrow('order was not submitted')
    expect(mocks.tastyRequest).toHaveBeenCalledTimes(1)
    expect(mocks.tastyRequest.mock.calls[0]?.[1]).toContain('/orders/dry-run')
    expect(mocks.withBrokerMutationLease).toHaveBeenCalledTimes(1)
    expect(mocks.renewBrokerMutationLease).toHaveBeenCalledTimes(1)
  })

  it('retains warnings returned with an already-accepted order', async () => {
    mocks.tastyRequest
      .mockResolvedValueOnce(response())
      .mockResolvedValueOnce(response([{ message: 'Order queued for review' }]))

    // The broker's warning text travels in its own untrusted field, never inside our detail.
    await expect(place()).resolves.toMatchObject({
      detail: 'Order #123 accepted by tastytrade with broker warnings.',
      orderId: '123',
      untrustedBrokerWarnings: ['Order queued for review'],
    })
    expect(mocks.withBrokerMutationLease).toHaveBeenCalledTimes(1)
    expect(mocks.renewBrokerMutationLease).toHaveBeenCalledTimes(2)
  })

  it('treats a lease lost before sending as a plain failure, not an ambiguous submission', async () => {
    mocks.tastyRequest.mockResolvedValue(response())
    mocks.renewBrokerMutationLease
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('BrokerMutationLease:lost'))

    // Nothing was sent, so quarantining the account would be a false alarm.
    const failure = place()
    await expect(failure).rejects.toThrow('BrokerMutationLease:lost')
    await expect(failure).rejects.not.toBeInstanceOf(BrokerageSubmissionUnknownError)
    expect(mocks.tastyRequest).toHaveBeenCalledTimes(1)
    expect(store.sqlite.prepare('SELECT count(*) AS count FROM broker_submissions').get()).toEqual({ count: 0 })
  })
})
