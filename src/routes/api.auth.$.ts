import { createFileRoute } from '@tanstack/react-router'

import { getAuthRuntime } from '../server/auth'
import { jsonNoStore } from '../server/http'
import { appEnv } from '../server/worker-env'
import { errorName, toError } from '../domain/failure'

async function handleAuth(request: Request) {
  try {
    const { auth } = await getAuthRuntime(appEnv)
    // Awaited, not returned bare: a returned promise is adopted after the try/catch frame is
    // left, so a rejection from the handler would miss this catch and its 503 entirely.
    return await auth.handler(request)
  } catch (error) {
    console.error('AuthUnavailable', errorName(toError(error)))
    return jsonNoStore({ error: 'Authentication is temporarily unavailable' }, { status: 503 })
  }
}

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: {
      GET: ({ request }) => handleAuth(request),
      POST: ({ request }) => handleAuth(request),
    },
  },
})
