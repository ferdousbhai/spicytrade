import { createFileRoute } from '@tanstack/react-router'

import { llmsTxt } from '../server/llms-txt'

// A route rather than a file in `public/`, so it is built from the constants the app itself uses.
// It changes only with a deploy, like `install.sh`, so a cached copy is never worth a stale one.
export const Route = createFileRoute('/llms.txt')({
  server: {
    handlers: {
      GET: () => new Response(llmsTxt(), {
        headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'text/markdown; charset=utf-8' },
      }),
    },
  },
})
