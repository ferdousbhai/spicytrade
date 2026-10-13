import { createFileRoute } from '@tanstack/react-router'

import { authorizeTastytrade } from '../server/broker-authorizations'
import { appEnv } from '../server/worker-env'

/**
 * Starts a member's one-click tastytrade connection. Authenticated by a minted agent token, not
 * the session cookie: `spicytrade connect-tastytrade` calls it from the member's terminal.
 */
export const Route = createFileRoute('/api/brokers/tastytrade/authorize')({
  server: {
    handlers: {
      POST: ({ request }) => authorizeTastytrade(request, appEnv),
    },
  },
})
