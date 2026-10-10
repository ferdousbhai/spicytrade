import { createFileRoute } from '@tanstack/react-router'

import { YearCandlesSchema } from '../domain/market'
import { errorName, toError } from '../domain/failure'
import { jsonNoStore, jsonPublic } from '../server/http'
import { loadStoredPublicMarketUniverse } from '../server/public-market-universe'
import { appEnv } from '../server/worker-env'
import { readYearCandleSeries } from '../server/year-candle-store'

// The scheduled refresh writes the year once a market day, so the default snapshot freshness
// would spend a request an hour on an answer that cannot have changed. These are a staleness
// budget, not a provider figure: a browser rechecks within a quarter hour and the edge within an
// hour, so the morning's refresh reaches every reader well inside the session it describes.
const YEAR_CANDLES_BROWSER_MAX_AGE_SECONDS = 15 * 60
const YEAR_CANDLES_EDGE_MAX_AGE_SECONDS = 60 * 60

/**
 * The year series on its own, for the one column that draws it. It changes once a day, which
 * is the argument for a separately cached resource rather than for riding the market snapshot
 * a reader refetches on every tab focus — a year of closes for a hundred symbols dwarfs
 * everything else in that payload, and most screens never render the chart at all.
 *
 * Daily closes are not account-derived, so one public response serves every audience. Only
 * the published universe is served, the same source-neutral list the public snapshot reads.
 */
export const Route = createFileRoute('/api/public-year-candles')({
  server: {
    handlers: {
      GET: async () => {
        if (!appEnv.DB) return jsonNoStore({ error: 'Year history is unavailable' }, { status: 503 })
        try {
          const universe = await loadStoredPublicMarketUniverse(appEnv)
          const { asOf, series } = await readYearCandleSeries(appEnv.DB, universe.symbols)
          // The instant is the store's, never the request's: a reader asking when this was
          // refreshed is not asking when they asked.
          return jsonPublic(
            YearCandlesSchema.parse({ asOf, series: [...series].map(([symbol, closes]) => ({ closes, symbol })) }),
            {},
            `public, max-age=${YEAR_CANDLES_BROWSER_MAX_AGE_SECONDS}, s-maxage=${YEAR_CANDLES_EDGE_MAX_AGE_SECONDS}`,
          )
        } catch (error) {
          console.error('YearCandlesUnavailable', errorName(toError(error)))
          return jsonNoStore({ error: 'Year history is temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
