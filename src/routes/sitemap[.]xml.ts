import { createFileRoute } from '@tanstack/react-router'

import { SITE_ORIGIN } from '../domain/site'

/** The public, account-free pages a crawler may index. Everything else needs a session. */
const PUBLIC_PAGES = ['/watch', '/disclosures', '/terms', '/privacy'] as const

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: () => new Response(
        `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PUBLIC_PAGES.map((path) => `  <url><loc>${SITE_ORIGIN}${path}</loc></url>`).join('\n')}\n</urlset>\n`,
        { headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'application/xml; charset=utf-8' } },
      ),
    },
  },
})
