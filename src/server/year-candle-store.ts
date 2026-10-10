import { z } from 'zod'

import { CandlePointSchema, MAX_YEAR_CANDLES, type CandlePoint } from '../domain/candle'
import { EquitySymbolSchema } from '../domain/instrument'
import { d1InListChunks } from './d1-limits'

const StoredClosesSchema = z.array(CandlePointSchema).max(MAX_YEAR_CANDLES)

// A stored row that no longer parses is treated as absent rather than fatal: the year chart is
// decoration over live prices, and one poisoned row must not take the whole market read down.
// The skip is still counted in the log, so a store that is quietly rotting shows up there.
const StoredYearAnchorRowSchema = z.object({ symbol: z.string(), year_ago_close: z.number() })
const StoredYearSeriesRowSchema = z.object({ as_of: z.string(), symbol: z.string(), closes_json: z.string() })

function logSkippedRows(count: number): void {
  if (count) console.warn('YearCandleRowsSkipped', count)
}

function storedCloses(json: string): CandlePoint[] | undefined {
  try {
    return StoredClosesSchema.safeParse(JSON.parse(json)).data
  } catch {
    return undefined
  }
}

/**
 * Where each symbol's year began. The snapshot needs only this to sort by return and print the
 * move; the series itself is large enough that carrying it in every market response cost more
 * than the chart it draws.
 */
export async function readYearAgoCloses(
  db: D1Database,
  symbols: readonly string[],
): Promise<Map<string, number>> {
  const anchors = new Map<string, number>()
  let skipped = 0
  // One bound parameter per symbol, so a long watchlist is read in statement-sized chunks.
  for (const chunk of d1InListChunks(symbols)) {
    const placeholders = chunk.map(() => '?').join(', ')
    const { results } = await db.prepare(
      `SELECT symbol, year_ago_close FROM year_candles
        WHERE symbol IN (${placeholders}) AND year_ago_close IS NOT NULL`,
    ).bind(...chunk).all()
    for (const result of results) {
      const row = StoredYearAnchorRowSchema.safeParse(result)
      if (row.success && row.data.year_ago_close > 0) anchors.set(row.data.symbol, row.data.year_ago_close)
      else skipped += 1
    }
  }
  logSkippedRows(skipped)
  return anchors
}

/**
 * The stored series for the given symbols, oldest close first, with the oldest refresh among
 * them: one instant has to stand for the whole answer, and the oldest is the only one that is
 * true of every row in it. The symbol list is the caller's audience filter — the public route
 * passes the published universe — so a row for a name since removed from the list is not served
 * in the window before the next refresh deletes it. The list rides as one JSON parameter, so its
 * length is not bounded by D1's bound-parameter limit.
 */
export async function readYearCandleSeries(
  db: D1Database,
  symbols: readonly string[],
): Promise<{ asOf?: string; series: Map<string, number[]> }> {
  const series = new Map<string, number[]>()
  let asOf: string | undefined
  let skipped = 0
  const { results } = await db.prepare(
    `SELECT symbol, closes_json, as_of FROM year_candles
      WHERE symbol IN (SELECT value FROM json_each(?))`,
  ).bind(JSON.stringify(symbols)).all()
  for (const result of results) {
    const row = StoredYearSeriesRowSchema.safeParse(result)
    const closes = row.success ? storedCloses(row.data.closes_json) : undefined
    if (!row.success || !closes) {
      skipped += 1
      continue
    }
    if (!closes.length) continue
    series.set(row.data.symbol, closes.map((point) => point.close))
    if (asOf === undefined || row.data.as_of < asOf) asOf = row.data.as_of
  }
  logSkippedRows(skipped)
  return { asOf, series }
}

function yearCandlesUpsertStatement(
  db: D1Database,
  symbol: string,
  asOf: string,
  closes: readonly CandlePoint[],
): D1PreparedStatement {
  const stored = StoredClosesSchema.parse(closes)
  return db.prepare(
    `INSERT INTO year_candles (symbol, as_of, closes_json, year_ago_close)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(symbol) DO UPDATE SET
       as_of = excluded.as_of,
       closes_json = excluded.closes_json,
       year_ago_close = excluded.year_ago_close`,
  ).bind(
    EquitySymbolSchema.parse(symbol),
    asOf,
    JSON.stringify(stored),
    stored[0]?.close ?? null,
  )
}

/**
 * Write one refresh and retire every row the refresh no longer covers, atomically. A symbol that
 * left the refreshed set would otherwise keep a `year_ago_close` from the day it left, which every
 * later read would present as "a year ago" — true once, then silently wrong. A requested symbol
 * whose snapshot did not arrive keeps its previous row: nothing was said about it, that row still
 * describes the symbol, and its own `as_of` says how old it is. A requested symbol whose snapshot
 * arrived empty is different: the provider answered that it has no year for it, so its old row is
 * retired in the same batch rather than served on as a current anchor.
 */
export async function replaceYearCandles(
  db: D1Database,
  asOf: string,
  requestedSymbols: readonly string[],
  series: ReadonlyMap<string, readonly CandlePoint[]>,
): Promise<void> {
  const requested = requestedSymbols.map((symbol) => EquitySymbolSchema.parse(symbol))
  const arrivedEmpty = [...series]
    .filter(([, closes]) => closes.length === 0)
    .map(([symbol]) => EquitySymbolSchema.parse(symbol))
  await db.batch([
    ...[...series]
      .filter(([, closes]) => closes.length > 0)
      .map(([symbol, closes]) => yearCandlesUpsertStatement(db, symbol, asOf, closes)),
    db.prepare('DELETE FROM year_candles WHERE symbol NOT IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(requested)),
    db.prepare('DELETE FROM year_candles WHERE symbol IN (SELECT value FROM json_each(?))')
      .bind(JSON.stringify(arrivedEmpty)),
  ])
}
