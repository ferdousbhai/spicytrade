import { z } from 'zod'

import {
  CATALYST_HORIZON_DAYS,
  CatalystKindSchema,
  CatalystTimingSchema,
  MAX_CATALYST_DESCRIPTION_LENGTH,
  MAX_CATALYST_TITLE_LENGTH,
} from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { IsoDateSchema } from '../domain/iso-date'
import { readBoundedJson } from './bounded-response'
import { type AppEnv } from './env'
import {
  bindCatalystCandidates,
  type CatalystCandidateBinding,
  type ResearchCatalystCandidate,
} from './research-catalyst-output'
import { type ReadPage, retainCitedPages } from './research-page-retention'
import { citedPageKey } from './research-url'
import { readStoredSecret } from './secrets'

/**
 * Exa searches the web and, given a JSON schema, synthesizes one structured answer from the
 * pages it read. A symbol goes in; dated events, each naming the page it came from, come back
 * under `output.content`, beside the list of pages the search returned.
 *
 * A synthesized answer is still model text, and so is anything else Exa says about a page --
 * including the page text it can return with each result, which is Exa's copy of a read this
 * Worker never made. So an event is kept only when its date is bound to a page this Worker read
 * itself, in this run, through its own browser (`retainCitedPages`), exactly as a member's
 * `record_catalysts` and `record_evidence` are. Exa's results decide only which pages are worth
 * that read: an event citing a page the search did not return was not read from anything Exa
 * shows, so it is refused without spending a browser read on an address the model chose. The
 * result text is not requested at all -- it bound nothing and was billed per page.
 *
 * Exa also returns an `output.grounding` list naming the pages that support each field, and it is
 * deliberately not read: it is the same model vouching for its own answer, and model output never
 * establishes a citation here. Reporting routinely writes "Sept. 1" where the event says
 * 2026-09-01, which is why the text is read the way every other catalyst binder reads it -- a
 * year-less month-day binds inside the horizon, where it can name only one date -- and by the same
 * code: `bindCatalystCandidates`.
 */
const EXA_SEARCH_URL = 'https://api.exa.ai/search'
const MAX_EXA_RESPONSE_BYTES = 2 * 1024 * 1024
/**
 * How many pages one search returns, and so -- since only a returned page that an event cites is
 * re-read -- the most browser reads one run makes. A named cost budget, the owner's choice: enough
 * distinct pages that a search usually surfaces a dated catalyst, while capping the paid, slow part
 * of a run -- the concurrent browser re-reads -- at this many. A re-read that the browser service
 * cannot open refuses only the events that cite it. A response listing more than it was asked for
 * is refused rather than trimmed, so the bound holds structurally.
 */
export const MAX_EXA_RESULTS = 10
/**
 * A named budget on the untrusted events array (the response is already byte-bounded above). A
 * real answer lists a handful of dated events for one symbol; this leaves ample headroom so a busy
 * name never trips it, while a runaway array is refused before any of it is processed.
 */
const MAX_EXA_EVENTS = 50
/**
 * Bounds the whole search, body included, since the signal aborts the stream too. A named budget,
 * the owner's judgment: long enough for Exa's structured-output search to finish on an ordinary
 * day, short enough that a hung search frees its symbol within minutes through the run budget
 * built on it (`CATALYST_RUN_BUDGET_MS`). Exported because
 * a `running` receipt older than the run this bounds is a run that died, not one still answering.
 */
export const EXA_REQUEST_TIMEOUT_MS = 30_000

const EXA_OUTPUT_SCHEMA = {
  additionalProperties: false,
  properties: {
    events: {
      items: {
        additionalProperties: false,
        properties: {
          date: { description: 'Scheduled date, YYYY-MM-DD', type: 'string' },
          description: { type: 'string' },
          kind: { enum: CatalystKindSchema.options, type: 'string' },
          sourceUrl: { description: 'The result URL this event was read from', type: 'string' },
          timing: { enum: CatalystTimingSchema.options, type: 'string' },
          title: { type: 'string' },
        },
        required: ['date', 'kind', 'title', 'sourceUrl'],
        type: 'object',
      },
      type: 'array',
    },
  },
  required: ['events'],
  type: 'object',
} as const

/** Only what choosing the pages to read needs: each returned page's address. */
const ExaResultSchema = z.object({ url: z.string() })

const ExaResponseSchema = z.object({
  output: z.object({
    content: z.object({ events: z.array(z.unknown()).max(MAX_EXA_EVENTS) }).optional(),
  }).optional(),
  // No default: a response without the pages it read is not a search that read none, and
  // synthesizing an empty list here would store "searched, empty" for a search that never ran.
  results: z.array(ExaResultSchema).max(MAX_EXA_RESULTS),
})

const ExaEventSchema = z.object({
  date: IsoDateSchema,
  description: z.string().min(1).max(MAX_CATALYST_DESCRIPTION_LENGTH).optional(),
  kind: CatalystKindSchema,
  sourceUrl: z.string().url(),
  timing: CatalystTimingSchema.optional(),
  title: z.string().min(1).max(MAX_CATALYST_TITLE_LENGTH),
})

// The window the query asks about is the one the binder enforces, so the search is not spent on
// events the binder would refuse.
function catalystQuery(symbol: string, name: string): string {
  return `Scheduled upcoming catalysts for ${name} (${symbol}) stock over the next ${CATALYST_HORIZON_DAYS} days: `
    + 'next earnings report date, investor day, product launch or event, regulatory or FDA '
    + 'decision date, clinical trial readout, conference presentation, shareholder meeting. '
    + 'Report only events with a specific announced date.'
}

type ExaResponse = z.infer<typeof ExaResponseSchema>

async function requestExaSearch(env: AppEnv, symbol: string, name: string): Promise<ExaResponse> {
  const apiKey = await readStoredSecret(env.EXA_API_KEY, 'EXA_API_KEY')
  const response = await fetch(EXA_SEARCH_URL, {
    // Neither a `news` category nor a published-date window: a scheduled event lives on an
    // investor-relations calendar, which is neither news nor recently published. Live runs
    // with those filters returned nothing for two of three symbols and a syndicated repost
    // for the third; without them the same searches cite the companies' own IR pages.
    // No `contents`: the synthesis does not need page text returned to us, and text Exa read is
    // not text this Worker read, so it could bind nothing.
    body: JSON.stringify({
      numResults: MAX_EXA_RESULTS,
      outputSchema: EXA_OUTPUT_SCHEMA,
      query: catalystQuery(symbol, name),
      type: 'auto',
    }),
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
    method: 'POST',
    signal: AbortSignal.timeout(EXA_REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) throw new Error(`ExaSearchFailed:${response.status}`)
  return ExaResponseSchema.parse(await readBoundedJson(response, MAX_EXA_RESPONSE_BYTES, 'ExaSearch'))
}

/**
 * One catalyst search for one symbol, bound by the same rules as every other producer of
 * model-authored dates: every event that survives names a page this Worker read on this run,
 * carries a date that page states, and falls inside the product's horizon. Everything else is
 * reported as rejected rather than stored.
 */
export async function runExaCatalystSearch(
  env: AppEnv,
  untrustedSymbol: string,
  name: string,
  now = new Date(),
): Promise<CatalystCandidateBinding> {
  const symbol = EquitySymbolSchema.parse(untrustedSymbol)
  // Without page reading nothing can be bound, so the search is not bought. Throwing records the
  // run as failed; returning an empty binding would record a complete search that found nothing
  // and hold the symbol for the whole refresh window.
  const browser = env.BROWSER
  if (!browser) throw new Error('CatalystSearch:page-reading-unavailable')
  const payload = await requestExaSearch(env, symbol, name)
  // An empty `events` is a search that found nothing; a missing one is a synthesis that did not
  // happen. Returning normally would record that as a complete, empty search and suppress the
  // symbol for the whole refresh interval, so it fails and the run's receipt says so.
  const events = payload.output?.content?.events
  if (!events) throw new Error('ExaOutputMissing')

  // Keyed by the canonical address every citation here is bound by, so an event citing a page
  // with a tracking parameter or fragment Exa's result lacks still names that page, and what is
  // read and stored is the one address a reader is given for it.
  const returnedPages = new Set<string>()
  for (const result of payload.results) {
    const key = citedPageKey(result.url)
    if (key !== undefined) returnedPages.add(key)
  }

  // Exa's own shape is refused here, under the event's number; everything the shared binder
  // checks -- the page, the horizon, the date on the page, duplicates -- is left to it, reported
  // under the same numbering.
  const refused: string[] = []
  const cited: { candidate: ResearchCatalystCandidate; number: number; sourceUrl: string }[] = []
  for (const [index, untrusted] of events.entries()) {
    const parsed = ExaEventSchema.safeParse(untrusted)
    if (!parsed.success) {
      refused.push(`catalyst ${index + 1}: ${parsed.error.issues[0]?.message ?? 'malformed'}`)
      continue
    }
    const event = parsed.data
    const sourceUrl = citedPageKey(event.sourceUrl)
    // `citedPageKey` already holds the key to `CitedSourceUrlSchema`'s rules: https, citable, and
    // inside the envelope once serialized.
    if (sourceUrl === undefined) {
      refused.push(`catalyst ${index + 1}: source is not a citable https page address`)
      continue
    }
    cited.push({
      candidate: {
        date: event.date,
        description: event.description ?? null,
        kind: event.kind,
        sourceIndex: 0,
        symbol,
        timing: event.timing ?? 'unknown',
        title: event.title,
      },
      number: index + 1,
      sourceUrl,
    })
  }

  // Each distinct page an event cites and the search returned is read once, through the same
  // `retainCitedPages` the member surfaces use, so its truncation bound comes from the browser
  // read. At most `MAX_EXA_RESULTS` pages, read concurrently so the run's wall time grows by one
  // page read rather than by one per page (`CATALYST_RUN_BUDGET_MS`). Each page is its own call: unlike a
  // member's recording, this run is not all-or-nothing -- every event stands or falls on its own
  // page -- so a page that will not open refuses the events that cite it, not the whole run.
  const toRead = [...new Set(cited.map(({ sourceUrl }) => sourceUrl))]
    .filter((key) => returnedPages.has(key))
  const pages = new Map<string, ReadPage>()
  const unopened = new Set<string>()
  const reads = await Promise.all(toRead.map(async (key) => ({
    key,
    read: await retainCitedPages(browser, [{ sourceUrl: key }], [0]),
  })))
  for (const { key, read } of reads) {
    const page = read.retained.get(key)
    if (page === undefined) unopened.add(key)
    else pages.set(key, page)
  }

  const candidates: ResearchCatalystCandidate[] = []
  const sources: { sourceUrl: string }[] = []
  const candidateNumbers: number[] = []
  for (const { candidate, number, sourceUrl } of cited) {
    if (unopened.has(sourceUrl)) {
      // The member path's wording for the same fact, under this event's number.
      refused.push(`catalyst ${number}: page did not open: ${sourceUrl}`)
      continue
    }
    // A page the search did not return was never read, and the binder refuses it as such.
    candidates.push({ ...candidate, sourceIndex: sources.length })
    sources.push({ sourceUrl })
    candidateNumbers.push(number)
  }
  const binding = bindCatalystCandidates(candidates, sources, pages, now, 'exa', candidateNumbers)
  return { catalysts: binding.catalysts, rejected: [...refused, ...binding.rejected] }
}
