import { createFileRoute } from '@tanstack/react-router'

import { EquitySymbolSchema } from '../domain/instrument'
import { errorName, toError } from '../domain/failure'
import { jsonNoStore } from '../server/http'
import { readUpcomingCatalystsForSymbol } from '../server/catalysts'
import { appEnv } from '../server/worker-env'

// The browser deduplicates these reads on the shared public-read cadence. HTTP caching would
// survive its explicit post-search invalidation and could restore rows the search just retired.
/**
 * Full catalyst rows for one symbol — description and source — for the focused runway.
 * The snapshot only carries the calendar, the same split as year closes vs the year chart.
 */
export const Route = createFileRoute('/api/public-catalysts')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const symbol = new URL(request.url).searchParams.get('symbol')
        const parsed = EquitySymbolSchema.safeParse(symbol)
        if (!parsed.success) return jsonNoStore({ error: 'Unknown symbol' }, { status: 400 })
        if (!appEnv.DB) return jsonNoStore({ error: 'Catalysts are unavailable' }, { status: 503 })
        try {
          const catalysts = await readUpcomingCatalystsForSymbol(appEnv, parsed.data)
          // Already parsed against `CatalystSchema` by the store read.
          return jsonNoStore({ catalysts })
        } catch (error) {
          console.error('PublicCatalystsUnavailable', errorName(toError(error)))
          return jsonNoStore({ error: 'Catalysts are temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
