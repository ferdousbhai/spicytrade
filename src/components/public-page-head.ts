import { type DailyBrief } from '../domain/brief'
import { issuerName, type PublicTicker } from '../domain/market'
import { BRIEF_ARCHIVE_PATH, briefPagePath, pageTitle, SITE_NAME, SITE_ORIGIN, symbolPagePath } from '../domain/site'
import { formatCalendarDay } from './ny-time'

/**
 * The head of a server-rendered public page: its own title and description, the same pair for
 * link previews (overriding the site-wide ones the root sets), and its canonical address on the
 * product's one origin. No figure goes in a title or description: a search result keeps them
 * long after the price or the rank has moved.
 */
function publicPageHead(page: { description: string; path: string; title: string }) {
  const title = pageTitle(page.title)
  const address = `${SITE_ORIGIN}${page.path}`
  return {
    links: [{ rel: 'canonical', href: address }],
    meta: [
      { title },
      { name: 'description', content: page.description },
      { property: 'og:title', content: title },
      { property: 'og:description', content: page.description },
      { property: 'og:url', content: address },
      { name: 'twitter:title', content: title },
      { name: 'twitter:description', content: page.description },
    ],
  }
}

export function symbolPageHead(ticker: Pick<PublicTicker, 'name' | 'symbol'>) {
  return publicPageHead({
    description: `${issuerName(ticker.name)} (${ticker.symbol}) options: IV rank, IV percentile, implied and historical volatility, liquidity, and upcoming catalysts on ${SITE_NAME}.`,
    path: symbolPagePath(ticker.symbol),
    title: `${ticker.symbol} options: IV rank, implied volatility and catalysts`,
  })
}

/** The names a brief argued, as a phrase: `NVDA`, `NVDA and AAPL`, `NVDA, AAPL and TSLA`. */
function namesPhrase(symbols: readonly string[]): string {
  if (symbols.length <= 1) return symbols.join('')
  return `${symbols.slice(0, -1).join(', ')} and ${symbols[symbols.length - 1]}`
}

export function briefPageHead(brief: Pick<DailyBrief, 'marketDate' | 'recommendations'>) {
  const day = formatCalendarDay(brief.marketDate)
  const symbols = brief.recommendations.map((recommendation) => recommendation.symbol)
  return publicPageHead({
    description: symbols.length
      ? `The ${SITE_NAME} daily options brief for ${day}: a trade line and thesis for ${namesPhrase(symbols)}, with the morning's headlines.`
      : `The ${SITE_NAME} daily options brief for ${day}: no trades, with the morning's headlines.`,
    path: briefPagePath(brief.marketDate),
    title: symbols.length ? `Options brief for ${day}: ${symbols.join(', ')}` : `Options brief for ${day}`,
  })
}

export function briefArchiveHead() {
  return publicPageHead({
    description: `Every ${SITE_NAME} daily options brief by market date, newest first, with the names each one argued.`,
    path: BRIEF_ARCHIVE_PATH,
    title: 'Daily options briefs',
  })
}
