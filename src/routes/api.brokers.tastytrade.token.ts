import { createFileRoute } from '@tanstack/react-router'

import { tastytradeAccessToken } from '../server/broker-authorizations'
import { appEnv } from '../server/worker-env'

/** Mints `spicytrade mcp`'s 15-minute access token from the member's refresh token. */
export const Route = createFileRoute('/api/brokers/tastytrade/token')({
  server: {
    handlers: {
      POST: ({ request }) => tastytradeAccessToken(request, appEnv),
    },
  },
})
