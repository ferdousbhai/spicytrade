import { Link } from '@tanstack/react-router'

import { type ClosedPosition, type OpenPosition, positionMove } from '../domain/brief'
import { type PositionsPageData } from '../domain/public-page'
import { DIRECTION_LABELS } from './brief-page'
import { Disclaimer } from './disclaimer'
import { formatCalendarDay } from './ny-time'
import { SitePage } from './site-page'
import { ThesisMarkdown } from './thesis-markdown'

const dollars = new Intl.NumberFormat('en-US', { currency: 'USD', style: 'currency' })
const percent = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1, minimumFractionDigits: 1, signDisplay: 'exceptZero', style: 'percent' })

function Day({ date }: { date: string }) {
  return <time dateTime={date}>{formatCalendarDay(date)}</time>
}

/** The name, linked to its symbol page when it has one, and the way the position leans. */
function PositionName({ linked, position }: { linked: ReadonlySet<string>; position: OpenPosition | ClosedPosition }) {
  return (
    <h3>
      {linked.has(position.symbol)
        ? <Link params={{ symbol: position.symbol }} to="/options/$symbol">{position.symbol}</Link>
        : position.symbol}
      <span>{DIRECTION_LABELS[position.direction]}</span>
    </h3>
  )
}

/** A call's full write-up, folded away under its one line so the list stays a list. */
function Reasoning({ label, text }: { label: string; text: string | undefined }) {
  if (!text) return null
  return (
    <details className="public-position-reasoning">
      <summary>{label}</summary>
      <ThesisMarkdown text={text} />
    </details>
  )
}

/**
 * How the stock moved while a closed position was open, signed the way the position leaned: a
 * gain is the stock going the call's way. It is the underlying's move, never the option's
 * return, and the page says so once above the list.
 */
function Move({ position }: { position: ClosedPosition }) {
  const move = positionMove(position)
  if (!move) return null
  const label = move.favour === null
    ? `The stock moved ${percent.format(move.change)}`
    : `The stock moved ${percent.format(Math.abs(move.change)).replace('+', '')} ${move.favour} the call`
  return <span aria-label={label} className="public-position-move" data-favour={move.favour ?? undefined} role="img" title={label}>{percent.format(move.change)}</span>
}

/**
 * The book (`/positions`): every position the daily brief has open, with the one line it rests on
 * and the latest reason it was kept, then the ones it has closed, with what changed. Every string
 * here is the producer's and is escaped by React.
 */
export function PositionsPage({ page }: { page: PositionsPageData }) {
  const { marketDate, positions } = page
  const linked = new Set(page.symbolsWithPages)
  return (
    <SitePage
      intro="Every position the daily brief has open, with the premise it rests on, and the ones it has closed, with what changed."
      title="Positions"
    >
      <section aria-label="About these positions">
        {positions && marketDate
          ? <p className="public-page-meta">As of the brief for <Link params={{ date: marketDate }} to="/briefs/$date"><Day date={marketDate} /></Link></p>
          : <p>No positions have been published yet. They arrive with the next brief.</p>}
        <nav aria-label="Briefs" className="public-brief-nav">
          <Link to="/briefs">All briefs</Link>
        </nav>
      </section>
      {positions && (
        <>
          <section aria-labelledby="open-positions">
            <h2 id="open-positions">Open <span className="public-position-count">{positions.open.length}</span></h2>
            {positions.open.length === 0 && <p>Nothing is open. No position is the brief's default.</p>}
            <ol className="public-positions">
              {positions.open.map((position) => (
                <li key={position.symbol}>
                  <div className="public-position-head"><PositionName linked={linked} position={position} /></div>
                  <strong className="trade-line">{position.trade}</strong>
                  {position.premise && <p className="public-position-premise">{position.premise}</p>}
                  {position.hold && <p><span className="public-position-label">Held <Day date={position.hold.date} /></span> {position.hold.reason}</p>}
                  <p className="public-page-meta">
                    Opened <Day date={position.openedOn} />
                    {position.entryPrice !== undefined && ` at ${dollars.format(position.entryPrice)}`}
                    {position.model && ` by ${position.model}`}
                  </p>
                  <Reasoning label="Why it was opened" text={position.reasoning} />
                </li>
              ))}
            </ol>
          </section>
          <section aria-labelledby="closed-positions">
            <h2 id="closed-positions">Closed <span className="public-position-count">{positions.closed.length}</span></h2>
            {positions.closed.length === 0
              ? <p>Nothing has been closed yet.</p>
              : <p className="public-page-meta">The percentage is the stock's move while the position was open, counted in the position's favour. It is not the option's return.</p>}
            <ol className="public-positions">
              {positions.closed.map((position) => (
                <li key={`${position.symbol}-${position.openedOn}`}>
                  <div className="public-position-head"><PositionName linked={linked} position={position} /><Move position={position} /></div>
                  <strong className="trade-line">{position.trade}</strong>
                  {position.reason && <p><span className="public-position-label">Closed</span> {position.reason}</p>}
                  <p className="public-page-meta">
                    <Day date={position.openedOn} /> to <Day date={position.closedOn} />
                    {position.entryPrice !== undefined && position.exitPrice !== undefined && ` · ${dollars.format(position.entryPrice)} to ${dollars.format(position.exitPrice)}`}
                  </p>
                  {(position.model || position.closedBy) && (
                    <p className="public-page-meta">
                      {position.model && `Opened by ${position.model}`}
                      {position.model && position.closedBy && ', '}
                      {position.closedBy && `${position.model ? 'closed' : 'Closed'} by ${position.closedBy}`}
                    </p>
                  )}
                  <Reasoning label="Why it was opened" text={position.reasoning} />
                  <Reasoning label="Why it was closed" text={position.closeReasoning} />
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
      <Disclaimer className="public-page-disclaimer" />
    </SitePage>
  )
}
