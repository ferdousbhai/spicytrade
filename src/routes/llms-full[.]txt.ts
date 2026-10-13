import { createFileRoute } from '@tanstack/react-router'

import { llmsFullTxt } from '../server/llms-txt'

export const Route = createFileRoute('/llms-full.txt')({
  server: {
    handlers: {
      GET: () => new Response(llmsFullTxt(), {
        headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'text/markdown; charset=utf-8' },
      }),
    },
  },
})
