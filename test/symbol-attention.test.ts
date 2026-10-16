import { describe, expect, it, vi } from 'vitest'

import {
  MAX_ATTENTION_SEARCHES,
  noteSymbolAttention,
  readsSymbols,
  type SymbolNamingCall,
} from '../src/server/symbol-attention'
import { CATALYST_FAILED_RETRY_MS } from '../src/server/catalyst-refresh'
import { instrumentCatalogFromPayload, persistInstrumentCatalog } from '../src/server/instrument-catalog'
import { unreadableBrowser } from './fake-browser'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

/**
 * The symbols `noteSymbolAttention` tries to buy a search for, in order. Each attempt starts with
 * one catalog read for exactly that symbol, and an empty catalog ends it there, so the reads are
 * the attempts and no search is ever bought.
 */
async function attemptedSymbols(
  call: SymbolNamingCall,
  seed: (store: SqliteD1Store) => Promise<void> = async () => undefined,
): Promise<unknown[]> {
  const store = await migrationStore()
  await seed(store)
  const attempted: unknown[] = []
  const prepare = store.database.prepare.bind(store.database)
  const database = Object.assign(store.database, {
    prepare: (query: string) => {
      const statement = prepare(query)
      if (!query.includes('FROM instrument_catalog')) return statement
      const bind = statement.bind.bind(statement)
      return Object.assign(statement, {
        bind: (...values: unknown[]) => {
          attempted.push(...values)
          return bind(...values)
        },
      })
    },
  })
  try {
    // A search is only bought with a browser to bind its answer; these searches fail before any
    // page is read, so the browser never opens one.
    await noteSymbolAttention(
      { BROWSER: unreadableBrowser(), DB: database, EXA_API_KEY: { get: async () => 'exa-key' } },
      call,
    )
  } finally {
    store.close()
  }
  return attempted
}

/** Names the catalog resolves and the watchlist tracks, so naming one claims a paid search. */
function trackedSymbols(symbols: readonly string[]) {
  return async (store: SqliteD1Store) => {
    await persistInstrumentCatalog({ DB: store.database }, instrumentCatalogFromPayload(
      symbols.map((symbol) => ({ active: true, description: symbol, 'instrument-type': 'Equity', symbol })),
      symbols,
    ))
    const now = new Date().toISOString()
    for (const symbol of symbols) {
      await store.database.prepare(
        `INSERT INTO internal_watchlist_items (symbol, instrument_type, origin, created_at, updated_at)
         VALUES (?, 'Equity', 'visitor-search', ?, ?)`,
      ).bind(symbol, now, now).run()
    }
  }
}

/** Every search the provider is asked for fails, which still spends the claim that bought it. */
function failingSearch() {
  const fetchMock = vi.fn(async () => new Response('', { status: 500 }))
  vi.stubGlobal('fetch', fetchMock)
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  return fetchMock
}

describe('symbol attention', () => {
  it('reads the symbols a caller chose to look at', async () => {
    expect(await attemptedSymbols({ symbols: ['nvda', '$hood'] })).toEqual(['NVDA', 'HOOD'])
    expect(await attemptedSymbols({ symbol: 'AAPL' })).toEqual(['AAPL'])
    // A call that names no instrument is not attention on one.
    expect(await attemptedSymbols({})).toEqual([])
    expect(await attemptedSymbols({ symbols: ['not a ticker at all'] })).toEqual([])
  })

  it('reads the underlying an option tool names', async () => {
    expect(await attemptedSymbols({ underlying: 'nvda' })).toEqual(['NVDA'])
    expect(await attemptedSymbols({
      contracts: [
        { underlying: 'AAPL' },
        { underlying: '$aapl' },
        { underlying: 'not a ticker at all' },
        { underlying: 'hood' },
      ],
    })).toEqual(['AAPL', 'HOOD'])
  })

  it('does not treat a free-text symbol search as attention on a symbol', () => {
    // A query is a prefix or a company name as often as a ticker; "APPLE" is not AAPL.
    expect(readsSymbols('search_symbols')).toBe(false)
    expect(readsSymbols('find_option_contracts')).toBe(true)
    expect(readsSymbols('read_option_greeks')).toBe(true)
  })

  it('visits every name while none of them buys a search', async () => {
    // Names the catalog cannot resolve cost nothing, so they do not spend the budget and the
    // names after them are still reached.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const many = Array.from({ length: 40 }, (_, index) => `SYM${index}`)
    expect(await attemptedSymbols({ symbols: many })).toEqual(many)
    expect(warn).not.toHaveBeenCalled()
  })

  it('bounds one call by the searches it buys, not the names it names', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchMock = failingSearch()
    const unknown = ['ZZA', 'ZZB', 'ZZC']
    const tracked = ['TA', 'TB', 'TC', 'TD', 'TE', 'TF', 'TG', 'TH']

    const attempted = await attemptedSymbols({ symbols: [...unknown, ...tracked] }, trackedSymbols(tracked))

    // The unknown names are visited for free; the budget is spent only on the tracked names that
    // claimed a run -- a search that failed was still bought -- and the rest are counted.
    expect(attempted).toEqual([...unknown, ...tracked.slice(0, MAX_ATTENTION_SEARCHES)])
    expect(fetchMock).toHaveBeenCalledTimes(MAX_ATTENTION_SEARCHES)
    expect(warn).toHaveBeenCalledWith('SymbolAttentionSymbolsUnvisited', tracked.length - MAX_ATTENTION_SEARCHES)
  })

  it('does not spend the budget on a name a recent failure is holding back', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const fetchMock = failingSearch()
    const held = ['HA', 'HB', 'HC', 'HD', 'HE', 'HF']
    const fresh = ['FA', 'FB']
    const seedTracked = trackedSymbols([...held, ...fresh])

    const attempted = await attemptedSymbols({ symbols: [...held, ...fresh] }, async (store) => {
      await seedTracked(store)
      // Each held name failed moments ago: its answer is still `failed`, but no claim is spent.
      const failedAt = new Date(Date.now() - CATALYST_FAILED_RETRY_MS / 2).toISOString()
      for (const symbol of held) {
        store.sqlite.prepare(
          `INSERT INTO catalyst_runs (symbol, source_provider, ran_at, catalyst_count, status)
           VALUES (?, 'exa', ?, 0, 'failed')`,
        ).run(symbol, failedAt)
      }
    })

    expect(attempted).toEqual([...held, ...fresh])
    expect(fetchMock).toHaveBeenCalledTimes(fresh.length)
  })

  it('logs nothing when a call stays inside the budget', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)

    const store = await migrationStore()
    await noteSymbolAttention({ DB: store.database }, { symbols: ['NVDA', 'AAPL'] })
    store.close()

    expect(warn).not.toHaveBeenCalled()
  })

  it('does not treat the whole-universe read as attention on every name in it', () => {
    // `read_watchlist` answers with everything; counting that as attention would turn one call
    // into a search per tracked symbol, which is the opposite of following a reader.
    expect(readsSymbols('read_watchlist')).toBe(false)
    expect(readsSymbols('read_catalysts')).toBe(true)
    expect(readsSymbols('read_instrument_quotes')).toBe(true)
  })
})
