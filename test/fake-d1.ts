
/**
 * Faithful, fully typed D1 stand-ins. Every call on them throws by default, so a test
 * spreads one in and overrides exactly the calls its code path makes; a query it did not
 * set up then fails loudly instead of reading a silent stub. The results are plain object
 * types rather than the `D1Database` / `D1PreparedStatement` class types, because object
 * spread only carries own properties — spreading a class-typed value would drop them.
 */

function unsupported(): never {
  throw new Error('UnsupportedD1Call')
}

export function unsupportedStatement() {
  return { all: unsupported, bind: unsupported, first: unsupported, raw: unsupported, run: unsupported }
}

export function unsupportedDatabase() {
  return {
    batch: unsupported,
    dump: unsupported,
    exec: unsupported,
    prepare: unsupported,
    withSession: unsupported,
  }
}

export function d1Result<T>(results: T[], changes = 0): D1Result<T> {
  return {
    meta: {
      changed_db: changes > 0,
      changes,
      duration: 0,
      last_row_id: 0,
      rows_read: 0,
      rows_written: 0,
      size_after: 0,
    },
    results,
    success: true,
  }
}

/**
 * A database the portfolio guard must never touch: it reads no D1 state, only the broker
 * snapshot. Every call on this throws, so a guard that starts reading one fails loudly.
 */
export function untouchedDb(): D1Database {
  return unsupportedDatabase()
}
