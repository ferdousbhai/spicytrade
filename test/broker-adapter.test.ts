import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type JsonValue } from '../src/domain/json-payload'
import { BrokerIdSchema } from '../src/domain/broker'

import {
  brokerAdapterFor,
  resetBrokerAdapters,
  setBrokerAdapters,
  UnknownBrokerError,
} from '../src/server/brokers'
import { tastytradeAdapter } from '../src/server/brokers/tastytrade'
import { loadBrokerageContext } from '../src/server/brokerage-context'
import { CallerVisibleError } from '../src/server/caller-visible-error'
import { readAccountHistory, readAccountSnapshot } from '../src/server/brokerage-read-tools'
import { assertPortfolioActionAllowed } from '../src/server/portfolio-risk'
import { resetBrokerApi, setBrokerApi, type BrokerApi } from '../src/server/tastytrade'
import {
  brokerCredential,
  STUB_BROKER_ID,
  stubBrokerCredential,
  stubAdapter,
  stubBroker,
} from './broker-stub'
import { untouchedDb } from './fake-d1'

/**
 * Every tastytrade entry point, wired to fail. Installed for the stub-adapter run so the seam
 * is proven real rather than nominal: if any account read still reaches provider code, the
 * test fails instead of quietly passing through it.
 */
const forbidden = () => { throw new Error('tastytrade transport reached') }

const forbiddenBrokerApi = {
  claimMarketRefresh: forbidden,
  loadMarketSnapshot: forbidden,
  loadPublicMarketSnapshot: forbidden,
  loadQuoteToken: forbidden,
  loadStoredMarketSnapshot: forbidden,
  loadStoredPublicMarketSnapshot: forbidden,
  refreshPublicMarketSession: forbidden,
  releaseMarketRefresh: forbidden,
  lookupPublicMarketSymbol: forbidden,
  lookupStoredMarketSymbol: forbidden,
  resolveAccountNumber: forbidden,
  tastyRequest: forbidden,
  withBrokerMutationLease: forbidden,
} satisfies BrokerApi

describe('broker adapter seam', () => {
  let adapter: ReturnType<typeof stubAdapter>

  beforeEach(() => {
    adapter = stubAdapter()
    setBrokerAdapters({ [STUB_BROKER_ID]: adapter })
    setBrokerApi(forbiddenBrokerApi)
  })

  afterEach(() => {
    resetBrokerAdapters()
    resetBrokerApi()
  })

  it('drives the account context, the portfolio guard, and the read tools with no provider code in the path', async () => {
    const context = await loadBrokerageContext({}, stubBrokerCredential)
    expect(context).not.toHaveProperty('accountNumber')
    expect(context).toMatchObject({
      source: STUB_BROKER_ID,
      balances: { netLiquidatingValue: 100_000 },
      positions: [{ symbol: 'SPY' }],
    })

    await expect(assertPortfolioActionAllowed({ DB: untouchedDb() }, {
      kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open',
      quantity: 1, limitPrice: 700, priceEffect: 'Debit',
    }, stubBrokerCredential, { accountNumber: 'STUB-1', optionContracts: [] })).resolves.toBeUndefined()

    const history = await readAccountHistory({}, { type: 'transactions' }, stubBrokerCredential)
    expect(history).toMatchObject({ source: STUB_BROKER_ID, totalItemCount: 1, truncated: false })
    expect(history.items).toHaveLength(1)

    const snapshot = await readAccountSnapshot({}, {}, stubBrokerCredential)
    expect(snapshot).toMatchObject({
      source: STUB_BROKER_ID,
      balances: { netLiquidatingValue: 100_000 },
      positions: [{ symbol: 'SPY' }],
    })
    expect(JSON.stringify(snapshot)).not.toContain('STUB-1')

    expect(adapter.calls).toEqual([
      'resolveAccountRef',
      'loadAccountSnapshot',
      // The guard is handed the account placement already resolved; it does not resolve its own.
      'loadAccountSnapshot',
      'resolveAccountRef',
      'readAccountHistory',
      'resolveAccountRef',
      'loadAccountSnapshot',
    ])
  })

  it('passes an account-resolution refusal to the snapshot caller as it passes it to history', async () => {
    const ambiguous = new CallerVisibleError('TastytradeAccount:explicit-account-required')
    setBrokerAdapters({ [STUB_BROKER_ID]: { ...adapter, resolveAccountRef: async () => { throw ambiguous } } })
    // A member with several accounts must be told why, not that the snapshot "could not be loaded".
    await expect(readAccountSnapshot({}, {}, stubBrokerCredential)).rejects.toBe(ambiguous)
    await expect(readAccountHistory({}, { type: 'orders' }, stubBrokerCredential)).rejects.toBe(ambiguous)
  })

  it('names a transport failure as an unloadable snapshot rather than passing its text through', async () => {
    setBrokerAdapters({
      [STUB_BROKER_ID]: { ...adapter, loadAccountSnapshot: async () => { throw new TypeError('fetch failed: secret detail') } },
    })
    await expect(readAccountSnapshot({}, {}, stubBrokerCredential)).rejects.toThrow('The account snapshot could not be loaded.')
  })

  it('fails closed on a broker id no adapter is registered for', async () => {
    expect(() => brokerAdapterFor(brokerCredential)).toThrow(UnknownBrokerError)
    await expect(loadBrokerageContext({}, brokerCredential))
      .rejects.toThrow("No broker adapter is registered for 'tastytrade'.")
    expect(adapter.calls).toEqual([])
  })

  it('fails closed rather than choosing a broker when no credential is presented', async () => {
    await expect(loadBrokerageContext({}, undefined)).rejects.toThrow('No brokerage is connected.')
    expect(adapter.calls).toEqual([])
  })
})

describe('registered adapters', () => {
  it('registers an adapter under every broker id the header parser accepts', () => {
    for (const broker of BrokerIdSchema.options) {
      expect(brokerAdapterFor({ accessToken: 'token', broker }).id).toBe(broker)
    }
  })
})

describe('tastytrade order history for reconciliation', () => {
  afterEach(() => resetBrokerApi())

  const history = (payload: JsonValue) => {
    const broker = stubBroker()
    broker.tastyRequest.mockResolvedValue(payload)
    setBrokerApi(broker)
    return tastytradeAdapter.readOrderHistory(
      {}, { accountNumber: 'TEST123', broker: 'tastytrade' }, { startDate: '2026-09-01' }, brokerCredential,
    )
  }

  it('treats a short page or a covering total as the whole history', async () => {
    await expect(history({ data: { items: [] } })).resolves.toEqual({ complete: true, orders: [] })
    await expect(history({ data: { items: [] }, pagination: { 'total-items': 0 } }))
      .resolves.toEqual({ complete: true, orders: [] })
    await expect(history({ data: { items: [] }, pagination: { 'total-items': 3 } }))
      .resolves.toEqual({ complete: false, orders: [] })
  })

  it('refuses a declared total it cannot read rather than guessing completeness', async () => {
    await expect(history({ data: { items: [] }, pagination: { 'total-items': null } })).rejects.toThrow('invalid response')
    await expect(history({ data: { items: [] }, pagination: { 'total-items': 'many' } })).rejects.toThrow('invalid response')
  })
})
