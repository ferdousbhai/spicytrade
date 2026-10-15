import { PublicMarketSnapshotSchema, type MarketState, type PublicMarketSnapshot } from '../domain/market'
import { PUBLIC_SNAPSHOT_URL } from '../deployment'
import { WATCH_SUMMARY_ID } from '../domain/site'

/**
 * A plain-HTML reading of the public snapshot, written into the `/watch` document on the server.
 *
 * The application shell is client-rendered (see `routes/_app.tsx`), so without this a crawler,
 * a link preview, or a reader without JavaScript receives an empty page. The shell's pending
 * placeholder (`WATCH_SUMMARY_ID`) is filled here; the client app replaces it as soon as it mounts,
 * so this never competes with the live view. Public data only: it reads the same snapshot any
 * anonymous browser fetches from `/api/public-snapshot`, and adds nothing account-derived.
 */

/**
 * The document must not wait on a cold snapshot rebuild. Past this bound the page goes out
 * with an explicit unavailable reading. This is the document latency budget.
 */
export const SUMMARY_TIMEOUT_MS = 1_500

export function isWatchDocument(pathname: string): boolean {
  return pathname === '/watch' || pathname === '/watch/'
}

const escapeHtml = (value: string) => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;')

const price = (value: number) => `$${value.toFixed(2)}`
const percent = (value: number) => `${value > 0 ? '+' : ''}${value.toFixed(2)}%`
const rank = (value: number | undefined) => (value === undefined ? '—' : value.toFixed(1))

const MARKET_STATE_LABELS = {
  open: 'Market open',
  closed: 'Market closed',
  pre: 'Pre-market',
  after: 'After hours',
  unknown: 'Market status unknown',
} as const satisfies Record<MarketState, string>

/** Market state as the snapshot reports it; the summary never infers a session of its own. */
function marketStateLine(snapshot: PublicMarketSnapshot): string {
  const state = MARKET_STATE_LABELS[snapshot.marketState]
  return `${state} · updated <time datetime="${escapeHtml(snapshot.syncedAt)}">${escapeHtml(new Date(snapshot.syncedAt).toUTCString())}</time>`
}

export function renderWatchSummary(snapshot: PublicMarketSnapshot): string {
  const rows = snapshot.tickers.map((ticker) => `<tr><th scope="row">${escapeHtml(ticker.symbol)}</th><td>${escapeHtml(ticker.name)}</td><td>${price(ticker.price)}</td><td>${percent(ticker.changePercent)}</td><td>${rank(ticker.ivRank)}</td></tr>`).join('')
  return `<section class="watch-summary" aria-label="Market snapshot"><h1>Options Watch</h1><p>${marketStateLine(snapshot)}</p><table><thead><tr><th scope="col">Symbol</th><th scope="col">Name</th><th scope="col">Price</th><th scope="col">Change</th><th scope="col">IV rank</th></tr></thead><tbody>${rows}</tbody></table><p>Showing ${snapshot.tickers.length} of ${snapshot.tickers.length} symbols. Data may be delayed. Not investment advice: see <a href="/disclosures">risk disclosures</a>.</p></section>`
}

/** Reads the public snapshot through the Worker's own route, so cache and refresh rules hold. */
export async function readPublicSnapshotForDocument(
  request: Request,
  serve: (snapshotRequest: Request) => Promise<Response>,
): Promise<PublicMarketSnapshot | undefined> {
  const snapshotRequest = new Request(new URL(PUBLIC_SNAPSHOT_URL, request.url))
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<undefined>((resolve) => { timer = setTimeout(resolve, SUMMARY_TIMEOUT_MS, undefined) })
  const read = (async () => {
    const response = await serve(snapshotRequest)
    if (!response.ok) return undefined
    const parsed = PublicMarketSnapshotSchema.safeParse(await response.json())
    return parsed.success ? parsed.data : undefined
  })().catch(() => undefined)
  try {
    return await Promise.race([read, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** Fills the shell's placeholder. Any other document passes through untouched. */
export function injectWatchSummary(response: Response, snapshot: PublicMarketSnapshot | undefined): Response {
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return response
  // Best-effort document enrichment must still tell no-JavaScript readers when its read failed.
  const html = snapshot ? renderWatchSummary(snapshot) : '<section class="watch-summary" aria-label="Market snapshot"><h1>Options Watch</h1><p>Market snapshot is temporarily unavailable. Reload to try again.</p><p>See <a href="/disclosures">risk disclosures</a>.</p></section>'
  return new HTMLRewriter()
    .on(`#${WATCH_SUMMARY_ID}`, { element: (element) => { element.setInnerContent(html, { html: true }) } })
    .transform(response)
}
