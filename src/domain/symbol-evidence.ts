import { z } from 'zod'

import { EquitySymbolSchema } from './instrument'
import { CitedSourceUrlSchema, MAX_CITED_SOURCE_TITLE_LENGTH } from './https-url'

/*
 * An evidence card is one quoted passage from a page, attached to a symbol by a member's own
 * agent: the place a member researching a name leaves what they read. It is bound -- the Worker
 * re-reads the page and refuses a quote it cannot find in that text -- so what accumulates
 * under a name is still sentences somebody's source actually contains.
 *
 * Every bound below is a rendering envelope for untrusted text rather than a research limit:
 * the card is read in a list beside the runway, and prose that overruns its measure is the one
 * thing a reader cannot correct for.
 */

/**
 * A quote is one sentence of a page, not a page. The evidence binder holds a submission to
 * this bound, so the quote a card stores is the quote the binder matched.
 */
export const MAX_EVIDENCE_QUOTE_LENGTH = 300
/** The member's own one-line reading of the quote. One line at the card's measure, no more. */
export const MAX_EVIDENCE_NOTE_LENGTH = 240
/**
 * A handle the member chose, never a name an identity provider gave us: this is a public
 * surface and the account behind it stays private. One line at a card's measure -- a handle
 * that does not fit beside the symbol on a phone is a sentence, and a card is not where a
 * sentence goes. Nothing account-derived ever fills it: the member types it or leaves it out.
 */
export const MAX_EVIDENCE_BYLINE_LENGTH = 40

/**
 * How many cards a public read returns for one symbol. The section sits under the runway in the
 * focus card and is read in one scroll; past that a reader is paging through an archive, which
 * is a different surface than "what has been found about this name lately".
 */
export const MAX_SYMBOL_EVIDENCE_CARDS = 12

/**
 * What a reader receives. The recorder's user id is deliberately absent from this contract: it
 * is account-derived data, it never leaves the server, and the byline -- chosen by the member,
 * never taken from an identity provider -- is the only attribution a public card carries.
 */
export const SymbolEvidenceSchema = z.strictObject({
  byline: z.string().min(1).max(MAX_EVIDENCE_BYLINE_LENGTH).nullable(),
  id: z.string().min(1),
  note: z.string().min(1).max(MAX_EVIDENCE_NOTE_LENGTH).nullable(),
  quote: z.string().min(1).max(MAX_EVIDENCE_QUOTE_LENGTH),
  recordedAt: z.string(),
  sourceTitle: z.string().min(1).max(MAX_CITED_SOURCE_TITLE_LENGTH),
  sourceUrl: CitedSourceUrlSchema,
  symbol: EquitySymbolSchema,
})

export type SymbolEvidence = z.infer<typeof SymbolEvidenceSchema>

export const SymbolEvidenceResponseSchema = z.strictObject({
  evidence: z.array(SymbolEvidenceSchema).max(MAX_SYMBOL_EVIDENCE_CARDS),
})
