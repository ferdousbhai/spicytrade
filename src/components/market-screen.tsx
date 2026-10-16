import { memo, useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { ArrowDown, ArrowUp, ArrowUpRight, ChevronRight, Search, Star, X } from 'lucide-react'
import { matchSorter } from 'match-sorter'

import { Button } from '#/components/ui/button'
import { Card, CardContent, CardHeader } from '#/components/ui/card'
import { Drawer, DrawerClose, DrawerContent, DrawerTitle } from '#/components/ui/drawer'
import { Empty, EmptyDescription, EmptyHeader } from '#/components/ui/empty'
import { Progress } from '#/components/ui/progress'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '#/components/ui/table'
import { equitySymbolFromModelText } from '../domain/instrument'
import { RecommendationCard } from './brief-card'
import { cn } from '#/lib/utils'
import { type DailyBrief } from '../domain/brief'
import { latestSessionCandles, REGULAR_SESSION_MS, type CandlePoint } from '../domain/candle'
import {
  CATALYST_KIND_NAMES,
  catalystCountdown,
  catalystKindName,
  catalystLabel,
  catalystSourceLink,
  catalystTimingLabel,
  marketDate,
  nextCatalystsBySymbol,
  upcomingCatalystsForSymbol,
  type Catalyst,
} from '../domain/catalyst'
import {
  fiftyTwoWeekPosition,
  formatMarketMetric,
  formatMarketPrice,
  issuerName,
  tickerFromPublic,
  volatilityVerdict,
  type IvTermStructure,
  type Ticker,
  type PublicSymbolLookup,
  type VolatilityVerdict,
  type Watchlist,
} from '../domain/market'
import { sourceHost } from '../domain/https-url'
import { type SymbolEvidence } from '../domain/symbol-evidence'
import { useCatalystSearch } from '../data/catalyst-refresh'
import { usePublicCatalysts } from '../data/public-catalysts'
import { loadSymbolEvidence } from '../data/symbol-evidence'
import { useYearCandles } from '../data/year-candles'
import { useSymbolSearch, type SymbolSearchState } from '../data/symbol-search'
import { CatalystStories } from './catalyst-stories'
import { formatCalendarDay, nyDate } from './ny-time'
import { compactElapsedLabel, useElapsedLabel } from './top-bar'
import { useRetryOnFocus } from '../data/retry-on-focus'

const verdictCopy = {
  cheap: 'Cheap',
  fair: 'Fair',
  rich: 'Expensive',
  unavailable: 'Unavailable',
} satisfies Record<VolatilityVerdict, string>

const compactFormatter = new Intl.NumberFormat('en-US', {
  maximumFractionDigits: 1,
  notation: 'compact',
})

function compactMetric(value: number | undefined, prefix = ''): string {
  return value === undefined ? '—' : `${prefix}${compactFormatter.format(value)}`
}

function formatSignedMetric(value: number | undefined, suffix: string): string {
  if (value === undefined) return '—'
  return `${value > 0 ? '+' : ''}${formatMarketMetric(value)}${suffix}`
}

function assetLabel(ticker: Pick<Ticker, 'assetType'>): string | undefined {
  return ticker.assetType === 'etf' ? 'ETF' : ticker.assetType === 'index' ? 'Index' : undefined
}

type SortDirection = 'asc' | 'desc'
type SortKey = 'marketCap' | 'year' | 'volume' | 'premium' | 'liquidity'
type Sort = { direction: SortDirection; key: SortKey }

/** The breakpoint the year column appears at, so nothing loads history a screen cannot show. */
const WIDE_VIEWPORT = '(min-width: 1120px)'
/**
 * Below this the table gives way to a list. Eight columns need 850px, and a phone showed the
 * first three of them with the price off the right edge; a list keeps every row one screen
 * wide. It is the same bound the focus card stacks at, so both surfaces change shape together.
 */
const NARROW_VIEWPORT = '(max-width: 959px)'

function useMediaQuery(query: string): boolean {
  // Both callbacks are stable per query: React keys the subscription on the subscribe
  // identity, so a closure rebuilt on every render re-added the change listener on every
  // commit, and this screen commits on every live quote. The query list itself is still
  // resolved inside them, so a renderer without matchMedia — jsdom, or a server pass, which
  // reads the server snapshot instead — never touches `window` at all.
  const subscribe = useCallback((onChange: () => void) => {
    const list = window.matchMedia?.(query)
    list?.addEventListener('change', onChange)
    return () => list?.removeEventListener('change', onChange)
  }, [query])
  const getSnapshot = useCallback(() => window.matchMedia?.(query).matches ?? false, [query])
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

// Compact rows show the active ranking metric so the ordering is visible.
type ListMetric = 'change' | SortKey
const LIST_METRIC_LABELS = {
  change: 'Day change',
  marketCap: 'Market cap',
  premium: 'IV rank',
  volume: 'Volume',
  year: '1Y return',
  liquidity: 'Liquidity',
} satisfies Record<ListMetric, string>

type ListPill = { tone: 'down' | 'flat' | 'up' | VolatilityVerdict; value: string }

function changeTone(percent: number): 'up' | 'down' | 'flat' {
  return percent > 0 ? 'up' : percent < 0 ? 'down' : 'flat'
}

/**
 * How old a row's volatility readings are, read at render. Rows re-render with every snapshot
 * and live tick, which is at least as often as an hour-granular age can change meaningfully.
 */
function metricsAgeLabel(ticker: Pick<Ticker, 'metricsUpdatedAt'>): string | undefined {
  return ticker.metricsUpdatedAt === undefined ? undefined : compactElapsedLabel(ticker.metricsUpdatedAt, Date.now())
}

function listPill(ticker: Ticker, metric: ListMetric): ListPill {
  switch (metric) {
    case 'change':
      return {
        tone: changeTone(ticker.changePercent),
        value: formatSignedMetric(ticker.changePercent, '%'),
      }
    case 'premium': {
      // The verdict keeps the rank that produced it beside it, as the table's premium cell does,
      // and the age of both: the provider computes them on its own schedule.
      const verdict = volatilityVerdict(ticker)
      const rank = formatIfReported(ticker.ivRank, formatMarketMetric)
      const age = metricsAgeLabel(ticker)
      return {
        tone: verdict,
        value: [verdictCopy[verdict] + (rank === undefined ? '' : ` ${rank}`), age].filter(Boolean).join(' · '),
      }
    }
    case 'year': {
      const value = yearReturn(ticker)
      return { tone: value === undefined ? 'flat' : changeTone(value), value: formatSignedMetric(value, '%') }
    }
    case 'liquidity':
      return { tone: 'flat', value: liquidityLabel(ticker) ?? '—' }
    case 'volume':
      return { tone: 'flat', value: compactMetric(ticker.volume) }
    case 'marketCap':
      return { tone: 'flat', value: compactMetric(ticker.marketCap, '$') }
  }
}

/**
 * Each header carries its column's cell class, because the column widths live on those classes:
 * a table with no rows otherwise sized its columns from the header labels alone and the headers
 * shifted under a search that matched nothing.
 */
type MarketColumn = { cellClass: string; defaultDirection: SortDirection; key: SortKey | 'symbol' | 'price'; label: string }
const MARKET_COLUMNS: MarketColumn[] = [
  { cellClass: 'instrument-cell', defaultDirection: 'asc', key: 'symbol', label: 'Instrument' },
  { cellClass: 'market-cap-cell', defaultDirection: 'desc', key: 'marketCap', label: 'Market cap' },
  { cellClass: 'price-cell', defaultDirection: 'desc', key: 'price', label: 'Price' },
  { cellClass: 'year-cell', defaultDirection: 'desc', key: 'year', label: '1Y' },
  { cellClass: 'volume-cell', defaultDirection: 'desc', key: 'volume', label: 'Volume' },
  { cellClass: 'premium-cell', defaultDirection: 'desc', key: 'premium', label: 'IV rank' },
  { cellClass: 'liquidity-cell', defaultDirection: 'desc', key: 'liquidity', label: 'Liquidity' },
]

// Symbols and nominal share prices identify instruments; neither ranks opportunities.
type SortColumn = MarketColumn & { key: SortKey }
const isSortColumn = (column: MarketColumn): column is SortColumn => column.key !== 'price' && column.key !== 'symbol'
const SORT_COLUMNS = MARKET_COLUMNS.filter(isSortColumn)

/**
 * Percent move across the cached year. The anchor rides the snapshot and the current price is
 * live, so sorting and the label work without the series the chart draws from.
 */
function yearReturn(ticker: Pick<Ticker, 'price' | 'yearAgoClose'>): number | undefined {
  const first = ticker.yearAgoClose
  if (first === undefined || first <= 0) return undefined
  return ((ticker.price - first) / first) * 100
}

/*
 * Both sparklines draw into one 100-wide box, stretched to their CSS size. The line's extremes
 * stay inside a small top and bottom inset so a close at the high or low never runs its stroke
 * into the edge of the box.
 */
const SPARK_WIDTH = 100
const SPARK_HEIGHT = 26
const SPARK_TOP_INSET = 2
const SPARK_BOTTOM_INSET = 3
const SPARK_VIEW_BOX = `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`

/** Where a close sits in the box, from its place between the series' low and high. */
function sparkY(value: number, low: number, span: number): number {
  const drawable = SPARK_HEIGHT - SPARK_TOP_INSET - SPARK_BOTTOM_INSET
  return SPARK_HEIGHT - SPARK_BOTTOM_INSET - ((value - low) / span) * drawable
}

/** One polyline in the shared box, scaled between the series' low and high. */
function SparkPolyline({ className, points }: { className: string; points: ReadonlyArray<readonly [x: number, close: number]> }) {
  const closes = points.map(([, close]) => close)
  const low = Math.min(...closes)
  const span = Math.max(...closes) - low || 1
  const line = points
    .map(([x, close]) => `${x.toFixed(2)},${sparkY(close, low, span).toFixed(2)}`)
    .join(' ')
  return (
    <svg aria-hidden="true" className={`sparkline ${className}`} preserveAspectRatio="none" viewBox={SPARK_VIEW_BOX}>
      <polyline points={line} />
    </svg>
  )
}

/**
 * A year of daily closes reads on its own elapsed span rather than a fixed one: the series is
 * whatever the cache holds, so stretching it to the full width is honest here in a way it is
 * not for a session that has barely started. The caller guarantees at least two closes.
 */
function YearSparkline({ closes }: { closes: readonly number[] }) {
  const step = SPARK_WIDTH / (closes.length - 1)
  return <SparkPolyline className="year-sparkline" points={closes.map((close, index) => [index * step, close] as const)} />
}

/**
 * Draws one session, which the caller narrows: the stored series deliberately keeps the prior
 * session, so a guard on the stored length would pass on yesterday's bars while this session
 * holds one point, and the polyline would be a single vertex — an empty chart in a filled slot.
 */
function Sparkline({ session }: { session: readonly CandlePoint[] }) {
  // The axis is the whole session rather than the data it has so far, so a partial morning
  // draws a short line at the left instead of stretching a few bars across the full width.
  const openedAt = session[0]!.time
  const points = session.map((point) => [
    Math.min(SPARK_WIDTH, ((point.time - openedAt) / REGULAR_SESSION_MS) * SPARK_WIDTH),
    point.close,
  ] as const)
  return <SparkPolyline className="session-sparkline" points={points} />
}

const SORT_METRICS = {
  marketCap: (ticker) => ticker.marketCap,
  year: yearReturn,
  volume: (ticker) => ticker.volume,
  premium: (ticker) => ticker.ivRank,
  liquidity: (ticker) => ticker.liquidity,
} satisfies Record<SortKey, (ticker: Ticker) => number | undefined>

function compareBySort(left: Ticker, right: Ticker, sort: Sort): number {
  const leftValue = SORT_METRICS[sort.key](left)
  const rightValue = SORT_METRICS[sort.key](right)
  if (leftValue === undefined || rightValue === undefined) {
    return Number(leftValue === undefined) - Number(rightValue === undefined)
  }
  const delta = leftValue - rightValue
  return sort.direction === 'asc' ? delta : -delta
}

function termStructureLabel(term: IvTermStructure): string {
  const spread = term.frontIv - term.backIv // positive: front over back
  if (Math.abs(spread) < 1) return 'Flat'
  return spread > 0
    ? `Front +${formatMarketMetric(spread)} pts`
    : `Back +${formatMarketMetric(Math.abs(spread))} pts`
}

function yearRangeLabel(ticker: Pick<Ticker, 'price' | 'yearHigh' | 'yearLow'>): string | undefined {
  const position = fiftyTwoWeekPosition(ticker)
  if (position === undefined || ticker.yearLow === undefined || ticker.yearHigh === undefined) return undefined
  return `${formatMarketPrice(ticker.yearLow)}–${formatMarketPrice(ticker.yearHigh)} · ${Math.round(position)}%`
}

function formatIfReported<T>(reading: T | undefined, format: (reading: T) => string): string | undefined {
  return reading === undefined ? undefined : format(reading)
}

function liquidityLabel(ticker: Pick<Ticker, 'liquidity'>): string | undefined {
  return formatIfReported(ticker.liquidity, (liquidity) => `${formatMarketMetric(liquidity)}/5`)
}

function focusTape(ticker: Ticker): Array<[label: string, value: string]> {
  const reported: Array<[label: string, value: string | undefined]> = [
    ['IV', formatIfReported(ticker.ivIndex, (iv) => `${formatMarketMetric(iv)}%`)],
    ['HV30', formatIfReported(ticker.historicalVolatility30Day, (hv) => `${formatMarketMetric(hv)}%`)],
    ['IV−HV', formatIfReported(ticker.ivHistoricalVolatility30DayDifference, (gap) => formatSignedMetric(gap, ' pts'))],
    ['5d', formatIfReported(ticker.ivIndex5DayChange, (change) => formatSignedMetric(change, ' pts'))],
    ['Rank', formatIfReported(ticker.ivRank, formatMarketMetric)],
    ['Pct', formatIfReported(ticker.ivPercentile, formatMarketMetric)],
    ['Term', formatIfReported(ticker.ivTermStructure, termStructureLabel)],
    ['Liq', liquidityLabel(ticker)],
    ['Lend', ticker.lendability],
    ['Vol', formatIfReported(ticker.volume, compactMetric)],
    ['Cap', formatIfReported(ticker.marketCap, (cap) => compactMetric(cap, '$'))],
    ['52w', yearRangeLabel(ticker)],
  ]
  return reported.filter((entry): entry is [label: string, value: string] => entry[1] !== undefined)
}

/** The table's empty state and the status line above a partial list say the same thing. */
const SYMBOL_SEARCH_FAILED = 'Symbol search is unavailable. Showing the loaded list only.'

/** What an empty table says depends on how far the search got, not just that it found nothing. */
function searchEmptyMessage(query: string, status: SymbolSearchState['status']): string {
  if (!query) return 'No option metrics are available for this list.'
  if (status === 'searching') return `Searching every listed symbol for "${query}"\u2026`
  if (status === 'failed') return SYMBOL_SEARCH_FAILED
  return 'No listed symbol matches your search.'
}

const CATALYST_SCOPE = `${CATALYST_KIND_NAMES.slice(0, -1).join(', ')} and ${CATALYST_KIND_NAMES.at(-1)}`

/**
 * An empty calendar is one whose search is running, one whose search or read did not finish, one
 * a search just confirmed has nothing on it, or one this browser has not seen searched -- and only
 * a confirmed search may say nothing is scheduled.
 */
function RunwayEmpty({
  confirmedEmpty,
  failed,
  readFailed,
  searching,
  symbol,
}: {
  confirmedEmpty: boolean
  failed: boolean
  readFailed: boolean
  searching: boolean
  symbol: string
}) {
  const [heading, detail] = searching
    ? [
        'Looking for what’s coming.',
        ` Nothing is on ${symbol}'s calendar yet, so spicytrade is searching for scheduled ${CATALYST_SCOPE} dates.`,
      ]
    : failed
    ? [
        'The calendar search didn’t finish.',
        ` spicytrade couldn't search for ${symbol}'s scheduled ${CATALYST_SCOPE} dates just now, so this calendar is unknown rather than empty.`,
      ]
    : readFailed
    ? [
        'The calendar didn’t load.',
        ` spicytrade couldn't read ${symbol}'s ${CATALYST_SCOPE} dates just now, so this calendar is unknown rather than empty.`,
      ]
    : confirmedEmpty
    ? [
        'Searched — nothing scheduled.',
        ` spicytrade just searched for ${symbol}'s ${CATALYST_SCOPE} dates and found none. A re-rating from here would have to come from something unannounced.`,
      ]
    : [
        'Nothing is on the calendar.',
        ` spicytrade tracks ${CATALYST_SCOPE} dates for ${symbol} and has none on file.`,
      ]
  return (
    <div className="runway-empty" aria-live="polite">
      <p><strong>{heading}</strong><span className="runway-empty-detail">{detail}</span></p>
    </div>
  )
}

function CatalystRunway({
  catalysts,
  confirmedEmpty,
  failed,
  now,
  readFailed,
  searching,
  symbol,
}: {
  catalysts: readonly Catalyst[]
  confirmedEmpty: boolean
  failed: boolean
  now: Date
  /** The symbol's full rows could not be read, so the calendar shown may be missing some. */
  readFailed: boolean
  searching: boolean
  symbol: string
}) {
  const upcoming = upcomingCatalystsForSymbol(symbol, catalysts, now)

  return (
    <section className="focus-runway" aria-label="What&rsquo;s coming">
      {upcoming.length
        ? (
            <>
              <ol className="runway">
                {upcoming.map((catalyst, index) => {
                  const source = catalystSourceLink(catalyst)
                  return (
                    <li className={cn('runway-event', catalyst.confidence, index === 0 && 'next')} key={catalyst.id}>
                      <div className="runway-when">
                        <strong>{catalystCountdown(catalyst, now)}</strong>
                        <time dateTime={catalyst.date}>
                          {formatCalendarDay(catalyst.date)}
                        </time>
                      </div>
                      <span aria-hidden="true" className="runway-mark" />
                      <div className="runway-body">
                        {/* The date the source last stated this, so an estimate that has not been
                            revisited in months reads as exactly that. */}
                        <p className="runway-kind">
                          <span>
                            {[catalystKindName(catalyst.kind), catalystTimingLabel(catalyst.timing)]
                              .filter(Boolean)
                              .join(' · ')}
                          </span>
                          <span>
                            {catalyst.confidence} · as of{' '}
                            <time dateTime={catalyst.updatedAt}>{nyDate.format(new Date(catalyst.updatedAt))}</time>
                          </span>
                        </p>
                        <strong>{catalyst.title}</strong>
                        {catalyst.description && <p className="runway-detail">{catalyst.description}</p>}
                        {source && (
                          <a href={source.url} rel="noreferrer" target="_blank">
                            {source.host}<ArrowUpRight aria-hidden="true" />
                          </a>
                        )}
                      </div>
                    </li>
                  )
                })}
              </ol>
              {searching && (
                <p className="runway-searching" aria-live="polite">
                  <span aria-hidden="true" /> Searching for more {CATALYST_SCOPE} dates…
                </p>
              )}
              {failed && !searching && (
                <p className="runway-searching" aria-live="polite">
                  The search for more {CATALYST_SCOPE} dates didn’t finish.
                </p>
              )}
              {readFailed && (
                <p className="runway-searching" aria-live="polite">
                  {symbol}’s full calendar didn’t load; these are the dates spicytrade already had.
                </p>
              )}
            </>
          )
        : (
            <RunwayEmpty
              confirmedEmpty={confirmedEmpty}
              failed={failed}
              readFailed={readFailed}
              searching={searching}
              symbol={symbol}
            />
          )}
    </section>
  )
}

/**
 * What members' agents have quoted under this name.
 *
 * Every card is a passage the server re-read on the page it cites, so the quote is the source's
 * own words; the note beside it is the recorder's reading and is labelled as theirs. Nothing
 * renders when nothing has been recorded: an empty state here would explain a surface a reader
 * has no way to fill, and the runway already says what is known about the name.
 */
function EvidenceCards({ symbol }: { symbol: string }) {
  // The answer carries the symbol it answers, so the cards of the name a reader just left can
  // never stand under the one they moved to while its own request is still in flight.
  const [answer, setAnswer] = useState<
    { cards: readonly SymbolEvidence[]; symbol: string } | { failed: true; symbol: string }
  >()
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    const controller = new AbortController()
    loadSymbolEvidence(symbol, controller.signal)
      .then((cards) => { if (!controller.signal.aborted) setAnswer({ cards, symbol }) })
      // A read that failed is not a name nothing has been recorded under, so it says so in one
      // muted line instead of passing for the empty case, which renders nothing.
      .catch(() => { if (!controller.signal.aborted) setAnswer({ failed: true, symbol }) })
    return () => controller.abort()
  }, [attempt, symbol])

  const current = answer?.symbol === symbol ? answer : undefined
  const failed = current !== undefined && 'failed' in current
  // A failed read is asked again when the window regains focus, as the calendar and year series
  // are; a mounted card otherwise kept its failure for as long as the symbol stayed selected.
  useRetryOnFocus(failed, () => setAttempt((count) => count + 1))
  if (failed) {
    return (
      <section className="focus-evidence" aria-label="Evidence">
        <p className="evidence-unavailable">Evidence unavailable</p>
      </section>
    )
  }
  const cards = current?.cards ?? []
  if (!cards.length) return null
  return (
    <section className="focus-evidence" aria-labelledby="focus-evidence-title">
      <header className="focus-eyebrow">
        <h3 id="focus-evidence-title">Evidence</h3>
      </header>
      <ol className="evidence-cards">
        {cards.map((card) => (
          <li className="evidence-card" key={card.id}>
            <blockquote>{card.quote}</blockquote>
            {card.note && <p className="evidence-note">{card.note}</p>}
            <p className="evidence-meta">
              {card.byline && <span>{card.byline}</span>}
              <a href={card.sourceUrl} rel="noreferrer" target="_blank">
                {sourceHost(card.sourceUrl)}<ArrowUpRight aria-hidden="true" />
              </a>
              <time dateTime={card.recordedAt}>{nyDate.format(new Date(card.recordedAt))}</time>
            </p>
          </li>
        ))}
      </ol>
    </section>
  )
}

/** The pin affordance, shared by the table row, the phone row and the focus sheet. */
function PinButton({
  className,
  onToggle,
  pinned,
  symbol,
}: {
  className?: string
  onToggle: (symbol: string) => void
  pinned: boolean
  symbol: string
}) {
  return (
    <Button
      aria-label={`${pinned ? 'Unpin' : 'Pin'} ${symbol}`}
      aria-pressed={pinned}
      className={cn('pin-button', pinned && 'pinned', className)}
      onClick={() => onToggle(symbol)}
      size="icon-sm"
      type="button"
      variant="ghost"
    >
      <Star aria-hidden="true" fill={pinned ? 'currentColor' : 'none'} />
    </Button>
  )
}

/**
 * The row's own control: symbol, asset type, issuer and next catalyst, with the reading a
 * screen reader hears in place of the columns it cannot see. One definition, so the table row
 * and the phone row can never announce a name differently.
 */
function InstrumentButton({
  catalyst,
  isSelected,
  now,
  onSelect,
  ticker,
}: {
  catalyst: Catalyst | undefined
  isSelected: boolean
  now: Date
  onSelect: (symbol: string) => void
  ticker: Ticker
}) {
  const copy = verdictCopy[volatilityVerdict(ticker)]
  const type = assetLabel(ticker)
  const ivRank = ticker.ivRank === undefined ? '—' : formatMarketMetric(ticker.ivRank)
  const issuer = issuerName(ticker.name)

  return (
    <Button
      aria-label={`${ticker.symbol}, ${issuer}, ${copy} option premium, IV rank ${ivRank}`}
      aria-pressed={isSelected}
      className="ticker-table-button"
      onClick={() => onSelect(ticker.symbol)}
      type="button"
      variant="ghost"
    >
      <span>
        <strong>{ticker.symbol}</strong>
        {type ? <small>{type}</small> : null}
      </span>
      <small>{issuer}</small>
      {catalyst ? <small>{catalystLabel(catalyst, now)}</small> : null}
    </Button>
  )
}

// A live quote replaces one ticker object at a time, so memoizing on the default shallow
// prop compare keeps every other row off the render path. The screen passes only
// referentially stable props, `now` included.
const MarketTickerRow = memo(function MarketTickerRow({
  catalyst,
  isPinned,
  isSelected,
  now,
  onSelectTicker,
  onTogglePinned,
  ticker,
  yearCloses,
}: {
  catalyst: Catalyst | undefined
  isPinned: boolean
  isSelected: boolean
  now: Date
  onSelectTicker: (symbol: string) => void
  onTogglePinned: (symbol: string) => void
  ticker: Ticker
  yearCloses?: readonly number[]
}) {
  const verdict = volatilityVerdict(ticker)
  const rangePosition = fiftyTwoWeekPosition(ticker)
  const session = latestSessionCandles(ticker.sparkline)

  return (
    <TableRow data-state={isSelected ? 'selected' : undefined}>
      <TableCell className="pin-cell">
        <PinButton onToggle={onTogglePinned} pinned={isPinned} symbol={ticker.symbol} />
      </TableCell>
      <TableCell className="instrument-cell">
        <InstrumentButton
          catalyst={catalyst}
          isSelected={isSelected}
          now={now}
          onSelect={onSelectTicker}
          ticker={ticker}
        />
      </TableCell>
      <TableCell className="market-cap-cell">
        <strong>{compactMetric(ticker.marketCap, '$')}</strong>
      </TableCell>
      <TableCell className="price-cell">
        <div className="price-session">
          {/* Only a live candle series draws a session chart. */}
          {session.length > 2 ? <Sparkline session={session} /> : null}
          <span>
            <strong>{formatMarketPrice(ticker.price)}</strong>
            <small>{formatSignedMetric(ticker.changePercent, '%')}</small>
          </span>
        </div>
        {/* An unreported reading is left out rather than announced, as the focus tape does. */}
        {rangePosition === undefined
          ? null
          : <Progress className="price-range" aria-label={`${Math.round(rangePosition)}% of 52-week range`} value={rangePosition} />}
      </TableCell>
      {/* The series is fetched on its own, only where the column is drawn, so it is absent
          until that request answers. The move beside it needs only the snapshot's anchor. */}
      <TableCell className="year-cell">
        {yearCloses && yearCloses.length > 1 ? <YearSparkline closes={yearCloses} /> : null}
        <strong>{formatSignedMetric(yearReturn(ticker), '%')}</strong>
      </TableCell>
      {/* tastytrade reports equity day share volume here, not 24-hour or option-contract
          volume. */}
      <TableCell className="volume-cell">
        <strong>{compactMetric(ticker.volume)}</strong>
      </TableCell>
      {/* The IV level rides on the verdict's line and IV rank on the next, rather than columns
          of their own, so the verdict keeps the readings that produced it beside it. */}
      <TableCell className={`premium-cell ${verdict}`}>
        <span className="premium-reading">
          <small>{formatIfReported(ticker.ivIndex, (iv) => `${formatMarketMetric(iv)}% IV`) ?? '—'}</small>
          <strong>{verdictCopy[verdict]}</strong>
        </span>
        <small>
          {[formatIfReported(ticker.ivRank, (rank) => `${formatMarketMetric(rank)} rank`) ?? '—', metricsAgeLabel(ticker)]
            .filter(Boolean)
            .join(' · ')}
        </small>
      </TableCell>
      <TableCell className="liquidity-cell">
        <strong>{liquidityLabel(ticker) ?? '—'}</strong>
        {ticker.lendability ? <small>{ticker.lendability}</small> : null}
      </TableCell>
    </TableRow>
  )
})

/**
 * The phone row: what the table says, one screen wide. Symbol, issuer and next catalyst on the
 * left, the session chart when the feed carries one, and the active sorting metric
 * on the right. Memoized on the same terms as the table row.
 */
const MarketListRow = memo(function MarketListRow({
  catalyst,
  isPinned,
  isSelected,
  metric,
  now,
  onSelectTicker,
  onTogglePinned,
  ticker,
  yearCloses,
}: {
  catalyst: Catalyst | undefined
  isPinned: boolean
  isSelected: boolean
  metric: ListMetric
  now: Date
  onSelectTicker: (symbol: string) => void
  onTogglePinned: (symbol: string) => void
  ticker: Ticker
  yearCloses?: readonly number[]
}) {
  const pill = listPill(ticker, metric)
  const session = latestSessionCandles(ticker.sparkline)

  return (
    <li className="watch-row" data-state={isSelected ? 'selected' : undefined}>
      <PinButton onToggle={onTogglePinned} pinned={isPinned} symbol={ticker.symbol} />
      <InstrumentButton
        catalyst={catalyst}
        isSelected={isSelected}
        now={now}
        onSelect={onSelectTicker}
        ticker={ticker}
      />
      {/* The session chart when the feed carries one; otherwise the year, which every reader
          has. A row with neither draws nothing rather than a synthetic two-point line. */}
      {session.length > 2
        ? <Sparkline session={session} />
        : yearCloses && yearCloses.length > 1 ? <YearSparkline closes={yearCloses} /> : null}
      <div className="watch-row-quote">
        <span className="watch-pill" data-tone={pill.tone}>
          {pill.value}
        </span>
        <small>{LIST_METRIC_LABELS[metric]}</small>
      </div>
    </li>
  )
})

/** The table's sortable headers, as one control a phone has room for. */
function SortControl({
  relevance,
  onChange,
  sort,
}: {
  relevance: boolean
  onChange: (sort: Sort) => void
  sort: Sort
}) {
  const flipped = sort.direction === 'asc' ? 'desc' : 'asc'
  return (
    <div className="watch-sort">
      <select
        aria-label="Sort by"
        onChange={(event) => {
          const column = SORT_COLUMNS.find((candidate) => candidate.key === event.target.value)
          if (column) onChange({ direction: column.defaultDirection, key: column.key })
        }}
        value={relevance ? 'relevance' : sort.key}
      >
        {relevance && <option value="relevance">Relevance</option>}
        {SORT_COLUMNS.map((column) => <option key={column.key} value={column.key}>{column.label}</option>)}
      </select>
      <button
        disabled={relevance}
        aria-label={`Sort ${flipped === 'asc' ? 'ascending' : 'descending'}`}
        className="sort-button"
        onClick={() => onChange({ direction: flipped, key: sort.key })}
        type="button"
      >
        {sort.direction === 'asc' ? <ArrowUp aria-hidden="true" /> : <ArrowDown aria-hidden="true" />}
      </button>
    </div>
  )
}

export function MarketScreen({
  activeWatchlist,
  catalysts,
  onSelectTicker,
  onTogglePinned,
  pinnedSymbols,
  brief,
  selected,
  tickers,
}: {
  activeWatchlist: Watchlist
  catalysts: Catalyst[]
  onSelectTicker: (symbol: string, lookup?: PublicSymbolLookup) => void
  onTogglePinned: (symbol: string, lookup?: PublicSymbolLookup) => void
  pinnedSymbols: readonly string[]
  brief?: DailyBrief
  selected: Ticker
  tickers: Ticker[]
}) {
  const marketDay = marketDate()
  // Every catalyst label here is day-granular, so the screen's clock advances only with the
  // New York market date: a `now` rebuilt on each render would re-render every memoized row
  // for labels that cannot have changed. Midday UTC falls on the same New York day, so this
  // anchor reads back as `marketDay`.
  const now = useMemo(() => new Date(`${marketDay}T12:00:00Z`), [marketDay])
  const [sort, setSort] = useState<Sort>({ direction: 'desc', key: 'volume' })
  const [query, setQuery] = useState('')
  const [searchSort, setSearchSort] = useState(false)
  // On a phone the focus card lives in a sheet over the list, so the list is the screen.
  const [detailOpen, setDetailOpen] = useState(false)
  const narrow = useMediaQuery(NARROW_VIEWPORT)
  const pinned = useMemo(() => new Set(pinnedSymbols), [pinnedSymbols])
  const tickersBySymbol = useMemo(() => {
    const index = new Map<string, Ticker>()
    for (const ticker of tickers) {
      if (!index.has(ticker.symbol)) index.set(ticker.symbol, ticker)
    }
    return index
  }, [tickers])
  const trimmedQuery = equitySymbolFromModelText(query) ?? query.trim()
  const matched = useMemo(() => trimmedQuery
    ? matchSorter(tickers, trimmedQuery, { keys: ['symbol', 'name'] })
    : activeWatchlist.symbols.flatMap((symbol) => {
        const ticker = tickersBySymbol.get(symbol)
        return ticker ? [ticker] : []
      }), [activeWatchlist.symbols, tickers, tickersBySymbol, trimmedQuery])
  // A fuzzy local match is not proof that the catalog lacks the exact requested symbol.
  const unlisted = Boolean(trimmedQuery) && !tickersBySymbol.has(trimmedQuery.toUpperCase())
  const search = useSymbolSearch(trimmedQuery, unlisted)
  const lookup = search.status === 'found' ? search.lookup : undefined
  const found = lookup && tickerFromPublic(lookup.ticker)
  const universe = found && !matched.some((ticker) => ticker.symbol === found.symbol)
    ? [found, ...matched]
    : matched
  const relevance = Boolean(trimmedQuery) && !searchSort
  // Favorites always lead, under every sort and search; the metric or relevance orders within
  // each group. Keeping the reader's own picks on top is the point of favoriting.
  const watchTickers = [...universe].sort((left, right) =>
    Number(pinned.has(right.symbol)) - Number(pinned.has(left.symbol))
    || (relevance ? 0 : compareBySort(left, right, sort)
      || left.symbol.localeCompare(right.symbol)))
  const selectResult = useCallback((symbol: string) => {
    onSelectTicker(symbol, lookup?.ticker.symbol === symbol ? lookup : undefined)
  }, [onSelectTicker, lookup])
  const toggleResultPinned = useCallback((symbol: string) => {
    onTogglePinned(symbol, lookup?.ticker.symbol === symbol ? lookup : undefined)
  }, [onTogglePinned, lookup])
  // Looking at a symbol with an empty month asks the server to go and find out. What comes
  // back joins the calendar on this visit rather than waiting for the next snapshot.
  const catalystSearch = useCatalystSearch(selected.symbol, catalysts, now)
  const focusedRead = usePublicCatalysts(selected.symbol)
  // The year series is fetched only where something draws it: the table's year column at the
  // wide breakpoint, and every phone row, which has the room the table's middle widths lack.
  const yearCandles = useYearCandles(useMediaQuery(WIDE_VIEWPORT) || narrow)
  // A tap on a phone both selects and opens the detail, as a stocks app does; a wide screen
  // keeps the card beside the list and only selects.
  const selectFromList = useCallback((symbol: string) => {
    selectResult(symbol)
    if (narrow) setDetailOpen(true)
  }, [narrow, selectResult])
  // The search state is a new object on every render, so the merge watches the catalysts a
  // found symbol carried rather than the state that carried them, and holds between searches.
  const looked = lookup?.catalysts
  const visibleCatalysts = useMemo(() => {
    // Later rows win by id, so a row a search just bound replaces the snapshot's copy of it.
    const merged = new Map(
      [...catalysts, ...(looked ?? []), ...catalystSearch.catalysts, ...focusedRead.catalysts]
        .map((catalyst) => [catalyst.id, catalyst]),
    )
    return [...merged.values()]
  }, [catalysts, catalystSearch.catalysts, focusedRead.catalysts, looked])
  const nextCatalysts = nextCatalystsBySymbol(visibleCatalysts, now)
  // Choosing a sort, from a header or the phone's control, leaves search relevance behind.
  const applySort = (next: Sort) => {
    setSort(next)
    setSearchSort(true)
  }
  const toggleSort = (column: SortColumn) => applySort(sort.key === column.key
    ? { direction: sort.direction === 'asc' ? 'desc' : 'asc', key: column.key }
    : { direction: column.defaultDirection, key: column.key })
  const pinnedTickers = tickers.filter((ticker) => pinned.has(ticker.symbol))
  const selectedVerdict = volatilityVerdict(selected)
  const selectedCopy = verdictCopy[selectedVerdict]
  const selectedAsset = assetLabel(selected)
  const selectedRecommendation = brief?.recommendations.find((recommendation) => recommendation.symbol === selected.symbol)
  const selectedTape = focusTape(selected)
  // Two ages, because they are two facts: the quote moves with the market, while the provider
  // recomputes volatility and liquidity on its own schedule and can leave them hours behind.
  // One "updated" label for the card would let the newer of the two vouch for the older.
  const quoteAge = useElapsedLabel(selected.updatedAt)
  const metricsAge = useElapsedLabel(selected.metricsUpdatedAt)
  const selectedCatalyst = nextCatalysts.get(selected.symbol)
  const selectedRank = formatIfReported(selected.ivRank, formatMarketMetric)

  const focusCard = (
      <Card className={cn('instrument-focus', selectedVerdict)} aria-labelledby="selected-instrument-title">
        <CardHeader>
          <div className="selected-summary">
            <div className="selected-instrument">
              <h2 className="selected-symbol" id="selected-instrument-title">{selected.symbol}</h2>
              <p>{issuerName(selected.name)}{selectedAsset ? ` · ${selectedAsset}` : ''}</p>
            </div>
            <div className="selected-price">
              <strong>{formatMarketPrice(selected.price)}</strong>
              <span>{formatSignedMetric(selected.changePercent, '%')}</span>
            </div>
          </div>
          {/* The premium verdict keeps the product's gradient axis, at a scale that
              leaves the recommendation and the runway as the panel's primary reading. */}
          <div className="premium-gauge">
            <span>Option premium</span>
            <strong className="premium-verdict">{selectedCopy}</strong>
            {selected.ivRank === undefined ? null : (
              <Progress className="premium-axis" aria-label={`IV rank ${selected.ivRank} out of 100`} value={selected.ivRank} />
            )}
          </div>
        </CardHeader>
        <CardContent className="focus-narrative">
          {/* What a reader reads, then the numbers under it: one column dissolves this wrapper into
              the narrative grid, and the wide layout makes it the main column beside the rail
              (see .instrument-focus in styles.css). */}
          <div className="focus-reading">
            {selectedRecommendation && (
              <section aria-labelledby="focus-recommendation-title" className="focus-recommendation">
                <header className="focus-eyebrow"><h3 id="focus-recommendation-title">Recommendation</h3></header>
                <RecommendationCard recommendation={selectedRecommendation} />
              </section>
            )}
            <EvidenceCards symbol={selected.symbol} />
            <section aria-label={`${selected.symbol} metrics`} className="focus-metrics">
              <dl className="focus-tape">
                {selectedTape.map(([label, value]) => (
                  <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
                ))}
              </dl>
              <p className="focus-freshness">
                <span>Quote <time dateTime={selected.updatedAt}>{quoteAge}</time></span>
                <span>
                  {'IV & liquidity '}
                  {selected.metricsUpdatedAt
                    ? <time dateTime={selected.metricsUpdatedAt}>{metricsAge}</time>
                    : 'age not reported'}
                </span>
              </p>
            </section>
          </div>
          <CatalystRunway
            catalysts={visibleCatalysts}
            confirmedEmpty={catalystSearch.confirmedEmpty}
            failed={catalystSearch.failed}
            now={now}
            readFailed={focusedRead.failed}
            searching={catalystSearch.searching}
            symbol={selected.symbol}
          />
        </CardContent>
      </Card>
  )

  const emptyResult = (
    <Empty className="watch-empty">
      <EmptyHeader>
        <EmptyDescription>
          {searchEmptyMessage(trimmedQuery, search.status)}
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  )

  return (
    <div className="market-screen">
      {/* No screen spends a band on an empty rail; the star on every row says what pinning does. */}
      {pinnedTickers.length > 0 && (
        <CatalystStories nextCatalysts={nextCatalysts} now={now} onSelect={selectFromList} tickers={pinnedTickers} />
      )}

      {narrow ? (
        <>
          {/* The selected name in two lines, so the list can be the screen without losing the
              reading a tap just changed. The full card is one tap away in the sheet. */}
          <button
            aria-label={`Open ${selected.symbol} detail`}
            className={cn('focus-strip', selectedVerdict)}
            onClick={() => setDetailOpen(true)}
            type="button"
          >
            <span className="focus-strip-name">
              <strong className="focus-strip-symbol">{selected.symbol}</strong>
              <small>{issuerName(selected.name)}</small>
            </span>
            <span className="focus-strip-quote">
              <strong>{formatMarketPrice(selected.price)}</strong>
              <small data-tone={changeTone(selected.changePercent)}>
                {formatSignedMetric(selected.changePercent, '%')}
              </small>
            </span>
            <span className="focus-strip-read">
              <em className="strip-verdict">{selectedCopy}</em>
              {selectedRank === undefined ? '' : ` ${selectedRank}`}
              {formatIfReported(selected.ivIndex, (iv) => ` · IV ${formatMarketMetric(iv)}%`) ?? ''}
              {selectedCatalyst ? ` · ${catalystLabel(selectedCatalyst, now)}` : ''}
            </span>
            <ChevronRight aria-hidden="true" />
          </button>
          <Drawer onOpenChange={setDetailOpen} open={detailOpen} showSwipeHandle>
            <DrawerContent className="focus-sheet">
              <DrawerTitle className="sr-only">{selected.symbol} detail</DrawerTitle>
              {/* The pin travels with the card, so a reader deciding on a name in the sheet
                  need not go back to the row to keep it. */}
              <PinButton
                className="focus-sheet-pin"
                onToggle={onTogglePinned}
                pinned={pinned.has(selected.symbol)}
                symbol={selected.symbol}
              />
              <DrawerClose aria-label="Close detail" className="focus-sheet-close">
                <X aria-hidden="true" />
              </DrawerClose>
              <div className="focus-sheet-scroll">{focusCard}</div>
            </DrawerContent>
          </Drawer>
        </>
      ) : focusCard}

      <section
        className="watch-table"
        aria-label={activeWatchlist.kind === 'public' ? activeWatchlist.name : undefined}
        aria-labelledby={activeWatchlist.kind === 'private' ? 'watch-title' : undefined}
      >
        <header className="section-header">
          <h2 className="watchlist-title" id="watch-title">{activeWatchlist.kind === 'public' ? 'Watchlist' : activeWatchlist.name}</h2>
          <div className="watch-search">
            <Search aria-hidden="true" />
            <input
              aria-label="Search all symbols"
              name="symbol-search"
              onChange={(event) => {
                setQuery(event.target.value)
                setSearchSort(false)
              }}
              placeholder="Search all symbols"
              type="search"
              value={query}
            />
          </div>
          {narrow && <SortControl onChange={applySort} sort={sort} relevance={relevance} />}
        </header>
        {watchTickers.length > 0 && search.status === 'failed' && (
          <p className="watch-status" role="status">{SYMBOL_SEARCH_FAILED}</p>
        )}
        {/* The year's move rides the snapshot and stays; only the chart beside it is missing,
            and an empty chart slot must not read as a year with nothing in it. */}
        {yearCandles.failed && (
          <p className="watch-status" role="status">Year charts are unavailable just now.</p>
        )}
        {narrow ? (
          <ol className="watch-list">
            {watchTickers.map((ticker) => (
              <MarketListRow
                catalyst={nextCatalysts.get(ticker.symbol)}
                isPinned={pinned.has(ticker.symbol)}
                isSelected={ticker.symbol === selected.symbol}
                key={ticker.symbol}
                metric={relevance ? 'change' : sort.key}
                now={now}
                onSelectTicker={selectFromList}
                onTogglePinned={toggleResultPinned}
                ticker={ticker}
                yearCloses={yearCandles.series.get(ticker.symbol)}
              />
            ))}
            {!watchTickers.length && (
              <li>{emptyResult}</li>
            )}
          </ol>
        ) : (
        <Table className="premium-data-table">
          <TableHeader>
            <TableRow>
              <TableHead className="pin-cell"><span className="sr-only">Pinned</span></TableHead>
              {MARKET_COLUMNS.map((column) => (
                <TableHead
                  aria-sort={!relevance && sort.key === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined}
                  className={column.cellClass}
                  key={column.key}
                >
                  {!isSortColumn(column) ? column.label : (
                  <button className="sort-button" onClick={() => toggleSort(column)} type="button">
                    {column.label}
                    {!relevance && sort.key === column.key && (sort.direction === 'asc'
                      ? <ArrowUp aria-hidden="true" />
                      : <ArrowDown aria-hidden="true" />)}
                  </button>
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {watchTickers.map((ticker) => (
              <MarketTickerRow
                catalyst={nextCatalysts.get(ticker.symbol)}
                isPinned={pinned.has(ticker.symbol)}
                isSelected={ticker.symbol === selected.symbol}
                key={ticker.symbol}
                now={now}
                onSelectTicker={selectResult}
                onTogglePinned={toggleResultPinned}
                ticker={ticker}
                yearCloses={yearCandles.series.get(ticker.symbol)}
              />
            ))}
            {!watchTickers.length && (
              <TableRow>
                <TableCell colSpan={MARKET_COLUMNS.length + 1}>{emptyResult}</TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        )}
      </section>
    </div>
  )
}
