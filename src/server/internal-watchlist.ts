import { z } from 'zod'

import { jsonObject, type JsonObject } from '../domain/json-payload'
import { EquitySymbolSchema, MAX_PROVIDER_LABEL_LENGTH, equitySymbolSql } from '../domain/instrument'
import { MAX_WATCHLIST_SYMBOLS } from '../domain/watchlist'
import { type AppEnv } from './env'
import { MAX_INSTRUMENT_CATALOG_ITEMS } from './instrument-catalog'
import { publishInternalWatchlistUniverse } from './public-market-universe'
import { defineSeam } from './seam'
import { CallerVisibleError } from './caller-visible-error'

// The retained seed was imported, once, under this per-kind list ceiling (an isolate-memory and
// D1-write budget of that import, not a bound on the product list, which is
// `MAX_WATCHLIST_SYMBOLS`). It is what bounds one symbol's membership read below.
const MAX_SOURCE_LISTS_PER_KIND = 100

/**
 * The origins an automatic prune may evict: the broker seed, a reader's search, and a member
 * agent's `remember_symbols`. Every other origin is a protected row (tiers 0-1 of the ranking)
 * that only an explicit removal deletes. A row of one of these origins ranks in tiers 2-6: in
 * the curated tiers 2-3 when the retained seed lists it, whatever its origin now says, and
 * otherwise below every curated name (tiers 4-6).
 * Admission and pruning read this one list: when admission counted only the seed as evictable,
 * visitor searches filled the protected capacity and refused an owner or trade-intent addition
 * while the prune could still have evicted every one of them.
 *
 * `agent-discussion` is here because any signed-in member can write it, a whole list's worth per
 * call and with no catalog check: were it protected, one member's agent could fill the protected
 * capacity and so refuse every later owner and trade-intent addition. Prunable, it can displace
 * only weaker provenance -- searches and uncurated seed rows -- never a curated or protected name.
 */
const PRUNABLE_ORIGINS = ['tastytrade-seed', 'visitor-search', 'agent-discussion'] as const satisfies readonly InternalWatchlistOrigin[]
const PRUNABLE_ORIGINS_SQL = `(${PRUNABLE_ORIGINS.map((origin) => `'${origin}'`).join(', ')})`

/**
 * The one ranking of the maintained list. Pruning keeps the head of it and the focus read
 * returns the head of it, so both are built from this text: two rankings had already drifted
 * (one capped the options-volume list, the other did not) and the drift was a silent
 * correctness bug rather than a visible failure. Lower tiers rank first:
 *
 *   0  an owner addition
 *   1  any other protected origin — trade intent, or a stored scheduled-research or position-sync row
 *   2  a seed member of one of the owner's private broker lists
 *   3  a seed member of the public High Options Volume list, by its rank there
 *   4  a name a member's agent discussed, which yields to every curated name
 *   5  a reader's search, which earns its place but yields to a discussed name too
 *   6  any other seed member
 *
 * Tiers 2 and 3 read list membership from the retained seed tables, not from the row's origin, so
 * a search or discussion that overwrote a seed row's origin (see INTERNAL_WATCHLIST_ORIGINS) keeps
 * the name in its curated tier rather than demoting it to tier 4 or 5.
 *
 * Ties break by options-volume rank, then most recently touched, then symbol. The text binds no
 * parameter, so a statement built on it binds only its own.
 */
const RANKED_ITEMS_CTE = `WITH private_symbols AS (
       SELECT DISTINCT upper(e.broker_symbol) AS symbol
       FROM internal_watchlist_seed_entries e
       JOIN internal_watchlist_seed_sources s ON s.id = e.source_id
       WHERE e.instrument_type = 'Equity' AND s.source_kind = 'private'
     ),
     volume_symbols AS (
       SELECT upper(e.broker_symbol) AS symbol, min(e.entry_index) AS volume_rank
       FROM internal_watchlist_seed_entries e
       JOIN internal_watchlist_seed_sources s ON s.id = e.source_id
       JOIN instrument_catalog c ON c.symbol = upper(e.broker_symbol)
       WHERE e.instrument_type = 'Equity'
         AND s.source_kind = 'public' AND s.name = 'High Options Volume'
         AND c.resolution_status = 'resolved' AND c.active = 1
         AND coalesce(c.is_etf, 0) = 0 AND coalesce(c.is_index, 0) = 0
         AND coalesce(c.is_illiquid, 0) = 0 AND coalesce(c.is_closing_only, 0) = 0
         AND coalesce(c.is_options_closing_only, 0) = 0
       GROUP BY upper(e.broker_symbol)
     ),
     ranked AS (
       SELECT i.symbol, i.updated_at, v.volume_rank,
         CASE
           WHEN i.origin = 'owner' THEN 0
           WHEN i.origin NOT IN ${PRUNABLE_ORIGINS_SQL} THEN 1
           WHEN p.symbol IS NOT NULL THEN 2
           WHEN v.volume_rank IS NOT NULL THEN 3
           WHEN i.origin = 'agent-discussion' THEN 4
           WHEN i.origin = 'visitor-search' THEN 5
           ELSE 6
         END AS tier
       FROM internal_watchlist_items i
       LEFT JOIN private_symbols p ON p.symbol = i.symbol
       LEFT JOIN volume_symbols v ON v.symbol = i.symbol
     )`
const RANK_ORDER = 'tier ASC, coalesce(volume_rank, 9223372036854775807) ASC, updated_at DESC, symbol ASC'
const MAX_CATALOG_CANDIDATES = MAX_INSTRUMENT_CATALOG_ITEMS
/*
 * Nothing writes the seed tables any more: every row is what the retired importer wrote, and it
 * refused to serialize a source's metadata past 256,000 UTF-8 bytes or an entry's past 64,000. A
 * string's length in UTF-16 units never exceeds its UTF-8 byte length, so a character bound of the
 * same number admits every value it wrote, and a longer one is not a row it wrote. Why the
 * importer chose those two numbers was never recorded.
 */
const MAX_SEED_SOURCE_METADATA_CHARS = 256_000
const MAX_SEED_ENTRY_METADATA_CHARS = 64_000
/**
 * A live item's metadata is always `{}`; the only writer of anything more was the retired importer,
 * which stored the ids of the seed lists naming the symbol -- at most every list of both kinds. The
 * longest value it could have written is therefore the bound, derived rather than guessed.
 */
const MAX_ITEM_METADATA_CHARS = JSON.stringify({
  seedSourceIds: (['private', 'public'] as const).flatMap((kind) =>
    Array.from({ length: MAX_SOURCE_LISTS_PER_KIND }, (_, index) => `tastytrade-${kind}-${index}`)),
}).length
const MAX_SEED_MEMBERSHIPS_PER_SYMBOL = 2 * MAX_SOURCE_LISTS_PER_KIND

const SymbolSchema = EquitySymbolSchema
const INTERNAL_WATCHLIST_ORIGINS = [
  'tastytrade-seed',
  // A reader's lookup is the weakest provenance a live path writes: every other live origin
  // overwrites it, and it overwrites only the retired seed's. That overwrite costs the name no
  // rank, because the ranking reads private and volume list membership from the retained seed
  // tables rather than from this column; it only lifts a seed member on no ranked list from
  // tier 6 to 5. A searched symbol on neither curated list ranks below a discussed one; one that is
  // a seed member of a private or High Options Volume list keeps that curated tier (2 or 3), above
  // every discussed name. Either way the prune in the same batch that admitted it can evict it.
  'visitor-search',
  // A member agent's `remember_symbols`. It is prunable (see PRUNABLE_ORIGINS), so it ranks below
  // every protected origin here: were it stronger than one, a member could turn a protected row
  // into a prunable one by naming it. It overwrites only a search's or the seed's origin.
  'agent-discussion',
  // Written by a retired scheduled research run. Rows that carry it remain in D1 and must still
  // parse and rank as protected, so it stays a stored origin, but no live path writes it.
  'scheduled-research',
  // Written only by the removed one-time finalization (held positions at that moment). Rows
  // that carry it remain in D1 and must still parse and rank, so it stays a stored origin,
  // but no live path may write it.
  'position-sync',
  'trade-intent',
  'owner',
] as const
const InternalWatchlistOriginSchema = z.enum(INTERNAL_WATCHLIST_ORIGINS)

const InternalWatchlistMutationOriginSchema = InternalWatchlistOriginSchema.exclude(['tastytrade-seed', 'scheduled-research', 'position-sync'])

export type InternalWatchlistOrigin = z.infer<typeof InternalWatchlistOriginSchema>
type InternalWatchlistMutationOrigin = z.infer<typeof InternalWatchlistMutationOriginSchema>

export type InternalWatchlistItem = {
  createdAt: string
  instrumentType: string
  metadata: JsonObject
  origin: InternalWatchlistOrigin
  symbol: string
  updatedAt: string
}

export type InternalWatchlistSymbolDetails = InternalWatchlistItem & {
  seedMemberships: Array<{
    entryMetadata: JsonObject
    sourceKind: 'private' | 'public'
    sourceMetadata: JsonObject
    sourceName: string
  }>
}

function requiredDatabase(env: AppEnv): D1Database {
  if (!env.DB) throw new CallerVisibleError('InternalWatchlist:store-unavailable')
  return env.DB
}

function normalizedSymbols(symbols: readonly string[]): string[] {
  return [...new Set(symbols.map((symbol) => SymbolSchema.safeParse(symbol).data).filter((symbol): symbol is string => Boolean(symbol)))]
}

/**
 * The retained seed's equities: stable catalog candidates that survive any live-list pruning or
 * removal. Nothing writes the seed tables any more (the one-time import is gone), so there is no
 * readiness row to gate on: a database without the import simply has no candidates, and the live
 * list grows from reader and owner additions instead.
 *
 * Entries are filtered by the domain symbol grammar in SQL, before the LIMIT, so the cap counts
 * only symbols the schema accepts: a stored entry in another venue's notation (`BF.B`) or past the
 * grammar's width is not a name this product can ask the broker for, and is left out rather than
 * counted toward the cap or thrown on after it.
 */
export async function readInternalWatchlistCatalogCandidates(env: AppEnv): Promise<string[]> {
  const db = requiredDatabase(env)
  const result = await db.prepare(
    `SELECT DISTINCT upper(broker_symbol) AS symbol
     FROM internal_watchlist_seed_entries
     WHERE instrument_type = 'Equity'
       AND ${equitySymbolSql('upper(broker_symbol)')}
     ORDER BY symbol ASC LIMIT ${MAX_CATALOG_CANDIDATES + 1}`,
  ).all<{ symbol: string }>()
  const symbols = z.array(z.object({ symbol: SymbolSchema })).max(MAX_CATALOG_CANDIDATES).parse(result.results)
  return symbols.map((row) => row.symbol)
}

/** Drop the automatically admitted rows that fall past `MAX_WATCHLIST_SYMBOLS` in the ranking. */
function pruneStatement(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `${RANKED_ITEMS_CTE}
     DELETE FROM internal_watchlist_items
     WHERE origin IN ${PRUNABLE_ORIGINS_SQL}
       AND symbol NOT IN (
         SELECT symbol FROM ranked ORDER BY ${RANK_ORDER} LIMIT ${MAX_WATCHLIST_SYMBOLS}
       )`,
  )
}

function originPriority(origin: InternalWatchlistOrigin): number {
  return INTERNAL_WATCHLIST_ORIGINS.indexOf(origin)
}

const storedOriginPrioritySql = `CASE internal_watchlist_items.origin ${INTERNAL_WATCHLIST_ORIGINS
  .map((origin, priority) => `WHEN '${origin}' THEN ${priority}`)
  .join(' ')} END`

function upsertSymbolsStatement(
  db: D1Database,
  symbols: readonly string[],
  origin: InternalWatchlistMutationOrigin,
  timestamp: string,
): D1PreparedStatement {
  const priority = originPriority(origin)
  return db.prepare(
    `WITH input AS (
       SELECT CAST(key AS INTEGER) AS input_index, value AS symbol
       FROM json_each(?)
     ), ranked_input AS (
       SELECT input_index, symbol,
         CASE WHEN EXISTS (
           SELECT 1 FROM internal_watchlist_items i
           WHERE i.symbol = input.symbol AND i.origin NOT IN ${PRUNABLE_ORIGINS_SQL}
         ) THEN 0 ELSE 1 END AS needs_slot
       FROM input
     ), admitted AS (
       SELECT input_index, symbol FROM (
         SELECT input_index, symbol, needs_slot,
           sum(needs_slot) OVER (ORDER BY input_index ASC) AS slot_number
         FROM ranked_input
       )
       WHERE needs_slot = 0 OR slot_number <= max(0, ${MAX_WATCHLIST_SYMBOLS} - (
         SELECT count(*) FROM internal_watchlist_items WHERE origin NOT IN ${PRUNABLE_ORIGINS_SQL}
       ))
     )
     INSERT INTO internal_watchlist_items
       (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
     SELECT symbol, 'Equity', ?, '{}', ?, ? FROM admitted
     -- SQLite needs a WHERE between an INSERT's SELECT and its upsert clause.
     WHERE true
     ON CONFLICT(symbol) DO UPDATE SET
       origin = CASE WHEN ? > ${storedOriginPrioritySql}
         THEN excluded.origin ELSE internal_watchlist_items.origin END,
       updated_at = CASE WHEN ? >= ${storedOriginPrioritySql}
         THEN excluded.updated_at ELSE internal_watchlist_items.updated_at END`,
  ).bind(JSON.stringify(symbols), origin, timestamp, timestamp, priority, priority)
}

/** Add or prioritize symbols while retaining immutable seed provenance and creation time. */
export async function ensureInternalWatchlistSymbols(
  env: AppEnv,
  symbols: readonly string[],
  origin: InternalWatchlistMutationOrigin,
  now = new Date(),
): Promise<string[]> {
  const db = requiredDatabase(env)
  const normalized = normalizedSymbols(symbols)
  if (!normalized.length) return []
  if (normalized.length > MAX_WATCHLIST_SYMBOLS) throw new CallerVisibleError('InternalWatchlist:too-many-symbols')
  const timestamp = now.toISOString()
  const parsedOrigin = InternalWatchlistMutationOriginSchema.parse(origin)
  // D1 batch executes transactionally. Ranking inside the same batch prevents concurrent
  // additions from each observing one free slot below `MAX_WATCHLIST_SYMBOLS` and jointly
  // exceeding the cap.
  // New symbols are admitted in input order up to the protected-row capacity; the only
  // automatic eviction targets are rows of a `PRUNABLE_ORIGINS` origin.
  await db.batch([
    upsertSymbolsStatement(db, normalized, parsedOrigin, timestamp),
    pruneStatement(db),
  ])
  const kept = await readInternalWatchlistFocus(env, MAX_WATCHLIST_SYMBOLS)
  await publishInternalWatchlistUniverse(env, now)
  const retained = new Set(kept)
  return normalized.filter((symbol) => retained.has(symbol))
}

export async function removeInternalWatchlistSymbols(env: AppEnv, symbols: readonly string[]): Promise<string[]> {
  const db = requiredDatabase(env)
  const normalized = normalizedSymbols(symbols)
  if (!normalized.length) return []
  if (normalized.length > MAX_WATCHLIST_SYMBOLS) throw new CallerVisibleError('InternalWatchlist:too-many-symbols')
  const results = await db.batch(normalized.map((symbol) => (
    db.prepare('DELETE FROM internal_watchlist_items WHERE symbol = ?').bind(symbol)
  )))
  const removed = normalized.filter((_, index) => results[index]?.meta.changes === 1)
  // Republish even for an idempotent retry. If the first attempt committed its
  // deletion but publication failed, the retry repairs the public projection.
  await publishInternalWatchlistUniverse(env)
  return removed
}

const StoredItemSchema = z.object({
  created_at: z.string().datetime(),
  instrument_type: z.string().min(1).max(MAX_PROVIDER_LABEL_LENGTH),
  metadata_json: z.string().max(MAX_ITEM_METADATA_CHARS),
  origin: InternalWatchlistOriginSchema,
  symbol: SymbolSchema,
  updated_at: z.string().datetime(),
})

export async function readInternalWatchlist(env: AppEnv): Promise<InternalWatchlistItem[]> {
  const result = await requiredDatabase(env).prepare(
    `SELECT symbol, instrument_type, origin, metadata_json, created_at, updated_at
     FROM internal_watchlist_items ORDER BY symbol ASC LIMIT ${MAX_WATCHLIST_SYMBOLS + 1}`,
  ).all()
  // Every write prunes to `MAX_WATCHLIST_SYMBOLS`, so a longer store is corrupt, not a page.
  if (!Array.isArray(result.results) || result.results.length > MAX_WATCHLIST_SYMBOLS) {
    throw new CallerVisibleError('InternalWatchlist:invalid-store')
  }
  return result.results.map((row) => {
    const parsed = StoredItemSchema.parse(row)
    const metadata = jsonObject(JSON.parse(parsed.metadata_json))
    if (!metadata) throw new CallerVisibleError('InternalWatchlist:invalid-metadata')
    return {
      createdAt: parsed.created_at,
      instrumentType: parsed.instrument_type,
      metadata,
      origin: parsed.origin,
      symbol: parsed.symbol,
      updatedAt: parsed.updated_at,
    }
  })
}

/**
 * Select the source-neutral working set: the head of the one ranking, at most `limit` names.
 * The retained broker provenance supplies the ranking, but neither the rank nor its source
 * crosses the server boundary — the caller gets bare symbols.
 */
export async function readInternalWatchlistFocus(
  env: AppEnv,
  limit = MAX_WATCHLIST_SYMBOLS,
): Promise<string[]> {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new CallerVisibleError('InternalWatchlist:invalid-focus-limit')
  const result = await requiredDatabase(env).prepare(
    `${RANKED_ITEMS_CTE}
     SELECT symbol FROM ranked ORDER BY ${RANK_ORDER} LIMIT ?`,
  ).bind(limit).all<{ symbol: string }>()
  return z.array(z.object({ symbol: SymbolSchema })).max(limit).parse(result.results).map((row) => row.symbol)
}

export async function readInternalWatchlistSymbolDetails(
  env: AppEnv,
  untrustedSymbol: string,
): Promise<InternalWatchlistSymbolDetails | undefined> {
  const symbol = SymbolSchema.parse(untrustedSymbol)
  const items = await readInternalWatchlist(env)
  const item = items.find((candidate) => candidate.symbol === symbol)
  if (!item) return undefined
  const result = await requiredDatabase(env).prepare(
    `SELECT s.source_kind, s.name, s.metadata_json AS source_metadata_json,
            e.metadata_json AS entry_metadata_json
     FROM internal_watchlist_seed_entries e
     JOIN internal_watchlist_seed_sources s ON s.id = e.source_id
     WHERE upper(e.broker_symbol) = ? AND e.instrument_type = 'Equity'
     ORDER BY s.source_kind ASC, s.source_index ASC, e.entry_index ASC
     LIMIT ${MAX_SEED_MEMBERSHIPS_PER_SYMBOL + 1}`,
  ).bind(symbol).all()
  if (!Array.isArray(result.results) || result.results.length > MAX_SEED_MEMBERSHIPS_PER_SYMBOL) {
    throw new CallerVisibleError('InternalWatchlist:invalid-provenance')
  }
  const seedMemberships = result.results.map((row) => {
    const parsed = z.object({
      entry_metadata_json: z.string().max(MAX_SEED_ENTRY_METADATA_CHARS),
      name: z.string().min(1).max(256),
      source_kind: z.enum(['private', 'public']),
      source_metadata_json: z.string().max(MAX_SEED_SOURCE_METADATA_CHARS),
    }).parse(row)
    const entryMetadata = jsonObject(JSON.parse(parsed.entry_metadata_json))
    const sourceMetadata = jsonObject(JSON.parse(parsed.source_metadata_json))
    if (!entryMetadata || !sourceMetadata) throw new CallerVisibleError('InternalWatchlist:invalid-provenance')
    return {
      entryMetadata,
      sourceKind: parsed.source_kind,
      sourceMetadata,
      sourceName: parsed.name,
    }
  })
  return { ...item, seedMemberships }
}

const internalWatchlistWriterSeam = defineSeam(() => ({ ensureSymbols: ensureInternalWatchlistSymbols }))

export const internalWatchlistWriter = internalWatchlistWriterSeam.current

export const setInternalWatchlistWriter = internalWatchlistWriterSeam.set

export const resetInternalWatchlistWriter = internalWatchlistWriterSeam.reset
