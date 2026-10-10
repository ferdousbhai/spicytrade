import { type ReadPage, TRUNCATED_READ_MISS } from './research-page-retention'

/*
 * A quote is bound to what this Worker actually read. Native web search runs inside the
 * provider, so a page the model reports opening leaves nothing here to check; a page read
 * through the Worker's browser leaves its text, and a quote has to appear in one of those.
 *
 * The check is deterministic: the quote's words must appear in the page's retained text. It
 * never asks a model whether a claim is supported — an earlier attempt did, and a model
 * vouching for a model is the self-check this pipeline learned to distrust.
 *
 * What this bounds is fabrication, not interpretation: a real sentence can still be quoted
 * beside a wrong inference. That residual belongs to the reader, which is why the quote
 * travels with the record rather than being discarded after the check.
 */

/**
 * Markdown renders the same sentence many ways; only its words decide a match. Exported because
 * a symbol-evidence card's id is derived from the quote in this same normal form
 * (`symbolEvidenceId`), so a repeat recording of one passage upserts the card it already made. A
 * second copy of these replacements would be a second, quietly different definition of the same
 * words: the quote this binding accepts could then land under a different card id, and one
 * passage would reach readers as two cards.
 */
export function normalizedCitationText(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`>#|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Enough of a refused quote for its author to find it again, without reprinting a paragraph of
 * untrusted text back to the agent that sent it. One definition, because every surface that
 * binds a quote refuses it in exactly these words.
 */
const REJECTED_QUOTE_EXCERPT_CHARS = 80

/**
 * A quote made only of markup or whitespace normalizes to nothing, and every page "contains"
 * nothing: left to `includes`, it would bind any page it named. So a quote has to carry words
 * before it can be matched at all, and that refusal is part of the one binding rule rather than
 * something each binder has to remember.
 */
export function quoteWithoutWordsReason(quote: string): string | undefined {
  return normalizedCitationText(quote) === '' ? 'quote has no words to find on its source' : undefined
}

/**
 * Why `quote` does not bind to `page`, or undefined when it does. A miss on a truncated read is
 * named as one: the quote may sit past the part this Worker read, and calling it absent from
 * the source would tell its author the page does not say what it may well say.
 */
export function quoteBindingRefusal(page: ReadPage, quote: string): string | undefined {
  const withoutWords = quoteWithoutWordsReason(quote)
  if (withoutWords) return withoutWords
  if (normalizedCitationText(page.markdown).includes(normalizedCitationText(quote))) return undefined
  const excerpt = quote.slice(0, REJECTED_QUOTE_EXCERPT_CHARS)
  return page.truncated
    ? `quote ${TRUNCATED_READ_MISS} its source: "${excerpt}"`
    : `quote absent from its source: "${excerpt}"`
}
