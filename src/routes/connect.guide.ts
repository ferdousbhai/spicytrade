import { createFileRoute } from '@tanstack/react-router'

import { connectGuide } from '../server/connect-guide'

export const Route = createFileRoute('/connect/guide')({
  server: {
    handlers: {
      GET: () => new Response(connectGuide(), {
        headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'text/markdown; charset=utf-8' },
      }),
    },
  },
})
