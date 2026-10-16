import { afterEach, describe, expect, it, vi } from 'vitest'

import { BrokerageSubmissionUnknownError } from '../src/server/brokerage'
import { BrokerCredentialMissingError } from '../src/server/broker-credential'
import { BrokerRefusalError, CallerVisibleError } from '../src/server/caller-visible-error'
import { BrokerCancellationAmbiguousError, resetBrokerAdapters, setBrokerAdapters } from '../src/server/brokers'
import { tastytradeAdapter } from '../src/server/brokers/tastytrade'
import { cancelBrokerageOrder, placeBrokerageOrder } from '../src/server/order-placement'
import { PortfolioRiskError } from '../src/server/portfolio-risk'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { resetInternalWatchlistWriter, setInternalWatchlistWriter } from '../src/server/internal-watchlist'
import { resetTradeGuards, setTradeGuards } from '../src/server/trade-guards'
import { type JsonValue } from '../src/domain/json-payload'
import { type AppEnv } from '../src/server/env'
import { unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'
import { brokerCredential, stubAdapter, stubBroker, STUB_BROKER_ID, stubBrokerCredential } from './broker-stub'

afterEach(() => {
  resetBrokerApi()
  resetBrokerAdapters()
  resetInternalWatchlistWriter()
  resetTradeGuards()
})

const EQUITY_ORDER = {
  action: 'Buy to Open' as const,
  kind: 'place_equity_order' as const,
  limitPrice: 700,
  priceEffect: 'Debit' as const,
  quantity: 1,
  symbol: 'SPY',
}

const ACCEPTED_ORDER_RESPONSE = {
  data: {
    'buying-power-effect': { effect: 'Debit' },
    order: {
      id: 123,
      legs: [{ action: 'Buy to Open', 'instrument-type': 'Equity', quantity: 1, symbol: 'SPY' }],
      'order-type': 'Limit',
      price: '700.00',
      'price-effect': 'Debit',
      'time-in-force': 'Day',
    },
    warnings: [],
  },
}

function allowingGuards() {
  setTradeGuards({
    assertOrderMarketSafe: async () => ({ ask: 700, bid: 699, observedAt: new Date().toISOString(), tickSize: 0.01 }),
    assertPortfolioActionAllowed: async () => undefined,
  })
}

/** A broker whose dry-run is clean and whose submission is whatever the test says. */
function brokerSubmitting(submit: () => Promise<JsonValue>, account = 'TEST123') {
  const brokerage = stubBroker()
  brokerage.resolveAccountNumber.mockResolvedValue(account)
  brokerage.tastyRequest.mockImplementation(async (_env: AppEnv, path: string) => (
    path.endsWith('/dry-run') ? ACCEPTED_ORDER_RESPONSE : submit()
  ))
  setBrokerApi(brokerage)
  setInternalWatchlistWriter({ ensureSymbols: async () => [] })
  allowingGuards()
  return brokerage
}

function submissions(brokerage: ReturnType<typeof stubBroker>) {
  return brokerage.tastyRequest.mock.calls.filter(([, path]) => !String(path).endsWith('/dry-run'))
}

function rows(store: SqliteD1Store) {
  return store.sqlite.prepare(
    'SELECT account_number, broker_id, error_code, payload_json, provider_order_id, resolved_payload_json, status FROM broker_submissions',
  ).all()
}

function quarantine(store: SqliteD1Store, account: string) {
  store.sqlite.prepare(
    `INSERT INTO broker_submissions (id, broker_id, account_number, payload_json, submitted_at, status)
     VALUES ('quarantined-1', 'tastytrade', ?, ?, ?, 'unresolved')`,
  ).run(account, JSON.stringify(EQUITY_ORDER), new Date().toISOString())
}

function apiError(status: number): Error {
  const error = new Error(`TastytradeApi:${status}:/accounts/[redacted]/orders`)
  error.name = status >= 500 ? 'TastytradeApiAmbiguousError' : 'TastytradeApiError'
  return error
}

let store: SqliteD1Store | undefined

/** What a placement scheduled past its reply, as the platform's `waitUntil` would keep alive. */
let scheduled: Array<Promise<unknown>> = []
const waitUntil = (task: Promise<unknown>) => { scheduled.push(task) }
const settleScheduled = () => Promise.all(scheduled)

afterEach(async () => {
  await settleScheduled()
  scheduled = []
  store?.close()
  store = undefined
})

async function freshStore(): Promise<SqliteD1Store> {
  store = await migrationStore()
  return store
}

describe('brokerage order placement', () => {
  it('refuses without a broker credential before touching the store or the broker', async () => {
    const brokerage = stubBroker()
    setBrokerApi(brokerage)
    const { database } = await freshStore()

    await expect(placeBrokerageOrder({ DB: database }, EQUITY_ORDER, undefined, waitUntil))
      .rejects.toBeInstanceOf(BrokerCredentialMissingError)
    expect(brokerage.resolveAccountNumber).not.toHaveBeenCalled()
    expect(brokerage.tastyRequest).not.toHaveBeenCalled()
  })

  it('refuses while an ambiguous submission for that account is unresolved', async () => {
    const brokerage = brokerSubmitting(async () => ACCEPTED_ORDER_RESPONSE)
    const db = await freshStore()
    quarantine(db, 'TEST123')

    await expect(placeBrokerageOrder({ DB: db.database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .rejects.toThrow(/still unresolved/)
    // Nothing may be submitted while the earlier submission is unaccounted for.
    expect(submissions(brokerage)).toHaveLength(0)
    expect(rows(db)).toHaveLength(1)
  })

  it('refuses a concurrent placement while the first submission is still in flight', async () => {
    let failFirst: (error: Error) => void = () => undefined
    const brokerage = brokerSubmitting(() => new Promise((_resolve, reject) => { failFirst = reject }))
    const db = await freshStore()

    // The stub lease does not serialize, which is the lost-lease case: only the write-ahead
    // claim stands between the second placement and a second order.
    const first = placeBrokerageOrder({ DB: db.database }, EQUITY_ORDER, brokerCredential, waitUntil)
    await vi.waitFor(() => expect(submissions(brokerage)).toHaveLength(1))
    await expect(placeBrokerageOrder({ DB: db.database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .rejects.toThrow(/still unresolved/)
    failFirst(new TypeError('fetch failed'))
    await expect(first).rejects.toBeInstanceOf(BrokerageSubmissionUnknownError)

    expect(submissions(brokerage)).toHaveLength(1)
    expect(rows(db)).toMatchObject([{ status: 'unresolved' }])
  })

  it('does not let one account quarantine block a different account', async () => {
    brokerSubmitting(async () => ACCEPTED_ORDER_RESPONSE, 'OTHER456')
    const db = await freshStore()
    quarantine(db, 'TEST123')

    await expect(placeBrokerageOrder({ DB: db.database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .resolves.toEqual({ detail: 'Order #123 accepted by tastytrade.', orderId: '123' })
  })

  it('resolves the account it places for through the adapter', async () => {
    // Account discovery is an account read, and every account read goes through a `BrokerAdapter`.
    const brokerage = brokerSubmitting(async () => ACCEPTED_ORDER_RESPONSE)
    const resolveAccountRef = vi.fn(async () => ({ accountNumber: 'ADAPTER789', broker: 'tastytrade' as const }))
    setBrokerAdapters({ tastytrade: { ...tastytradeAdapter, resolveAccountRef } })
    const db = await freshStore()

    await expect(placeBrokerageOrder({ DB: db.database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .resolves.toMatchObject({ orderId: '123' })
    expect(resolveAccountRef).toHaveBeenCalledWith({ DB: db.database }, brokerCredential)
    expect(brokerage.resolveAccountNumber).not.toHaveBeenCalled()
    expect(rows(db)).toMatchObject([{ account_number: 'ADAPTER789' }])
  })

  it('settles the claimed row as executed with the broker order id', async () => {
    brokerSubmitting(async () => ACCEPTED_ORDER_RESPONSE)
    const db = await freshStore()

    await expect(placeBrokerageOrder({ DB: db.database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .resolves.toMatchObject({ orderId: '123' })
    // A later price-only replacement resolves the original order's shape from this row.
    const [row] = rows(db)
    expect(row).toMatchObject({ account_number: 'TEST123', broker_id: 'tastytrade', provider_order_id: '123', status: 'executed' })
    expect(JSON.parse(String(row?.payload_json))).toMatchObject({ kind: 'place_equity_order', symbol: 'SPY' })
  })

  it('quarantines the account when a submission becomes ambiguous', async () => {
    brokerSubmitting(async () => { throw new TypeError('fetch failed') })
    const db = await freshStore()

    await expect(placeBrokerageOrder({ DB: db.database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .rejects.toBeInstanceOf(BrokerageSubmissionUnknownError)
    const [row] = rows(db)
    expect(row).toMatchObject({ account_number: 'TEST123', broker_id: 'tastytrade', status: 'unresolved' })
    // The server-parsed action, and beside it the exact order built from it: reconciliation
    // fingerprints against the second, never against anything the caller supplied.
    expect(JSON.parse(String(row?.payload_json))).toMatchObject({ kind: 'place_equity_order', symbol: 'SPY' })
    expect(JSON.parse(String(row?.resolved_payload_json))).toMatchObject({
      legs: [{ action: 'Buy to Open', 'instrument-type': 'Equity', quantity: 1, symbol: 'SPY' }],
      price: '700.00',
    })
  })

  it('keeps a 5xx submission quarantined', async () => {
    brokerSubmitting(async () => { throw apiError(503) })
    const db = await freshStore()

    await expect(placeBrokerageOrder({ DB: db.database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .rejects.toBeInstanceOf(BrokerageSubmissionUnknownError)
    expect(rows(db)).toMatchObject([{ status: 'unresolved' }])
  })

  it('marks a definite 4xx rejection failed and leaves the account tradeable', async () => {
    brokerSubmitting(async () => { throw apiError(422) })
    const db = await freshStore()

    await expect(placeBrokerageOrder({ DB: db.database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .rejects.toThrow('TastytradeApi:422')
    expect(rows(db)).toMatchObject([{ error_code: 'TastytradeApiError', status: 'failed' }])
  })

  it('settles a 2xx placement echoing a Rejected order as failed, not accepted', async () => {
    const rejected = { data: { ...ACCEPTED_ORDER_RESPONSE.data, order: { ...ACCEPTED_ORDER_RESPONSE.data.order, status: 'Rejected' } } }
    brokerSubmitting(async () => rejected)
    const db = await freshStore()

    await expect(placeBrokerageOrder({ DB: db.database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .rejects.toThrow('Tastytrade rejected this order')
    expect(rows(db)).toMatchObject([{ error_code: 'TastytradeOrderRejected', status: 'failed' }])
  })

  it('refuses a dry-run echoing a Rejected order before any claim or submission', async () => {
    const rejected = { data: { ...ACCEPTED_ORDER_RESPONSE.data, order: { ...ACCEPTED_ORDER_RESPONSE.data.order, status: 'Rejected' } } }
    const brokerage = brokerSubmitting(async () => ACCEPTED_ORDER_RESPONSE)
    brokerage.tastyRequest.mockImplementation(async (_env: AppEnv, path: string) => (
      path.endsWith('/dry-run') ? rejected : ACCEPTED_ORDER_RESPONSE
    ))
    const db = await freshStore()

    await expect(placeBrokerageOrder({ DB: db.database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .rejects.toThrow('Tastytrade rejected this order')
    expect(submissions(brokerage)).toHaveLength(0)
    expect(rows(db)).toHaveLength(0)
  })

  it('refuses to submit when the write-ahead claim cannot be recorded', async () => {
    const brokerage = brokerSubmitting(async () => ACCEPTED_ORDER_RESPONSE)
    const db: D1Database = {
      ...unsupportedDatabase(),
      prepare: (sql: string) => ({
        ...unsupportedStatement(),
        bind: () => ({
          ...unsupportedStatement(),
          first: async () => null,
          run: async () => {
            if (sql.includes('INSERT INTO broker_submissions')) throw new Error('D1 persistence unavailable')
            throw new Error(`Unexpected run query: ${sql}`)
          },
        }),
      }),
    }
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(placeBrokerageOrder({ DB: db }, EQUITY_ORDER, brokerCredential, waitUntil))
      .rejects.toThrow('nothing was submitted')
    expect(submissions(brokerage)).toHaveLength(0)
    expect(errorLog).toHaveBeenCalledWith('BrokerageSubmissionClaimFailed')
  })

  /** The store answers every read, but no settlement write lands, so the claimed row stays unresolved. */
  function unsettleable(db: SqliteD1Store): D1Database {
    return {
      ...unsupportedDatabase(),
      prepare: (sql: string) => {
        if (sql.startsWith('UPDATE broker_submissions')) throw new Error('D1 persistence unavailable')
        return db.database.prepare(sql)
      },
    }
  }

  it('reports an accepted order whose settlement could not be recorded, and stays quarantined', async () => {
    brokerSubmitting(async () => ACCEPTED_ORDER_RESPONSE)
    const db = await freshStore()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(placeBrokerageOrder({ DB: unsettleable(db) }, EQUITY_ORDER, brokerCredential, waitUntil))
      .resolves.toMatchObject({ detail: expect.stringContaining('stays quarantined'), orderId: '123' })
    expect(rows(db)).toMatchObject([{ status: 'unresolved' }])
  })

  it('says a 4xx refusal it could not record leaves the account quarantined', async () => {
    // Told only "refused", the caller would meet the next placement's quarantine with no reason.
    brokerSubmitting(async () => { throw apiError(422) })
    const db = await freshStore()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const refusal = placeBrokerageOrder({ DB: unsettleable(db) }, EQUITY_ORDER, brokerCredential, waitUntil)
    await expect(refusal).rejects.toBeInstanceOf(CallerVisibleError)
    await expect(refusal).rejects.toThrow(
      'Tastytrade refused this order (TastytradeApiError), so it was not placed. spicytrade could not record this result, so this account stays quarantined until reconcile_brokerage_action confirms it.',
    )
    expect(rows(db)).toMatchObject([{ status: 'unresolved' }])
  })

  it('says a rejected echo it could not record leaves the account quarantined', async () => {
    const rejected = { data: { ...ACCEPTED_ORDER_RESPONSE.data, order: { ...ACCEPTED_ORDER_RESPONSE.data.order, status: 'Rejected' } } }
    brokerSubmitting(async () => rejected)
    const db = await freshStore()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const refusal = placeBrokerageOrder({ DB: unsettleable(db) }, EQUITY_ORDER, brokerCredential, waitUntil)
    await expect(refusal).rejects.toMatchObject({
      check: 'broker-rejected',
      message: 'Tastytrade rejected this order, so it was not placed. spicytrade could not record this result, so this account stays quarantined until reconcile_brokerage_action confirms it.',
      untrustedBrokerData: { messages: [] },
    })
    await expect(refusal).rejects.toBeInstanceOf(BrokerRefusalError)
    expect(rows(db)).toMatchObject([{ status: 'unresolved' }])
  })

  it('refuses a rejected portfolio guard before any broker request or claim', async () => {
    const brokerage = brokerSubmitting(async () => ACCEPTED_ORDER_RESPONSE)
    setTradeGuards({
      assertOrderMarketSafe: async () => ({ ask: 700, bid: 699, observedAt: new Date().toISOString(), tickSize: 0.01 }),
      assertPortfolioActionAllowed: async () => { throw new PortfolioRiskError('The requested close is larger than the verified matching position.') },
    })
    const db = await freshStore()

    await expect(placeBrokerageOrder({ DB: db.database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .rejects.toThrow('larger than the verified')
    expect(brokerage.tastyRequest).not.toHaveBeenCalled()
    expect(rows(db)).toHaveLength(0)
  })
})

describe('trade-intent provenance', () => {
  function recordingWatchlist(write: () => Promise<string[]> = async () => []) {
    const remembered: Array<{ origin: string; symbols: readonly string[] }> = []
    setInternalWatchlistWriter({
      ensureSymbols: async (_env, symbols, origin) => {
        remembered.push({ origin, symbols })
        return write()
      },
    })
    return remembered
  }

  it('remembers the symbol only once the broker has accepted the order', async () => {
    brokerSubmitting(async () => ACCEPTED_ORDER_RESPONSE)
    const remembered = recordingWatchlist()
    const db = await freshStore()

    await expect(placeBrokerageOrder({ DB: db.database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .resolves.toMatchObject({ orderId: '123' })
    await settleScheduled()
    expect(remembered).toEqual([{ origin: 'trade-intent', symbols: ['SPY'] }])
  })

  it('gives a guard-refused order no trade-intent provenance', async () => {
    brokerSubmitting(async () => ACCEPTED_ORDER_RESPONSE)
    const remembered = recordingWatchlist()
    setTradeGuards({
      assertOrderMarketSafe: async () => ({ ask: 700, bid: 699, observedAt: new Date().toISOString(), tickSize: 0.01 }),
      assertPortfolioActionAllowed: async () => { throw new PortfolioRiskError('This account will not open a naked or unbounded short position.') },
    })

    await expect(placeBrokerageOrder({ DB: (await freshStore()).database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .rejects.toBeInstanceOf(PortfolioRiskError)
    await settleScheduled()
    expect(remembered).toEqual([])
  })

  it('gives a broker-rejected order no trade-intent provenance', async () => {
    brokerSubmitting(async () => { throw apiError(422) })
    const remembered = recordingWatchlist()

    await expect(placeBrokerageOrder({ DB: (await freshStore()).database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .rejects.toThrow('TastytradeApi:422')
    await settleScheduled()
    expect(remembered).toEqual([])
  })

  it('reports an accepted order even when the watchlist write fails, and logs a fixed event', async () => {
    const brokerage = brokerSubmitting(async () => ACCEPTED_ORDER_RESPONSE)
    const failure = new Error('D1 watchlist unavailable for account TEST123')
    failure.name = 'D1Error'
    recordingWatchlist(async () => { throw failure })
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const db = await freshStore()

    await expect(placeBrokerageOrder({ DB: db.database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .resolves.toEqual({ detail: 'Order #123 accepted by tastytrade.', orderId: '123' })
    expect(submissions(brokerage)).toHaveLength(1)
    expect(rows(db)).toMatchObject([{ status: 'executed' }])
    await settleScheduled()
    expect(errorLog).toHaveBeenCalledWith('TradeIntentRememberFailed', 'D1Error')
  })

  it('returns the accepted receipt without waiting on the watchlist write', async () => {
    brokerSubmitting(async () => ACCEPTED_ORDER_RESPONSE)
    let finishWrite: () => void = () => undefined
    const remembered = recordingWatchlist(() => new Promise((resolve) => { finishWrite = () => resolve([]) }))
    const db = await freshStore()

    // A write that never finishes on its own: an awaited one would hold the receipt hostage.
    const receipt = await Promise.race([
      placeBrokerageOrder({ DB: db.database }, EQUITY_ORDER, brokerCredential, waitUntil),
      new Promise((resolve) => { setTimeout(() => resolve('receipt withheld'), 200) }),
    ])
    expect(receipt).toEqual({ detail: 'Order #123 accepted by tastytrade.', orderId: '123' })
    // The write was started and handed to waitUntil, which keeps it alive past the reply.
    await vi.waitFor(() => expect(remembered).toHaveLength(1))
    expect(scheduled).toHaveLength(1)
    finishWrite()
  })

  it('writes the watchlist only after the mutation lease is released', async () => {
    const brokerage = brokerSubmitting(async () => ACCEPTED_ORDER_RESPONSE)
    let leaseHeld = false
    brokerage.withBrokerMutationLease.mockImplementation(async (_env, _account, operation) => {
      leaseHeld = true
      try {
        return await operation({ renew: brokerage.renewBrokerMutationLease })
      } finally {
        leaseHeld = false
      }
    })
    const heldDuringWrite: boolean[] = []
    recordingWatchlist(async () => {
      heldDuringWrite.push(leaseHeld)
      return []
    })

    await expect(placeBrokerageOrder({ DB: (await freshStore()).database }, EQUITY_ORDER, brokerCredential, waitUntil))
      .resolves.toMatchObject({ orderId: '123' })
    await settleScheduled()
    expect(heldDuringWrite).toEqual([false])
  })
})

describe('cancelling a working order', () => {
  it('cancels through the adapter for the account the credential resolves to', async () => {
    const cancelled: Array<{ account: string; orderId: string }> = []
    setBrokerAdapters({
      [STUB_BROKER_ID]: {
        ...stubAdapter(),
        cancelOrder: async (_env, ref, orderId) => { cancelled.push({ account: ref.accountNumber, orderId }) },
      },
    })

    await expect(cancelBrokerageOrder({}, '12345', stubBrokerCredential))
      .resolves.toMatchObject({ cancelled: '12345' })
    expect(cancelled).toEqual([{ account: 'STUB-1', orderId: '12345' }])
  })

  it('refuses without a broker credential rather than choosing an account', async () => {
    await expect(cancelBrokerageOrder({}, '12345', undefined))
      .rejects.toBeInstanceOf(BrokerCredentialMissingError)
  })

  it('surfaces an ambiguous cancellation instead of retrying it', async () => {
    const cancelOrder = vi.fn(async () => { throw new BrokerCancellationAmbiguousError() })
    setBrokerAdapters({
      [STUB_BROKER_ID]: {
        ...stubAdapter(),
        cancelOrder,
      },
    })
    // The order may or may not still be working. Anything that looks like success here would
    // let the next placement through on a false reading of the account.
    await expect(cancelBrokerageOrder({}, '12345', stubBrokerCredential))
      .rejects.toBeInstanceOf(BrokerCancellationAmbiguousError)
    expect(cancelOrder).toHaveBeenCalledOnce()
  })
})

describe('brokers without placement', () => {
  it('refuses by name rather than claiming no brokerage is connected', async () => {
    setBrokerAdapters({ [STUB_BROKER_ID]: stubAdapter() })
    // Reads work for this credential, so "connect a brokerage" would be a lie; the refusal has
    // to say that placement specifically is missing for this broker.
    await expect(placeBrokerageOrder({ DB: (await freshStore()).database }, EQUITY_ORDER, stubBrokerCredential, waitUntil))
      .rejects.toThrow(/not implemented for/)
  })
})
