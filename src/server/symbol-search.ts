import { z } from 'zod'

import { EQUITY_SYMBOL_REGEX, EquitySymbolSchema } from '../domain/instrument'
import { type AppEnv } from './env'
import { CallerVisibleError } from './caller-visible-error'

/**
 * The watchlist is what the market screen loads, and it is never the whole market. A
 * reader who types a name it does not carry is asking about a real instrument, so the
 * search falls through to the instrument catalog — the resolved tastytrade equities
 * this Worker already stores — and the caller admits the match onto the list.
 *
 * Only the catalog answers here. A symbol the catalog has never heard of is resolved
 * against the broker by the caller, so this module stays a pure read.
 */
export type SymbolSearchMatch = {
  name: string
  symbol: string
}

/** Long enough for a company name, short enough that no reader typed it by accident. */
export const MAX_QUERY_LENGTH = 48
const MAX_MATCHES = 5

const MatchRowSchema = z.object({
  description: z.string().nullable(),
  short_description: z.string().nullable(),
  symbol: EquitySymbolSchema,
})

/** A reader types `sofi`, `$SOFI` or `SoFi Technologies`; only the first two are a ticker. */
export function symbolCandidate(query: string): string | undefined {
  const candidate = query.trim().replace(/^\$/, '').toUpperCase()
  return EQUITY_SYMBOL_REGEX.test(candidate) ? candidate : undefined
}

export function searchableQuery(rawQuery: string): string | undefined {
  const query = rawQuery.trim()
  if (!query || query.length > MAX_QUERY_LENGTH) return undefined
  // LIKE treats these as wildcards, so a reader cannot turn a name search into a scan.
  return query.toUpperCase().replace(/[%_]/g, ' ').replace(/\s+/g, ' ').trim() || undefined
}

// D1 refuses a LIKE pattern over 50 bytes, and the widest one here wraps the query in two `%`.
const D1_LIKE_PATTERN_MAX_BYTES = 50
const utf8 = new TextEncoder()

/**
 * The query cut, at a character boundary, to what fits D1's pattern limit. A search is capped at
 * `MAX_QUERY_LENGTH` characters, which is within the limit for ASCII but not once a name carries
 * accented letters; the cut keeps the leading text, which is what a name match turns on.
 */
function likePatternText(query: string): string {
  let text = query
  while (utf8.encode(text).length > D1_LIKE_PATTERN_MAX_BYTES - 2) text = text.slice(0, -1)
  return text.trimEnd()
}

/**
 * Symbol first, then company name: an exact ticker outranks a ticker that starts with
 * the query, which outranks a name that starts with it, which outranks a name that
 * merely contains it. Ties break toward the shorter symbol, which is the more likely
 * subject of a bare search.
 */
export async function searchInstrumentCatalog(
  env: AppEnv,
  rawQuery: string,
  limit = MAX_MATCHES,
): Promise<SymbolSearchMatch[]> {
  if (!env.DB) throw new CallerVisibleError('SymbolSearch:store-unavailable')
  const query = searchableQuery(rawQuery)
  if (!query) return []
  const pattern = likePatternText(query)
  const prefix = `${pattern}%`
  const contains = `%${pattern}%`
  const result = await env.DB.prepare(
    `SELECT symbol, description, short_description
     FROM instrument_catalog
     WHERE resolution_status = 'resolved'
       AND coalesce(active, 1) = 1
       AND (
         symbol = ?1
         OR symbol LIKE ?2
         OR upper(coalesce(description, '')) LIKE ?3
         OR upper(coalesce(short_description, '')) LIKE ?3
       )
     ORDER BY CASE
         WHEN symbol = ?1 THEN 0
         WHEN symbol LIKE ?2 THEN 1
         WHEN upper(coalesce(description, '')) LIKE ?2 THEN 2
         ELSE 3
       END,
       length(symbol), symbol
     LIMIT ?4`,
  ).bind(query, prefix, contains, Math.max(1, Math.min(MAX_MATCHES, limit))).all()
  return z.array(MatchRowSchema).parse(result.results).map((row) => ({
    name: row.description ?? row.short_description ?? row.symbol,
    symbol: row.symbol,
  }))
}
