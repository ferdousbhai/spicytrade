import { upcomingCatalystsForSymbol } from '../domain/catalyst'
import { type BriefArchiveEntry, type BriefPageData, type SymbolPageData } from '../domain/public-page'
import { CallerVisibleError } from './caller-visible-error'
import { listDailyBriefs, readAdjacentBriefDates, readDailyBriefOn, readLatestRecommendation } from './daily-brief-store'
import { type AppEnv } from './env'
import { loadStoredPublicMarketUniverse } from './public-market-universe'
import { brokerApi, loadStoredPublicSymbol } from './tastytrade'
import { readStoredMarketRecords } from './tastytrade-market-store'

/*
 * What the server-rendered public pages read. Every function here is a read over rows already
 * stored: no provider request, no catalyst search, no watchlist admission, no attention receipt,
 * no refresh lease. Crawlers request every one of these pages, and reader attention -- not a
 * crawl -- is what buys a search, so nothing reachable from here may write or spend.
 *
 * Absence (`null`) is a page that does not exist and is answered 404 by its route; a store that
 * cannot be read throws, so an outage is never served as a missing page.
 */

function database(env: AppEnv): D1Database {
  if (!env.DB) throw new CallerVisibleError('PublicPages:store-unavailable')
  return env.DB
}

/** One symbol on the public snapshot, or `null` for a symbol that snapshot does not show. */
export async function readSymbolPage(env: AppEnv, symbol: string, now = new Date()): Promise<SymbolPageData | null> {
  const db = database(env)
  const stored = await loadStoredPublicSymbol(env, symbol)
  if (!stored) return null
  return {
    // The store keeps one row per producer; a reader is shown one row per event.
    catalysts: upcomingCatalystsForSymbol(stored.ticker.symbol, stored.catalysts, now),
    marketState: stored.marketState,
    recommendation: await readLatestRecommendation(db, stored.ticker.symbol),
    syncedAt: stored.syncedAt,
    ticker: stored.ticker,
  }
}

/** The brief published for one market date with its archive neighbours, or `null` for none. */
export async function readBriefPage(env: AppEnv, marketDate: string): Promise<BriefPageData | null> {
  const db = database(env)
  const [brief, adjacent] = await Promise.all([readDailyBriefOn(db, marketDate), readAdjacentBriefDates(db, marketDate)])
  if (!brief) return null
  return {
    brief,
    newerMarketDate: adjacent.newer,
    olderMarketDate: adjacent.older,
    symbolsWithPages: await symbolsWithPages(env, brief.recommendations.map((recommendation) => recommendation.symbol)),
  }
}

/**
 * Which of these symbols the stored public snapshot shows -- listed in the published universe
 * and holding a stored quote, the same two conditions `loadStoredPublicSymbol` answers a page on.
 */
async function symbolsWithPages(env: AppEnv, symbols: readonly string[]): Promise<string[]> {
  if (!symbols.length) return []
  const universe = new Set((await loadStoredPublicMarketUniverse(env)).symbols)
  const listed = [...new Set(symbols)].filter((symbol) => universe.has(symbol))
  if (!listed.length) return []
  const { quotes } = await readStoredMarketRecords(env, listed)
  return listed.filter((symbol) => quotes.has(symbol))
}

/** Every published brief's market date and names, newest first. */
export async function readBriefArchive(env: AppEnv): Promise<BriefArchiveEntry[]> {
  return (await listDailyBriefs(database(env))).map((brief) => ({
    marketDate: brief.marketDate,
    symbols: brief.recommendations.map((recommendation) => recommendation.symbol),
  }))
}

/**
 * The symbols that have a page: exactly the tickers of the stored public snapshot, in its own
 * (alphabetical, source-neutral) order. A cold store throws rather than answering with an empty
 * list, so the sitemap built from this cannot go out without its symbol pages.
 */
export async function readSymbolPageSymbols(env: AppEnv): Promise<string[]> {
  const stored = await brokerApi().loadStoredPublicMarketSnapshot(env)
  if (!stored) throw new CallerVisibleError('PublicPages:snapshot-unavailable')
  return stored.snapshot.tickers.map((ticker) => ticker.symbol)
}
