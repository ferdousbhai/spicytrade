import { errorName, toError } from '../domain/failure'
import { BRIEF_ARCHIVE_PATH, briefPagePath, SITE_ORIGIN, symbolPagePath } from '../domain/site'
import { type AppEnv } from './env'
import { readBriefArchive, readSymbolPageSymbols } from './public-pages'

/**
 * The public, account-free pages a crawler may index that exist whatever the store holds.
 * `/recommendations` is left out on purpose: it is the client-rendered view of the same briefs,
 * and each brief's own server-rendered page under `/briefs` is the address to index.
 */
const STATIC_PUBLIC_PAGES = ['/watch', BRIEF_ARCHIVE_PATH, '/disclosures', '/terms', '/privacy'] as const

/**
 * How long a client may reuse the sitemap. Building it reads the whole stored snapshot and every
 * brief, and what it lists changes when a brief is published -- once a market day -- or a symbol
 * joins or leaves the public list. An hour bounds how late a new page is announced here, and
 * that page is already linked from `/briefs` or the `/watch` table in the meantime.
 */
const SITEMAP_MAX_AGE_SECONDS = 60 * 60

const escapeXml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&apos;')

export function renderSitemap(paths: readonly string[]): string {
  const urls = paths.map((path) => `  <url><loc>${escapeXml(`${SITE_ORIGIN}${path}`)}</loc></url>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`
}

/**
 * The static pages, then every brief page, then every symbol page. Whole or not at all: a
 * sitemap missing its briefs or its symbols reads to a crawler as those pages being gone, so a
 * failed read answers with an error status -- which a crawler retries -- and is never cached.
 */
export async function sitemapResponse(env: AppEnv): Promise<Response> {
  try {
    const [briefs, symbols] = await Promise.all([readBriefArchive(env), readSymbolPageSymbols(env)])
    return new Response(renderSitemap([
      ...STATIC_PUBLIC_PAGES,
      ...briefs.map((brief) => briefPagePath(brief.marketDate)),
      ...symbols.map(symbolPagePath),
    ]), {
      headers: {
        'Cache-Control': `public, max-age=${SITEMAP_MAX_AGE_SECONDS}`,
        'Content-Type': 'application/xml; charset=utf-8',
      },
    })
  } catch (error) {
    console.error('SitemapUnavailable', errorName(toError(error)))
    return new Response('Sitemap is temporarily unavailable\n', {
      headers: { 'Cache-Control': 'no-store', 'Content-Type': 'text/plain; charset=utf-8' },
      status: 503,
    })
  }
}
