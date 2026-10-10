import { z } from 'zod'

import {
  CatalystSchema,
  marketDate,
  MAX_CATALYSTS_PER_SYMBOL,
  RecordedCatalystSchema,
  type Catalyst,
} from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { isValidIsoDate } from '../domain/iso-date'
import { type AppEnv } from './env'
import { jsonObject, jsonText, type JsonObject, type JsonValue } from '../domain/json-payload'
import { d1InListChunks, d1RowPlaceholders, rowsPerD1Statement } from './d1-limits'
import { CallerVisibleError } from './caller-visible-error'

const TASTYTRADE_METRICS_URL = 'https://developer.tastytrade.com/open-api-spec/market-metrics/'
const CATALYST_BOUND_PARAMETERS_PER_ROW = 13
const CATALYST_ROWS_PER_STATEMENT = rowsPerD1Statement(CATALYST_BOUND_PARAMETERS_PER_ROW)

/**
 * Every producer writes the same row to the same table and is told apart by this column, so
 * adding one costs a value rather than a table, an upsert, and an arm on the view. A row's id
 * carries its producer too, which is what keeps it traceable to something that can refresh or
 * retract it — the property migration 0019 retired two tables for lacking.
 *
 * Only the producers that write today. The table's CHECK still admits the retired `dan` and
 * `daily-research` values because their rows remain on the calendar and are read like any other;
 * nothing here writes under either again.
 */
export type CatalystProvider = 'tastytrade' | 'exa' | 'member-research'

export function catalystUpsertStatements(
  db: D1Database,
  provider: CatalystProvider,
  catalysts: readonly Catalyst[],
  observedAt: string,
): D1PreparedStatement[] {
  // Every producer writes through here, so this is the one place the write envelope is held.
  //
  // A sighting never moves backwards. `CURRENT_CATALYSTS` reads only a producer's latest
  // sighting, so a superseded run that finishes last -- an attention search still in flight when
  // the owner forces a newer one that lands first -- would otherwise stamp its older instant back
  // over the newer rows, retire what the newer run reported, and put its stale fields in their
  // place. The guard on the conflict branch makes that late write land nowhere for any row the
  // newer run touched. Every producer stamps the instant its own run began, so an equal stamp is
  // the same run writing again and still applies.
  const rows = catalysts.map((catalyst) => RecordedCatalystSchema.parse(catalyst))
  const statements: D1PreparedStatement[] = []
  for (let start = 0; start < rows.length; start += CATALYST_ROWS_PER_STATEMENT) {
    const chunk = rows.slice(start, start + CATALYST_ROWS_PER_STATEMENT)
    statements.push(db.prepare(
      `INSERT INTO catalysts
        (id, source_provider, symbol, kind, title, description, event_date, timing, confidence, source_label, source_url, updated_at, last_seen_at)
       VALUES ${chunk.map(() => d1RowPlaceholders(CATALYST_BOUND_PARAMETERS_PER_ROW)).join(', ')}
       ON CONFLICT(id) DO UPDATE SET
        symbol = excluded.symbol, kind = excluded.kind, title = excluded.title,
        description = excluded.description, event_date = excluded.event_date,
        timing = excluded.timing, confidence = excluded.confidence,
        source_label = excluded.source_label, source_url = excluded.source_url,
        updated_at = excluded.updated_at, last_seen_at = excluded.last_seen_at
       WHERE excluded.last_seen_at >= catalysts.last_seen_at`,
    ).bind(...chunk.flatMap((catalyst) => [
      catalyst.id, provider, catalyst.symbol, catalyst.kind, catalyst.title,
      catalyst.description ?? null, catalyst.date, catalyst.timing, catalyst.confidence,
      catalyst.source, catalyst.sourceUrl, catalyst.updatedAt, observedAt,
    ])))
  }
  return statements
}

function optionalBoolean(object: JsonObject, key: string): boolean | undefined {
  const value = object[key]
  if (value === undefined || value === null) return undefined
  const parsed = z.boolean().safeParse(value)
  if (!parsed.success) throw new CallerVisibleError(`TastytradeCatalyst:invalid-${key}`)
  return parsed.data
}

function earningsRecord(metric: JsonObject | undefined): JsonObject | undefined {
  const value = metric?.earnings
  if (value === undefined || value === null) return undefined
  const earnings = jsonObject(value)
  if (!earnings) throw new CallerVisibleError('TastytradeCatalyst:invalid-earnings')
  return earnings
}

function upcomingEarningsDate(earnings: JsonObject | undefined, today: string): string | undefined {
  if (!earnings || optionalBoolean(earnings, 'visible') === false) return undefined
  const rawDate = earnings['expected-report-date']
  if (rawDate === undefined || rawDate === null) return undefined
  const candidate = jsonText(rawDate)
  if (!candidate || !isValidIsoDate(candidate)) throw new CallerVisibleError('TastytradeCatalyst:invalid-earnings-date')
  if (candidate < today) return undefined
  return candidate
}

function providerTimestamp(value: JsonValue): string {
  const candidate = jsonText(value)
  if (!candidate || Number.isNaN(Date.parse(candidate))) {
    throw new CallerVisibleError('TastytradeCatalyst:invalid-updated-at')
  }
  return new Date(candidate).toISOString()
}

function earningsTiming(value: JsonValue): Catalyst['timing'] {
  if (value === undefined || value === null) return 'unknown'
  const parsed = z.string().safeParse(value)
  if (!parsed.success) throw new CallerVisibleError('TastytradeCatalyst:invalid-time-of-day')
  const timing = parsed.data.toLowerCase()
  if (timing.includes('before') || timing.includes('pre')) return 'pre-market'
  if (timing.includes('after') || timing.includes('post')) return 'after-hours'
  if (timing.includes('during') || timing.includes('market')) return 'intraday'
  return 'unknown'
}

export function catalystsFromMarketMetrics(metrics: readonly JsonObject[], now = new Date()): Catalyst[] {
  const today = marketDate(now)
  return metrics.flatMap((metric) => {
    const symbol = EquitySymbolSchema.parse(jsonText(metric.symbol)?.toUpperCase())
    const earnings = earningsRecord(metric)
    if (!earnings) return []
    const earningsDate = upcomingEarningsDate(earnings, today)
    if (!earningsDate) return []
    const estimated = optionalBoolean(earnings, 'estimated')
    const updatedAt = providerTimestamp(earnings['updated-at'] ?? metric['updated-at'])
    return [CatalystSchema.parse({
      id: `tastytrade:${symbol}:earnings`,
      symbol,
      kind: 'earnings',
      title: `${symbol} earnings`,
      date: earningsDate,
      timing: earningsTiming(earnings['time-of-day']),
      confidence: estimated === false ? 'confirmed' : 'estimated',
      source: 'tastytrade market metrics',
      sourceUrl: TASTYTRADE_METRICS_URL,
      updatedAt,
    })]
  })
}

export function earningsDateFromMetric(metric: JsonObject | undefined, now = new Date()): string | null {
  const earnings = earningsRecord(metric)
  return upcomingEarningsDate(earnings, marketDate(now)) ?? null
}

/**
 * Every row its producer still reports, which is the source every reader selects from.
 *
 * Research rows are additive on purpose: a source going quiet is not proof that an event it
 * once observed was cancelled, so nothing is deleted when a run stops mentioning it. But a
 * producer that searched the same symbol again and wrote a row for the same kind of event has
 * not gone quiet — it answered that question a second time, and the earlier row that later
 * write did not refresh is a date the producer no longer reports. Left in, one producer's two
 * answers reach a reader as two events, which is the same duplicate a second producer makes
 * and the one `distinctCatalysts` cannot fold, because a moved date is not the same date.
 *
 * `last_seen_at` is stamped on every row a write touches, so "this producer looked again and
 * did not see this" is a fact the store already holds; migration 0020 kept the column for
 * exactly this and nothing had ever read it. Partitioned by kind, so a run that reported
 * earnings says nothing about a conference an earlier one found, and two events of one kind
 * written by one run share a stamp and both stand.
 *
 * Only for a producer that answers for the whole symbol, which is what a `catalyst_runs`
 * receipt records: a search buys coverage of one name, so its later answer supersedes its
 * earlier one. A producer with no receipt is not one voice — `member-research`, like the retired
 * `daily-research` rows still stored, is whichever member's agent wrote that row — so a second member recording
 * a date is not the first one looking again, and nothing there retires anything. A later
 * producer earns this by writing a receipt, not by being named here.
 *
 * Retired from the read and never deleted: the row stays answerable to the producer that wrote
 * it, and a producer that reports that date again refreshes it back into view.
 */
export const CURRENT_CATALYSTS =
  `(SELECT c.id, c.source_provider, c.symbol, c.kind, c.title, c.description, c.event_date,
        c.timing, c.confidence, c.source_label, c.source_url, c.updated_at
      FROM (
        SELECT *, max(last_seen_at) OVER (PARTITION BY source_provider, symbol, kind) AS latest_sighting
          FROM upcoming_catalysts
      ) c
     WHERE c.last_seen_at = c.latest_sighting
        OR NOT EXISTS (
          SELECT 1 FROM catalyst_runs r
           WHERE r.source_provider = c.source_provider AND r.symbol = c.symbol
        ))`

/*
 * Every producer's upcoming rows, nearest first, for at most `MAX_CATALYSTS_PER_SYMBOL` events
 * per symbol. The cap counts events, not rows: two producers that saw one event wrote two rows,
 * which `distinctCatalysts` folds into one for a reader, and a cap on rows spent a symbol's ten
 * on its duplicates and dropped real events off the far end. So the window ranks by the fold's
 * own event identity -- symbol, date and kind -- and every sighting of a kept event is returned
 * for the reader to fold. A dense rank gives each event one number however many rows share it,
 * and orders a symbol's events by date first, so the cap still drops only the far end.
 */
const EVENT_RANK = 'DENSE_RANK() OVER (PARTITION BY symbol ORDER BY event_date ASC, kind ASC)'

/**
 * `EVENT_RANK` across every symbol of one read, for a cap on a whole calendar rather than on each
 * symbol: the same event identity and the same date-first order, with the symbol joining the
 * identity because the partition no longer carries it.
 */
export const CALENDAR_EVENT_RANK = 'DENSE_RANK() OVER (ORDER BY event_date ASC, symbol ASC, kind ASC)'

/** A catalyst row as `CatalystSchema` reads it, shared by the snapshot and agent calendar reads. */
export const CATALYST_COLUMNS = `id, symbol, kind, title, description, event_date AS date, timing, confidence,
           source_label AS source, source_url AS "sourceUrl", updated_at AS "updatedAt"`

const UPCOMING_CATALYSTS_QUERY =
  `SELECT id, symbol, kind, title, description, date, timing, confidence, source, "sourceUrl", "updatedAt"
     FROM (
       SELECT ${CATALYST_COLUMNS},
           ${EVENT_RANK} AS nearest
         FROM ${CURRENT_CATALYSTS}
         WHERE event_date >= ? AND symbol IN (SELECT value FROM json_each(?))
     )
     WHERE nearest <= ?
     ORDER BY date ASC, symbol ASC, id ASC`

/**
 * The upcoming-catalyst read for a snapshot's symbols, for a caller that must not write. The
 * table holds rows for every symbol any producer ever wrote -- a member's agent researching a
 * name nobody lists, a symbol since removed -- so a snapshot reads only its own symbols, and the
 * stored and live builds of one state carry the same calendar. The symbols travel as one JSON
 * parameter, so their count is not capped by D1's bound-parameter limit.
 */
export async function readUpcomingCatalysts(
  env: AppEnv,
  symbols: readonly string[],
  now = new Date(),
): Promise<Catalyst[]> {
  if (!env.DB) throw new CallerVisibleError('CatalystStoreUnavailable')
  const normalized = [...new Set(symbols.map((symbol) => EquitySymbolSchema.parse(symbol)))]
  if (!normalized.length) return []
  const result = await env.DB.prepare(UPCOMING_CATALYSTS_QUERY)
    .bind(marketDate(now), JSON.stringify(normalized), MAX_CATALYSTS_PER_SYMBOL).all()
  return CatalystSchema.array().parse(result.results ?? [])
}

/** One symbol's upcoming catalysts, for the focused runway: the same rows the many-symbol read returns. */
export async function readUpcomingCatalystsForSymbol(
  env: AppEnv,
  symbol: string,
  now = new Date(),
): Promise<Catalyst[]> {
  return readUpcomingCatalysts(env, [symbol], now)
}

/**
 * A tastytrade earnings snapshot is authoritative only for the symbols its metrics answered: a
 * metrics row with no upcoming earnings retires the stored one, but a symbol whose row never
 * arrived said nothing, so its stored row is kept and still read. The two sets are passed apart
 * for that reason -- deleting for every requested symbol would turn a missing provider row into
 * an apparently cancelled earnings date.
 */
export async function persistAndLoadCatalysts(
  env: AppEnv,
  observed: readonly Catalyst[],
  symbols: { answered: readonly string[]; requested: readonly string[] },
  now = new Date(),
): Promise<Catalyst[]> {
  if (!env.DB) throw new CallerVisibleError('CatalystStoreUnavailable')
  const answered = [...new Set(symbols.answered.map((symbol) => EquitySymbolSchema.parse(symbol)))]
  const requested = [...new Set(symbols.requested.map((symbol) => EquitySymbolSchema.parse(symbol)))]
  const statements: D1PreparedStatement[] = []
  for (const chunk of d1InListChunks(answered)) {
    statements.push(env.DB.prepare(
      `DELETE FROM catalysts
       WHERE source_provider = 'tastytrade' AND symbol IN (${chunk.map(() => '?').join(', ')})`,
    ).bind(...chunk))
  }
  statements.push(...catalystUpsertStatements(env.DB, 'tastytrade', observed, now.toISOString()))
  if (statements.length) await env.DB.batch(statements)
  return readUpcomingCatalysts(env, requested, now)
}

/**
 * Research sources are additive: unlike a fresh tastytrade earnings snapshot, one
 * source going quiet is not proof that a previously observed event was cancelled.
 * Keep each source's stable row and only refresh it when that source sees it again.
 */
export async function persistResearchCatalysts(
  env: AppEnv,
  provider: CatalystProvider,
  catalysts: readonly Catalyst[],
  now = new Date(),
): Promise<void> {
  if (!env.DB) throw new CallerVisibleError('CatalystStoreUnavailable')
  if (!catalysts.length) return
  await env.DB.batch(catalystUpsertStatements(env.DB, provider, catalysts, now.toISOString()))
}
