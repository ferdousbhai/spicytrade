/** The product's one public address. */
export const SITE_ORIGIN = 'https://spicy.trade'
/** The domain alone, for mail addresses. It is not the brand. */
const SITE_HOST = new URL(SITE_ORIGIN).host
/**
 * The brand is spicytrade, not the domain: the name every surface shows -- page titles, the
 * sign-in consent screen, the guide an agent reads -- comes from here rather than being typed
 * again. The wordmark draws the second part in the pepper red. The PWA manifest is static JSON and
 * names it separately.
 */
export const WORDMARK = ['spicy', 'trade'] as const
export const SITE_NAME = WORDMARK.join('')
/** The one-sentence description the document head and link previews carry. */
export const SITE_DESCRIPTION = 'Public options intelligence and market research with guarded order placement through your own brokerage credentials.'
/** Where the MCP surface is served, on this origin and no other. */
export const MCP_PATH = '/mcp'
export const MCP_ENDPOINT = `${SITE_ORIGIN}${MCP_PATH}`
/** The guide an agent follows to connect itself, served by `src/routes/connect.guide.ts`. */
export const CONNECT_GUIDE_URL = `${SITE_ORIGIN}/connect/guide`
/** The local agent's installer, served from `public/install.sh`. */
export const INSTALL_SCRIPT_URL = `${SITE_ORIGIN}/install.sh`

/** Where readers write: support, privacy requests, and legal notices, all on the site's own domain. */
export const SUPPORT_EMAIL = `support@${SITE_HOST}`
export const PRIVACY_EMAIL = `privacy@${SITE_HOST}`
export const LEGAL_EMAIL = `legal@${SITE_HOST}`

/** The element the server fills with a plain snapshot reading on `/watch` (`server/watch-summary.ts`). */
export const WATCH_SUMMARY_ID = 'watch-summary'

/** The archive of published daily briefs, one server-rendered page per market date under it. */
export const BRIEF_ARCHIVE_PATH = '/briefs'

/** The brief's book: every open position and the ones it has closed. */
export const POSITIONS_PATH = '/positions'

/** One published brief's own address, keyed by its market date (`YYYY-MM-DD`). */
export function briefPagePath(marketDate: string): string {
  return `${BRIEF_ARCHIVE_PATH}/${marketDate}`
}

/**
 * One symbol's server-rendered page. A share class is written after a slash (`BRK/B`), which a
 * single path segment cannot carry bare, so it travels percent-encoded.
 */
export function symbolPagePath(symbol: string): string {
  return `/options/${encodeURIComponent(symbol)}`
}

/** A page's document title: what the page is, then whose it is. */
export function pageTitle(page: string): string {
  return `${page} | ${SITE_NAME}`
}

/**
 * The application shell's views, named once: each view's own `head` titles it in the browser,
 * and the shell's `head` titles the document the server sends (`routes/_app.tsx` says why the
 * view's own cannot).
 */
const APP_VIEW_NAMES = { '/connect': 'Connect', '/recommendations': 'Recommendations', '/watch': 'Watch' } as const
export type AppViewPath = keyof typeof APP_VIEW_NAMES

export function isAppViewPath(path: string): path is AppViewPath {
  return Object.hasOwn(APP_VIEW_NAMES, path)
}

export function appViewHead(path: AppViewPath) {
  return { meta: [{ title: pageTitle(APP_VIEW_NAMES[path]) }] }
}
