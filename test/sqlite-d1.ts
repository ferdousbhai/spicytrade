import { readdir, readFile } from 'node:fs/promises'
import { DatabaseSync, type StatementSync } from 'node:sqlite'
import { z } from 'zod'

import type { JsonObject } from '../src/domain/json-payload'
import type { InternalWatchlistOrigin } from '../src/server/internal-watchlist'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'

const D1_LIKE_PATTERN_MAX_BYTES = 50

type BoundStatement = D1PreparedStatement & { __run: () => Promise<D1Result> }

type SqlInput = null | number | bigint | string

const SqlInputSchema = z.union([
  z.null(), z.number(), z.bigint(), z.string(), z.boolean().transform(Number),
])

function sqlInputs(values: readonly unknown[]): SqlInput[] {
  return z.array(SqlInputSchema).parse(values)
}

function prepared(statement: StatementSync, onExecute: () => void, values: unknown[] = []): BoundStatement {
  const inputs = sqlInputs(values)
  const run = async () => {
    onExecute()
    const result = statement.run(...inputs)
    return d1Result([], Number(result.changes))
  }
  return {
    ...unsupportedStatement(),
    __run: run,
    all: async <T>() => {
      onExecute()
      // SAFETY: this test adapter mirrors D1: each caller owns the row type supplied to `all<T>()`.
      return d1Result(statement.all(...inputs) as T[])
    },
    bind: (...nextValues: unknown[]) => prepared(statement, onExecute, nextValues),
    first: async <T>(column?: string) => {
      onExecute()
      const row = statement.get(...inputs)
      if (!row) return null
      // SAFETY: this test adapter mirrors D1: each caller owns the selected `first<T>()` contract.
      return (column ? row[column] : row) as T
    },
    run,
  }
}

function sqliteD1(sql: readonly string[]) {
  const sqlite = new DatabaseSync(':memory:')
  // D1 refuses a LIKE or GLOB pattern over 50 bytes ("pattern too complex"); stock SQLite allows
  // 50,000, which let a query that fails in production pass here.
  // SAFETY: Node's `DatabaseSync#limits` is newer than this repository's @types/node.
  const { limits } = sqlite as DatabaseSync & { limits: { likePatternLength: number } }
  limits.likePatternLength = D1_LIKE_PATTERN_MAX_BYTES
  let executedQueries = 0
  sqlite.exec('PRAGMA foreign_keys = ON')
  for (const migration of sql) sqlite.exec(migration)
  const database: D1Database = {
    ...unsupportedDatabase(),
    batch: async <T = unknown>(statements: D1PreparedStatement[]) => {
      const results: D1Result<T>[] = []
      sqlite.exec('BEGIN IMMEDIATE')
      try {
        for (const candidate of statements) {
          // SAFETY: this database produces every statement through `prepared`, which attaches `__run`.
          const statement = candidate as BoundStatement
          // SAFETY: `__run` has the same result envelope as D1; batch callers own their generic row type.
          results.push(await statement.__run() as D1Result<T>)
        }
        sqlite.exec('COMMIT')
      } catch (cause) {
        sqlite.exec('ROLLBACK')
        throw cause
      }
      return results
    },
    prepare: (query) => prepared(sqlite.prepare(query), () => { executedQueries++ }),
  }
  return { close: () => sqlite.close(), database, queryCount: () => executedQueries, sqlite }
}

export type SqliteD1Store = ReturnType<typeof sqliteD1>

const migrationsDirectory = new URL('../migrations/', import.meta.url)
let migrationSql: Promise<string[]> | undefined

// Tests read the whole migrations directory in numeric filename order instead of naming files, so a
// new migration is exercised everywhere the moment it lands. `test/migrations.test.ts` deliberately
// stays on explicit per-file reads: it proves each migration applies over its real prior state.
function loadMigrations(): Promise<string[]> {
  migrationSql ??= (async () => {
    const names = (await readdir(migrationsDirectory)).filter((name) => name.endsWith('.sql')).sort()
    return await Promise.all(names.map((name) => readFile(new URL(name, migrationsDirectory), 'utf8')))
  })()
  return migrationSql
}

export async function migrationStore() {
  return sqliteD1(await loadMigrations())
}

/**
 * The member row the foreign keys point at. Recording evidence keeps the account behind it, so
 * a store that records needs that account to exist here exactly as it does in production.
 */
export function seedMember(store: SqliteD1Store, userId: string): string {
  store.sqlite.prepare(
    `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
     VALUES (?, 'Member', ? || '@example.com', 1, 'now', 'now')`,
  ).run(userId, userId)
  return userId
}

/** The default row timestamp `seedWatchlist` writes when an item doesn't pass its own. */
const SEEDED_AT = '2026-08-26T10:00:00.000Z'

type SeededWatchlistItem = {
  metadata?: JsonObject
  origin?: InternalWatchlistOrigin
  symbol: string
  updatedAt?: string
}

/** One retained broker list: the provenance the ranking and the owner's symbol details read. */
export type SeededWatchlistSource = {
  entries: Array<{ instrumentType?: string; metadata?: JsonObject; symbol: string }>
  kind: 'private' | 'public'
  metadata?: JsonObject
  name: string
}

/** Seed-origin items for bare symbols, the common fixture. */
export function seededItems(symbols: readonly string[]): SeededWatchlistItem[] {
  return symbols.map((symbol) => ({ symbol }))
}

/**
 * The watchlist state production holds: the one-time seed's retained sources and entries, and the
 * maintained items. Production has no writer for the seed any more (the owner bootstrap that
 * imported it is gone) and no read gates on its readiness row, so tests write only the rows a
 * read consults, directly rather than through a production path kept alive only for them.
 * An item defaults to the seed origin; a source's id follows the imported `tastytrade-<kind>-<n>`
 * shape so the ranking's joins and the provenance reads see what production holds.
 */
export function seedWatchlist(
  store: SqliteD1Store,
  items: readonly SeededWatchlistItem[],
  provenance: readonly SeededWatchlistSource[] = [],
): void {
  const insertSource = store.sqlite.prepare(
    `INSERT INTO internal_watchlist_seed_sources (id, source_kind, source_index, name, metadata_json)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const insertEntry = store.sqlite.prepare(
    `INSERT INTO internal_watchlist_seed_entries
       (source_id, entry_index, broker_symbol, instrument_type, metadata_json)
     VALUES (?, ?, ?, ?, ?)`,
  )
  const kindCounts = { private: 0, public: 0 }
  for (const source of provenance) {
    const sourceIndex = kindCounts[source.kind]++
    const id = `tastytrade-${source.kind}-${sourceIndex}`
    insertSource.run(id, source.kind, sourceIndex, source.name, JSON.stringify(source.metadata ?? { name: source.name }))
    source.entries.forEach((entry, entryIndex) => {
      const instrumentType = entry.instrumentType ?? 'Equity'
      insertEntry.run(id, entryIndex, entry.symbol, instrumentType, JSON.stringify(
        entry.metadata ?? { symbol: entry.symbol, 'instrument-type': instrumentType },
      ))
    })
  }
  const insertItem = store.sqlite.prepare(
    `INSERT INTO internal_watchlist_items (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
     VALUES (?, 'Equity', ?, ?, ?, ?)`,
  )
  for (const item of items) {
    const { metadata = {}, origin = 'tastytrade-seed', symbol, updatedAt = SEEDED_AT } = item
    insertItem.run(symbol, origin, JSON.stringify(metadata), SEEDED_AT, updatedAt)
  }
}
