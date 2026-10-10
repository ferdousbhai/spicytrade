import { type TSchema, Type } from 'typebox'

import { z } from 'zod'

import { PublicTickerSchema } from '../domain/market'
import { EquitySymbolSchema, ModelTextEquitySymbolType } from '../domain/instrument'
import { type AgentTool } from '../domain/agent-tool'
import { textResult } from './agent-tool-result'
import { type AppEnv } from './env'
import { type BackgroundScheduler, edgeCache, servePublicSnapshot } from './public-snapshot-cache'
import { servePublicSymbolSearch } from './public-symbol-search'
import { MarketMetricsReadParameters, MAX_QUOTE_INSTRUMENTS, SymbolSearchQueryError, SymbolSearchQueryType } from './brokerage-read-contracts'
import { CallerVisibleError } from './caller-visible-error'
import { tickerSymbolsArgument } from './ticker-arguments'

/**
 * The market reads an unauthenticated caller gets.
 *
 * A signed-in caller's quote and metric tools ask the broker on every call, on this Worker's own
 * market credential. Serving those anonymously would put an uncapped per-call cost behind no
 * identity at all -- which is the real reason the surface was gated, even though the same data
 * has always been public through the website.
 *
 * These read the website's own cached snapshot instead, through the same edge cache entry a
 * visitor populates. An anonymous agent therefore costs exactly what an anonymous browser costs
 * and not a request more, so the tier needs no rate limit of its own: the bound is the cache
 * that already exists rather than a number chosen here.
 *
 * The trade is honest and stated on each tool: the tracked universe only, priced as of the last
 * refresh rather than this instant.
 *
 * Each tool takes the signed-in tool's own symbol schema and bound: these share their names and
 * answer the same question, so an agent must not find the anonymous tier accepts a different size
 * or spelling. Quotes take the signed-in quote budget; metrics reuse the signed-in parameters; the
 * search takes the signed-in query schema, which also keeps a query the route would empty out.
 */
const PublicQuoteParameters = Type.Object({
  symbols: Type.Array(ModelTextEquitySymbolType, { maxItems: MAX_QUOTE_INSTRUMENTS, minItems: 1 }),
}, { additionalProperties: false })

/** The shared query schema, advertised so an agent is never offered a query the route would refuse. */
const PublicSearchParameters = Type.Object({ query: SymbolSearchQueryType }, { additionalProperties: false })

/**
 * The public search route answered something other than a match or a clean miss. `status` is
 * this Worker's own public search route's answer, never a provider's.
 */
export class PublicSymbolSearchError extends CallerVisibleError {
  constructor(status: number) {
    super(`Symbol search is unavailable (HTTP ${status}).`)
    this.name = 'PublicSymbolSearchError'
  }
}

/** Quote and metric fields the anonymous tools actually return. The website book also carries
 *  recommendations, catalysts and unused ticker columns; those stay unread here. */
const PublicQuoteTickerSchema = z.object({
  change: z.number(),
  changePercent: z.number(),
  ivIndex: z.number().optional(),
  ivPercentile: z.number().optional(),
  ivRank: z.number().optional(),
  marketCap: z.number().nonnegative().optional(),
  price: z.number(),
  symbol: EquitySymbolSchema,
})

type PublicQuoteTicker = z.infer<typeof PublicQuoteTickerSchema>

const PublicQuoteBookSchema = z.object({
  syncedAt: z.string(),
  tickers: z.array(z.unknown()),
})

type PublicQuoteBook = z.infer<typeof PublicQuoteBookSchema>

/** Whatever the public route answers, read at this boundary rather than passed through blind. */
const SearchResultSchema = z.union([
  z.object({ error: z.string() }),
  z.object({ ticker: PublicTickerSchema, watchlisted: z.boolean().optional() }).passthrough(),
])

/**
 * Pull the requested rows out of the website snapshot without parsing the rest of the book.
 * A malformed requested row still fails closed; a malformed unrequested row is ignored.
 */
export function selectPublicQuoteRows(book: PublicQuoteBook, requested: readonly string[]) {
  // An entry that does not read as a ticker is refused, as the signed-in tools refuse it, rather
  // than passed through as a lookup key that would only ever come back as "not tracked".
  const wanted = new Set(tickerSymbolsArgument(requested))
  const rows: PublicQuoteTicker[] = []
  const found = new Set<string>()
  for (const row of book.tickers) {
    const peeked = z.object({ symbol: z.string() }).safeParse(row)
    if (!peeked.success || !wanted.has(peeked.data.symbol)) continue
    rows.push(PublicQuoteTickerSchema.parse(row))
    found.add(peeked.data.symbol)
  }
  return {
    missing: [...wanted].filter((symbol) => !found.has(symbol)),
    rows,
    syncedAt: book.syncedAt,
  }
}

async function readCachedSnapshot(env: AppEnv, schedule: BackgroundScheduler): Promise<PublicQuoteBook> {
  const origin = requiredOrigin(env)
  // The same URL the website requests, so this shares its cache entry rather than opening a
  // second one that would double the refresh cost it was meant to avoid.
  const response = await servePublicSnapshot(new Request(`${origin}/api/public-snapshot`), env, edgeCache(), schedule)
  if (!response.ok) throw new CallerVisibleError('PublicSnapshotUnavailable')
  return PublicQuoteBookSchema.parse(await response.json())
}

function requiredOrigin(env: AppEnv): string {
  const origin = env.AUTH_BASE_URL
  if (!origin) throw new CallerVisibleError('PublicSnapshotOriginMissing')
  return origin
}

/**
 * A name outside the tracked universe is reported rather than silently dropped: an empty answer
 * would read as "no such symbol" when the truth is "not tracked, and a signed-in caller can ask
 * the broker directly".
 */
function unavailableNote(missing: readonly string[]): string | undefined {
  if (!missing.length) return undefined
  return `not in the tracked universe: ${missing.join(', ')}. A signed-in caller can quote any symbol live.`
}

/** `schedule` runs the snapshot refresh past the tool's answer, exactly as the website's route does. */
export function createPublicMarketReadTools(env: AppEnv, schedule: BackgroundScheduler): AgentTool<TSchema>[] {
  return [
    {
      description: 'Price and daily move for tracked symbols, from the public snapshot refreshed '
        + 'about once a minute. Not a live quote and carries no bid/ask: sign in for those.',
      execute: async (params) => {
        // SAFETY: the MCP server validates every call against this tool's own JSON Schema before
        // dispatch, and `PublicQuoteParameters` requires `symbols` as a non-empty string array.
        const { symbols } = params as { symbols: string[] }
        const { missing, rows, syncedAt } = selectPublicQuoteRows(await readCachedSnapshot(env, schedule), symbols)
        return textResult({
          asOf: syncedAt,
          note: unavailableNote(missing),
          quotes: rows.map((row) => ({
            change: row.change,
            changePercent: row.changePercent,
            price: row.price,
            symbol: row.symbol,
          })),
          source: 'spice-public-snapshot',
        })
      },
      name: 'read_instrument_quotes',
      parameters: PublicQuoteParameters,
    },
    {
      description: 'Implied volatility rank, percentile and index for tracked symbols, from the '
        + 'public snapshot refreshed about once a minute. Sign in for the full broker metrics.',
      execute: async (params) => {
        // SAFETY: the MCP server validates every call against this tool's own JSON Schema before
        // dispatch, and `MarketMetricsReadParameters` requires `symbols` as a non-empty string array.
        const { symbols } = params as { symbols: string[] }
        const { missing, rows, syncedAt } = selectPublicQuoteRows(await readCachedSnapshot(env, schedule), symbols)
        return textResult({
          asOf: syncedAt,
          metrics: rows.map((row) => ({
            ivIndex: row.ivIndex,
            ivPercentile: row.ivPercentile,
            ivRank: row.ivRank,
            marketCap: row.marketCap,
            symbol: row.symbol,
          })),
          note: unavailableNote(missing),
          source: 'spice-public-snapshot',
        })
      },
      name: 'read_market_metrics',
      parameters: MarketMetricsReadParameters,
    },
    {
      // The website's own search, which is edge-cached per query and, when a name resolves,
      // asks to admit it to the tracked universe. So an agent looking something up leaves the
      // site knowing about it -- the visitor who never runs an agent sees the same row
      // afterwards. Admission is not guaranteed: protected rows can fill the list, and the prune
      // that runs in the same write as the admission can evict a searched name at once, just as
      // a later one can, so the description points at `watchlisted`.
      description: 'Resolve a ticker or company name. A name that resolves joins the tracked '
        + 'universe when the list has room, where it may later be displaced by stronger names; '
        + '`watchlisted` in the result says whether it was kept.',
      execute: async (params) => {
        // SAFETY: the MCP server validates every call against this tool's own JSON Schema before
        // dispatch, and `PublicSearchParameters` requires `query` as a non-empty string.
        const { query } = params as { query: string }
        const response = await servePublicSymbolSearch(
          new Request(`${requiredOrigin(env)}/api/public-symbol-search?q=${encodeURIComponent(query)}`),
          env,
          edgeCache(),
        )
        // A 404 is the route's answer that nothing matches, which is a result. A 400 is the route
        // refusing the query itself: the caller's to fix, so it is refused in the signed-in tool's
        // words rather than reported as an outage. Anything else not ok is the lookup failing, and
        // returning its body as an ordinary result would read to the model as a successful search.
        if (response.status === 400) throw new SymbolSearchQueryError()
        if (!response.ok && response.status !== 404) throw new PublicSymbolSearchError(response.status)
        return textResult(SearchResultSchema.parse(await response.json()))
      },
      name: 'search_symbols',
      parameters: PublicSearchParameters,
    },
  ]
}
