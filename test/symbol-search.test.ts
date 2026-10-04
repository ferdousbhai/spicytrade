import { afterEach, describe, expect, it, vi } from 'vitest'

import { migrationStore, seededItems, seedWatchlist, type SqliteD1Store } from './sqlite-d1'
import {
  instrumentCatalogFromPayload,
  persistInstrumentCatalog,
  unresolvedInstrumentCatalogItem,
} from '../src/server/instrument-catalog'
import { stubBrokerGate } from './broker-stub'
import { searchInstrumentCatalog, searchableQuery, symbolCandidate } from '../src/server/symbol-search'
import { readInternalWatchlist } from '../src/server/internal-watchlist'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.resetModules()
})

async function seedCatalog(
  env: { DB: D1Database },
  rows: readonly { active?: boolean; description: string; resolved?: boolean; symbol: string }[],
): Promise<void> {
  await persistInstrumentCatalog(env, rows.flatMap((row) => row.resolved === false
    ? [unresolvedInstrumentCatalogItem(row.symbol)]
    : instrumentCatalogFromPayload([{
        active: row.active ?? true,
        description: row.description,
        'instrument-type': 'Equity',
        symbol: row.symbol,
      }], [row.symbol])))
}

describe('symbol search query shape', () => {
  it('reads a ticker out of a cashtag or any letter case, and nothing out of a name', () => {
    expect(symbolCandidate('sofi')).toBe('SOFI')
    expect(symbolCandidate(' $brk/b ')).toBe('BRK/B')
    expect(symbolCandidate('SoFi Technologies')).toBeUndefined()
  })

  it('refuses an empty or oversized search and neutralizes LIKE wildcards', () => {
    expect(searchableQuery('   ')).toBeUndefined()
    expect(searchableQuery('a'.repeat(49))).toBeUndefined()
    expect(searchableQuery('  bloom   energy ')).toBe('BLOOM ENERGY')
    expect(searchableQuery('%_%')).toBeUndefined()
    expect(searchableQuery('blo%om')).toBe('BLO OM')
  })
})

describe('instrument catalog fallback search', () => {
  it('ranks an exact ticker over a prefix, and a name match under both', async () => {
    const store = await migrationStore()
    const env = { DB: store.database }
    await seedCatalog(env, [
      { description: 'Bloom Energy Corporation', symbol: 'BE' },
      { description: 'Beam Therapeutics', symbol: 'BEAM' },
      { description: 'ProShares UltraPro QQQ', symbol: 'TQQQ' },
      { description: 'Blossom Industries', symbol: 'BLOM' },
    ])

    await expect(searchInstrumentCatalog(env, 'be')).resolves.toEqual([
      { name: 'Bloom Energy Corporation', symbol: 'BE' },
      { name: 'Beam Therapeutics', symbol: 'BEAM' },
    ])
    await expect(searchInstrumentCatalog(env, 'bloom energy')).resolves.toEqual([
      { name: 'Bloom Energy Corporation', symbol: 'BE' },
    ])
    await expect(searchInstrumentCatalog(env, 'ultrapro')).resolves.toEqual([
      { name: 'ProShares UltraPro QQQ', symbol: 'TQQQ' },
    ])
    store.close()
  })

  it('answers a full-length search with accented letters instead of failing D1\'s pattern limit', async () => {
    const store = await migrationStore()
    const env = { DB: store.database }
    // 48 characters, the most a search may have, but over 48 bytes once accents are UTF-8.
    const longest = 'Soci\u00e9t\u00e9 G\u00e9n\u00e9rale '.padEnd(48, 'x')
    await expect(searchInstrumentCatalog(env, longest)).resolves.toEqual([])
    store.close()
  })

  it('never answers with an unresolved or inactive instrument', async () => {
    const store = await migrationStore()
    const env = { DB: store.database }
    await seedCatalog(env, [
      { active: false, description: 'Delisted Industries', symbol: 'DEAD' },
      { description: 'Unknown Holdings', resolved: false, symbol: 'HUH' },
    ])

    await expect(searchInstrumentCatalog(env, 'DEAD')).resolves.toEqual([])
    await expect(searchInstrumentCatalog(env, 'HUH')).resolves.toEqual([])
    store.close()
  })
})

describe('public symbol lookup', () => {
  async function seededStore(): Promise<SqliteD1Store> {
    const store = await migrationStore()
    seedWatchlist(store, seededItems(['NVDA']))
    return store
  }

  /** `quoted: false` resolves every instrument but has the provider quote none of them. */
  function marketFetch({ quoted = true } = {}): ReturnType<typeof vi.fn> {
    return vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/oauth/token')) {
        return Response.json({ access_token: 'public-read-token', expires_in: 900 })
      }
      if (url.pathname.endsWith('/instruments/equities')) {
        return Response.json({ data: { items: url.searchParams.getAll('symbol[]')
          .filter((symbol) => symbol !== 'NOPE')
          .map((symbol) => ({
            active: true, description: `${symbol} Corporation`, 'instrument-type': 'Equity', symbol,
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
        if (!quoted) return Response.json({ data: { items: [] } })
        return Response.json({ data: { items: url.searchParams.getAll('equity').map((symbol) => ({
          symbol, mark: '100', 'previous-close': '98', description: symbol,
          'updated-at': '2026-08-26T13:31:00.000Z',
        })) } })
      }
      return new Response('', { status: 404 })
    })
  }

  it('resolves an unlisted ticker against the broker and admits it to the maintained list', async () => {
    const store = await seededStore()
    vi.stubGlobal('fetch', marketFetch())
    const { brokerApi } = await import('../src/server/tastytrade')
    const secret: SecretsStoreSecret = { get: async () => 'secret' }
    const env = {
      BROKER_GATE: stubBrokerGate().namespace,
      DB: store.database,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    }

    await seedCatalog(env, [{ symbol: 'TQQQX', description: 'TQQQ Fund' }])
    await expect(brokerApi().lookupStoredMarketSymbol(env, 'TQQQ')).resolves.toBeUndefined()
    const lookup = await brokerApi().lookupPublicMarketSymbol(env, 'TQQQ')

    expect(lookup?.ticker).toMatchObject({ name: 'TQQQ Corporation', price: 100, symbol: 'TQQQ' })
    expect(lookup?.watchlisted).toBe(true)
    // A reader's lookup is recorded as exactly that, so it can never outrank a researched name.
    const items = await readInternalWatchlist(env)
    expect(items.find((item) => item.symbol === 'TQQQ')?.origin).toBe('visitor-search')
    expect(JSON.parse(String(store.sqlite.prepare(
      `SELECT payload_json FROM public_market_universe WHERE id = 'primary'`,
    ).get()?.payload_json)).symbols).toContain('TQQQ')
    store.close()
  })

  it('does not admit a catalog prefix when the exact ticker is missing at the broker', async () => {
    const store = await seededStore()
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input))
      if (url.pathname.endsWith('/oauth/token')) {
        return Response.json({ access_token: 'public-read-token', expires_in: 900 })
      }
      if (url.pathname.endsWith('/instruments/equities')) {
        return Response.json({ data: { items: [] } })
      }
      return new Response('', { status: 404 })
    }))
    const { brokerApi } = await import('../src/server/tastytrade')
    const secret: SecretsStoreSecret = { get: async () => 'secret' }
    const env = {
      BROKER_GATE: stubBrokerGate().namespace,
      DB: store.database,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    }

    await seedCatalog(env, [{ symbol: 'TQQQX', description: 'TQQQ Fund' }])
    await expect(brokerApi().lookupPublicMarketSymbol(env, 'TQQQ')).resolves.toBeUndefined()
    const items = await readInternalWatchlist(env)
    expect(items.some((item) => item.symbol === 'TQQQ' || item.symbol === 'TQQQX')).toBe(false)
    store.close()
  })

  it('answers nothing for a symbol the broker does not know, and adds nothing', async () => {
    const store = await seededStore()
    vi.stubGlobal('fetch', marketFetch())
    const { brokerApi } = await import('../src/server/tastytrade')
    const secret: SecretsStoreSecret = { get: async () => 'secret' }
    const env = {
      BROKER_GATE: stubBrokerGate().namespace,
      DB: store.database,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    }

    await expect(brokerApi().lookupPublicMarketSymbol(env, 'NOPE')).resolves.toBeUndefined()
    await expect(brokerApi().lookupPublicMarketSymbol(env, 'not a ticker at all')).resolves.toBeUndefined()
    expect((await readInternalWatchlist(env)).some((item) => item.symbol === 'NOPE')).toBe(false)
    store.close()
  })

  it('answers not found for a resolved symbol with no quote, and adds nothing', async () => {
    const store = await seededStore()
    // The instrument resolves, but the provider quotes nothing for it.
    vi.stubGlobal('fetch', marketFetch({ quoted: false }))
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { brokerApi } = await import('../src/server/tastytrade')
    const secret: SecretsStoreSecret = { get: async () => 'secret' }
    const env = {
      BROKER_GATE: stubBrokerGate().namespace,
      DB: store.database,
      TASTYTRADE_CLIENT_SECRET: secret,
      TASTYTRADE_REFRESH_TOKEN: secret,
    }

    await expect(brokerApi().lookupPublicMarketSymbol(env, 'TQQQ')).resolves.toBeUndefined()
    expect((await readInternalWatchlist(env)).some((item) => item.symbol === 'TQQQ')).toBe(false)
    store.close()
  })
})
