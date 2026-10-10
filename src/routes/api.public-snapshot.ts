import { createFileRoute } from '@tanstack/react-router'
import { waitUntil } from 'cloudflare:workers'

import { edgeCache, servePublicSnapshot } from '../server/public-snapshot-cache'
import { appEnv } from '../server/worker-env'

export const Route = createFileRoute('/api/public-snapshot')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        // The refresh runs past the response, so the reader never waits on it.
        return servePublicSnapshot(request, appEnv, edgeCache(), waitUntil)
      },
    },
  },
})
