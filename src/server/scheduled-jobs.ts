import { marketDate } from '../domain/catalyst'
import { isCashOpenMinute } from '../domain/market'
import { type AppEnv } from './env'
import { MARKET_FEED_INSTANCE, MAX_DAILY_CANDLE_SYMBOLS } from './market-feed-contracts'
import { loadStoredPublicMarketUniverse } from './public-market-universe'
import { ConfigurationError } from './secrets'
import { readStoredMarketRecords } from './tastytrade-market-store'
import { replaceYearCandles } from './year-candle-store'

/**
 * What one tick's year refresh did. The off-hour fire is its own outcome rather than a count of
 * zero, because a refresh that ran and stored nothing -- an empty focus, a feed that answered for
 * no symbol -- is worth noticing, and a skip that logs the same line would hide it every day.
 */
type YearCandleRefresh =
  | { status: 'refreshed'; symbolCount: number }
  | { reason: 'not-cash-open'; status: 'skipped' }

/** The tick's log line for a refresh: an event name and a count, never symbols or content. */
export function yearCandleRefreshEvent(refresh: YearCandleRefresh) {
  return refresh.status === 'skipped'
    ? { event: 'YearCandlesRefreshSkipped', reason: refresh.reason }
    : { event: 'YearCandlesRefreshed', symbolCount: refresh.symbolCount }
}

/**
 * Refresh the cached year of daily closes. A daily bar changes once a session, so this runs on
 * the schedule rather than on the live feed, and the read path serves whatever was last stored.
 * Returning the count keeps the caller's log honest about a partial refresh.
 */
export async function refreshYearCandles(env: AppEnv, asOf = new Date()): Promise<YearCandleRefresh> {
  // The trigger fires at 13:30 and 14:30 UTC so one of them is 09:30 Eastern in either DST
  // offset. The off-season fire is a no-op rather than a second DXLink subscription. Its skip
  // reason names the minute, not the session: at 10:30 Eastern the market is open.
  if (!isCashOpenMinute(asOf)) return { reason: 'not-cash-open', status: 'skipped' }
  // A missing binding is a misconfiguration, not a refresh of nothing: throw its name so the
  // tick's failure log says which one, rather than logging a count of zero that reads as success.
  if (!env.DB) throw new ConfigurationError('BindingMissing', 'DB')
  if (!env.MARKET_FEED) throw new ConfigurationError('BindingMissing', 'MARKET_FEED')
  const symbols = await yearCandleSymbols(env)
  if (!symbols.length) return { status: 'refreshed', symbolCount: 0 }
  const result = await env.MARKET_FEED.getByName(MARKET_FEED_INSTANCE).readDailyCandles(symbols)
  const series = new Map(result.series.map(({ symbol, closes }) => [symbol, closes]))
  await replaceYearCandles(env.DB, marketDate(asOf), symbols, series)
  // The count is what was stored: a series that arrived empty retires its row rather than
  // refreshing it, so it is not a refreshed symbol.
  const symbolCount = result.series.filter(({ closes }) => closes.length > 0).length
  return { status: 'refreshed', symbolCount }
}

/**
 * The names one year read covers. The published universe can hold up to `MAX_WATCHLIST_SYMBOLS`,
 * but one read admits only `MAX_DAILY_CANDLE_SYMBOLS`; asking for the whole list refused the
 * refresh the moment the list -- which grows on its own through visitor search -- outgrew the
 * read. Which names get a year series is public (the replace retires every other row), so the
 * budget is chosen only from what a reader already sees: the published universe, ordered by the
 * stored snapshot volume, most first, with ties and a missing volume falling back to the
 * alphabet. Taking the head of the private ranking instead published which names the owner
 * added, a trade touched, or a private broker list carried.
 */
async function yearCandleSymbols(env: AppEnv): Promise<string[]> {
  const { symbols } = await loadStoredPublicMarketUniverse(env)
  const { quotes } = await readStoredMarketRecords(env, symbols)
  const volume = (symbol: string) => quotes.get(symbol)?.volume ?? -1
  return [...symbols]
    .sort((left, right) => volume(right) - volume(left) || (left < right ? -1 : left > right ? 1 : 0))
    .slice(0, MAX_DAILY_CANDLE_SYMBOLS)
}
