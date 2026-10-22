import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { normalizeTastytradeMarketTicker, tickerFromStoredRecords } from '../src/server/tastytrade-market-normalization'
import {
  claimMarketRefresh,
  renewMarketRefresh,
  persistMarketSession,
  persistTastytradeMarketSnapshot,
  readStoredMarketRecords,
  readStoredMarketSession,
  releaseMarketRefresh,
  sweepExpiredSymbolRefreshLeases,
  SYMBOL_REFRESH_LEASE_PREFIX,
} from '../src/server/tastytrade-market-store'
import { unsupportedDatabase } from './fake-d1'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

const metric = {
  earningsDate: '2026-10-29',
  ivIndex: 27.4,
  // As a row written before the conversion rounded holds it: 0.183711532 * 100 in float64.
  ivRank: 18.371153200000002,
  ivTermStructure: {
    backExpiration: '2026-09-11',
    backIv: 26.1,
    frontExpiration: '2026-09-04',
    frontIv: 28.9,
  },
  liquidity: 5,
  marketCap: 3_500_000_000_000,
  providerUpdatedAt: '2026-08-28T09:05:00.000Z',
  symbol: 'AAPL',
}

const quote = {
  previousClose: 238.25,
  price: 236.41,
  providerUpdatedAt: '2026-08-28T13:31:00.000Z',
  symbol: 'AAPL',
  volume: 44_000_000,
  yearHigh: 260.1,
  yearLow: 164.08,
}

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => {
  store.close()
})

describe('stored market read model', () => {
  it('round-trips what the writer persisted back into a renderable ticker', async () => {
    const env = { DB: store.database }
    await persistTastytradeMarketSnapshot(env, { metrics: [metric], quotes: [quote] })

    const records = await readStoredMarketRecords(env, ['AAPL', 'NVDA'])
    expect(records.metrics.get('AAPL')).toEqual(metric)
    expect(records.quotes.get('AAPL')).toEqual(quote)
    expect(records.observedAt).toBeDefined()
    // A symbol the store has never seen is absent rather than a zero-priced row.
    expect(records.quotes.get('NVDA')).toBeUndefined()

    const ticker = tickerFromStoredRecords(
      'AAPL',
      records.metrics.get('AAPL'),
      records.quotes.get('AAPL')!,
      { description: 'Apple', 'is-etf': false, 'is-index': false, lendability: 'Easy To Borrow' },
      undefined,
      new Date('2026-08-28T13:31:00.000Z'),
    )
    expect(ticker).toMatchObject({
      assetType: 'stock',
      // Not `236.41 - 238.25`, which is -1.8400000000000034: the day move is ours to compute,
      // so it carries the provider's cent precision rather than float64's account of it.
      change: -1.84,
      earningsDate: '2026-10-29',
      lendability: 'Easy To Borrow',
      marketCap: 3_500_000_000_000,
      name: 'Apple',
      price: 236.41,
      symbol: 'AAPL',
      updatedAt: '2026-08-28T13:31:00.000Z',
      // The two provider instants stay distinct: the quote's and the metrics' own.
      metricsUpdatedAt: '2026-08-28T09:05:00.000Z',
    })
    // Candle history is live-only state and is never reconstructed from the store.
    expect(ticker.sparkline).toEqual([])
    // Four decimal places, for the same reason: the percentage is a projection of ours, and
    // -0.7722980062959091 claims sixteen digits of a move the provider reported to the cent.
    expect(ticker.changePercent).toBe(-0.7723)
    // A row written before the conversion rounded keeps its digits until its symbol next
    // reaches the provider, which outside market hours is a long time, so the read rounds too.
    expect(ticker.ivRank).toBe(18.3712)
  })

  it('reads back exactly the ticker the live build published', async () => {
    // A figure stored as the provider reported it must come back with the provider's digits;
    // rounding it on the way out made the stored read publish a number the live read did not.
    const env = { DB: store.database }
    const instrument = { description: 'Apple', 'is-etf': false, 'is-index': false, lendability: 'Easy To Borrow' }
    const live = normalizeTastytradeMarketTicker('AAPL', {
      'historical-volatility-30-day': '23.456789',
      'implied-volatility-index': '0.274567891',
      'implied-volatility-index-5-day-change': '0.0123456',
      'implied-volatility-index-rank': '0.183711532',
      'implied-volatility-percentile': '0.61',
      'iv-hv-30-day-difference': '4.001234567',
      'liquidity-rating': '3.123456',
      'updated-at': '2026-08-28T09:05:00.000Z',
    }, {
      mark: '236.41', 'previous-close': '238.25', 'updated-at': '2026-08-28T13:31:00.000Z',
    }, instrument)
    await persistTastytradeMarketSnapshot(env, { metrics: [live.metricRecord], quotes: [live.quoteRecord] })

    const records = await readStoredMarketRecords(env, ['AAPL'])
    const stored = tickerFromStoredRecords(
      'AAPL', records.metrics.get('AAPL'), records.quotes.get('AAPL')!, instrument, undefined,
      new Date('2026-08-28T13:31:00.000Z'),
    )
    expect(stored).toEqual(live.ticker)
    expect(stored.historicalVolatility30Day).toBe(23.456789)
    expect(stored.ivHistoricalVolatility30DayDifference).toBe(4.001234567)
    expect(stored.liquidity).toBe(3.123456)
  })

  it('reports both the oldest and the newest reading, and counts rows it could not read', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const env = { DB: store.database }
    await persistTastytradeMarketSnapshot(env, { metrics: [], quotes: [quote] }, new Date('2026-08-28T13:00:00.000Z'))
    await persistTastytradeMarketSnapshot(env, { metrics: [], quotes: [{ ...quote, symbol: 'NVDA' }] }, new Date('2026-08-28T14:00:00.000Z'))

    const records = await readStoredMarketRecords(env, ['AAPL', 'NVDA'])
    expect(records.observedAt).toBe('2026-08-28T13:00:00.000Z')
    expect(records.latestObservedAt).toBe('2026-08-28T14:00:00.000Z')
    expect(warn).not.toHaveBeenCalled()

    store.sqlite.exec('PRAGMA ignore_check_constraints = ON')
    store.sqlite.prepare("UPDATE tastytrade_market_quotes SET price = 'unreadable' WHERE symbol = 'NVDA'").run()
    const partial = await readStoredMarketRecords(env, ['AAPL', 'NVDA'])
    expect([...partial.quotes.keys()]).toEqual(['AAPL'])
    expect(warn).toHaveBeenCalledWith('MarketStoreRowsSkipped', 1)
  })

  it('drops an earnings date the store has outlived, as the live path does', async () => {
    const env = { DB: store.database }
    await persistTastytradeMarketSnapshot(env, { metrics: [metric], quotes: [quote] })
    const records = await readStoredMarketRecords(env, ['AAPL'])

    // The row is still the provider's record; what a reader is shown is only an upcoming date,
    // so a stored snapshot never advertises an earnings date that has already been reported.
    const ticker = tickerFromStoredRecords(
      'AAPL',
      records.metrics.get('AAPL'),
      records.quotes.get('AAPL')!,
      undefined,
      undefined,
      new Date('2026-10-30T13:31:00.000Z'),
    )
    expect(ticker.earningsDate).toBeNull()
  })

  it('grants the refresh claim to one caller and releases it only by expiry', async () => {
    const env = { DB: store.database }
    const now = new Date('2026-08-28T13:31:00.000Z')

    const claims = await Promise.all([
      claimMarketRefresh(env, 30_000, now),
      claimMarketRefresh(env, 30_000, now),
      claimMarketRefresh(env, 30_000, now),
    ])
    expect(claims.filter(Boolean)).toHaveLength(1)

    // Still held part-way through the lease, so a later visitor does not pile on a second refresh.
    await expect(claimMarketRefresh(env, 30_000, new Date(now.getTime() + 29_000))).resolves.toBe(false)
    // A refresh that died mid-flight cannot wedge the lease shut.
    await expect(claimMarketRefresh(env, 30_000, new Date(now.getTime() + 31_000))).resolves.toBe(true)
  })

  it('grants a claim per resource so one symbol lookup cannot block another', async () => {
    const env = { DB: store.database }
    const now = new Date('2026-08-28T13:31:00.000Z')

    await expect(claimMarketRefresh(env, 30_000, now, 'symbol:AAPL')).resolves.toBe(true)
    await expect(claimMarketRefresh(env, 30_000, now, 'symbol:AAPL')).resolves.toBe(false)
    // A different resource is unaffected, and needs no seeded row to be claimable.
    await expect(claimMarketRefresh(env, 30_000, now, 'symbol:NVDA')).resolves.toBe(true)
  })

  it('renews a live refresh across batches without extending an expired or newer claim', async () => {
    const env = { DB: store.database }
    const start = new Date('2026-09-01T13:00:00.000Z')
    const renewed = new Date(start.getTime() + 15_000)
    await expect(claimMarketRefresh(env, 30_000, start)).resolves.toBe(true)
    await expect(renewMarketRefresh(env, 30_000, start, renewed)).resolves.toBe(true)
    await expect(claimMarketRefresh(env, 30_000, new Date(start.getTime() + 31_000))).resolves.toBe(false)
    // The old expiry no longer identifies the claim, even while the renewed lease is live.
    await expect(renewMarketRefresh(env, 30_000, start, new Date(start.getTime() + 32_000))).resolves.toBe(false)
    const expiredAt = new Date(renewed.getTime() + 30_000)
    await expect(renewMarketRefresh(env, 30_000, renewed, expiredAt)).resolves.toBe(false)
    await expect(claimMarketRefresh(env, 30_000, expiredAt)).resolves.toBe(true)
    await expect(renewMarketRefresh(env, 30_000, renewed, new Date(expiredAt.getTime() + 1))).resolves.toBe(false)
  })

  it('releases only the claim its holder made', async () => {
    const env = { DB: store.database }
    const now = new Date('2026-08-28T13:31:00.000Z')

    await expect(claimMarketRefresh(env, 30_000, now, 'symbol:AAPL')).resolves.toBe(true)
    await releaseMarketRefresh(env, 30_000, now, 'symbol:AAPL')
    // A finished holder frees the resource before its lease would have expired.
    const next = new Date(now.getTime() + 1_000)
    await expect(claimMarketRefresh(env, 30_000, next, 'symbol:AAPL')).resolves.toBe(true)

    // A holder that outlived its lease and was superseded releases nothing of the newer claim.
    await releaseMarketRefresh(env, 30_000, now, 'symbol:AAPL')
    await expect(claimMarketRefresh(env, 30_000, new Date(next.getTime() + 1_000), 'symbol:AAPL')).resolves.toBe(false)
  })

  it('sweeps lapsed per-symbol leases without touching the held or the public one', async () => {
    const env = { DB: store.database }
    const now = new Date('2026-08-28T13:31:00.000Z')
    // Anonymous search keys a lease by the reader's own query text, so without a sweep every
    // distinct query is a permanent row.
    await claimMarketRefresh(env, 30_000, now, `${SYMBOL_REFRESH_LEASE_PREFIX}AAPL`)
    await claimMarketRefresh(env, 30_000, now, `${SYMBOL_REFRESH_LEASE_PREFIX}NVDA`)
    await claimMarketRefresh(env, 30_000, now)

    const held = new Date(now.getTime() + 29_000)
    await expect(sweepExpiredSymbolRefreshLeases(env, held)).resolves.toBe(0)
    // A lease still held guards a lookup in flight, so only a lapsed one is dropped.
    await expect(claimMarketRefresh(env, 30_000, held, `${SYMBOL_REFRESH_LEASE_PREFIX}AAPL`)).resolves.toBe(false)

    const lapsed = new Date(now.getTime() + 31_000)
    await expect(sweepExpiredSymbolRefreshLeases(env, lapsed)).resolves.toBe(2)
    await expect(sweepExpiredSymbolRefreshLeases({}, lapsed)).rejects.toMatchObject({ name: 'BindingMissing' })
    const remaining = await store.database.prepare('SELECT id FROM market_refresh_lease').all()
    expect(remaining.results).toEqual([{ id: 'public-snapshot' }])
  })

  it('grants the claim when the store cannot answer, rather than denying every visitor', async () => {
    // The lease only exists to spare the provider. A store outage or a schema still catching
    // up must degrade to one extra refresh, never to a public page that cannot be served.
    // Every call on this database throws, which is how a missing table or a D1 outage reads.
    const unavailable = unsupportedDatabase()

    await expect(claimMarketRefresh({ DB: unavailable }, 30_000)).resolves.toBe(true)
    await expect(claimMarketRefresh({}, 30_000)).resolves.toBe(true)
  })

  it('caches the provider session state for visitors that never call the provider', async () => {
    const env = { DB: store.database }
    await expect(readStoredMarketSession(env)).resolves.toBeUndefined()

    await persistMarketSession(
      env,
      'pre',
      '2026-08-28T13:30:00.000Z',
      '2026-08-28T20:00:00.000Z',
      new Date('2026-08-28T11:00:00.000Z'),
    )
    await expect(readStoredMarketSession(env)).resolves.toEqual({
      closesAt: '2026-08-28T20:00:00.000Z',
      observedAt: '2026-08-28T11:00:00.000Z',
      opensAt: '2026-08-28T13:30:00.000Z',
      state: 'pre',
    })

    // A session with no opening bell to report leaves the countdown with nothing to count.
    await persistMarketSession(env, 'closed', undefined, undefined, new Date('2026-08-28T20:01:00.000Z'))
    await expect(readStoredMarketSession(env)).resolves.toEqual({
      closesAt: undefined,
      observedAt: '2026-08-28T20:01:00.000Z',
      opensAt: undefined,
      state: 'closed',
    })
  })
  it('logs a stored session row it cannot read instead of dropping it silently', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    store.sqlite.prepare(
      `INSERT INTO market_session (id, state, observed_at) VALUES ('equities', 'halted', '2026-08-28T11:00:00.000Z')`,
    ).run()

    await expect(readStoredMarketSession({ DB: store.database })).resolves.toBeUndefined()
    expect(warn).toHaveBeenCalledWith('MarketSessionRowSkipped')
  })
})
