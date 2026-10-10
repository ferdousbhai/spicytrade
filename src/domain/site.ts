/** The product's one public address. */
const SITE_ORIGIN = 'https://spicy.trade'
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
/** Where the MCP surface is served, on this origin and no other. */
export const MCP_PATH = '/mcp'
export const MCP_ENDPOINT = `${SITE_ORIGIN}${MCP_PATH}`

/** Where readers write: support, privacy requests, and legal notices, all on the site's own domain. */
export const SUPPORT_EMAIL = `support@${SITE_HOST}`
export const PRIVACY_EMAIL = `privacy@${SITE_HOST}`
export const LEGAL_EMAIL = `legal@${SITE_HOST}`

/** A page's document title: what the page is, then whose it is. */
export function pageTitle(page: string): string {
  return `${page} | ${SITE_NAME}`
}
