import { createFileRoute } from '@tanstack/react-router'

import { FavoriteMutationSchema } from '../domain/favorites'
import { errorName, toError } from '../domain/failure'
import { mergeFavoriteSymbols, readFavoriteSymbols, removeFavoriteSymbols } from '../server/favorites'
import { authenticateRequest, jsonNoStore } from '../server/http'
import { appEnv } from '../server/worker-env'

export const Route = createFileRoute('/api/favorites')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authenticated = await authenticateRequest(request, appEnv)
        if ('response' in authenticated) return authenticated.response
        if (!appEnv.DB) return jsonNoStore({ error: 'Favorite sync is unavailable' }, { status: 503 })
        try {
          return jsonNoStore({ symbols: await readFavoriteSymbols(appEnv.DB, authenticated.identity.id) })
        } catch (error) {
          console.error('FavoriteReadFailed', errorName(toError(error)))
          return jsonNoStore({ error: 'Favorite sync is temporarily unavailable' }, { status: 503 })
        }
      },
      POST: async ({ request }) => {
        const authenticated = await authenticateRequest(request, appEnv, true)
        if ('response' in authenticated) return authenticated.response
        if (!appEnv.DB) return jsonNoStore({ error: 'Favorite sync is unavailable' }, { status: 503 })
        const parsed = FavoriteMutationSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) return jsonNoStore({ error: 'Invalid favorite change' }, { status: 400 })
        try {
          const symbols = parsed.data.kind === 'merge'
            ? await mergeFavoriteSymbols(appEnv.DB, authenticated.identity.id, parsed.data.symbols)
            : await removeFavoriteSymbols(appEnv.DB, authenticated.identity.id, parsed.data.symbols)
          return jsonNoStore({ symbols })
        } catch (error) {
          console.error('FavoriteMutationFailed', errorName(toError(error)))
          return jsonNoStore({ error: 'Favorite sync is temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
