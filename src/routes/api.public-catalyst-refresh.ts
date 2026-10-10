import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { CatalystRefreshSchema } from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { errorName, toError } from '../domain/failure'
import { refreshCatalystsForSymbol } from '../server/catalyst-refresh'
import { authorizePersonalRequest, jsonNoStore } from '../server/http'
import { appEnv } from '../server/worker-env'

const RefreshRequestSchema = z.strictObject({
  force: z.boolean().optional(),
  symbol: EquitySymbolSchema,
})

/**
 * Reader attention is what keeps catalyst coverage seeded: a favorite from anyone, signed in
 * or not, and a look at a symbol whose next month is empty. The window that decides whether a
 * search is actually bought lives on the server, so this route is safe to call on every one.
 *
 * Spending a search the window would have refused is the owner's alone: it costs money per
 * call, and incidental attention must stay bounded however many readers arrive.
 */
export const Route = createFileRoute('/api/public-catalyst-refresh')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const parsed = RefreshRequestSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) return jsonNoStore({ error: 'Name one symbol' }, { status: 400 })
        if (!appEnv.DB) return jsonNoStore({ error: 'Catalyst research is unavailable' }, { status: 503 })
        if (parsed.data.force) {
          const unauthorized = await authorizePersonalRequest(request, appEnv, true)
          if (unauthorized) return unauthorized
        }
        try {
          const refresh = await refreshCatalystsForSymbol(
            appEnv,
            parsed.data.symbol,
            new Date(),
            parsed.data.force ?? false,
          )
          return jsonNoStore(CatalystRefreshSchema.parse(refresh))
        } catch (error) {
          console.error('CatalystRefreshUnavailable', errorName(toError(error)))
          return jsonNoStore({ error: 'Catalyst research is temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
