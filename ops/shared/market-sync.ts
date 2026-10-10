import { type AppEnv } from '../../src/server/env'
import { brokerApi } from '../../src/server/tastytrade'

type OwnerMarketSyncSummary = {
  catalystCount: number
  syncedAt: string
  tickerCount: number
  watchlistItemCount: number
}

/**
 * The owner snapshot the instrument-catalog bootstrap runs after refreshing the catalog. Only
 * counts and the observation time leave the Worker: source watchlist
 * names, membership, and ticker provenance stay private even on an owner-only route, so
 * the run log can never carry them.
 */
export async function summarizeOwnerMarketSync(env: AppEnv): Promise<OwnerMarketSyncSummary> {
  const snapshot = await brokerApi().loadMarketSnapshot(env)
  const [watchlist] = snapshot.watchlists
  // MarketSnapshotSchema pins this array to exactly one entry: the maintained internal
  // watchlist, which the owner snapshot labels private. A public label here would mean this
  // route served the public projection, a broken assumption to surface rather than count.
  if (watchlist.kind !== 'private') throw new Error('OwnerMarketSync:watchlist-not-private')
  return {
    catalystCount: snapshot.catalysts.length,
    syncedAt: snapshot.syncedAt,
    tickerCount: snapshot.tickers.length,
    watchlistItemCount: watchlist.symbols.length,
  }
}
