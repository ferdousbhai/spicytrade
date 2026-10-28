import { createFileRoute } from '@tanstack/react-router'

import { EquitySymbolSchema } from '../domain/instrument'
import { errorName, toError } from '../domain/failure'
import { jsonNoStore, jsonPublic } from '../server/http'
import { readLatestRecommendation } from '../server/daily-brief-store'
import { appEnv } from '../server/worker-env'

/**
 * An answer changes only when a brief is published, once a market day, and a reader sees the
 * standing brief's own names from the snapshot rather than from here. So it may be kept for an
 * hour by a browser and at the edge, as long as a same-day correction of an older brief may lag.
 */
const RECOMMENDATION_RESPONSE_CACHE_CONTROL = 'public, max-age=3600, s-maxage=3600'

/** The newest recommendation any published brief made for one symbol, with its market date. */
export const Route = createFileRoute('/api/public-symbol-recommendation')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const symbol = EquitySymbolSchema.safeParse(new URL(request.url).searchParams.get('symbol'))
        if (!symbol.success) return jsonNoStore({ error: 'Invalid symbol' }, { status: 400 })
        if (!appEnv.DB) return jsonNoStore({ error: 'Symbol recommendation is unavailable' }, { status: 503 })
        try {
          // The brief already crosses the public snapshot boundary; this exposes one of its
          // validated recommendations and never reads account state.
          return jsonPublic(
            { recommendation: await readLatestRecommendation(appEnv.DB, symbol.data) },
            {},
            RECOMMENDATION_RESPONSE_CACHE_CONTROL,
          )
        } catch (error) {
          console.error('SymbolRecommendationUnavailable', errorName(toError(error)))
          return jsonNoStore({ error: 'Symbol recommendation is temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
