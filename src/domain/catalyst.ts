import { z } from 'zod'

import { EquitySymbolSchema } from './instrument'
import { CitedSourceUrlSchema, HttpsSourceUrlSchema } from './https-url'
import { addDays, IsoDateSchema } from './iso-date'

/**
 * How far ahead a catalyst may be scheduled and still be worth carrying. Every research producer
 * refuses a finding dated past it at its write boundary, and the agent's catalyst read admits no
 * wider window, since nothing a research producer bound lies beyond it. The site's own reads bound
 * rows per symbol rather than by date, and the broker's earnings feed is stored as reported -- a
 * next quarterly report falls well inside this window anyway.
 */
export const CATALYST_HORIZON_DAYS = 180
/**
 * How many upcoming events one symbol contributes to a snapshot, nearest first.
 *
 * The store holds every dated event any producer ever bound, and members' own agents can now
 * add to it, so "every upcoming row" is a set that only grows and that every visitor loads.
 * Ten is what a runway is for: a reader is deciding what is coming next for a name, and the
 * eleventh-nearest event is months out and will be inside this bound long before it matters.
 * The busiest symbol on the live surface carries six. What the cap drops is always the far end
 * of the calendar, never something nearer that a reader is actually trading against.
 */
export const MAX_CATALYSTS_PER_SYMBOL = 10
export const MAX_CATALYST_DESCRIPTION_LENGTH = 500
export const MAX_CATALYST_TITLE_LENGTH = 120

export const CatalystKindSchema = z.enum([
  'earnings', 'investor-event', 'product-event', 'regulatory', 'clinical',
  'conference', 'shareholder',
])
const CatalystConfidenceSchema = z.enum(['confirmed', 'estimated'])
export const CatalystTimingSchema = z.enum(['pre-market', 'intraday', 'after-hours', 'unknown'])

export const CatalystSchema = z.object({
  id: z.string(),
  symbol: EquitySymbolSchema,
  kind: CatalystKindSchema,
  title: z.string().min(1).max(MAX_CATALYST_TITLE_LENGTH),
  description: z.string().min(1).max(MAX_CATALYST_DESCRIPTION_LENGTH).nullable().optional(),
  date: IsoDateSchema,
  timing: CatalystTimingSchema,
  confidence: CatalystConfidenceSchema,
  source: z.string().min(1).optional(),
  sourceUrl: HttpsSourceUrlSchema.optional(),
  updatedAt: z.string(),
})

export type Catalyst = z.infer<typeof CatalystSchema>

/**
 * What a producer may write: a recorded catalyst is a citation like any other, so its page
 * address is held to the same envelope an evidence card or a brief link is. Only the write is:
 * Exa's addresses were stored as given, with no length bound, and a read that refused one
 * overlong legacy row would fail every visitor's snapshot rather than that row. Reads keep
 * `CatalystSchema`'s https rule, and every row written from here on meets both.
 */
export const RecordedCatalystSchema = CatalystSchema.extend({ sourceUrl: CitedSourceUrlSchema.optional() })

/** Calendar fields every visitor needs for stories and the runway. Description and source
 *  ride a per-symbol fetch, the same way year closes left the snapshot. */
export function snapshotCatalyst(catalyst: Catalyst): Catalyst {
  return {
    confidence: catalyst.confidence,
    date: catalyst.date,
    id: catalyst.id,
    kind: catalyst.kind,
    symbol: catalyst.symbol,
    timing: catalyst.timing,
    title: catalyst.title,
    updatedAt: catalyst.updatedAt,
  }
}

/**
 * What a catalyst search hands back to the reader who provoked it. `ran` is true only when a
 * search finished and answered; the rows already stored for the symbol reach the browser with
 * the next snapshot either way.
 */
export const CatalystRefreshSchema = z.strictObject({
  catalysts: z.array(CatalystSchema),
  ran: z.boolean(),
  // Why no search happened. Without it, "searched and found nothing", "refused, one ran this
  // month" and "not a name this site tracks" reach a reader as the same empty calendar.
  // `failed` is a search that was paid for and never answered, which says nothing about the
  // calendar and must not read as one searched and found empty.
  reason: z.enum(['failed', 'fresh', 'unknown-symbol', 'untracked']).optional(),
})

export type CatalystRefresh = z.infer<typeof CatalystRefreshSchema>

const KIND_PRIORITY = {
  earnings: 0,
  regulatory: 1,
  clinical: 2,
  'investor-event': 3,
  'product-event': 4,
  conference: 5,
  shareholder: 6,
} satisfies Record<Catalyst['kind'], number>

const MARKET_DATE_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
})

export function marketDate(date = new Date()): string {
  const parts = Object.fromEntries(MARKET_DATE_FORMATTER.formatToParts(date).map((part) => [part.type, part.value]))
  return `${parts.year}-${parts.month}-${parts.day}`
}

function epochDay(date: string): number {
  const [year, month, day] = date.split('-').map(Number)
  return Math.floor(Date.UTC(year, month - 1, day) / 86_400_000)
}

const CONFIDENCE_PRIORITY = {
  confirmed: 0,
  estimated: 1,
} satisfies Record<Catalyst['confidence'], number>

/**
 * Which of two sightings of the same event a reader is shown. A confirmed row beats an
 * estimated one, whichever producer wrote it; among rows of equal confidence the more recent
 * sighting wins, because a producer that looked again is answering for what is scheduled now --
 * so a broker calendar row the broker itself marked estimated yields to a newer estimated
 * search; then the id, so the choice is stable. Every `updatedAt` a producer writes is an ISO
 * instant, which compares lexically.
 */
function compareCatalystStanding(left: Catalyst, right: Catalyst): number {
  return CONFIDENCE_PRIORITY[left.confidence] - CONFIDENCE_PRIORITY[right.confidence]
    || right.updatedAt.localeCompare(left.updatedAt)
    || left.id.localeCompare(right.id)
}

/** Soonest date first, then by kind priority, then by standing. */
function compareCatalystOrder(left: Catalyst, right: Catalyst): number {
  return left.date.localeCompare(right.date)
    || KIND_PRIORITY[left.kind] - KIND_PRIORITY[right.kind]
    || compareCatalystStanding(left, right)
}

/**
 * Two producers that saw one event wrote two rows, and both are kept: each is answerable for
 * what it observed, and a search going quiet is not proof an event moved. A reader is looking
 * at a calendar rather than at our producers, so a display shows one row per event and lets
 * `compareCatalystStanding` say which, nearest first. Symbol, kind and date are that event's
 * identity here because they already are one to every research producer, each of which
 * refuses its own second sighting of them.
 *
 * Never a merge of the group: a timing or a link shown beside another producer's confidence
 * would be a claim no producer made, under a citation that does not support it. A row drops
 * whole, with whatever it alone carried.
 */
export function distinctCatalysts(catalysts: readonly Catalyst[]): Catalyst[] {
  const seen = new Set<string>()
  return [...catalysts].sort(compareCatalystOrder).filter((catalyst) => {
    const event = `${catalyst.symbol}:${catalyst.kind}:${catalyst.date}`
    if (seen.has(event)) return false
    seen.add(event)
    return true
  })
}

/** One pass that indexes the next dated event for every symbol at once. */
export function nextCatalystsBySymbol(
  catalysts: readonly Catalyst[],
  now: Date,
): ReadonlyMap<string, Catalyst> {
  const today = marketDate(now)
  const next = new Map<string, Catalyst>()
  for (const catalyst of catalysts) {
    if (catalyst.date < today) continue
    const current = next.get(catalyst.symbol)
    if (!current || compareCatalystOrder(catalyst, current) < 0) next.set(catalyst.symbol, catalyst)
  }
  return next
}

function daysUntilCatalyst(catalyst: Catalyst, now: Date): number {
  return epochDay(catalyst.date) - epochDay(marketDate(now))
}

export function upcomingCatalystsForSymbol(
  symbol: string,
  catalysts: readonly Catalyst[],
  now: Date,
): Catalyst[] {
  const today = marketDate(now)
  return distinctCatalysts(catalysts.filter(
    (catalyst) => catalyst.symbol === symbol && catalyst.date >= today,
  ))
}

/**
 * How far ahead a symbol has to be covered before a reader looking at it learns anything.
 * A calendar that is empty for the next month is the honest trigger for going and looking:
 * either nothing is scheduled, or nobody has searched this symbol yet.
 */
const CATALYST_NEAR_TERM_DAYS = 30

export function hasNearTermCatalyst(
  symbol: string,
  catalysts: readonly Catalyst[],
  now: Date,
): boolean {
  const horizon = addDays(marketDate(now), CATALYST_NEAR_TERM_DAYS)
  return upcomingCatalystsForSymbol(symbol, catalysts, now).some((catalyst) => catalyst.date <= horizon)
}

export function catalystLabel(catalyst: Catalyst, now: Date): string {
  const days = daysUntilCatalyst(catalyst, now)
  const event = ({
    earnings: 'EARN', 'investor-event': 'INVESTOR', 'product-event': 'PRODUCT', regulatory: 'REG',
    clinical: 'CLINICAL', conference: 'CONF', shareholder: 'VOTE',
  } satisfies Record<Catalyst['kind'], string>)[catalyst.kind]
  if (days === 0) return `${event} TODAY`
  return `${event} ${days}D`
}

const KIND_NAMES = {
  earnings: 'earnings',
  regulatory: 'regulatory',
  clinical: 'clinical',
  'investor-event': 'investor day',
  'product-event': 'product launch',
  conference: 'conference',
  shareholder: 'shareholder vote',
} satisfies Record<Catalyst['kind'], string>

/**
 * What a reader can open, if anything. A row's id names the producer that wrote it, and the
 * broker's earnings feed cites the API specification that documents the field — a page no
 * reader has any use for — so those rows carry no link at all. Everything else shows the
 * host it was read from: the producer's own name is an implementation detail of ours, not
 * something a reader is looking at when they check where a date came from.
 */
export function catalystSourceLink(catalyst: Catalyst): { host: string; url: string } | undefined {
  if (!catalyst.sourceUrl || catalyst.id.startsWith('tastytrade:')) return undefined
  const url = new URL(catalyst.sourceUrl)
  return { host: url.hostname.replace(/^www\./, ''), url: catalyst.sourceUrl }
}

export function catalystKindName(kind: Catalyst['kind']): string {
  return KIND_NAMES[kind]
}

export const CATALYST_KIND_NAMES: readonly string[] = CatalystKindSchema.options
  .slice()
  .sort((left, right) => KIND_PRIORITY[left] - KIND_PRIORITY[right])
  .map((kind) => KIND_NAMES[kind])

export function catalystCountdown(catalyst: Catalyst, now: Date): string {
  const days = daysUntilCatalyst(catalyst, now)
  return days <= 0 ? 'TODAY' : `${days}D`
}

export function catalystTimingLabel(timing: Catalyst['timing']): string | undefined {
  return ({
    'pre-market': 'Pre-market', intraday: 'Intraday', 'after-hours': 'After hours', unknown: undefined,
  } satisfies Record<Catalyst['timing'], string | undefined>)[timing]
}
