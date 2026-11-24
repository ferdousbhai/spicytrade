import { createFileRoute } from '@tanstack/react-router'

import { exchangeTastytrade } from '../server/broker-authorizations'
import { appEnv } from '../server/worker-env'

/** The CLI collecting an approved connection's refresh token, once, with its agent token and verifier. */
export const Route = createFileRoute('/api/brokers/tastytrade/exchange')({
  server: {
    handlers: {
      POST: ({ request }) => exchangeTastytrade(request, appEnv),
    },
  },
})
