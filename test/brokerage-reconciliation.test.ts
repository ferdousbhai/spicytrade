import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  matchesSubmittedOrder,
  reconcileUnknownBrokerageAction,
  SUBMISSION_TRANSPORT_BUDGET_MS,
} from '../src/server/brokerage-reconciliation'
import { BROKER_CLOCK_SKEW_MS } from '../src/server/order-market'
import { BrokerageSubmissionUnknownError } from '../src/server/brokerage'
import { buildOrderPayload } from '../src/server/order-payload'
import { placeBrokerageOrder } from '../src/server/order-placement'
import { brokerCredential, stubBroker } from './broker-stub'
import { tastytradeAdapter, tastytradeOrderRecord } from '../src/server/brokers/tastytrade'
import { resetBrokerAdapters, setBrokerAdapters } from '../src/server/brokers'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { resetInternalWatchlistWriter, setInternalWatchlistWriter } from '../src/server/internal-watchlist'
import { resetTradeGuards, setTradeGuards } from '../src/server/trade-guards'
import { type BrokerOrderRecord } from '../src/domain/broker'
import { type JsonObject, type JsonValue } from '../src/domain/json-payload'
import { type AppEnv } from '../src/server/env'
import { unsupportedDatabase } from './fake-d1'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

let store: SqliteD1Store | undefined

afterEach(() => {
  store?.close()
  store = undefined
  resetBrokerApi()
  resetBrokerAdapters()
  resetInternalWatchlistWriter()
  resetTradeGuards()
})

describe('brokerage submission reconciliation', () => {
  const intended = buildOrderPayload({
    action: 'Buy to Open', expiry: '2026-09-18', kind: 'place_option_order', limitPrice: 2.5,
    optionType: 'C', priceEffect: 'Debit', quantity: 2, strike: 600, underlying: 'SPY',
  }, ['SPY   260918C00600000'])

  it('requires an exact payload fingerprint inside the submission window', () => {
    const rowOf = (overrides: JsonObject = {}) => tastytradeOrderRecord({
      id: '42', legs: intended.legs, 'order-type': 'Limit', price: '2.50',
      'price-effect': 'Debit', 'received-at': '2026-08-14T14:00:30.000Z', status: 'Live',
      'time-in-force': 'Day', 'updated-at': '2026-08-14T14:00:31.000Z',
      ...overrides,
    })
    const claimed = { claimed: true, submittedAt: new Date('2026-08-14T14:00:00.000Z') }
    const row = rowOf()
    expect(matchesSubmittedOrder(
      row, intended, claimed, new Date('2026-08-14T14:01:00.000Z'),
    )).toBe(true)
    expect(matchesSubmittedOrder(
      rowOf({ price: '2.55' }), intended, claimed, new Date('2026-08-14T14:01:00.000Z'),
    )).toBe(false)
    expect(matchesSubmittedOrder(
      rowOf({ 'received-at': '2026-08-13T14:00:00.000Z' }), intended,
      claimed, new Date('2026-08-14T14:01:00.000Z'),
    )).toBe(false)

    const replacementRow = rowOf({ 'replaces-order-id': '123' })
    expect(matchesSubmittedOrder(
      replacementRow, intended, claimed, new Date('2026-08-14T14:01:00.000Z'), '123',
    )).toBe(true)
    expect(matchesSubmittedOrder(
      replacementRow, intended, claimed, new Date('2026-08-14T14:01:00.000Z'), 'other',
    )).toBe(false)

    // A claimed row was written before its request left: only clock skew reaches back past it,
    // while a legacy row, recorded after the request returned, keeps the wider record lag.
    const earlier = rowOf({ 'received-at': '2026-08-14T13:58:30.000Z' })
    const later = new Date('2026-08-14T15:00:00.000Z')
    expect(matchesSubmittedOrder(earlier, intended, claimed, later)).toBe(false)
    expect(matchesSubmittedOrder(earlier, intended, { ...claimed, claimed: false }, later)).toBe(true)
    // Nothing the submission sent can arrive after its transport budget plus skew, however late
    // the reconcile runs.
    const pastBudget = new Date(claimed.submittedAt.getTime() + SUBMISSION_TRANSPORT_BUDGET_MS + BROKER_CLOCK_SKEW_MS + 1)
    expect(matchesSubmittedOrder(rowOf({ 'received-at': pastBudget.toISOString() }), intended, claimed, later)).toBe(false)
    const atBudget = new Date(pastBudget.getTime() - 1)
    expect(matchesSubmittedOrder(rowOf({ 'received-at': atBudget.toISOString() }), intended, claimed, later)).toBe(true)
  })

  it('does not report an unavailable reconciliation store as no quarantined action', async () => {
    await expect(reconcileUnknownBrokerageAction({}, brokerCredential)).rejects.toThrow('store-unavailable')
  })

  // The adapter, not this layer, reads the provider's status word: a Rejected row settles the
  // claim as failed and anything else found in history settles it as executed.
  it.each([
    { brokerStatus: 'Filled', outcome: 'executed', stored: { provider_order_id: '42', status: 'executed' } },
    { brokerStatus: 'Rejected', outcome: 'failed', stored: { provider_order_id: null, status: 'failed' } },
  ])('reconciles an ambiguous option order after its contract has left the chain ($brokerStatus)', async ({ brokerStatus, outcome, stored }) => {
    const contract = 'SPY   260918C00600000'
    const optionOrder = {
      action: 'Buy to Open' as const, expiry: '2026-09-18', kind: 'place_option_order' as const, limitPrice: 2.5,
      optionType: 'C' as const, priceEffect: 'Debit' as const, quantity: 2, strike: 600, underlying: 'SPY',
    }
    const orderBody = {
      id: 42, legs: intended.legs, 'order-type': 'Limit', price: '2.50', 'price-effect': 'Debit', 'time-in-force': 'Day',
    }
    let chainListsContract = true
    const chain = () => ({
      data: {
        items: chainListsContract
          ? [{
            active: true, 'expiration-date': '2026-09-18', 'instrument-type': 'Equity Option', 'is-closing-only': false,
            'option-chain-type': 'Standard', 'option-type': 'C', 'shares-per-contract': 100,
            'strike-price': '600.0', symbol: contract, 'underlying-symbol': 'SPY',
          }]
          : [],
      },
    })
    const brokerage = stubBroker()
    brokerage.resolveAccountNumber.mockResolvedValue('TEST123')
    brokerage.tastyRequest.mockImplementation(async (_env: AppEnv, path: string): Promise<JsonValue> => {
      if (path.startsWith('/option-chains/')) return chain()
      if (path.endsWith('/dry-run')) {
        return { data: { 'buying-power-effect': { effect: 'Debit' }, order: orderBody, warnings: [] } }
      }
      // The submission itself: a transport failure after sending, so it may have reached the market.
      throw new TypeError('fetch failed')
    })
    setBrokerApi(brokerage)
    setInternalWatchlistWriter({ ensureSymbols: async () => [] })
    setTradeGuards({
      assertOrderMarketSafe: async () => ({ ask: 2.6, bid: 2.4, observedAt: new Date().toISOString(), tickSize: 0.01 }),
      assertPortfolioActionAllowed: async () => undefined,
    })
    store = await migrationStore()
    const env = { DB: store.database }

    await expect(placeBrokerageOrder(env, optionOrder, brokerCredential, () => undefined))
      .rejects.toBeInstanceOf(BrokerageSubmissionUnknownError)
    // The submission carries the deadline armed before its claim, which bounds when it can arrive.
    const submission = brokerage.tastyRequest.mock.calls.find(([, path, init]) => (
      !String(path).endsWith('/dry-run') && init?.method === 'POST'
    ))
    expect(submission?.[2]?.signal).toBeInstanceOf(AbortSignal)
    const [claimed] = store.sqlite.prepare('SELECT submitted_at, resolved_payload_json FROM broker_submissions').all()
    expect(JSON.parse(String(claimed?.resolved_payload_json))).toEqual(intended)

    // The next morning the 0DTE contract is gone from the chain. Reconciliation must not need it.
    chainListsContract = false
    const chainReadsBefore = brokerage.tastyRequest.mock.calls.length
    const submittedAt = String(claimed?.submitted_at)
    const brokerRow: BrokerOrderRecord = tastytradeOrderRecord({
      ...orderBody, 'received-at': submittedAt, status: brokerStatus, 'updated-at': submittedAt,
    })
    setBrokerAdapters({
      tastytrade: {
        ...tastytradeAdapter,
        readOrderHistory: async () => ({ complete: true, orders: [brokerRow] }),
        resolveAccountRef: async () => ({ accountNumber: 'TEST123', broker: 'tastytrade' }),
      },
    })

    await expect(reconcileUnknownBrokerageAction(env, brokerCredential))
      .resolves.toMatchObject({ providerOrderId: '42', status: outcome })
    expect(brokerage.tastyRequest.mock.calls.length).toBe(chainReadsBefore)
    expect(store.sqlite.prepare('SELECT status, provider_order_id FROM broker_submissions').all())
      .toEqual([stored])
  })

  describe('when another request settles the row first', () => {
    const optionAction = {
      action: 'Buy to Open', expiry: '2026-09-18', kind: 'place_option_order', limitPrice: 2.5,
      optionType: 'C', priceEffect: 'Debit', quantity: 2, strike: 600, underlying: 'SPY',
    }

    /** The row is claimed, then settled by a racing request just before this one's UPDATE runs. */
    async function racedStore(submittedAt: string, racingSettle: string) {
      const raced = await migrationStore()
      store = raced
      raced.sqlite.prepare(
        `INSERT INTO broker_submissions (id, broker_id, account_number, payload_json, resolved_payload_json, submitted_at, status)
         VALUES ('row-1', 'tastytrade', 'TEST123', ?, ?, ?, 'unresolved')`,
      ).run(JSON.stringify(optionAction), JSON.stringify(intended), submittedAt)
      const database: D1Database = {
        ...unsupportedDatabase(),
        prepare: (sql: string) => {
          if (sql.startsWith('UPDATE broker_submissions')) raced.sqlite.prepare(racingSettle).run()
          return raced.database.prepare(sql)
        },
      }
      return database
    }

    function historyWith(orders: BrokerOrderRecord[]) {
      setBrokerApi(stubBroker())
      setBrokerAdapters({
        tastytrade: {
          ...tastytradeAdapter,
          readOrderHistory: async () => ({ complete: true, orders }),
          resolveAccountRef: async () => ({ accountNumber: 'TEST123', broker: 'tastytrade' }),
        },
      })
    }

    it('reports the executed settlement it lost to, not a standing quarantine', async () => {
      const submittedAt = new Date().toISOString()
      const DB = await racedStore(
        submittedAt,
        "UPDATE broker_submissions SET status = 'executed', error_code = NULL, provider_order_id = '42' WHERE id = 'row-1'",
      )
      historyWith([tastytradeOrderRecord({
        id: '42', legs: intended.legs, 'order-type': 'Limit', price: '2.50', 'price-effect': 'Debit',
        'received-at': submittedAt, status: 'Filled', 'time-in-force': 'Day',
      })])

      await expect(reconcileUnknownBrokerageAction({ DB }, brokerCredential)).resolves.toEqual({
        actionId: 'row-1',
        detail: 'The action was already reconciled by another request.',
        providerOrderId: '42',
        status: 'executed',
      })
    })

    it('reports a settlement it lost to on the absence path too', async () => {
      const submittedAt = new Date(Date.now() - 60 * 60_000).toISOString()
      const DB = await racedStore(
        submittedAt,
        "UPDATE broker_submissions SET status = 'failed', error_code = 'TastytradeApiError' WHERE id = 'row-1'",
      )
      historyWith([])

      await expect(reconcileUnknownBrokerageAction({ DB }, brokerCredential)).resolves.toEqual({
        actionId: 'row-1',
        detail: 'The action was already reconciled by another request.',
        status: 'failed',
      })
    })
  })

  it('keeps a payload-echoing row with no received-at and a late updated-at as a candidate', async () => {
    const claimed = { claimed: true, submittedAt: new Date('2026-08-14T14:00:00.000Z') }
    const later = new Date('2026-08-14T15:00:00.000Z')
    const rowOf = (updatedAt: string) => tastytradeOrderRecord({
      id: '42', legs: intended.legs, 'order-type': 'Limit', price: '2.50', 'price-effect': 'Debit',
      status: 'Filled', 'time-in-force': 'Day', 'updated-at': updatedAt,
    })
    // Filled long after the transport budget: updated-at moved, the order is still ours.
    expect(matchesSubmittedOrder(rowOf('2026-08-14T14:40:00.000Z'), intended, claimed, later)).toBe(true)
    // Last touched before the submission could have arrived: not ours.
    expect(matchesSubmittedOrder(rowOf('2026-08-14T13:00:00.000Z'), intended, claimed, later)).toBe(false)

    store = await migrationStore()
    const submittedAt = new Date(Date.now() - 60 * 60_000)
    store.sqlite.prepare(
      `INSERT INTO broker_submissions (id, broker_id, account_number, payload_json, resolved_payload_json, submitted_at, status)
       VALUES ('row-1', 'tastytrade', 'TEST123', ?, ?, ?, 'unresolved')`,
    ).run(
      JSON.stringify({
        action: 'Buy to Open', expiry: '2026-09-18', kind: 'place_option_order', limitPrice: 2.5,
        optionType: 'C', priceEffect: 'Debit', quantity: 2, strike: 600, underlying: 'SPY',
      }),
      JSON.stringify(intended),
      submittedAt.toISOString(),
    )
    const lateUpdate = new Date(submittedAt.getTime() + 30 * 60_000).toISOString()
    const orders = [rowOf(lateUpdate), { ...rowOf(lateUpdate), id: '43' }]
    setBrokerApi(stubBroker())
    setBrokerAdapters({
      tastytrade: {
        ...tastytradeAdapter,
        readOrderHistory: async () => ({ complete: true, orders }),
        resolveAccountRef: async () => ({ accountNumber: 'TEST123', broker: 'tastytrade' }),
      },
    })

    // Two candidates are ambiguous, never an absence: the quarantine stays.
    const ambiguous = await reconcileUnknownBrokerageAction({ DB: store.database }, brokerCredential)
    expect(ambiguous).toMatchObject({ status: 'unresolved' })
    expect(ambiguous.detail).toContain('More than one exact broker match')
    expect(store.sqlite.prepare('SELECT status FROM broker_submissions').all()).toEqual([{ status: 'unresolved' }])

    // The lone real order settles as executed rather than as BrokerageSubmissionNotFound.
    orders.pop()
    await expect(reconcileUnknownBrokerageAction({ DB: store.database }, brokerCredential))
      .resolves.toMatchObject({ providerOrderId: '42', status: 'executed' })
  })

  it('names an incomplete history, not a past instant, when absence cannot yet be concluded', async () => {
    store = await migrationStore()
    const longAgo = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
    store.sqlite.prepare(
      `INSERT INTO broker_submissions (id, broker_id, account_number, payload_json, resolved_payload_json, submitted_at, status)
       VALUES ('row-1', 'tastytrade', 'TEST123', ?, ?, ?, 'unresolved')`,
    ).run(
      JSON.stringify({
        action: 'Buy to Open', expiry: '2026-09-18', kind: 'place_option_order', limitPrice: 2.5,
        optionType: 'C', priceEffect: 'Debit', quantity: 2, strike: 600, underlying: 'SPY',
      }),
      JSON.stringify(intended),
      longAgo,
    )
    setBrokerApi(stubBroker())
    setBrokerAdapters({
      tastytrade: {
        ...tastytradeAdapter,
        readOrderHistory: async () => ({ complete: false, orders: [] }),
        resolveAccountRef: async () => ({ accountNumber: 'TEST123', broker: 'tastytrade' }),
      },
    })

    const result = await reconcileUnknownBrokerageAction({ DB: store.database }, brokerCredential)
    expect(result).toMatchObject({ status: 'unresolved' })
    expect(result.detail).toContain('came back incomplete')
    expect(result.detail).not.toContain('can be concluded from')
    expect(store.sqlite.prepare('SELECT status FROM broker_submissions').all()).toEqual([{ status: 'unresolved' }])
  })

  it('refuses a stored order that disagrees with its stored action rather than trusting either', async () => {
    store = await migrationStore()
    store.sqlite.prepare(
      `INSERT INTO broker_submissions (id, broker_id, account_number, payload_json, resolved_payload_json, submitted_at, status)
       VALUES ('row-1', 'tastytrade', 'TEST123', ?, ?, ?, 'unresolved')`,
    ).run(
      JSON.stringify({
        action: 'Buy to Open', expiry: '2026-09-18', kind: 'place_option_order', limitPrice: 2.5,
        optionType: 'C', priceEffect: 'Debit', quantity: 2, strike: 600, underlying: 'SPY',
      }),
      JSON.stringify({ ...intended, price: '2.55' }),
      new Date().toISOString(),
    )
    setBrokerApi(stubBroker())
    setBrokerAdapters({
      tastytrade: {
        ...tastytradeAdapter,
        readOrderHistory: async () => ({ complete: true, orders: [] }),
        resolveAccountRef: async () => ({ accountNumber: 'TEST123', broker: 'tastytrade' }),
      },
    })

    await expect(reconcileUnknownBrokerageAction({ DB: store.database }, brokerCredential))
      .rejects.toThrow('stored-order-disagrees-with-action')
    expect(store.sqlite.prepare('SELECT status FROM broker_submissions').all()).toEqual([{ status: 'unresolved' }])
  })

  it('refuses to record a matched broker order id that is not all digits', async () => {
    store = await migrationStore()
    const submittedAt = new Date().toISOString()
    store.sqlite.prepare(
      `INSERT INTO broker_submissions (id, broker_id, account_number, payload_json, resolved_payload_json, submitted_at, status)
       VALUES ('row-1', 'tastytrade', 'TEST123', ?, ?, ?, 'unresolved')`,
    ).run(
      JSON.stringify({
        action: 'Buy to Open', expiry: '2026-09-18', kind: 'place_option_order', limitPrice: 2.5,
        optionType: 'C', priceEffect: 'Debit', quantity: 2, strike: 600, underlying: 'SPY',
      }),
      JSON.stringify(intended),
      submittedAt,
    )
    setBrokerApi(stubBroker())
    setBrokerAdapters({
      tastytrade: {
        ...tastytradeAdapter,
        readOrderHistory: async () => ({
          complete: true,
          orders: [tastytradeOrderRecord({
            id: '42/../cancel', legs: intended.legs, 'order-type': 'Limit', price: '2.50', 'price-effect': 'Debit',
            'received-at': submittedAt, status: 'Filled', 'time-in-force': 'Day',
          })],
        }),
        resolveAccountRef: async () => ({ accountNumber: 'TEST123', broker: 'tastytrade' }),
      },
    })

    await expect(reconcileUnknownBrokerageAction({ DB: store.database }, brokerCredential))
      .rejects.toThrow('TastytradeReconciliation:invalid-match')
    expect(store.sqlite.prepare('SELECT status, provider_order_id FROM broker_submissions').all())
      .toEqual([{ provider_order_id: null, status: 'unresolved' }])
  })

  describe('among identical tickets', () => {
    const storedAction = JSON.stringify({
      action: 'Buy to Open', expiry: '2026-09-18', kind: 'place_option_order', limitPrice: 2.5,
      optionType: 'C', priceEffect: 'Debit', quantity: 2, strike: 600, underlying: 'SPY',
    })
    // Past the absence window, so a history with no candidate settles the row as never placed.
    const claimedAt = new Date(Date.now() - 30 * 60_000)
    const at = (offsetMs: number) => new Date(claimedAt.getTime() + offsetMs).toISOString()
    const ticket = (id: string, receivedAt: string) => tastytradeOrderRecord({
      id, legs: intended.legs, 'order-type': 'Limit', price: '2.50', 'price-effect': 'Debit',
      'received-at': receivedAt, status: 'Filled', 'time-in-force': 'Day',
    })

    async function quarantined(history: BrokerOrderRecord[]) {
      store = await migrationStore()
      store.sqlite.prepare(
        `INSERT INTO broker_submissions (id, broker_id, account_number, payload_json, resolved_payload_json, submitted_at, status)
         VALUES ('row-1', 'tastytrade', 'TEST123', ?, ?, ?, 'unresolved')`,
      ).run(storedAction, JSON.stringify(intended), claimedAt.toISOString())
      setBrokerApi(stubBroker())
      setBrokerAdapters({
        tastytrade: {
          ...tastytradeAdapter,
          readOrderHistory: async () => ({ complete: true, orders: history }),
          resolveAccountRef: async () => ({ accountNumber: 'TEST123', broker: 'tastytrade' }),
        },
      })
      return store
    }

    it('does not take an order another submission already recorded as this one\'s', async () => {
      // The same ticket placed ten seconds earlier settled executed as order 41; this claim never
      // reached the broker, so 41 is the only echo in history and it is not this row's.
      const sqlite = (await quarantined([ticket('41', at(-9_000))])).sqlite
      sqlite.prepare(
        `INSERT INTO broker_submissions
           (id, broker_id, account_number, payload_json, resolved_payload_json, submitted_at, status, provider_order_id)
         VALUES ('settled-1', 'tastytrade', 'TEST123', ?, ?, ?, 'executed', '41')`,
      ).run(storedAction, JSON.stringify(intended), at(-10_000))

      await expect(reconcileUnknownBrokerageAction({ DB: store!.database }, brokerCredential))
        .resolves.toMatchObject({ actionId: 'row-1', status: 'failed' })
      expect(sqlite.prepare('SELECT id, status, provider_order_id FROM broker_submissions ORDER BY id').all()).toEqual([
        { id: 'row-1', provider_order_id: null, status: 'failed' },
        { id: 'settled-1', provider_order_id: '41', status: 'executed' },
      ])
    })

    it('settles on its own order when the same ticket was placed again later from elsewhere', async () => {
      // Order 43 is an identical ticket entered in the broker's own app minutes afterwards: no
      // request of this submission could have arrived that late.
      const sqlite = (await quarantined([ticket('42', at(1_000)), ticket('43', at(5 * 60_000))])).sqlite

      await expect(reconcileUnknownBrokerageAction({ DB: store!.database }, brokerCredential))
        .resolves.toMatchObject({ providerOrderId: '42', status: 'executed' })
      expect(sqlite.prepare('SELECT status, provider_order_id FROM broker_submissions').all())
        .toEqual([{ provider_order_id: '42', status: 'executed' }])
    })
  })

  it('identifies a legacy row\'s contract even once it is closing-only and inactive', async () => {
    const brokerage = stubBroker()
    brokerage.tastyRequest.mockResolvedValue({
      data: {
        items: [{
          active: false, 'expiration-date': '2026-09-18', 'instrument-type': 'Equity Option', 'is-closing-only': true,
          'option-chain-type': 'Standard', 'option-type': 'C', 'shares-per-contract': 100,
          'strike-price': '600.0', symbol: 'SPY   260918C00600000', 'underlying-symbol': 'SPY',
        }],
      },
    })
    setBrokerApi(brokerage)
    store = await migrationStore()
    const submittedAt = new Date().toISOString()
    // A row claimed before the resolved order was stored: the action tuple only.
    store.sqlite.prepare(
      `INSERT INTO broker_submissions (id, broker_id, account_number, payload_json, submitted_at, status)
       VALUES ('legacy-1', 'tastytrade', 'TEST123', ?, ?, 'unresolved')`,
    ).run(JSON.stringify({
      action: 'Buy to Open', expiry: '2026-09-18', kind: 'place_option_order', limitPrice: 2.5,
      optionType: 'C', priceEffect: 'Debit', quantity: 2, strike: 600, underlying: 'SPY',
    }), submittedAt)
    setBrokerAdapters({
      tastytrade: {
        ...tastytradeAdapter,
        readOrderHistory: async () => ({
          complete: true,
          orders: [tastytradeOrderRecord({
            id: '43', legs: intended.legs, 'order-type': 'Limit', price: '2.50', 'price-effect': 'Debit',
            'received-at': submittedAt, status: 'Filled', 'time-in-force': 'Day',
          })],
        }),
        resolveAccountRef: async () => ({ accountNumber: 'TEST123', broker: 'tastytrade' }),
      },
    })

    await expect(reconcileUnknownBrokerageAction({ DB: store.database }, brokerCredential))
      .resolves.toMatchObject({ providerOrderId: '43', status: 'executed' })
  })

  describe('beside an in-flight placement', () => {
    const equityOrder = {
      action: 'Buy to Open' as const, kind: 'place_equity_order' as const, limitPrice: 700,
      priceEffect: 'Debit' as const, quantity: 1, symbol: 'SPY',
    }
    const echoed = {
      id: 123,
      legs: [{ action: 'Buy to Open', 'instrument-type': 'Equity', quantity: 1, symbol: 'SPY' }],
      'order-type': 'Limit', price: '700.00', 'price-effect': 'Debit', 'time-in-force': 'Day',
    }
    const accepted = { data: { 'buying-power-effect': { effect: 'Debit' }, order: echoed, warnings: [] } }

    /** A placement whose submission is held open until the test answers it. */
    function heldPlacement() {
      let answer: (value: JsonValue) => void = () => undefined
      const brokerage = stubBroker()
      brokerage.tastyRequest.mockImplementation(async (_env: AppEnv, path: string): Promise<JsonValue> => (
        path.endsWith('/dry-run') ? accepted : new Promise((resolve) => { answer = resolve })
      ))
      setBrokerApi(brokerage)
      setInternalWatchlistWriter({ ensureSymbols: async () => [] })
      setTradeGuards({
        assertOrderMarketSafe: async () => ({ ask: 700, bid: 699, observedAt: new Date().toISOString(), tickSize: 0.01 }),
        assertPortfolioActionAllowed: async () => undefined,
      })
      const historyReads: number[] = []
      setBrokerAdapters({
        tastytrade: {
          ...tastytradeAdapter,
          readOrderHistory: async () => {
            historyReads.push(Date.now())
            return {
              complete: true,
              orders: [tastytradeOrderRecord({ ...echoed, 'received-at': new Date().toISOString(), status: 'Live' })],
            }
          },
          resolveAccountRef: async () => ({ accountNumber: 'TEST123', broker: 'tastytrade' }),
        },
      })
      return { answer: (value: JsonValue) => answer(value), brokerage, historyReads }
    }

    function submitted(brokerage: ReturnType<typeof stubBroker>) {
      return brokerage.tastyRequest.mock.calls.filter(([, path]) => !String(path).endsWith('/dry-run'))
    }

    it('waits for the placement to settle under the account lease instead of settling its row', async () => {
      const { answer, brokerage, historyReads } = heldPlacement()
      // A lease that serializes, as the Durable Object's does: the next holder waits.
      let tail: Promise<unknown> = Promise.resolve()
      brokerage.withBrokerMutationLease.mockImplementation(async (_env, _account, operation) => {
        const run = tail.then(() => operation({ renew: brokerage.renewBrokerMutationLease }))
        tail = run.catch(() => undefined)
        return run
      })
      store = await migrationStore()
      const env = { DB: store.database }

      const placement = placeBrokerageOrder(env, equityOrder, brokerCredential, () => undefined)
      await vi.waitFor(() => expect(submitted(brokerage)).toHaveLength(1))
      const reconcile = reconcileUnknownBrokerageAction(env, brokerCredential)
      // The broker has the order, the placement has not settled it: reconciliation must not
      // have read history yet, or it could settle the row out from under the placement.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(historyReads).toEqual([])

      answer(accepted)
      await expect(placement).resolves.toEqual({ detail: 'Order #123 accepted by tastytrade.', orderId: '123' })
      await expect(reconcile).resolves.toEqual({ detail: 'No brokerage submission needs reconciliation.', status: 'none' })
      expect(store.sqlite.prepare('SELECT status, provider_order_id FROM broker_submissions').all())
        .toEqual([{ provider_order_id: '123', status: 'executed' }])
    })

    it('reports the placement settled when a reconcile already recorded the same order', async () => {
      // The stub lease does not serialize: the lapsed-lease case, where only the read-back
      // keeps the placement from telling its agent a settled account is still quarantined.
      const { answer, brokerage } = heldPlacement()
      store = await migrationStore()
      const env = { DB: store.database }

      const placement = placeBrokerageOrder(env, equityOrder, brokerCredential, () => undefined)
      await vi.waitFor(() => expect(submitted(brokerage)).toHaveLength(1))
      await expect(reconcileUnknownBrokerageAction(env, brokerCredential))
        .resolves.toMatchObject({ providerOrderId: '123', status: 'executed' })

      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
      answer(accepted)
      await expect(placement).resolves.toEqual({ detail: 'Order #123 accepted by tastytrade.', orderId: '123' })
      expect(logged).not.toHaveBeenCalledWith('BrokerageSubmissionSettleFailed')
      logged.mockRestore()
    })
  })
})
