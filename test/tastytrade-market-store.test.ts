import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type Ticker } from '../src/domain/market'
import { MAX_WATCHLIST_SYMBOLS } from '../src/domain/watchlist'
import { D1_MAX_BOUND_PARAMETERS } from '../src/server/d1-limits'
import {
  persistTastytradeMarketSnapshot,
  readStoredMarketRecords,
  type TastytradeMarketRecords,
} from '../src/server/tastytrade-market-store'
import { marketTickersFixture } from './fixtures/market'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => {
  store.close()
})

function sourceRecords(
  tickers: readonly Ticker[],
  previousClose = (ticker: Ticker) => ticker.price - ticker.change,
): TastytradeMarketRecords {
  return {
    metrics: tickers.map((ticker) => ({
      earningsDate: ticker.earningsDate,
      historicalVolatility30Day: ticker.historicalVolatility30Day,
      ivHistoricalVolatility30DayDifference: ticker.ivHistoricalVolatility30DayDifference,
      ivIndex: ticker.ivIndex,
      ivIndex5DayChange: ticker.ivIndex5DayChange,
      ivPercentile: ticker.ivPercentile,
      ivRank: ticker.ivRank,
      ivTermStructure: ticker.ivTermStructure,
      liquidity: ticker.liquidity,
      marketCap: ticker.marketCap,
      providerUpdatedAt: ticker.metricsUpdatedAt,
      symbol: ticker.symbol,
    })),
    quotes: tickers.map((ticker) => ({
      previousClose: previousClose(ticker),
      price: ticker.price,
      providerUpdatedAt: ticker.updatedAt,
      symbol: ticker.symbol,
      volume: ticker.volume,
      yearHigh: ticker.yearHigh,
      yearLow: ticker.yearLow,
    })),
  }
}

describe('source-specific tastytrade market storage', () => {
  it('fails when source storage is unavailable', async () => {
    await expect(persistTastytradeMarketSnapshot(
      {},
      sourceRecords([marketTickersFixture[0]!]),
    )).rejects.toThrow('TastytradeMarketStore:unavailable')
  })

  it('keeps a full watchlist refresh below D1 query and bind limits', async () => {
    const boundParameterCounts: number[] = []
    const batch = vi.fn(async () => [])
    const database: D1Database = {
      ...unsupportedDatabase(),
      batch,
      prepare: vi.fn(() => ({
        ...unsupportedStatement(),
        bind: (...values: unknown[]) => {
          boundParameterCounts.push(values.length)
          if (values.length > D1_MAX_BOUND_PARAMETERS) throw new Error('too many SQL variables')
          return unsupportedStatement()
        },
      })),
    }
    const template = marketTickersFixture[0]!
    const tickers = Array.from({ length: MAX_WATCHLIST_SYMBOLS }, (_, index) => ({
      ...template,
      name: `Ticker ${index}`,
      symbol: `T${index}`,
    }))

    await persistTastytradeMarketSnapshot({ DB: database }, sourceRecords(tickers))

    expect(batch).toHaveBeenCalledOnce()
    expect(boundParameterCounts.length).toBeGreaterThan(1)
    expect(Math.max(...boundParameterCounts)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
  })

  it('skips and counts a stored quote with no positive previous close rather than showing no move', async () => {
    // The table's CHECK refuses such a row, so the read is exercised against rows D1 hands back.
    const quote = (symbol: string, previousClose: number) => ({
      observed_at: '2026-08-26T13:31:00.000Z',
      previous_close: previousClose,
      price: 100,
      provider_updated_at: '2026-08-26T13:31:00.000Z',
      symbol,
      volume: null,
      year_high: null,
      year_low: null,
    })
    const database: D1Database = {
      ...unsupportedDatabase(),
      prepare: vi.fn((sql: string) => ({
        ...unsupportedStatement(),
        bind: () => ({
          ...unsupportedStatement(),
          all: async <T>() => {
            const rows = sql.includes('tastytrade_market_quotes') ? [quote('GOOD', 98), quote('ZERO', 0)] : []
            // SAFETY: the reader re-parses every row with its own schema; that parse is under test.
            return d1Result(rows as T[])
          },
        }),
      })),
    }
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const records = await readStoredMarketRecords({ DB: database }, ['GOOD', 'ZERO'])

    expect([...records.quotes.keys()]).toEqual(['GOOD'])
    expect(warned).toHaveBeenCalledWith('MarketStoreRowsSkipped', 1)
  })

  it('stores a 52-week range whose high equals its low', async () => {
    const ticker = { ...marketTickersFixture[0]!, yearHigh: 10, yearLow: 10, price: 10, change: 0 }

    await persistTastytradeMarketSnapshot({ DB: store.database }, sourceRecords([ticker]))

    expect(store.sqlite.prepare('SELECT year_low, year_high FROM tastytrade_market_quotes').get())
      .toEqual({ year_low: 10, year_high: 10 })
    // An inverted range stays a broken frame at the store too.
    expect(() => store.sqlite.prepare('UPDATE tastytrade_market_quotes SET year_low = 11').run()).toThrow()
  })

  it('keeps metrics and quotes in their source-specific tables', async () => {
    const ticker = marketTickersFixture.find((candidate) => candidate.symbol === 'NVDA')!

    await persistTastytradeMarketSnapshot(
      { DB: store.database },
      sourceRecords([ticker], () => 180),
      new Date('2026-08-26T20:00:00.000Z'),
    )

    expect(store.sqlite.prepare(
      'SELECT symbol, iv_rank_percent, market_cap, provider_updated_at, observed_at FROM tastytrade_market_metrics',
    ).get()).toEqual({
      iv_rank_percent: 72,
      market_cap: 4_730_000_000_000,
      // The provider's instant is kept beside the Worker's own, since only one of them says
      // how old the reading is.
      provider_updated_at: ticker.metricsUpdatedAt ?? null,
      observed_at: '2026-08-26T20:00:00.000Z',
      symbol: 'NVDA',
    })
    expect(store.sqlite.prepare(
      'SELECT symbol, previous_close, price, volume, provider_updated_at FROM tastytrade_market_quotes',
    ).get()).toEqual({
      price: 191.68,
      previous_close: 180,
      provider_updated_at: '2026-08-13T13:31:00.000Z',
      symbol: 'NVDA',
      volume: 128_400_000,
    })
    expect(store.sqlite.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'view' AND name = 'public_market_overview'",
    ).get()).toBeUndefined()
    expect(store.sqlite.prepare('PRAGMA table_info(tastytrade_market_metrics)').all().map((row) => row.name))
      .not.toContain('price')
    const quoteColumns = store.sqlite.prepare('PRAGMA table_info(tastytrade_market_quotes)').all()
      .map((row) => row.name)
    expect(quoteColumns).not.toContain('iv_rank_percent')
    expect(quoteColumns).not.toContain('change_amount')
    expect(quoteColumns).not.toContain('change_percent')
    const nullableMetricColumns = store.sqlite.prepare('PRAGMA table_info(tastytrade_market_metrics)').all()
      .filter((row) => row.notnull === 0)
      .map((row) => row.name)
    expect(nullableMetricColumns).toEqual(expect.arrayContaining([
      'iv_index_percent',
      'iv_rank_percent',
      'iv_percentile_percent',
      'liquidity_rating',
    ]))
  })
})
