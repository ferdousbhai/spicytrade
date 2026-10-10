import {
  MAX_SYMBOL_EVIDENCE_CARDS,
  SymbolEvidenceSchema,
  type SymbolEvidence,
} from '../domain/symbol-evidence'
import { EquitySymbolSchema } from '../domain/instrument'
import { sha256Base64Url } from './digest'
import { normalizedCitationText } from './research-citation-binding'

/**
 * Storage for evidence cards: one provider (members' own agents) and one contract (a passage
 * this Worker re-read, attached to a symbol).
 *
 * The row's identity is the passage itself -- symbol, canonical page address, and the quote as
 * the citation binder normalizes it -- so recording the same sentence again refreshes the card
 * that exists rather than stacking another copy of it under the name. That makes an agent that
 * re-runs its research idempotent by construction, which is what stops a name from filling up
 * with the same quote worded three ways.
 */
type SymbolEvidenceRecord = {
  byline: string | null
  note: string | null
  quote: string
  recordedAt: string
  recordedByUserId: string
  sourceTitle: string
  sourceUrl: string
  symbol: string
}

/**
 * The card's id, derived rather than random so a repeat is an upsert. The producer prefix is
 * the same convention a catalyst row carries: a row says what wrote it, and can be retracted
 * as a set on that basis.
 */
async function symbolEvidenceId(symbol: string, sourceUrl: string, quote: string): Promise<string> {
  const identity = [symbol, sourceUrl, normalizedCitationText(quote)].join('\n')
  return `member-evidence:${await sha256Base64Url(identity)}`
}

export async function upsertSymbolEvidence(db: D1Database, record: SymbolEvidenceRecord): Promise<string> {
  const symbol = EquitySymbolSchema.parse(record.symbol)
  const id = await symbolEvidenceId(symbol, record.sourceUrl, record.quote)
  // Symbol, address and quote are the identity, so the update touches everything but them: the
  // passage as first recorded is what a reader has already seen, and rewriting it from a second
  // recording that normalizes to the same words would change a quote nobody re-read.
  await db.prepare(
    `INSERT INTO symbol_evidence
      (id, symbol, quote, note, source_url, source_title, byline, recorded_at, recorded_by_user_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
      note = excluded.note, source_title = excluded.source_title, byline = excluded.byline,
      recorded_at = excluded.recorded_at, recorded_by_user_id = excluded.recorded_by_user_id`,
  ).bind(
    id, symbol, record.quote, record.note, record.sourceUrl, record.sourceTitle,
    record.byline, record.recordedAt, record.recordedByUserId,
  ).run()
  return id
}

/**
 * The newest cards for one symbol, for a public reader. `recorded_by_user_id` is never selected
 * here and has no other reader: the byline the member chose is the whole of a card's public
 * attribution, and the account behind it stays server-side.
 */
export async function readSymbolEvidence(
  db: D1Database,
  symbol: string,
): Promise<SymbolEvidence[]> {
  const result = await db.prepare(
    `SELECT id, symbol, quote, note, source_url AS "sourceUrl", source_title AS "sourceTitle",
        byline, recorded_at AS "recordedAt"
       FROM symbol_evidence
       WHERE symbol = ?
       ORDER BY recorded_at DESC, id ASC
       LIMIT ?`,
  ).bind(EquitySymbolSchema.parse(symbol), MAX_SYMBOL_EVIDENCE_CARDS).all()
  return SymbolEvidenceSchema.array().parse(result.results ?? [])
}
