import { afterEach, describe, expect, it, vi } from 'vitest'
import { stubBrokerGate } from './broker-stub'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { migrationStore, seededItems, seedWatchlist } from './sqlite-d1'
import { symbolAt } from './symbols'
import { MAX_WATCHLIST_SYMBOLS } from '../src/domain/watchlist'
import { catalystUpsertStatements } from '../src/server/catalysts'
import {
  loadStoredPublicMarketUniverse,
  publishInternalWatchlistUniverse,
} from '../src/server/public-market-universe'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

const secret: SecretsStoreSecret = { get: async () => 'secret' }

function storedCatalogRow(symbol: string) {
  return {
    active: 1,
    borrow_rate: null,
    bypass_manual_review: 0,
    country_of_incorporation: null,
    country_of_taxation: null,
    created_at: '2026-08-26T12:00:00.000Z',
    description: symbol,
    halted_at: null,
    identity_refreshed_at: '2026-08-26T12:00:00.000Z',
    identity_source: 'equity-endpoint',
    instrument_sub_type: null,
    instrument_type: 'Equity',
    is_closing_only: 0,
    is_etf: 0,
    is_fractional_quantity_eligible: null,
    is_illiquid: 0,
    is_index: 0,
    is_options_closing_only: 0,
    lendability: null,
    listed_market: null,
    market_time_instrument_collection: null,
    overnight_trading_permitted: null,
    pre_ipo: 0,
    resolution_status: 'resolved',
    short_description: null,
    source_name: 'tastytrade',
    status_refreshed_at: '2026-08-26T12:00:00.000Z',
    stops_trading_at: null,
    streamer_symbol: symbol,
    symbol,
    underlying_product_type: null,
    updated_at: '2026-08-26T12:00:00.000Z',
  }
}

describe('public market boundary', () => {
  it('rejects missing, malformed, and oversized stored universes', async () => {
    const store = await migrationStore()
    await expect(loadStoredPublicMarketUniverse({ DB: store.database })).rejects.toThrow('not-found')
    store.sqlite.prepare(
      `INSERT INTO public_market_universe (id, payload_json, updated_at) VALUES ('primary', ?, ?)`,
    ).run(JSON.stringify({ symbols: ['not a ticker'] }), '2026-08-26T12:00:00.000Z')
    await expect(loadStoredPublicMarketUniverse({ DB: store.database })).rejects.toThrow()

    store.sqlite.prepare(`DELETE FROM public_market_universe WHERE id = 'primary'`).run()
    const symbols = Array.from(
      { length: MAX_WATCHLIST_SYMBOLS + 1 },
      (_, index) => symbolAt(index),
    )
    const insert = store.sqlite.prepare(
      `INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
       VALUES (?, 'Equity', 'owner', '{}', ?, ?)`,
    )
    for (const symbol of symbols) insert.run(symbol, '2026-08-26T12:00:00.000Z', '2026-08-26T12:00:00.000Z')
    await expect(publishInternalWatchlistUniverse({ DB: store.database }))
      .rejects.toThrow('PublicMarketUniverse:too-many-symbols')
    expect(store.sqlite.prepare(`SELECT id FROM public_market_universe WHERE id = 'primary'`).get()).toBeUndefined()
    store.close()
  })

  it('stores exactly the alphabetized watchlist projection in one statement', async () => {
    const store = await migrationStore()
    const env = { DB: store.database }
    await publishInternalWatchlistUniverse(env)
    expect(store.sqlite.prepare(`SELECT payload_json FROM public_market_universe WHERE id = 'primary'`).get())
      .toEqual({ payload_json: JSON.stringify({ symbols: [] }) })

    const insert = store.sqlite.prepare(
      `INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
       VALUES (?, 'Equity', ?, '{}', ?, ?)`,
    )
    for (const [symbol, origin] of [['MSFT', 'owner'], ['AAPL', 'scheduled-research'], ['BRK/B', 'owner']]) {
      insert.run(symbol, origin, '2026-08-26T12:00:00.000Z', '2026-08-26T12:00:00.000Z')
    }
    // Two publishes racing over a changing watchlist leave the copy of the list as it now is.
    await Promise.all([publishInternalWatchlistUniverse(env), publishInternalWatchlistUniverse(env)])
    store.sqlite.prepare(`DELETE FROM internal_watchlist_items WHERE symbol = 'MSFT'`).run()
    await publishInternalWatchlistUniverse(env, new Date('2026-08-27T12:00:00.000Z'))

    const watchlist = store.sqlite.prepare(`SELECT symbol FROM internal_watchlist_items ORDER BY symbol`).all()
      .map((row) => String(row.symbol))
    expect(store.sqlite.prepare(`SELECT payload_json, updated_at FROM public_market_universe WHERE id = 'primary'`).get())
      .toEqual({
        // Byte-for-byte the shape `JSON.stringify` of the schema object produced before.
        payload_json: JSON.stringify({ symbols: watchlist }),
        updated_at: '2026-08-27T12:00:00.000Z',
      })
    await expect(loadStoredPublicMarketUniverse(env)).resolves.toEqual({ symbols: ['AAPL', 'BRK/B'] })
    store.close()
  })

  it('fails before provider access when the public D1 universe is unavailable', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { loadPublicMarketSnapshot } = await import('../src/server/tastytrade')
    const brokerGate = stubBrokerGate()

    await expect(loadPublicMarketSnapshot({
      BROKER_GATE: brokerGate.namespace,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    })).rejects.toThrow('PublicMarketUniverse:store-unavailable')

    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not hide a missing bulk symbol behind an individual-endpoint retry', async () => {
    const store = await migrationStore()
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'catalog-token', expires_in: 900 })
      if (url.includes('/instruments/equities?')) return Response.json({ data: { items: [] } })
      if (url.includes('/instruments/equities/SPCX')) throw new Error('Unexpected individual fallback')
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { refreshTastytradeInstrumentCatalog } = await import('../src/server/tastytrade')

    await expect(refreshTastytradeInstrumentCatalog({
      BROKER_GATE: stubBrokerGate().namespace,
      DB: store.database,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    }, ['SPCX'])).resolves.toMatchObject({ missingSymbols: ['SPCX'], receivedCount: 0 })
    expect(store.sqlite.prepare('SELECT resolution_status FROM instrument_catalog WHERE symbol = ?').get('SPCX'))
      .toEqual({ resolution_status: 'unresolved' })
    store.close()
  })

  it('serves the internal list alone and never syncs a held symbol into it', async () => {
    const store = await migrationStore()
    seedWatchlist(store, seededItems(['NVDA']))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'owner-read-token', expires_in: 900 })
      if (url.endsWith('/customers/me/accounts')) {
        return Response.json({ data: { items: [{ account: { 'account-number': 'TEST123' } }] } })
      }
      if (url.endsWith('/accounts/TEST123/positions')) {
        return Response.json({ data: { items: [{ symbol: 'META', quantity: '1' }] } })
      }
      if (url.includes('/market-time/equities/sessions/current')) {
        return Response.json({ data: { state: 'Open', 'open-at': '2026-08-26T13:30:00.000Z' } })
      }
      const symbols = ['NVDA']
      if (url.includes('/market-metrics')) return Response.json({ data: { items: symbols.map((symbol) => ({
        symbol,
        'implied-volatility-index': '0.42',
        'implied-volatility-index-rank': '0.55',
        'implied-volatility-percentile': '0.61',
        'liquidity-rating': '4',
      })) } })
      if (url.includes('/market-data/by-type')) return Response.json({ data: { items: symbols.map((symbol) => ({
        symbol, mark: '100', 'previous-close': '98', description: symbol,
        change: '2', 'change-percent': '2.0408163265',
        'updated-at': '2026-08-26T13:31:00.000Z',
      })) } })
      if (url.includes('/instruments/equities')) return Response.json({ data: { items: symbols.map((symbol) => ({
        active: true, description: symbol, 'instrument-type': 'Equity', symbol,
      })) } })
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { brokerApi } = await import('../src/server/tastytrade')
    const brokerGate = stubBrokerGate()

    const snapshot = await brokerApi().loadMarketSnapshot({
      BROKER_GATE: brokerGate.namespace,
      DB: store.database,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    })

    expect(snapshot.watchlists).toEqual([
      { id: 'watchlist', kind: 'private', name: 'Watchlist', symbols: ['NVDA'] },
    ])
    expect(snapshot.tickers.find((ticker) => ticker.symbol === 'META')).toBeUndefined()
    expect(store.sqlite.prepare(
      `SELECT origin FROM internal_watchlist_items WHERE symbol = 'META'`,
    ).get()).toBeUndefined()
    expect(JSON.parse(String(store.sqlite.prepare(
      `SELECT payload_json FROM public_market_universe WHERE id = 'primary'`,
    ).get()?.payload_json))).toEqual({ symbols: ['NVDA'] })
    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(requestedUrls.some((url) => url.includes('/watchlists'))).toBe(false)
    expect(requestedUrls.some((url) => url.includes('/customers/'))).toBe(false)
    expect(requestedUrls.some((url) => url.includes('/accounts/'))).toBe(false)

    fetchMock.mockClear()
    // The stored read is entirely local now: no account path means no broker request at all.
    await brokerApi().loadStoredMarketSnapshot({
      BROKER_GATE: brokerGate.namespace,
      DB: store.database,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    })
    expect(fetchMock).not.toHaveBeenCalled()
    store.close()
  })

  it('keeps a restored seed universe whole and pages the market read into broker-sized requests', async () => {
    const store = await migrationStore()
    const symbols = Array.from({ length: 105 }, (_, index) => symbolAt(index))
    seedWatchlist(store, seededItems(symbols))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/oauth/token')) return Response.json({ access_token: 'owner-read-token', expires_in: 900 })
      if (url.pathname.includes('/market-time/equities/sessions/current')) {
        return Response.json({ data: { state: 'Open' } })
      }
      if (url.pathname.endsWith('/instruments/equities')) {
        return Response.json({ data: { items: url.searchParams.getAll('symbol[]').map((symbol) => ({
          active: true, description: symbol, 'instrument-type': 'Equity', symbol,
        })) } })
      }
      if (url.pathname.endsWith('/market-metrics')) {
        return Response.json({ data: { items: (url.searchParams.get('symbols') ?? '').split(',').map((symbol) => ({
          symbol,
          'implied-volatility-index': '0.42',
          'implied-volatility-index-rank': '0.55',
          'implied-volatility-percentile': '0.61',
          'liquidity-rating': '4',
        })) } })
      }
      if (url.pathname.endsWith('/market-data/by-type')) {
        return Response.json({ data: { items: url.searchParams.getAll('equity').map((symbol) => ({
          symbol, mark: '100', 'previous-close': '98', description: symbol,
          change: '2', 'change-percent': '2.0408163265',
          'updated-at': '2026-08-26T13:31:00.000Z',
        })) } })
      }
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { brokerApi } = await import('../src/server/tastytrade')
    const brokerGate = stubBrokerGate()

    const snapshot = await brokerApi().loadMarketSnapshot({
      BROKER_GATE: brokerGate.namespace,
      DB: store.database,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    })

    expect(snapshot.watchlists).toHaveLength(1)
    expect(snapshot.watchlists[0]?.symbols).toHaveLength(symbols.length)
    expect(store.sqlite.prepare('SELECT count(*) AS count FROM internal_watchlist_items').get())
      .toEqual({ count: symbols.length })
    expect(JSON.parse(String(store.sqlite.prepare(
      `SELECT payload_json FROM public_market_universe WHERE id = 'primary'`,
    ).get()?.payload_json)).symbols).toHaveLength(symbols.length)
    // A list longer than one broker request is read in pages, so no single URL
    // has to name every symbol on it.
    const metricSymbolCounts = fetchMock.mock.calls
      .map(([input]) => new URL(String(input)))
      .filter((url) => url.pathname.endsWith('/market-metrics'))
      .map((url) => (url.searchParams.get('symbols') ?? '').split(',').length)
    expect(metricSymbolCounts).toEqual([100, 5])
    store.close()
  })

  it('loads the stored source-free universe through market-only endpoints', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'public-read-token', expires_in: 900 })
      if (url.includes('/market-time/equities/sessions/current')) return Response.json({ data: { state: 'Open' } })
      if (url.includes('/market-metrics')) return Response.json({ data: { items: ['BE', 'NVDA'].map((symbol) => ({
        symbol,
        'implied-volatility-index': '0.42',
        'implied-volatility-index-rank': '0.55',
        'implied-volatility-percentile': '0.61',
        'liquidity-rating': '4',
        // Metrics are computed on the provider's own schedule, hours behind the quote here;
        // BE's row carries no instant at all (JSON drops the undefined).
        'updated-at': symbol === 'NVDA' ? '2026-08-26T05:02:00.000Z' : undefined,
      })) } })
      if (url.includes('/market-data/by-type')) return Response.json({ data: { items: ['BE', 'NVDA'].map((symbol) => ({
        symbol, mark: '100', 'previous-close': '98', description: symbol,
        change: '2', 'change-percent': '2.0408163265',
        'updated-at': '2026-08-26T13:31:00.000Z',
      })) } })
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const db: D1Database = {
      ...unsupportedDatabase(),
      batch: async (statements) => statements.map(() => d1Result([])),
      prepare: (sql: string) => ({
        ...unsupportedStatement(),
        first: async () => {
          if (sql.includes('FROM public_market_universe')) {
            // GONE is listed but the provider answers for it nowhere: it is left out and counted.
            return { payload_json: JSON.stringify({ symbols: ['BE', 'GONE', 'NVDA'] }) }
          }
          if (sql.includes('FROM daily_briefs')) return null
          throw new Error(`Unexpected first query: ${sql}`)
        },
        bind: () => ({
          ...unsupportedStatement(),
          all: async <T>() => {
            if (sql.includes('FROM upcoming_catalysts')) return d1Result<T>([])
            if (sql.includes('FROM instrument_catalog')) {
              const rows = ['BE', 'NVDA'].map(storedCatalogRow)
              // SAFETY: this branch exactly models the catalog row selected by production SQL.
              return d1Result(rows as T[])
            }
            throw new Error(`Unexpected all query: ${sql}`)
          },
        }),
      }),
    }
    const { loadPublicMarketSnapshot } = await import('../src/server/tastytrade')
    const brokerGate = stubBrokerGate()

    const snapshot = await loadPublicMarketSnapshot({
      BROKER_GATE: brokerGate.namespace,
      DB: db,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    })

    expect(snapshot.watchlists[0]?.symbols).toEqual(['BE', 'GONE', 'NVDA'])
    expect(warn).toHaveBeenCalledWith('MarketSymbolsDropped', 1)
    expect(snapshot.tickers).toEqual([
      expect.objectContaining({ symbol: 'BE', updatedAt: '2026-08-26T13:31:00.000Z' }),
      expect.objectContaining({ symbol: 'NVDA', updatedAt: '2026-08-26T13:31:00.000Z', metricsUpdatedAt: '2026-08-26T05:02:00.000Z' }),
    ])
    // A metrics row the provider did not date carries no instant, rather than the quote's.
    expect(snapshot.tickers[0]?.metricsUpdatedAt).toBeUndefined()
    expect(snapshot.tickers.every((ticker) => !('position' in ticker))).toBe(true)
    const requestedUrls = fetchMock.mock.calls.map(([input]) => String(input))
    expect(requestedUrls.some((url) => url.includes('/accounts/') || url.includes('/watchlists'))).toBe(false)
    expect(requestedUrls.some((url) => url.includes('/instruments/equities'))).toBe(false)
  })

  it('carries the same catalysts, and only the snapshot\'s own, in the stored and live builds', async () => {
    // The catalyst table holds rows for names no snapshot lists: a member's agent researching
    // anything it likes, a symbol since removed. Neither build may carry them.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-26T13:32:00.000Z'))
    const store = await migrationStore()
    seedWatchlist(store, [{ symbol: 'NVDA', origin: 'owner' }])
    const researched = (symbol: string) => ({
      confidence: 'estimated' as const,
      date: '2026-09-15',
      id: `member-research:${symbol}:investor-event:2026-09-15`,
      kind: 'investor-event' as const,
      source: 'Member research · investors.example.com',
      sourceUrl: 'https://investors.example.com/events',
      symbol,
      timing: 'unknown' as const,
      title: `${symbol} investor day`,
      updatedAt: '2026-08-26T12:00:00.000Z',
    })
    await store.database.batch(catalystUpsertStatements(
      store.database, 'member-research', [researched('NVDA'), researched('META')], '2026-08-26T12:00:00.000Z',
    ))
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'owner-read-token', expires_in: 900 })
      if (url.includes('/market-time/equities/sessions/current')) {
        return Response.json({ data: { state: 'Open', 'open-at': '2026-08-26T13:30:00.000Z' } })
      }
      if (url.includes('/market-metrics')) return Response.json({ data: { items: [{
        symbol: 'NVDA',
        'implied-volatility-index': '0.42',
        'implied-volatility-index-rank': '0.55',
        'implied-volatility-percentile': '0.61',
        'liquidity-rating': '4',
      }] } })
      if (url.includes('/market-data/by-type')) return Response.json({ data: { items: [{
        symbol: 'NVDA', mark: '100', 'previous-close': '98', description: 'NVDA',
        change: '2', 'change-percent': '2.0408163265',
        'updated-at': '2026-08-26T13:31:00.000Z',
      }] } })
      if (url.includes('/instruments/equities')) return Response.json({ data: { items: [{
        active: true, description: 'NVDA', 'instrument-type': 'Equity', symbol: 'NVDA',
      }] } })
      return new Response('', { status: 404 })
    })
    vi.stubGlobal('fetch', fetchMock)
    const { brokerApi } = await import('../src/server/tastytrade')
    const env = {
      BROKER_GATE: stubBrokerGate().namespace,
      DB: store.database,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    }
    try {
      const live = await brokerApi().loadMarketSnapshot(env)
      const stored = await brokerApi().loadStoredMarketSnapshot(env)
      expect(live.catalysts.map((catalyst) => catalyst.symbol)).toEqual(['NVDA'])
      expect(stored?.catalysts).toEqual(live.catalysts)

      const livePublic = await brokerApi().loadPublicMarketSnapshot(env)
      const storedPublic = await brokerApi().loadStoredPublicMarketSnapshot(env)
      expect(livePublic.catalysts.map((catalyst) => catalyst.symbol)).toEqual(['NVDA'])
      expect(storedPublic?.snapshot.catalysts).toEqual(livePublic.catalysts)

      // A symbol lookup served from the store reads that one symbol's calendar.
      const lookup = await brokerApi().lookupStoredMarketSymbol(env, 'NVDA')
      expect(lookup?.catalysts).toEqual(live.catalysts)
    } finally {
      vi.useRealTimers()
      store.close()
    }
  })

  it('retires a stored earnings date only for a symbol whose metrics row arrived', async () => {
    // A metrics row with no upcoming earnings is the provider saying the date is gone. A symbol
    // whose row never arrived said nothing, so its stored date must survive the build.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-08-26T13:32:00.000Z'))
    const store = await migrationStore()
    seedWatchlist(store, [{ symbol: 'AMD', origin: 'owner' }, { symbol: 'NVDA', origin: 'owner' }])
    const earnings = (symbol: string) => ({
      confidence: 'estimated' as const,
      date: '2026-09-15',
      id: `tastytrade:${symbol}:earnings`,
      kind: 'earnings' as const,
      source: 'tastytrade market metrics',
      sourceUrl: 'https://developer.tastytrade.com/open-api-spec/market-metrics/',
      symbol,
      timing: 'unknown' as const,
      title: `${symbol} earnings`,
      updatedAt: '2026-08-26T12:00:00.000Z',
    })
    await store.database.batch(catalystUpsertStatements(
      store.database, 'tastytrade', [earnings('AMD'), earnings('NVDA')], '2026-08-26T12:00:00.000Z',
    ))
    const quote = (symbol: string) => ({
      symbol, mark: '100', 'previous-close': '98', description: symbol,
      change: '2', 'change-percent': '2.0408163265',
      'updated-at': '2026-08-26T13:31:00.000Z',
    })
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/oauth/token')) return Response.json({ access_token: 'owner-read-token', expires_in: 900 })
      if (url.includes('/market-time/equities/sessions/current')) {
        return Response.json({ data: { state: 'Open', 'open-at': '2026-08-26T13:30:00.000Z' } })
      }
      // Only NVDA's metrics row arrives, and it carries no upcoming earnings.
      if (url.includes('/market-metrics')) return Response.json({ data: { items: [{
        symbol: 'NVDA',
        'implied-volatility-index': '0.42',
        'implied-volatility-index-rank': '0.55',
        'implied-volatility-percentile': '0.61',
        'liquidity-rating': '4',
      }] } })
      if (url.includes('/market-data/by-type')) return Response.json({ data: { items: [quote('AMD'), quote('NVDA')] } })
      if (url.includes('/instruments/equities')) return Response.json({ data: { items: ['AMD', 'NVDA'].map((symbol) => ({
        active: true, description: symbol, 'instrument-type': 'Equity', symbol,
      })) } })
      return new Response('', { status: 404 })
    }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { brokerApi } = await import('../src/server/tastytrade')
    try {
      const live = await brokerApi().loadMarketSnapshot({
        BROKER_GATE: stubBrokerGate().namespace,
        DB: store.database,
        TASTYTRADE_CLIENT_SECRET: secret,
        TASTYTRADE_REFRESH_TOKEN: secret,
      })
      expect(live.catalysts.map((catalyst) => catalyst.id)).toEqual(['tastytrade:AMD:earnings'])
      expect(store.sqlite.prepare("SELECT symbol FROM catalysts WHERE source_provider = 'tastytrade'").all())
        .toEqual([{ symbol: 'AMD' }])
    } finally {
      vi.useRealTimers()
      store.close()
    }
  })
})
