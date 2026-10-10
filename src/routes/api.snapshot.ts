import { createFileRoute } from '@tanstack/react-router'

import { appEnv } from '../server/worker-env'
import { authorizePersonalRequest, jsonNoStore, jsonPrivateRevalidate } from '../server/http'
import { snapshotEtag } from '../server/public-snapshot-cache'
import { brokerApi } from '../server/tastytrade'
import { errorName, toError } from '../domain/failure'

/**
 * The owner reads the same stored snapshot every visitor does, so an ordinary page load costs
 * the provider nothing. `?live=1` is the explicit escape hatch that rebuilds from tastytrade,
 * and it also refreshes the store for everyone behind it.
 */
export const Route = createFileRoute('/api/snapshot')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const unauthorized = await authorizePersonalRequest(request, appEnv)
        if (unauthorized) return unauthorized
        const live = new URL(request.url).searchParams.get('live') === '1'
        try {
          const snapshot = (live ? undefined : await brokerApi().loadStoredMarketSnapshot(appEnv))
            ?? await brokerApi().loadMarketSnapshot(appEnv)
          return jsonPrivateRevalidate(
            request,
            snapshot,
            snapshotEtag(snapshot),
          )
        } catch (error) {
          console.error('MarketSnapshotUnavailable', errorName(toError(error)))
          return jsonNoStore({ error: 'Market sync is temporarily unavailable' }, { status: 502 })
        }
      },
    },
  },
})
