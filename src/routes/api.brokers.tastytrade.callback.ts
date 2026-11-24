import { createFileRoute } from '@tanstack/react-router'

import { tastytradeCallback } from '../server/broker-authorizations'
import { appEnv } from '../server/worker-env'

/**
 * tastytrade's redirect URI. Unauthenticated by necessity; it records the return for the CLI
 * that is polling for it (see `tastytradeCallback`).
 */
export const Route = createFileRoute('/api/brokers/tastytrade/callback')({
  server: {
    handlers: {
      GET: ({ request }) => tastytradeCallback(request, appEnv),
    },
  },
})
