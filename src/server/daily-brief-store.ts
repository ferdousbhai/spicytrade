import { z } from 'zod'

import {
  dailyBriefId,
  DailyBriefSchema,
  DailyBriefSubmissionSchema,
  type DailyBrief,
  type DatedRecommendation,
  type DailyBriefSubmission,
} from '../domain/brief'
import { EquitySymbolSchema } from '../domain/instrument'
import { IsoDateSchema } from '../domain/iso-date'

const StoredRowSchema = z.object({ payload_json: z.string() })

type StoredRow = z.infer<typeof StoredRowSchema>

/** D1's row type is a claim, not a check: the row and its payload are both re-parsed on every read. */
function parseStored(row: StoredRow): DailyBrief {
  return DailyBriefSchema.parse(JSON.parse(StoredRowSchema.parse(row).payload_json))
}

/**
 * Briefs are ordered by market date, never by publication instant: a retried Workflow step can
 * republish an older date after a newer one, and that must neither become the standing brief nor
 * put the archive out of order. The id is `brief-<YYYY-MM-DD>` (the table's CHECK enforces it),
 * so its lexical order is market-date order and the primary key serves both reads.
 *
 * The store owns only persistence shape; callers keep their audience-specific absence policy.
 */
export async function readLatestDailyBrief(db: D1Database): Promise<DailyBrief | undefined> {
  const row = await db.prepare('SELECT payload_json FROM daily_briefs ORDER BY id DESC LIMIT 1').first<StoredRow>()
  return row ? parseStored(row) : undefined
}

/** One archive neighbour, the brief for the latest market date before the given one. */
export async function readDailyBriefBefore(db: D1Database, marketDateBefore: string): Promise<DailyBrief | undefined> {
  const row = await db.prepare(
    'SELECT payload_json FROM daily_briefs WHERE id < ? ORDER BY id DESC LIMIT 1',
  ).bind(dailyBriefId(IsoDateSchema.parse(marketDateBefore))).first<StoredRow>()
  return row ? parseStored(row) : undefined
}

/**
 * The newest brief, by market date, that recommended this symbol, and that recommendation, or
 * `null` when none has. The SQL match only selects the row; the whole brief is re-parsed and the
 * recommendation picked from the parsed contract, so a payload that matched in JSON but fails the
 * schema, or parses without that recommendation, throws here.
 *
 * A symbol no brief names reads every row: one per market date, so a year is a few hundred
 * payloads. The route's edge cache bounds how often that runs; a derived (symbol, date) index
 * written at publish is the step up if the archive outgrows it.
 */
export async function readLatestRecommendation(db: D1Database, symbol: string): Promise<DatedRecommendation | null> {
  const wanted = EquitySymbolSchema.parse(symbol)
  const row = await db.prepare(
    `SELECT payload_json FROM daily_briefs
     WHERE EXISTS (
       SELECT 1 FROM json_each(payload_json, '$.recommendations')
       WHERE json_extract(value, '$.symbol') = ?
     )
     ORDER BY id DESC LIMIT 1`,
  ).bind(wanted).first<StoredRow>()
  if (!row) return null
  const brief = parseStored(row)
  const recommendation = brief.recommendations.find((candidate) => candidate.symbol === wanted)
  // The row was selected for naming this symbol, so a parsed brief without it is stored data the
  // SQL and the schema read differently: that is a failure, not a name never recommended.
  if (!recommendation) throw new Error('Stored brief names the symbol only outside its parsed recommendations')
  return { marketDate: brief.marketDate, recommendation }
}

/**
 * The publish boundary. What arrives is untrusted model output from the Workflow, typed only
 * by what the caller claims: it is re-parsed against the submission contract here, given its
 * id and instant, and stored whole or not at all. A second publication for the same market date
 * replaces the first, which is what lets a retried run land without a duplicate day.
 */
export async function publishDailyBrief(db: D1Database, submission: DailyBriefSubmission, now = new Date()): Promise<DailyBrief> {
  const parsed = DailyBriefSubmissionSchema.parse(submission)
  const brief = DailyBriefSchema.parse({
    ...parsed,
    id: dailyBriefId(parsed.marketDate),
    publishedAt: now.toISOString(),
  })
  await db.prepare(
    `INSERT INTO daily_briefs (id, published_at, payload_json)
     VALUES (?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET published_at = excluded.published_at, payload_json = excluded.payload_json`,
  ).bind(brief.id, brief.publishedAt, JSON.stringify(brief)).run()
  return brief
}
