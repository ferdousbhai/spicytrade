import { createFileRoute } from '@tanstack/react-router'

import { edgeCache } from '../server/public-snapshot-cache'
import { servePublicSymbolSearch } from '../server/public-symbol-search'
import { appEnv } from '../server/worker-env'

export const Route = createFileRoute('/api/public-symbol-search')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        return servePublicSymbolSearch(request, appEnv, edgeCache())
      },
    },
  },
})
