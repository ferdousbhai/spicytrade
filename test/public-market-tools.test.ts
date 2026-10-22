import { migrationStore, type SqliteD1Store } from './sqlite-d1'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Value } from 'typebox/value'

import { PublicMarketSnapshotSchema } from '../src/domain/market'
import {
  createPublicMarketReadTools,
  PublicSymbolSearchError,
  selectPublicQuoteRows,
} from '../src/server/public-market-tools'
import { MAX_QUERY_LENGTH } from '../src/server/symbol-search'
import {
  InstrumentQuoteReadParameters,
  MarketMetricsReadParameters,
  MAX_MARKET_SYMBOLS,
  MAX_QUOTE_INSTRUMENTS,
  SymbolSearchParameters,
  SymbolSearchQueryError,
} from '../src/server/brokerage-read-contracts'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { UnreadableTickerError } from '../src/server/ticker-arguments'
import { stubBroker } from './broker-stub'

describe('anonymous public quote projection', () => {
  it('reads requested rows without parsing the rest of the website book', () => {
    const snapshot = {
      syncedAt: '2026-09-16T14:07:48.941Z',
      tickers: [
        { symbol: 'AAPL', price: 236.41, change: -1.84, changePercent: -0.77, name: 'Apple' },
        { symbol: 'NVDA', price: 191.68, change: 4.91, changePercent: 2.63, ivRank: 72, ivPercentile: 81, ivIndex: 48.2, marketCap: 4_730_000_000_000 },
      ],
    }
    expect(() => PublicMarketSnapshotSchema.parse(snapshot)).toThrow()

    const projected = selectPublicQuoteRows(snapshot, ['nvda', 'XOM'])
    expect(projected.syncedAt).toBe(snapshot.syncedAt)
    expect(projected.missing).toEqual(['XOM'])
    expect(projected.rows).toEqual([{
      change: 4.91,
      changePercent: 2.63,
      ivIndex: 48.2,
      ivPercentile: 81,
      ivRank: 72,
      marketCap: 4_730_000_000_000,
      price: 191.68,
      symbol: 'NVDA',
    }])
  })

  it('fails closed on a requested row that is not a quote', () => {
    expect(() => selectPublicQuoteRows({
      syncedAt: '2026-09-16T14:07:48.941Z',
      tickers: [{ symbol: 'NVDA', price: '191.68', change: 4.91, changePercent: 2.63 }],
    }, ['NVDA'])).toThrow()
  })

  it('refuses a requested entry that does not read as a ticker instead of looking it up', () => {
    expect(() => selectPublicQuoteRows({ syncedAt: '2026-09-16T14:07:48.941Z', tickers: [] }, ['NVDA', 'not a ticker']))
      .toThrow(UnreadableTickerError)
  })

  it('ignores a malformed row the caller did not ask for', () => {
    const projected = selectPublicQuoteRows({
      syncedAt: '2026-09-16T14:07:48.941Z',
      tickers: [
        { symbol: 'AAPL' },
        { symbol: 'NVDA', price: 191.68, change: 4.91, changePercent: 2.63 },
      ],
    }, ['NVDA'])
    expect(projected.rows).toHaveLength(1)
    expect(projected.rows[0]?.symbol).toBe('NVDA')
  })
})

describe('anonymous quote and metric parameters', () => {
  const tools = createPublicMarketReadTools({ AUTH_BASE_URL: 'https://spice.test' }, () => undefined)
  const parametersOf = (name: string) => {
    const tool = tools.find((candidate) => candidate.name === name)
    if (!tool) throw new Error(`${name} is missing`)
    return tool.parameters
  }
  const symbols = (count: number) => Array.from({ length: count }, (_, index) => `$s${index}`)

  it('accepts exactly what the signed-in tool of the same name accepts', () => {
    const quotes = parametersOf('read_instrument_quotes')
    for (const count of [MAX_QUOTE_INSTRUMENTS, MAX_QUOTE_INSTRUMENTS + 1]) {
      expect(Value.Check(quotes, { symbols: symbols(count) }))
        .toBe(Value.Check(InstrumentQuoteReadParameters, { symbols: symbols(count) }))
    }
    expect(Value.Check(quotes, { symbols: symbols(MAX_QUOTE_INSTRUMENTS) })).toBe(true)
    expect(Value.Check(quotes, { symbols: symbols(MAX_QUOTE_INSTRUMENTS + 1) })).toBe(false)

    const metrics = parametersOf('read_market_metrics')
    for (const count of [MAX_MARKET_SYMBOLS, MAX_MARKET_SYMBOLS + 1]) {
      expect(Value.Check(metrics, { symbols: symbols(count) }))
        .toBe(Value.Check(MarketMetricsReadParameters, { symbols: symbols(count) }))
    }
    expect(Value.Check(metrics, { symbols: ['$nvda'] })).toBe(true)
  })
})

describe('anonymous symbol search', () => {
  // The real search route behind the tool, over a stub broker and an edge cache that holds
  // nothing, so each call reaches the route's own answer.
  const broker = stubBroker()
  let store: SqliteD1Store

  beforeEach(async () => {
    store = await migrationStore()
    vi.clearAllMocks()
    setBrokerApi(broker)
    vi.stubGlobal('caches', { default: { match: async () => undefined, put: async () => undefined } })
  })

  afterEach(() => {
    store.close()
    resetBrokerApi()
  })

  function searchTool() {
    const tool = createPublicMarketReadTools({ AUTH_BASE_URL: 'https://spice.test', DB: store.database }, () => undefined)
      .find((candidate) => candidate.name === 'search_symbols')
    if (!tool) throw new Error('search_symbols is missing')
    return tool
  }

  it('advertises the search route\'s own query bound', () => {
    expect(searchTool().parameters).toMatchObject({ properties: { query: { maxLength: MAX_QUERY_LENGTH } } })
  })

  it('reports a clean miss as a result', async () => {
    broker.lookupPublicMarketSymbol.mockResolvedValue(undefined)
    const result = await searchTool().execute({ query: 'ZZZZ' })
    expect(JSON.parse(result.content[0]!.text)).toEqual({ error: 'No tradable symbol matches that search' })
  })

  it('accepts exactly the queries the signed-in search_symbols accepts', () => {
    const anonymous = searchTool().parameters
    for (const query of ['NVDA', '$sofi', 'SoFi Technologies', '_a', '%%', '_ %', '   ', 'Soci\u00e9t\u00e9', 'A'.repeat(MAX_QUERY_LENGTH + 1)]) {
      expect(Value.Check(anonymous, { query })).toBe(Value.Check(SymbolSearchParameters, { query }))
    }
    // Nothing the route would empty out, and nothing outside printable ASCII, is advertised.
    for (const query of ['%%', '_ %', '   ', 'Soci\u00e9t\u00e9']) expect(Value.Check(anonymous, { query })).toBe(false)
  })

  it('refuses a query the route refuses rather than reporting an outage', async () => {
    // Only wildcards, reaching execute past the schema: the route answers 400 before any lookup.
    const refused = searchTool().execute({ query: '%%' })
    await expect(refused).rejects.toBeInstanceOf(SymbolSearchQueryError)
    await expect(refused).rejects.not.toBeInstanceOf(PublicSymbolSearchError)
    expect(broker.lookupPublicMarketSymbol).not.toHaveBeenCalled()
  })

  it('fails visibly rather than returning an outage as a search result', async () => {
    broker.lookupPublicMarketSymbol.mockRejectedValue(new Error('ProviderDown'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    await expect(searchTool().execute({ query: 'NVDA' })).rejects.toBeInstanceOf(PublicSymbolSearchError)
  })
})
