import { type AgentTool } from '../domain/agent-tool'
import { Type } from 'typebox'
import { Compile } from 'typebox/compile'

import { equitySymbolFromModelText, ModelTextEquitySymbolType } from '../domain/instrument'
import { type JsonValue } from '../domain/json-payload'
import {
  MAX_EVIDENCE_BYLINE_LENGTH,
  MAX_EVIDENCE_NOTE_LENGTH,
  MAX_EVIDENCE_QUOTE_LENGTH,
} from '../domain/symbol-evidence'
import { MAX_CITED_SOURCE_TITLE_LENGTH, MAX_CITED_SOURCE_URL_LENGTH } from '../domain/https-url'
import { textResult } from './agent-tool-result'
import { type AppEnv } from './env'
import { retainCitedPages } from './research-page-retention'
import { quoteBindingRefusal, quoteWithoutWordsReason } from './research-citation-binding'
import { citedPageKey } from './research-url'
import { upsertSymbolEvidence } from './symbol-evidence'
import { CallerVisibleError } from './caller-visible-error'

/*
 * One quoted passage, attached to a symbol, by a member's own agent.
 *
 * A member researching a name has read something worth keeping, and the site has had nowhere
 * to keep it. This is that place, held to the same rule as every other citation here: the Worker re-reads the page
 * itself and refuses a quote it cannot find in that text, so a card is always the page's own
 * words rather than a model's recollection of them. Why the passage matters is the member's
 * note, which is labelled as theirs and binds nothing.
 *
 * A refusal returns the exact reason, the way publishing does, because the fix is always the
 * same shape: quote what the page says, or cite the page that says it.
 */

const EvidenceParameters = Type.Object({
  byline: Type.Optional(Type.String({
    description: 'A handle to sign the card with, shown publicly. Never a real name.',
    maxLength: MAX_EVIDENCE_BYLINE_LENGTH,
    minLength: 1,
  })),
  note: Type.Optional(Type.String({
    description: 'One line on why the quote matters. Yours, not the page\'s.',
    maxLength: MAX_EVIDENCE_NOTE_LENGTH,
    minLength: 1,
  })),
  quote: Type.String({
    description: 'The passage, word for word as the page has it.',
    maxLength: MAX_EVIDENCE_QUOTE_LENGTH,
    minLength: 1,
  }),
  sourceTitle: Type.String({ maxLength: MAX_CITED_SOURCE_TITLE_LENGTH, minLength: 1 }),
  sourceUrl: Type.String({
    description: 'The exact https address the quote was read from.',
    maxLength: MAX_CITED_SOURCE_URL_LENGTH,
    minLength: 1,
  }),
  symbol: ModelTextEquitySymbolType,
}, { additionalProperties: false })

const EvidenceValidator = Compile(EvidenceParameters)

type EvidenceRecording =
  | { id: string; status: 'recorded'; symbol: string }
  | { rejected: string[]; status: 'rejected' }

export async function recordSymbolEvidence(
  env: AppEnv,
  recordedByUserId: string,
  untrustedEvidence: JsonValue,
  requestedNow?: Date,
): Promise<EvidenceRecording> {
  const browser = env.BROWSER
  // Without page reading the quote cannot be bound, so nothing may be written. Fail closed.
  if (!browser) throw new CallerVisibleError('SymbolEvidence:page-reading-unavailable')
  const db = env.DB
  if (!db) throw new CallerVisibleError('SymbolEvidenceStoreUnavailable')
  // A card is a row that needs a name behind it, and the caller's is the one the token carries.
  if (!recordedByUserId) throw new CallerVisibleError('SymbolEvidence:unidentified-caller')
  const now = requestedNow ?? new Date()
  // Re-parsed at the trust boundary whatever the transport already checked.
  const evidence = EvidenceValidator.Parse(untrustedEvidence)

  const symbol = equitySymbolFromModelText(evidence.symbol)
  if (symbol === undefined) return { rejected: ['symbol: not a ticker symbol'], status: 'rejected' }
  // Canonicalized here as well as in `retainCitedPages` only so the refusal names this tool's own
  // field; the key is what the read below is keyed on and what the card stores.
  const sourceUrl = citedPageKey(evidence.sourceUrl)
  if (sourceUrl === undefined) {
    return { rejected: ['sourceUrl: not a readable https page address'], status: 'rejected' }
  }
  // Refused before a page read is spent on it: nothing on any page could bind it.
  const withoutWords = quoteWithoutWordsReason(evidence.quote)
  if (withoutWords) return { rejected: [withoutWords], status: 'rejected' }

  // The one read path every citation surface goes through.
  const { rejected, retained } = await retainCitedPages(browser, [{ sourceUrl }], [0])
  if (rejected.length) return { rejected, status: 'rejected' }
  const page = retained.get(sourceUrl)
  // Unreachable while canonicalization is idempotent; refused rather than bound to nothing.
  if (page === undefined) throw new CallerVisibleError('SymbolEvidence:page-not-retained')
  // The same normalization every citation here is bound by: markdown renders one sentence
  // many ways, and only its words decide whether the page contains the quote.
  const refusal = quoteBindingRefusal(page, evidence.quote)
  if (refusal) return { rejected: [refusal], status: 'rejected' }

  const id = await upsertSymbolEvidence(db, {
    byline: evidence.byline ?? null,
    note: evidence.note ?? null,
    quote: evidence.quote,
    recordedAt: now.toISOString(),
    recordedByUserId,
    sourceTitle: evidence.sourceTitle,
    sourceUrl,
    symbol,
  })
  return { id, status: 'recorded', symbol }
}

export function createSymbolEvidenceTool(
  env: AppEnv,
  recordedByUserId: string,
): AgentTool<typeof EvidenceParameters> {
  return {
    description: 'Attach a quoted passage from a page to a symbol, for every reader of this '
      + 'site. The server reads the page itself and refuses a quote it cannot find word for '
      + 'word in that text, returning the exact reason. Recording the same passage again '
      + 'refreshes the card rather than adding a second one. `note` is your own reading of the '
      + 'quote; `byline` is a handle you choose, and is public.',
    // SAFETY: `recordSymbolEvidence` re-parses its input with this same schema at the trust
    // boundary regardless of what the transport already checked.
    execute: async (params) => textResult(
      await recordSymbolEvidence(env, recordedByUserId, params as never),
    ),
    name: 'record_evidence',
    parameters: EvidenceParameters,
  }
}
