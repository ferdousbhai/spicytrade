import { Link } from '@tanstack/react-router'

import { catalystKindName, catalystSourceLink, catalystTimingLabel, type Catalyst } from '../domain/catalyst'
import { formatMarketMetric, formatMarketPrice, issuerName, MARKET_STATE_LABELS, type PublicTicker } from '../domain/market'
import { type SymbolPageData } from '../domain/public-page'
import { RecommendationCard } from './brief-card'
import { Disclaimer } from './disclaimer'
import { formatCalendarDay, nyDateTime } from './ny-time'
import { DIRECTION_LABELS } from './brief-page'
import { SitePage } from './site-page'

const compact = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, notation: 'compact' })
const signed = (value: number, format: (magnitude: number) => string) => `${value > 0 ? '+' : value < 0 ? '−' : ''}${format(Math.abs(value))}`
const percent = (value: number) => `${formatMarketMetric(value)}%`
const points = (value: number) => `${formatMarketMetric(value)} pts`

/** A stored instant in New York time, marked up as the instant it is. */
function Instant({ at }: { at: string }) {
  return <time dateTime={at}>{nyDateTime.format(new Date(at))}</time>
}

/**
 * Every reading the public ticker carries, in the units the live table prints them in. A reading
 * the provider did not report is left out rather than printed as a zero or a dash a crawler
 * would index as a value.
 */
function readings(ticker: PublicTicker): Array<[label: string, value: string]> {
  const rows: Array<[string, string | undefined]> = [
    ['Price', formatMarketPrice(ticker.price)],
    ['Change', `${signed(ticker.change, formatMarketPrice)} (${signed(ticker.changePercent, (value) => `${value.toFixed(2)}%`)})`],
    ['IV rank', ticker.ivRank === undefined ? undefined : formatMarketMetric(ticker.ivRank)],
    ['IV percentile', ticker.ivPercentile === undefined ? undefined : formatMarketMetric(ticker.ivPercentile)],
    ['Implied volatility', ticker.ivIndex === undefined ? undefined : percent(ticker.ivIndex)],
    ['Implied volatility, 5-day change', ticker.ivIndex5DayChange === undefined ? undefined : signed(ticker.ivIndex5DayChange, points)],
    ['Historical volatility, 30-day', ticker.historicalVolatility30Day === undefined ? undefined : percent(ticker.historicalVolatility30Day)],
    ['Implied minus historical volatility', ticker.ivHistoricalVolatility30DayDifference === undefined ? undefined : signed(ticker.ivHistoricalVolatility30DayDifference, points)],
    ['Implied volatility term structure', ticker.ivTermStructure === undefined
      ? undefined
      : `${percent(ticker.ivTermStructure.frontIv)} for ${formatCalendarDay(ticker.ivTermStructure.frontExpiration)}, ${percent(ticker.ivTermStructure.backIv)} for ${formatCalendarDay(ticker.ivTermStructure.backExpiration)}`],
    ['Options liquidity', ticker.liquidity === undefined ? undefined : `${formatMarketMetric(ticker.liquidity)}/5`],
    ['Share volume', ticker.volume === undefined ? undefined : compact.format(ticker.volume)],
    ['Market cap', ticker.marketCap === undefined ? undefined : `$${compact.format(ticker.marketCap)}`],
    ['52-week range', ticker.yearLow === undefined || ticker.yearHigh === undefined ? undefined : `${formatMarketPrice(ticker.yearLow)}–${formatMarketPrice(ticker.yearHigh)}`],
    ['Lendability', ticker.lendability],
    ['Next earnings', ticker.earningsDate ? formatCalendarDay(ticker.earningsDate) : undefined],
  ]
  return rows.flatMap(([label, value]) => (value === undefined ? [] : [[label, value]]))
}

function CatalystRow({ catalyst }: { catalyst: Catalyst }) {
  const source = catalystSourceLink(catalyst)
  const timing = catalystTimingLabel(catalyst.timing)
  return (
    <li>
      <p className="public-catalyst-when">
        <time dateTime={catalyst.date}>{formatCalendarDay(catalyst.date)}</time>
        {` · ${catalystKindName(catalyst.kind)} · ${catalyst.confidence}`}
        {timing ? ` · ${timing}` : null}
      </p>
      {/* Title and description are provider or research text: React escapes them. */}
      <h3>{catalyst.title}</h3>
      {catalyst.description ? <p>{catalyst.description}</p> : null}
      {source ? <p><a href={source.url} rel="noreferrer" target="_blank">{source.host}</a></p> : null}
    </li>
  )
}

/**
 * One symbol's server-rendered page (`/options/$symbol`): what the stored public snapshot holds
 * for it, the dated events already on its calendar, and the latest brief that argued it. It
 * shows stored state only and says so where the calendar is empty -- an empty calendar here is
 * not a search that found nothing, because this page never runs one.
 */
export function SymbolPage({ page }: { page: SymbolPageData }) {
  const { catalysts, recommendation, ticker } = page
  const name = issuerName(ticker.name)
  return (
    <SitePage
      intro={`${name}: implied volatility, options liquidity and upcoming catalysts, as the public market snapshot holds them.`}
      title={`${ticker.symbol} options`}
    >
      <section aria-labelledby="symbol-readings-title">
        <h2 id="symbol-readings-title">Price and volatility</h2>
        <p className="public-page-meta">
          {MARKET_STATE_LABELS[page.marketState]} · stored <Instant at={page.syncedAt} />
          {' · quote '}<Instant at={ticker.updatedAt} />
          {ticker.metricsUpdatedAt ? <>{' · volatility readings '}<Instant at={ticker.metricsUpdatedAt} /></> : null}
        </p>
        <dl className="public-readings">
          {readings(ticker).map(([label, value]) => (
            <div key={label}><dt>{label}</dt><dd>{value}</dd></div>
          ))}
        </dl>
        <p>Data may be delayed. <Link to="/watch">Open the live watchlist</Link> for streaming quotes, the year chart and the option chain for {ticker.symbol}.</p>
      </section>
      <section aria-labelledby="symbol-catalysts-title">
        <h2 id="symbol-catalysts-title">Upcoming catalysts</h2>
        {catalysts.length
          ? <ol className="public-catalysts">{catalysts.map((catalyst) => <CatalystRow catalyst={catalyst} key={catalyst.id} />)}</ol>
          : <p>No upcoming dated event is stored for {ticker.symbol}. This page shows what is already on the calendar and does not run a search.</p>}
      </section>
      <section aria-labelledby="symbol-brief-title">
        <h2 id="symbol-brief-title">Latest brief recommendation</h2>
        {recommendation
          ? (
            <>
              <p className="public-page-meta">
                {recommendation.recommendation.direction ? `${DIRECTION_LABELS[recommendation.recommendation.direction]} · argued on ` : 'Exit argued on '}
                <Link params={{ date: recommendation.marketDate }} to="/briefs/$date">
                  <time dateTime={recommendation.marketDate}>{formatCalendarDay(recommendation.marketDate)}</time>
                </Link>
              </p>
              <RecommendationCard recommendation={recommendation.recommendation} />
            </>
          )
          : <p>No published brief has recommended {ticker.symbol}. <Link to="/briefs">All briefs</Link>.</p>}
        <Disclaimer className="public-page-disclaimer" />
      </section>
    </SitePage>
  )
}
