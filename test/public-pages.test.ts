import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { persistResearchCatalysts } from '../src/server/catalysts'
import { publishDailyBrief } from '../src/server/daily-brief-store'
import { readBriefArchive, readBriefPage, readSymbolPage, readSymbolPageSymbols } from '../src/server/public-pages'
import { sitemapResponse } from '../src/server/sitemap'
import { type AppEnv } from '../src/server/env'
import { persistTastytradeMarketSnapshot } from '../src/server/tastytrade-market-store'
import { unsupportedDatabase } from './fake-d1'
import { dailyBriefFixture } from './fixtures/market'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

const { id: _id, publishedAt: _publishedAt, ...submission } = dailyBriefFixture
const OBSERVED_AT = new Date('2026-08-13T13:31:00.000Z')
const NOW = new Date('2026-08-13T15:00:00.000Z')
const quote = (symbol: string) => ({ previousClose: 200, price: 204.5, providerUpdatedAt: OBSERVED_AT.toISOString(), symbol })

let store: SqliteD1Store
/** Every statement the code under test prepared, so a read path can be held to reads. */
let prepared: string[]
let env: AppEnv

function publishUniverse(symbols: readonly string[]): void {
  store.sqlite.prepare(
    `INSERT OR REPLACE INTO public_market_universe (id, payload_json, updated_at) VALUES ('primary', ?, ?)`,
  ).run(JSON.stringify({ symbols }), OBSERVED_AT.toISOString())
}

/** NVDA and BRK/B are listed and quoted; ZZZQ is listed with no quote; TSLA is quoted but unlisted. */
async function seedMarket(): Promise<void> {
  publishUniverse(['BRK/B', 'NVDA', 'ZZZQ'])
  await persistTastytradeMarketSnapshot(
    { DB: store.database },
    { metrics: [], quotes: [quote('NVDA'), quote('BRK/B'), quote('TSLA')] },
    OBSERVED_AT,
  )
  await persistResearchCatalysts({ DB: store.database }, 'exa', [{
    confidence: 'estimated',
    date: '2026-09-22',
    description: 'Management presents the roadmap.',
    id: 'exa:NVDA:investor-event:2026-09-22',
    kind: 'investor-event',
    source: 'exa',
    sourceUrl: 'https://investor.nvidia.com/events/default.aspx',
    symbol: 'NVDA',
    timing: 'pre-market',
    title: 'NVIDIA investor day',
    updatedAt: OBSERVED_AT.toISOString(),
  }], OBSERVED_AT)
}

const totalChanges = () => store.sqlite.prepare('SELECT total_changes() AS n').get()
/** Row counts of the tables a search, an admission, a refresh claim or a budgeted lookup writes. */
const boughtRows = () => ['catalyst_runs', 'internal_watchlist_items', 'market_refresh_lease', 'public_search_budget']
  .map((table) => store.sqlite.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get())

beforeEach(async () => {
  // The stored read asks the calendar for dates from today on, by the real clock.
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  store = await migrationStore()
  prepared = []
  const database: D1Database = {
    ...unsupportedDatabase(),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => store.database.batch<T>(statements),
    prepare: (sql) => {
      prepared.push(sql)
      return store.database.prepare(sql)
    },
  }
  env = { DB: database }
})

afterEach(() => {
  store.close()
  vi.useRealTimers()
})

describe('symbol page read', () => {
  it('carries the stored ticker, its calendar and the latest recommendation with its market date', async () => {
    await seedMarket()
    await publishDailyBrief(store.database, submission, new Date('2026-08-13T13:35:00.000Z'))

    const page = await readSymbolPage(env, 'NVDA', NOW)
    expect(page?.ticker).toMatchObject({ change: 4.5, price: 204.5, symbol: 'NVDA' })
    expect(page?.syncedAt).toBe(OBSERVED_AT.toISOString())
    expect(page?.catalysts.map((catalyst) => catalyst.id)).toEqual(['exa:NVDA:investor-event:2026-09-22'])
    expect(page?.catalysts[0]?.description).toBe('Management presents the roadmap.')
    expect(page?.recommendation).toEqual({ marketDate: '2026-08-13', recommendation: submission.recommendations[0] })

    const shareClass = await readSymbolPage(env, 'BRK/B', NOW)
    expect(shareClass?.ticker.symbol).toBe('BRK/B')
    expect(shareClass?.catalysts).toEqual([])
    expect(shareClass?.recommendation).toBeNull()
  })

  it('answers null for a symbol the public snapshot does not show', async () => {
    await seedMarket()
    // Quoted in the store, but not on the published list: the store holding it is not the page existing.
    await expect(readSymbolPage(env, 'TSLA', NOW)).resolves.toBeNull()
    // Listed, but the store has no quote: the snapshot leaves it out, so there is no page.
    await expect(readSymbolPage(env, 'ZZZQ', NOW)).resolves.toBeNull()
    await expect(readSymbolPage(env, 'not a symbol', NOW)).rejects.toThrow()
  })

  it('only reads: no write, no provider request, whether the symbol has a page or not', async () => {
    await seedMarket()
    await publishDailyBrief(store.database, submission, new Date('2026-08-13T13:35:00.000Z'))
    const fetchSpy = vi.fn(async () => { throw new Error('a page read must not reach the network') })
    vi.stubGlobal('fetch', fetchSpy)
    const before = totalChanges()
    const bought = boughtRows()

    for (const symbol of ['NVDA', 'BRK/B', 'TSLA', 'ZZZQ', 'AAPL']) await readSymbolPage(env, symbol, NOW)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(totalChanges()).toEqual(before)
    expect(prepared.length).toBeGreaterThan(0)
    for (const sql of prepared) expect(sql.trimStart()).toMatch(/^SELECT\b/)
    // Nothing a crawl could have bought: no search receipt, watchlist row, refresh lease or search budget.
    expect(boughtRows()).toEqual(bought)
  })

  it('throws, rather than answering as a missing page, when the store cannot be read', async () => {
    await expect(readSymbolPage({}, 'NVDA', NOW)).rejects.toThrow('PublicPages:store-unavailable')
    // No published universe at all is an unready store, not a symbol without a page.
    await expect(readSymbolPage(env, 'NVDA', NOW)).rejects.toThrow('PublicMarketUniverse:not-found')
  })
})

describe('brief page reads', () => {
  it('reads one market date with its neighbours and the names that have a symbol page', async () => {
    await seedMarket()
    await publishDailyBrief(store.database, { ...submission, marketDate: '2026-08-12', recommendations: [] }, new Date('2026-08-12T13:35:00.000Z'))
    const brief = await publishDailyBrief(store.database, {
      ...submission,
      recommendations: [
        ...submission.recommendations,
        { direction: 'neutral', symbol: 'TSLA', thesis: 'Unlisted.', trade: 'TSLA 300c' },
        { direction: 'bearish', symbol: 'ZZZQ', thesis: 'Unquoted.', trade: 'ZZZQ 5p' },
      ],
    }, new Date('2026-08-13T13:35:00.000Z'))

    await expect(readBriefPage(env, '2026-08-13')).resolves.toEqual({
      brief,
      newerMarketDate: null,
      olderMarketDate: '2026-08-12',
      symbolsWithPages: ['NVDA'],
    })
    await expect(readBriefPage(env, '2026-08-12')).resolves.toMatchObject({ newerMarketDate: '2026-08-13', olderMarketDate: null, symbolsWithPages: [] })
    await expect(readBriefPage(env, '2026-08-14')).resolves.toBeNull()
    await expect(readBriefPage({}, '2026-08-13')).rejects.toThrow('PublicPages:store-unavailable')
    for (const sql of prepared) expect(sql.trimStart()).toMatch(/^SELECT\b/)
  })

  it('lists every brief newest first with its names', async () => {
    await publishDailyBrief(store.database, { ...submission, marketDate: '2026-08-12', recommendations: [] }, new Date('2026-08-12T13:35:00.000Z'))
    await publishDailyBrief(store.database, submission, new Date('2026-08-13T13:35:00.000Z'))
    await expect(readBriefArchive(env)).resolves.toEqual([
      { marketDate: '2026-08-13', symbols: ['NVDA'] },
      { marketDate: '2026-08-12', symbols: [] },
    ])
  })
})

describe('sitemap', () => {
  it('lists the static pages, every brief page and every symbol the snapshot shows', async () => {
    await seedMarket()
    await publishDailyBrief(store.database, { ...submission, marketDate: '2026-08-12' }, new Date('2026-08-12T13:35:00.000Z'))
    await publishDailyBrief(store.database, submission, new Date('2026-08-13T13:35:00.000Z'))

    await expect(readSymbolPageSymbols(env)).resolves.toEqual(['BRK/B', 'NVDA'])
    const response = await sitemapResponse(env)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/xml; charset=utf-8')
    expect(response.headers.get('Cache-Control')).toBe('public, max-age=3600')
    const locations = [...(await response.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map((match) => match[1])
    expect(locations).toEqual([
      'https://spicy.trade/watch',
      'https://spicy.trade/briefs',
      'https://spicy.trade/positions',
      'https://spicy.trade/disclosures',
      'https://spicy.trade/terms',
      'https://spicy.trade/privacy',
      'https://spicy.trade/briefs/2026-08-13',
      'https://spicy.trade/briefs/2026-08-12',
      'https://spicy.trade/options/BRK%2FB',
      'https://spicy.trade/options/NVDA',
    ])
    for (const sql of prepared) expect(sql.trimStart()).toMatch(/^SELECT\b/)
  })

  it('answers with an uncached error, never a partial sitemap, when a read it depends on fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    // Briefs are readable, but no universe is published: the symbol pages cannot be listed.
    await publishDailyBrief(store.database, submission, new Date('2026-08-13T13:35:00.000Z'))
    const unready = await sitemapResponse(env)
    expect(unready.status).toBe(503)
    expect(unready.headers.get('Cache-Control')).toBe('no-store')
    expect(await unready.text()).not.toContain('<urlset')

    // A universe with nothing quoted is a cold store, likewise not an empty symbol list.
    publishUniverse(['NVDA'])
    expect((await sitemapResponse(env)).status).toBe(503)

    // The symbols are readable, but one stored brief no longer meets the contract.
    await seedMarket()
    store.sqlite.prepare("INSERT INTO daily_briefs (id, published_at, payload_json) VALUES ('brief-2026-08-12', 'x', '{}')").run()
    expect((await sitemapResponse(env)).status).toBe(503)
    expect((await sitemapResponse({})).status).toBe(503)
    expect(error).toHaveBeenCalledWith('SitemapUnavailable', expect.any(String))
  })
})
