import { z } from 'zod'

import { EquitySymbolSchema, isTradeableInstrument } from '../domain/instrument'
import { EARNINGS_SAME_REPORT_DAYS, marketDate, type CatalystRefresh } from '../domain/catalyst'
import { errorName, toError } from '../domain/failure'
import { addDays } from '../domain/iso-date'
import { type CatalystProvider, CURRENT_CATALYSTS, persistResearchCatalysts } from './catalysts'
import { EXA_REQUEST_TIMEOUT_MS, runExaCatalystSearch } from './catalyst-research-exa'
import { PAGE_NAVIGATION_TIMEOUT_MS } from './research-page-retention'
import { type AppEnv } from './env'
import { readInstrumentCatalog } from './instrument-catalog'
import { CallerVisibleError } from './caller-visible-error'

/**
 * Catalyst coverage follows attention: a symbol is worth paying a web search for once a
 * reader favorites it, or once one looks at it and finds an empty near-term calendar.
 * A symbol is searched at most once in this window whatever a finished search found, so a name
 * nobody has looked at stays unsearched and a name a hundred readers open is one search.
 *
 * The window bounds how often one symbol is searched. It says nothing about how many symbols
 * are reachable, and that set was the whole instrument catalog -- thousands of names, spendable
 * by anyone with no credential, since attention has always been anonymous. Incidental attention
 * is therefore limited to the tracked watchlist: the universe this product actually serves, and
 * already bounded at `MAX_WATCHLIST_SYMBOLS`. A reader's search asks for its name to join that
 * list, but the add is not guaranteed: it is refused when protected rows already fill the list,
 * and the prune that runs in the same write can evict it at once, as a later one can. A searched
 * name on neither curated seed list goes after uncurated seed rows but before a name a member's
 * agent discussed; one that is a seed member of a private or High Options Volume list keeps that
 * curated tier, above discussed names (see RANKED_ITEMS_CTE in internal-watchlist). A name that
 * did not stay on the list answers `untracked` here rather than buying a search, which is the
 * bound working, not a fault.
 * The owner's forced run is unaffected -- it is deliberate rather than incidental, and already
 * costs an owner credential.
 *
 * How long a complete search holds its symbol depends on what the calendar says (`holdAfterComplete`),
 * and each span is a cost policy:
 * - `CATALYST_REFRESH_INTERVAL_DAYS`: a week. Companies confirm and move dates on that cadence --
 *   an earnings date is usually confirmed two to four weeks out -- and a month-long hold covered
 *   that whole run-up, leaving a stale estimate standing until its own date passed. The worst
 *   case is one search per tracked symbol per week, `MAX_WATCHLIST_SYMBOLS` a week.
 * - `CATALYST_NEAR_EVENT_REFRESH_DAYS` inside `CATALYST_NEAR_EVENT_DAYS` of a scheduled event: the
 *   two weeks before an event are when its date and the events around it are announced, and when
 *   a reader is trading against them. That adds at most seven searches per symbol per event.
 * - `CATALYST_CONTRADICTED_REFRESH_MS` once a confirmed earnings date contradicts this producer's
 *   latest estimate after its last search: what the search reported is known to be wrong. The
 *   floor of a day is there because the broker restamps its row without the date moving, and the
 *   web can still carry the old date, so without it every look could buy another search.
 */
export const CATALYST_REFRESH_INTERVAL_DAYS = 7
export const CATALYST_NEAR_EVENT_DAYS = 14
export const CATALYST_NEAR_EVENT_REFRESH_DAYS = 2
export const CATALYST_CONTRADICTED_REFRESH_MS = 86_400_000
export const CATALYST_PROVIDER: CatalystProvider = 'exa'
/** The `catalyst_runs.detail` CHECK in migration 0024 admits at most this many characters. */
const MAX_RUN_DETAIL_LENGTH = 500

/**
 * The work a run does besides the search and the page loads: the catalog read before it, the
 * secret read, acquiring a browser and extracting each page's text, and the D1 persist and receipt
 * write after it. None of those carries its own timeout, so this is a stated allowance rather than
 * a derived one -- as long again as the search itself, far more than a handful of D1 statements
 * take, and still short enough that a dead run frees its symbol within minutes rather than the
 * refresh window.
 */
const RUN_OVERHEAD_ALLOWANCE_MS = EXA_REQUEST_TIMEOUT_MS
/**
 * How long a `running` receipt can be a live run. Past this it is a run that died mid-flight -- a
 * reader who disconnected from the public refresh, or attention work cut off with its invocation
 * -- and it holds nothing back. Were a run somehow still alive past it, the cost is one extra
 * search, against a symbol left unsearched for the refresh window. Its late persist cannot undo the newer
 * run: a row write never moves a sighting backwards (`catalystUpsertStatements`), and its receipt
 * lands nowhere (`recordRun`). What it adds is rows the newer run did not report, stamped with its
 * older instant: a row of a kind the newer run also reported reads as superseded, and a kind it
 * did not report stands, exactly as an earlier run's would.
 */
// The search's cited pages are re-read concurrently after it answers, so they add one page load's
// navigation bound however many pages there are.
export const CATALYST_RUN_BUDGET_MS = EXA_REQUEST_TIMEOUT_MS + PAGE_NAVIGATION_TIMEOUT_MS
  + RUN_OVERHEAD_ALLOWANCE_MS
/**
 * How long a `failed` receipt holds its symbol before another incidental search may be bought.
 * Readers retry a failed calendar whenever their window regains focus, and the route needs no
 * account, so without this every look during a provider outage is another paid search. The
 * policy: an outage costs at most four searches an hour per symbol however many readers look,
 * and a reader who comes back after it still gets a fresh attempt the same hour.
 */
export const CATALYST_FAILED_RETRY_MS = 15 * 60_000

const HeldRunSchema = z.object({ status: z.enum(['running', 'complete', 'failed']) })
const HoldContextSchema = z.object({ contradicted: z.number(), near: z.number() })

/**
 * How long this symbol's last complete search holds it, from what the calendar holds now (see
 * the policy at `CATALYST_REFRESH_INTERVAL_DAYS`). Read before the claim rather than inside it:
 * two concurrent callers read the same calendar and so the same span, and the claim statement
 * still lets only one of them buy the search.
 *
 * "Contradicted" compares this producer's latest earnings sighting with any confirmed earnings
 * date of the same report (`EARNINGS_SAME_REPORT_DAYS`) that the provider stamped after the
 * search ran -- a confirmation the search could not have seen. Read from the view rather than
 * `CURRENT_CATALYSTS`, which already hides that estimate.
 */
async function holdAfterComplete(db: D1Database, symbol: string, now: Date): Promise<number> {
  const today = marketDate(now)
  const context = HoldContextSchema.parse(await db.prepare(
    `SELECT
       EXISTS (
         SELECT 1 FROM ${CURRENT_CATALYSTS} upcoming
          WHERE upcoming.symbol = ? AND upcoming.event_date BETWEEN ? AND ?
       ) AS near,
       EXISTS (
         SELECT 1 FROM catalyst_runs r
           JOIN upcoming_catalysts estimate
             ON estimate.symbol = r.symbol AND estimate.source_provider = r.source_provider
           JOIN upcoming_catalysts confirmed ON confirmed.symbol = r.symbol
          WHERE r.symbol = ? AND r.source_provider = ? AND r.status = 'complete'
            AND estimate.kind = 'earnings' AND estimate.confidence = 'estimated' AND estimate.event_date >= ?
            AND estimate.last_seen_at = (
              SELECT max(latest.last_seen_at) FROM upcoming_catalysts latest
               WHERE latest.symbol = r.symbol AND latest.source_provider = r.source_provider
                 AND latest.kind = 'earnings'
            )
            AND confirmed.kind = 'earnings' AND confirmed.confidence = 'confirmed'
            AND confirmed.event_date <> estimate.event_date
            AND abs(julianday(confirmed.event_date) - julianday(estimate.event_date)) <= ?
            AND confirmed.updated_at > r.ran_at
       ) AS contradicted`,
  ).bind(
    symbol, today, addDays(today, CATALYST_NEAR_EVENT_DAYS),
    symbol, CATALYST_PROVIDER, today, EARNINGS_SAME_REPORT_DAYS,
  ).first())
  if (context.contradicted) return CATALYST_CONTRADICTED_REFRESH_MS
  return (context.near ? CATALYST_NEAR_EVENT_REFRESH_DAYS : CATALYST_REFRESH_INTERVAL_DAYS) * 86_400_000
}

/**
 * Claim the run before making it. A concurrent favorite of the same symbol then sees a
 * fresh receipt and does not buy a second search.
 *
 * Three receipts hold a symbol back, each for its own span: a `complete` one for `completeHoldMs`,
 * which `holdAfterComplete` reads from the calendar; a `running` one inside the run budget, because that search may yet answer; and a
 * `failed` one inside the retry backoff. A `running` receipt past the budget is a run that died
 * mid-flight, so it ages out within minutes rather than standing in for a search that never
 * finished for the whole window. A held `failed` receipt answers `failed`, never `fresh`: the
 * last search bound nothing, so the calendar is still unknown rather than searched and empty.
 *
 * The decision and the write are one statement. Reading the receipt and then upserting let two
 * concurrent callers -- many readers on the public route, or attention and a reader at once --
 * both see an expired receipt and both buy a search; the guard on the conflict branch lets
 * exactly one of them change the row. `ran_at` is only ever written here, from `toISOString()`,
 * whose fixed-width UTC form orders as text the way it orders as time, so the cutoffs compare as
 * strings. A receipt in any other form reads as expired -- `julianday` is NULL for text it cannot
 * parse -- because one extra search costs less than a symbol that can never be searched again.
 */
async function claimRun(
  db: D1Database,
  symbol: string,
  now: Date,
  forced: boolean,
  completeHoldMs: number,
): Promise<'claimed' | 'fresh' | 'failed'> {
  const cutoff = (ms: number) => new Date(now.getTime() - ms).toISOString()
  const claim = await db.prepare(
    `INSERT INTO catalyst_runs (symbol, source_provider, ran_at, catalyst_count, status)
     VALUES (?, ?, ?, 0, 'running')
     ON CONFLICT(symbol, source_provider) DO UPDATE SET
       ran_at = excluded.ran_at, catalyst_count = 0, status = 'running', detail = NULL
     WHERE ? = 1
       OR julianday(catalyst_runs.ran_at) IS NULL
       OR (catalyst_runs.status = 'complete' AND catalyst_runs.ran_at <= ?)
       OR (catalyst_runs.status = 'running' AND catalyst_runs.ran_at <= ?)
       OR (catalyst_runs.status = 'failed' AND catalyst_runs.ran_at <= ?)`,
  ).bind(
    symbol,
    CATALYST_PROVIDER,
    now.toISOString(),
    forced ? 1 : 0,
    cutoff(completeHoldMs),
    cutoff(CATALYST_RUN_BUDGET_MS),
    cutoff(CATALYST_FAILED_RETRY_MS),
  ).run()
  if (claim.meta.changes === 1) return 'claimed'
  // Nothing deletes a receipt, so the row the guard refused is still there to say why.
  const held = HeldRunSchema.parse(await db.prepare(
    'SELECT status FROM catalyst_runs WHERE symbol = ? AND source_provider = ?',
  ).bind(symbol, CATALYST_PROVIDER).first())
  return held.status === 'failed' ? 'failed' : 'fresh'
}

/**
 * On the maintained watchlist. Searching for a name admits it there, so this is a bound on which
 * symbols incidental attention may spend a search on, not on which symbols can ever be covered.
 */
async function isTracked(db: D1Database, symbol: string): Promise<boolean> {
  const row = await db.prepare(
    'SELECT 1 AS tracked FROM internal_watchlist_items WHERE symbol = ?',
  ).bind(symbol).first()
  return row !== null
}

/**
 * Close the receipt this run claimed, and only that one. A run that outlived its budget may find
 * its symbol already reclaimed by a newer run; the claim's own `ran_at` identifies it, so the late
 * run's outcome lands nowhere rather than overwriting the newer run's receipt.
 */
async function recordRun(
  db: D1Database,
  symbol: string,
  claimedAt: Date,
  status: 'complete' | 'failed',
  catalystCount: number,
  detail: string | undefined,
): Promise<void> {
  await db.prepare(
    `UPDATE catalyst_runs SET status = ?, catalyst_count = ?, detail = ?
     WHERE symbol = ? AND source_provider = ? AND ran_at = ? AND status = 'running'`,
  ).bind(
    status,
    catalystCount,
    detail?.slice(0, MAX_RUN_DETAIL_LENGTH) ?? null,
    symbol,
    CATALYST_PROVIDER,
    claimedAt.toISOString(),
  ).run()
}

/**
 * What one refresh attempt answers, plus whether it spent a claim -- that is, bought a search.
 * The reader's answer cannot say so: `reason: 'failed'` is both a search that was paid for and
 * threw, and a refusal held back by an earlier failure's backoff, and a reader must see those
 * the same. A caller budgeting searches must not, so this stays server-side and off the wire.
 */
type CatalystRefreshAttempt = { claimed: boolean; refresh: CatalystRefresh }

/**
 * Run a catalyst search for one symbol unless one was already run for it inside the refresh
 * window. The symbol must be a resolved instrument this Worker already knows, so attention
 * paid to something the catalog cannot name buys nothing.
 *
 * `forced` spends a search the window would have refused. Incidental attention must stay
 * bounded, but an owner asking on purpose is a different signal, and without it a symbol
 * searched once reads as empty for the whole hold with no way to ask again. The receipt is still
 * written, so a forced run resets the window for everyone rather than escaping it.
 *
 * A search that throws answers `ran: false, reason: 'failed'`: it bound nothing, and a reader
 * must not be told the calendar was searched and found empty when the search never finished.
 */
export async function refreshCatalystsForSymbol(
  env: AppEnv,
  untrustedSymbol: string,
  now = new Date(),
  forced = false,
): Promise<CatalystRefresh> {
  return (await attemptCatalystRefresh(env, untrustedSymbol, now, forced)).refresh
}

/** `refreshCatalystsForSymbol`, also saying whether the attempt claimed a run and so bought a search. */
export async function attemptCatalystRefresh(
  env: AppEnv,
  untrustedSymbol: string,
  now = new Date(),
  forced = false,
): Promise<CatalystRefreshAttempt> {
  // Every receipt and every row lives in D1, so without it nothing here can be answered.
  const db = env.DB
  if (!db) throw new CallerVisibleError('CatalystRunStoreUnavailable')
  const symbol = EquitySymbolSchema.parse(untrustedSymbol)
  const instrument = (await readInstrumentCatalog(env, [symbol])).get(symbol)
  // A delisted name has no upcoming anything. Paying for a search on one is spending real money
  // to learn that a company acquired two years ago has no next earnings date.
  if (!instrument || !isTradeableInstrument(instrument)) {
    return { claimed: false, refresh: { catalysts: [], ran: false, reason: 'unknown-symbol' } }
  }
  if (!forced && !await isTracked(db, symbol)) {
    return { claimed: false, refresh: { catalysts: [], ran: false, reason: 'untracked' } }
  }
  const claim = await claimRun(db, symbol, now, forced, await holdAfterComplete(db, symbol, now))
  if (claim !== 'claimed') return { claimed: false, refresh: { catalysts: [], ran: false, reason: claim } }

  try {
    const run = await runExaCatalystSearch(
      env,
      symbol,
      instrument.description ?? instrument.shortDescription ?? symbol,
      now,
    )
    await persistResearchCatalysts(env, CATALYST_PROVIDER, run.catalysts, now)
    await recordRun(db, symbol, now, 'complete', run.catalysts.length, run.rejected.join('; ') || undefined)
    return { claimed: true, refresh: { catalysts: run.catalysts, ran: true } }
  } catch (error) {
    // The log line carries the error's name only; the private receipt keeps the message, which
    // is where an owner reconciling a failed run looks.
    console.error('CatalystRefreshFailed', errorName(toError(error)))
    await recordRun(db, symbol, now, 'failed', 0, toError(error)?.message ?? 'UnknownError')
    return { claimed: true, refresh: { catalysts: [], ran: false, reason: 'failed' } }
  }
}
