import { z } from 'zod'

import { readBoundedJson } from './bounded-response'
import { type AppEnv } from './env'
import { citedPageKey } from './research-url'

/**
 * A page's text as read, and whether the read reached `MAX_PAGE_MARKDOWN_CHARS`. A binder that
 * cannot find a date or a quote in a truncated read has not shown it absent from the page, only
 * from the part it read, and must say which. `readResearchPageMarkdown` is the only producer, so
 * that bound is the one that applied to every read.
 */
export type ReadPage = { markdown: string; truncated: boolean }

/*
 * A citation is worth what this Worker can show was read. Native web search happens inside
 * the provider, so a page it opened leaves nothing here to bind a claim to; a page read
 * through this function leaves its text behind, and the binder afterwards refuses any citation
 * or quote absent from it.
 *
 * Markdown is capped so one page cannot exhaust the isolate on its own.
 */
export const MAX_PAGE_MARKDOWN_CHARS = 120_000

/** How a binder names a miss on a truncated read, so the author knows the rest went unread. */
export const TRUNCATED_READ_MISS = `not found in a read cut at ${MAX_PAGE_MARKDOWN_CHARS} characters of`
const MAX_PAGE_RESPONSE_BYTES = 4_000_000
/**
 * How long one page may take to load: Browser Run's own default navigation timeout, passed
 * explicitly so a caller budgeting wall time (`CATALYST_RUN_BUDGET_MS`) derives from a bound this
 * module sets rather than one it assumes. It bounds the navigation, not the whole call -- acquiring
 * a browser and extracting the markdown come on top, which a budget states as its own allowance.
 */
export const PAGE_NAVIGATION_TIMEOUT_MS = 30_000

/**
 * One page read through the Worker's browser, used wherever a model-authored citation is
 * checked against text this Worker fetched itself.
 * A browser timeout, session limit, or oversized body all return undefined: the caller's
 * contract is "cite something else", never a run-ending error. A page longer than the cap is
 * read in part and says so, rather than passing its prefix off as the whole page.
 */
async function readResearchPageMarkdown(
  browser: NonNullable<AppEnv['BROWSER']>,
  key: string,
): Promise<ReadPage | undefined> {
  try {
    const response = await browser.quickAction('markdown', {
      gotoOptions: { timeout: PAGE_NAVIGATION_TIMEOUT_MS },
      url: key,
    })
    if (!response.ok) return undefined
    const payload = await readBoundedJson(response, MAX_PAGE_RESPONSE_BYTES, 'ResearchReadPage')
    const parsed = z.object({ result: z.string(), success: z.literal(true) }).safeParse(payload).data
    if (!parsed) return undefined
    return {
      markdown: parsed.result.slice(0, MAX_PAGE_MARKDOWN_CHARS),
      truncated: parsed.result.length > MAX_PAGE_MARKDOWN_CHARS,
    }
  } catch {
    return undefined
  }
}

interface RetainedCitedPages {
  rejected: string[]
  /** Empty whenever anything was rejected: no binder may run on a partial set of reads. */
  retained: Map<string, ReadPage>
}

/**
 * Read every page a set of citations points at, once each, and retain its text for the binders.
 *
 * Every surface that admits model-authored citations faces the same sequence in the same order:
 * canonicalize the cited addresses, refuse any that is not a citable page before reading
 * anything, then read each distinct page and refuse if one did not open. One definition, so no
 * surface can quietly hold a citation to a weaker rule than another.
 *
 * Only a cited page is read, so the browser budget of one call is bounded by how many citations
 * the caller admits: the catalyst recording's `MAX_RECORDED_CATALYSTS`, one page per event at
 * most; one page for a piece of evidence; and for an Exa catalyst search, one page per call, made
 * once for each distinct page an event cites among the search's results -- so at most
 * `MAX_EXA_RESULTS` per run, however many of its `MAX_EXA_EVENTS` cite them. A separate page cap
 * here sat above those bounds and could never fire.
 *
 * Indices are not deduplicated: a bad address cited twice is named once per citation, which is
 * what an agent fixes. Distinct pages are, because a page that will not open is one fact about
 * that page however many citations lean on it.
 */
export async function retainCitedPages(
  browser: NonNullable<AppEnv['BROWSER']>,
  sources: readonly { sourceUrl: string }[],
  citedIndices: Iterable<number>,
): Promise<RetainedCitedPages> {
  const rejected: string[] = []
  const pageKeys = new Set<string>()
  for (const index of citedIndices) {
    const sourceUrl = sources[index]?.sourceUrl
    // An index past the end of sources has no page to read; the binders reject the citation.
    if (sourceUrl === undefined) continue
    const key = citedPageKey(sourceUrl)
    if (key === undefined) rejected.push(`source ${index}: not a readable https page address`)
    else pageKeys.add(key)
  }
  if (rejected.length) return { rejected, retained: new Map() }

  const retained = new Map<string, ReadPage>()
  for (const key of pageKeys) {
    const page = await readResearchPageMarkdown(browser, key)
    if (page === undefined) rejected.push(`page did not open: ${key}`)
    else retained.set(key, page)
  }
  if (rejected.length) return { rejected, retained: new Map() }
  return { rejected, retained }
}
