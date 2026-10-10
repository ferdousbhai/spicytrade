import { z } from 'zod'

// dxFeed delivers history as a snapshot transaction rather than a plain run of events.
const DXLINK_TX_PENDING = 0x1
export const DXLINK_REMOVE_EVENT = 0x2
export const DXLINK_SNAPSHOT_BEGIN = 0x4
export const DXLINK_SNAPSHOT_END = 0x8
export const DXLINK_SNAPSHOT_SNIP = 0x10

// A regular US equity session is 6.5 hours, which the 1D chart draws end to end.
export const REGULAR_SESSION_MS = (6 * 60 + 30) * 60 * 1_000
// Two sessions are kept, not one: the newest is what the chart draws, and holding the prior
// session means the column still shows a full day before today's opening bell. Trimming by bar
// count rather than by session is what keeps it there across the overnight gap and the weekend.
export const MAX_INTRADAY_CANDLES = (REGULAR_SESSION_MS / (5 * 60 * 1_000)) * 2
// A US trading year is about 252 sessions; the margin absorbs a provider that counts holidays
// differently rather than silently dropping the oldest weeks of the year chart.
export const MAX_YEAR_CANDLES = 260
// A gap this large cannot occur inside a regular session, so it separates one session from the next.
const SESSION_BREAK_MS = 4 * 60 * 60 * 1_000

export const CandlePointSchema = z.object({
  time: z.number().int().nonnegative(),
  sequence: z.number().int().nonnegative(),
  close: z.number().finite().nonnegative(),
})

export type CandlePoint = z.infer<typeof CandlePointSchema>

/** The newest session in the series, which is the span a 1D chart draws. */
export function latestSessionCandles(points: readonly CandlePoint[]): readonly CandlePoint[] {
  let start = points.length - 1
  while (start > 0 && points[start]!.time - points[start - 1]!.time < SESSION_BREAK_MS) start -= 1
  return points.slice(Math.max(0, start))
}

function sameCandle(left: CandlePoint, right: Pick<CandlePoint, 'sequence' | 'time'>): boolean {
  return left.time === right.time && left.sequence === right.sequence
}

export function updateCandleSeries(
  current: readonly CandlePoint[],
  point: CandlePoint,
  remove = false,
  limit = MAX_INTRADAY_CANDLES,
): CandlePoint[] {
  const next = current.filter((candidate) => !sameCandle(candidate, point))
  if (!remove) next.push(point)
  next.sort((left, right) => left.time - right.time || left.sequence - right.sequence)
  return next.slice(Math.max(0, next.length - limit))
}

/** Keep the richer live series unless the incoming data reaches further forward in time. */
export function reconcileCandleSeries(
  current: readonly CandlePoint[],
  incoming: readonly CandlePoint[],
): CandlePoint[] {
  if (!current.length) return incoming.slice(-MAX_INTRADAY_CANDLES)
  if (!incoming.length) return current.slice(-MAX_INTRADAY_CANDLES)

  const currentLatest = current[current.length - 1]!
  const incomingLatest = incoming[incoming.length - 1]!
  if (incomingLatest.time <= currentLatest.time) return current.slice(-MAX_INTRADAY_CANDLES)
  return (incoming.length >= current.length ? incoming : current).slice(-MAX_INTRADAY_CANDLES)
}

export type CandleFrame = CandlePoint & { eventFlags: number }

type CandleSnapshotResult =
  /** No snapshot is open, so the point is an ordinary live update the caller owns. */
  | { status: 'live' }
  /** The point joined an open snapshot that has not finished arriving. */
  | { status: 'buffering' }
  /** The snapshot closed; these points replace the series wholesale. */
  | { status: 'complete'; points: CandlePoint[] }

/**
 * A snapshot arrives as BEGIN, a run of points, then END or SNIP, with TX_PENDING marking a
 * batch that is still mid-transaction. Buffering the run and committing it whole is what keeps
 * a half-delivered series off the chart, and it is the same protocol for a day of five-minute
 * bars as for a year of daily ones.
 */
export class CandleSnapshotAccumulator {
  private readonly pending = new Map<string, { endSeen: boolean; points: CandlePoint[] }>()

  accept(symbol: string, frame: CandleFrame, limit = MAX_INTRADAY_CANDLES): CandleSnapshotResult {
    const { eventFlags, ...point } = frame
    if (eventFlags & DXLINK_SNAPSHOT_BEGIN) this.pending.set(symbol, { endSeen: false, points: [] })
    const pending = this.pending.get(symbol)
    if (!pending) return { status: 'live' }
    pending.points = updateCandleSeries(
      pending.points,
      point,
      Boolean(eventFlags & DXLINK_REMOVE_EVENT),
      limit,
    )
    pending.endSeen ||= Boolean(eventFlags & (DXLINK_SNAPSHOT_END | DXLINK_SNAPSHOT_SNIP))
    if (!pending.endSeen || eventFlags & DXLINK_TX_PENDING) return { status: 'buffering' }
    this.pending.delete(symbol)
    return { status: 'complete', points: pending.points }
  }

  forget(symbol: string): void {
    this.pending.delete(symbol)
  }

  clear(): void {
    this.pending.clear()
  }
}
