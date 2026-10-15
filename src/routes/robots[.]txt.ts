import { createFileRoute } from '@tanstack/react-router'

import { SITE_ORIGIN } from '../domain/site'

// API routes carry no page a crawler should index; the sitemap names the pages that do.
export const Route = createFileRoute('/robots.txt')({
  server: {
    handlers: {
      GET: () => new Response(
        `User-agent: *\nDisallow: /api/\nDisallow: /authorize\n\nSitemap: ${SITE_ORIGIN}/sitemap.xml\n`,
        { headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'text/plain; charset=utf-8' } },
      ),
    },
  },
})
