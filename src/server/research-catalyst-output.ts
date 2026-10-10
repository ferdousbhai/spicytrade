import { z } from 'zod'

import {
  CATALYST_HORIZON_DAYS,
  CatalystKindSchema,
  CatalystTimingSchema,
  marketDate,
  MAX_CATALYST_DESCRIPTION_LENGTH,
  MAX_CATALYST_TITLE_LENGTH,
  RecordedCatalystSchema,
  type Catalyst,
} from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { addDays, IsoDateSchema, textMentionsDateWithinHorizon } from '../domain/iso-date'
import { type CatalystProvider } from './catalysts'
import { type ReadPage, TRUNCATED_READ_MISS } from './research-page-retention'
import { citedPageKey } from './research-url'

export const ResearchCatalystCandidateSchema = z.strictObject({
  date: IsoDateSchema,
  description: z.string().min(1).max(MAX_CATALYST_DESCRIPTION_LENGTH).nullable(),
  kind: CatalystKindSchema,
  sourceIndex: z.number().int().nonnegative(),
  symbol: EquitySymbolSchema,
  timing: CatalystTimingSchema,
  title: z.string().min(1).max(MAX_CATALYST_TITLE_LENGTH),
})

export type ResearchCatalystCandidate = z.infer<typeof ResearchCatalystCandidateSchema>

export interface CatalystCandidateBinding {
  catalysts: Catalyst[]
  rejected: string[]
}

/**
 * How a bound row names the producer that wrote it. The id prefix is the provider value itself,
 * which is what the `catalysts` CHECK pairs a row's id against, so a row stays traceable to
 * something that can refresh or retract it. The label is the other half of that, for a reader:
 * it says which surface produced the date, beside the host it was read from.
 */
const BOUND_CATALYST_LABELS = {
  exa: 'Exa search',
  'member-research': 'Member research',
} satisfies Partial<Record<CatalystProvider, string>>

type BoundCatalystProvider = keyof typeof BOUND_CATALYST_LABELS

/**
 * Turn model-authored catalyst candidates into application-owned rows. A candidate survives
 * only when this run retained its HTTPS page and the page states the event date -- in full, or
 * as a month-day with no conflicting year printed beside it while the date is inside the horizon,
 * where a month-day can name only one date.
 *
 * The provider is a parameter so every producer of model-authored dates -- a member's recording
 * and the Exa search -- is bound under the same rules. A label only names rows as they are
 * written -- a stored row carries its own -- so a retired producer needs no entry here.
 *
 * A rejection names its candidate by position, or by `candidateNumbers` when the producer
 * refused some of its own items before binding and reports under their original numbers.
 */
export function bindCatalystCandidates(
  candidates: readonly ResearchCatalystCandidate[],
  sources: readonly { sourceUrl: string }[],
  retained: ReadonlyMap<string, ReadPage>,
  now: Date,
  provider: BoundCatalystProvider,
  candidateNumbers?: readonly number[],
): CatalystCandidateBinding {
  const catalysts: Catalyst[] = []
  const rejected: string[] = []
  const ids = new Set<string>()
  const today = marketDate(now)
  const horizon = addDays(today, CATALYST_HORIZON_DAYS)

  for (const [position, untrusted] of candidates.entries()) {
    const number = candidateNumbers?.[position] ?? position + 1
    const parsed = ResearchCatalystCandidateSchema.safeParse(untrusted)
    if (!parsed.success) {
      rejected.push(...parsed.error.issues.map((issue) => (
        `catalyst ${number}: ${issue.message}`
      )))
      continue
    }
    const candidate = parsed.data
    const source = sources[candidate.sourceIndex]
    const sourceUrl = source ? citedPageKey(source.sourceUrl) : undefined
    const page = sourceUrl ? retained.get(sourceUrl) : undefined
    if (!sourceUrl || !page) {
      rejected.push(`catalyst ${number}: source was not read this run`)
      continue
    }
    if (candidate.date < today || candidate.date > horizon) {
      rejected.push(`catalyst ${number}: date is outside the ${CATALYST_HORIZON_DAYS}-day horizon`)
      continue
    }
    if (!textMentionsDateWithinHorizon(page.markdown, candidate.date, today, horizon)) {
      // Year-less mentions bind within the horizon, so what remains missing is the date itself --
      // or, on a page read only in part, the date may sit past what was read.
      rejected.push(page.truncated
        ? `catalyst ${number}: ${candidate.date} ${TRUNCATED_READ_MISS} its source page`
        : `catalyst ${number}: ${candidate.date} does not appear on its source page`)
      continue
    }
    const id = `${provider}:${candidate.symbol}:${candidate.kind}:${candidate.date}`
    if (ids.has(id)) {
      rejected.push(`catalyst ${number}: duplicates ${id}`)
      continue
    }
    ids.add(id)
    const { sourceIndex: _sourceIndex, ...publicFields } = candidate
    catalysts.push(RecordedCatalystSchema.parse({
      ...publicFields,
      confidence: 'estimated',
      id,
      source: `${BOUND_CATALYST_LABELS[provider]} · ${new URL(sourceUrl).hostname.replace(/^www\./, '')}`,
      sourceUrl,
      updatedAt: now.toISOString(),
    }))
  }
  return { catalysts, rejected }
}
