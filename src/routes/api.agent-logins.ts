import { createFileRoute } from '@tanstack/react-router'

import { approveAgentLogin, signOutAgentLogin } from '../server/agent-logins'
import { appEnv } from '../server/worker-env'

/**
 * The member's approval of a terminal sign-in, posted by `/connect/agent`. Authenticated by the
 * session cookie and same-origin only: approving is what the page's button does, never a link.
 * DELETE is a computer signing itself out with its own bearer token (`spicytrade uninstall`).
 */
export const Route = createFileRoute('/api/agent-logins')({
  server: {
    handlers: {
      DELETE: ({ request }) => signOutAgentLogin(request, appEnv),
      POST: ({ request }) => approveAgentLogin(request, appEnv),
    },
  },
})
