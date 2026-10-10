import { z } from 'zod'

import {
  CandlePointSchema,
  CandleSnapshotAccumulator,
  DXLINK_REMOVE_EVENT,
  MAX_INTRADAY_CANDLES,
  MAX_YEAR_CANDLES,
  type CandleFrame,
  type CandlePoint,
} from '../domain/candle'
import { EquitySymbolSchema, MAX_PROVIDER_LABEL_LENGTH } from '../domain/instrument'
import { jsonNumber, type JsonObject } from '../domain/json-payload'
import { MAX_LIVE_STREAM_SYMBOLS } from '../domain/watchlist'

/**
 * The one relay instance every caller addresses. The name is historical: the relay once ran on
 * an account credential, and it now runs on the Worker's market-data token with no account in
 * it. The value is kept because a Durable Object's identity is its name — renaming it would
 * start a second relay and a second upstream socket rather than rename the first.
 */
export const MARKET_FEED_INSTANCE = 'primary-account'

/**
 * How often a browser announces it is still reading the live feed. The relay derives its idle
 * cutoff from this and the browser sends on it, so both ends read the one constant.
 */
export const CLIENT_HEARTBEAT_MS = 30_000

export const MarketFeedSymbolsSchema = z.array(EquitySymbolSchema)
  .min(1)
  .max(MAX_LIVE_STREAM_SYMBOLS)

export const LiveMarketEventSchema = z.object({
  type: z.literal('market'),
  symbol: EquitySymbolSchema,
  price: z.number().finite().positive().optional(),
  change: z.number().finite().optional(),
  bid: z.number().finite().positive().optional(),
  ask: z.number().finite().positive().optional(),
  candle: CandlePointSchema.extend({
    close: z.number().finite().nonnegative(),
    eventFlags: z.number().int().nonnegative(),
  }).optional(),
  candleSnapshot: z.array(CandlePointSchema).max(MAX_INTRADAY_CANDLES).optional(),
  timestamp: z.string().datetime(),
}).superRefine((event, context) => {
  if (event.candle && !(event.candle.eventFlags & DXLINK_REMOVE_EVENT) && event.candle.close <= 0) {
    context.addIssue({ code: 'custom', message: 'A non-remove candle needs a positive close.', path: ['candle', 'close'] })
  }
})

export type LiveMarketEvent = z.infer<typeof LiveMarketEventSchema>

/**
 * The feed status's optional detail is one line of this Worker's own wording shown beside the
 * status dot; a named budget of about one line at phone width, refusing a runaway message.
 */
const MAX_FEED_STATUS_DETAIL_LENGTH = 160

export const MarketFeedStatusSchema = z.object({
  asOf: z.string().datetime(),
  detail: z.string().max(MAX_FEED_STATUS_DETAIL_LENGTH).optional(),
  state: z.enum(['connecting', 'live', 'reconnecting', 'degraded']),
  type: z.literal('feed-status'),
})

export type MarketFeedStatus = z.infer<typeof MarketFeedStatusSchema>

// One interactive Greeks RPC may briefly subscribe and wait for every requested contract;
// bounding that fan-out keeps its timeout and returned model context predictable.
export const MAX_OPTION_GREEKS_CONTRACTS = 10

export const OptionStreamerSymbolSchema = z.string()
  .trim()
  .max(MAX_PROVIDER_LABEL_LENGTH)
  .regex(new RegExp(`^\\.[A-Z0-9.]{1,${MAX_PROVIDER_LABEL_LENGTH - 1}}$`))

const OptionGreeksEventSchema = z.object({
  delta: z.number().finite(),
  eventAt: z.string().datetime(),
  gamma: z.number().finite(),
  impliedVolatility: z.number().finite().nonnegative(),
  impliedVolatilityUnit: z.literal('decimal_ratio'),
  optionPrice: z.number().finite().nonnegative(),
  receivedAt: z.string().datetime(),
  rho: z.number().finite(),
  source: z.literal('tastytrade-dxlink'),
  streamerSymbol: OptionStreamerSymbolSchema,
  theta: z.number().finite(),
  vega: z.number().finite(),
})

export type OptionGreeksEvent = z.infer<typeof OptionGreeksEventSchema>

export const OptionGreeksReadResultSchema = z.object({
  asOf: z.string().datetime(),
  greeks: z.array(OptionGreeksEventSchema).max(MAX_OPTION_GREEKS_CONTRACTS),
  impliedVolatilityUnit: z.literal('decimal_ratio'),
  source: z.literal('tastytrade-dxlink'),
})

export type OptionGreeksReadResult = z.infer<typeof OptionGreeksReadResultSchema>

/** Validate the bounded, exact broker streamer symbols accepted by the public DO RPC. */
export function parseOptionStreamerSymbols(value: readonly string[]): string[] {
  const parsed = z.array(OptionStreamerSymbolSchema)
    .min(1)
    .max(MAX_OPTION_GREEKS_CONTRACTS)
    .parse(value)
  return [...new Set(parsed)]
}

/**
 * A provider epoch-millisecond instant as ISO text, or undefined for one that is not a positive
 * safe integer or lies past ECMAScript's maximum time value (the largest instant a `Date` holds).
 */
export function isoFromEpoch(epoch: number | undefined): string | undefined {
  if (epoch === undefined || epoch <= 0 || !Number.isSafeInteger(epoch)) return undefined
  const date = new Date(epoch)
  return Number.isFinite(date.getTime()) ? date.toISOString() : undefined
}

/** Parse one compact dxFeed Greeks row, rejecting partial or non-finite observations. */
export function optionGreeksFromRow(
  row: JsonObject,
  receivedAt = new Date(),
): OptionGreeksEvent | undefined {
  const streamerSymbol = OptionStreamerSymbolSchema.safeParse(row.eventSymbol)
  const eventAt = isoFromEpoch(jsonNumber(row.time))
  const optionPrice = jsonNumber(row.price)
  const impliedVolatility = jsonNumber(row.volatility)
  const delta = jsonNumber(row.delta)
  const gamma = jsonNumber(row.gamma)
  const theta = jsonNumber(row.theta)
  const rho = jsonNumber(row.rho)
  const vega = jsonNumber(row.vega)
  if (!streamerSymbol.success
    || eventAt === undefined
    || optionPrice === undefined
    || optionPrice < 0
    || impliedVolatility === undefined
    || impliedVolatility < 0
    || delta === undefined
    || gamma === undefined
    || theta === undefined
    || rho === undefined
    || vega === undefined
    || !Number.isFinite(receivedAt.getTime())) return undefined
  return OptionGreeksEventSchema.parse({
    delta,
    eventAt,
    gamma,
    impliedVolatility,
    impliedVolatilityUnit: 'decimal_ratio',
    optionPrice,
    receivedAt: receivedAt.toISOString(),
    rho,
    source: 'tastytrade-dxlink',
    streamerSymbol: streamerSymbol.data,
    theta,
    vega,
  })
}

type SymbolWait<T> = {
  received: Map<string, T>
  reject: (error: Error) => void
  resolve: (received: Map<string, T>) => void
  settled: boolean
  symbols: readonly string[]
  timeout: ReturnType<typeof setTimeout>
}

type SymbolWaitLease<T> = {
  promise: Promise<T>
  release: () => void
}

/**
 * Overlapping bounded RPC waiters that share one upstream subscription per symbol. Each waiter
 * settles when every symbol it named has delivered, or when its own timeout fires; the refcount
 * is what tells the relay which symbols are still demanded once a waiter releases.
 */
class SymbolWaitRegistry<T> {
  private nextRequestId = 0
  private readonly requests = new Map<number, SymbolWait<T>>()
  private readonly symbolRefCounts = new Map<string, number>()

  constructor(private readonly options: {
    /** Settle a timed-out waiter with what did arrive, rather than rejecting it. */
    keepPartialOnTimeout: boolean
    label: string
    /** Called when the last waiter on a symbol releases it. */
    onForget?: (symbol: string) => void
  }) {}

  register(symbols: readonly string[], timeoutMs: number): SymbolWaitLease<Map<string, T>> {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`The ${this.options.label} timeout must be a positive number of milliseconds.`)
    }
    const requestId = ++this.nextRequestId
    let resolvePromise!: (received: Map<string, T>) => void
    let rejectPromise!: (error: Error) => void
    const promise = new Promise<Map<string, T>>((resolve, reject) => {
      resolvePromise = resolve
      rejectPromise = reject
    })
    const request: SymbolWait<T> = {
      received: new Map(),
      reject: rejectPromise,
      resolve: resolvePromise,
      settled: false,
      symbols,
      timeout: setTimeout(() => this.timeout(requestId), timeoutMs),
    }
    this.requests.set(requestId, request)
    for (const symbol of symbols) {
      this.symbolRefCounts.set(symbol, (this.symbolRefCounts.get(symbol) ?? 0) + 1)
    }
    let released = false
    return {
      promise,
      release: () => {
        if (released) return
        released = true
        clearTimeout(request.timeout)
        this.requests.delete(requestId)
        for (const symbol of symbols) {
          const count = (this.symbolRefCounts.get(symbol) ?? 1) - 1
          if (count > 0) this.symbolRefCounts.set(symbol, count)
          else {
            this.symbolRefCounts.delete(symbol)
            this.options.onForget?.(symbol)
          }
        }
      },
    }
  }

  isDemanded(symbol: string): boolean {
    return this.symbolRefCounts.has(symbol)
  }

  deliver(symbol: string, value: T): void {
    for (const request of this.requests.values()) {
      if (request.settled || !request.symbols.includes(symbol)) continue
      request.received.set(symbol, value)
      if (request.received.size !== request.symbols.length) continue
      request.settled = true
      clearTimeout(request.timeout)
      request.resolve(request.received)
    }
  }

  demandSymbols(): Set<string> {
    return new Set(this.symbolRefCounts.keys())
  }

  get activeRequestCount(): number {
    return this.requests.size
  }

  private timeout(requestId: number): void {
    const request = this.requests.get(requestId)
    if (!request || request.settled) return
    request.settled = true
    if (this.options.keepPartialOnTimeout && request.received.size) {
      request.resolve(request.received)
      return
    }
    const missing = request.symbols.filter((symbol) => !request.received.has(symbol))
    request.reject(new Error(`Timed out waiting for ${this.options.label}: ${missing.join(', ')}.`))
  }
}

type OptionGreeksLease = SymbolWaitLease<OptionGreeksEvent[]>

/** Account for overlapping bounded RPC waiters while sharing one upstream subscription. */
export class OptionGreeksRequestRegistry {
  private readonly waits = new SymbolWaitRegistry<OptionGreeksEvent>({
    keepPartialOnTimeout: false,
    label: 'option Greeks',
  })

  register(symbols: readonly string[], timeoutMs: number): OptionGreeksLease {
    const requested = parseOptionStreamerSymbols(symbols)
    const lease = this.waits.register(requested, timeoutMs)
    return {
      promise: lease.promise.then((received) => requested.map((symbol) => received.get(symbol)!)),
      release: lease.release,
    }
  }

  accept(event: OptionGreeksEvent): void {
    this.waits.deliver(event.streamerSymbol, event)
  }

  demandSymbols(): Set<string> {
    return this.waits.demandSymbols()
  }

  get activeRequestCount(): number {
    return this.waits.activeRequestCount
  }
}

/**
 * One aggregation period and session scope per subscription. `intraday` is the span a 1D chart
 * draws, so `tho=true` holds it to the regular session; `daily` carries a year of closes and
 * takes the default scope, since a daily bar has no session to exclude.
 */
const CANDLE_FEED_PERIODS = ['intraday', 'daily'] as const

type CandleFeedPeriod = typeof CANDLE_FEED_PERIODS[number]

const CANDLE_PERIOD_SUFFIXES = {
  intraday: '{=5m,tho=true}',
  daily: '{=d}',
} as const satisfies Record<CandleFeedPeriod, string>

/**
 * The suffix is part of the subscription identity, and both periods share one upstream channel.
 * Adds, removes, and inbound routing must build and read it the same way or a remove silently
 * misses, the upstream subscription leaks, and two periods merge into one corrupted series.
 */
function candleStreamerSymbol(symbol: string, period: CandleFeedPeriod): string {
  return `${symbol}${CANDLE_PERIOD_SUFFIXES[period]}`
}

export function candleSubscription(
  symbol: string,
  fromTime: number,
  period: CandleFeedPeriod,
) {
  return { type: 'Candle' as const, symbol: candleStreamerSymbol(symbol, period), fromTime }
}

/** Recover which series an upstream row belongs to, since one channel carries both. */
export function candleFeedPeriod(streamerSymbol: string): CandleFeedPeriod | undefined {
  const suffixAt = streamerSymbol.indexOf('{')
  if (suffixAt < 0) return undefined
  const suffix = streamerSymbol.slice(suffixAt)
  return CANDLE_FEED_PERIODS.find((period) => CANDLE_PERIOD_SUFFIXES[period] === suffix)
}

/**
 * How many symbols one year-candle refresh reads. This is a named resource budget, not a
 * provider limit: the year store it fills is served whole in one public response, at up to
 * `MAX_YEAR_CANDLES` closes a symbol, and one read must collect a year snapshot per symbol
 * inside the relay's daily-candle timeout. It is deliberately not the browser's
 * `MAX_LIVE_STREAM_SYMBOLS` — that bounds one reader's socket, and borrowing it tied the cached
 * year to a browser setting. The value matches what the refresh has always read.
 */
export const MAX_DAILY_CANDLE_SYMBOLS = 100

const DailyCandleSymbolsSchema = z.array(EquitySymbolSchema).min(1).max(MAX_DAILY_CANDLE_SYMBOLS)

/** Validate a year-candle read before normalization can change its cardinality. */
function parseDailyCandleSymbols(value: readonly string[]): string[] {
  return [...new Set(DailyCandleSymbolsSchema.parse(value))]
}

export const DailyCandlesReadResultSchema = z.object({
  asOf: z.string().datetime(),
  series: z.array(z.object({
    symbol: EquitySymbolSchema,
    closes: z.array(CandlePointSchema).max(MAX_YEAR_CANDLES),
  })),
  source: z.literal('tastytrade-dxlink'),
})

export type DailyCandlesReadResult = z.infer<typeof DailyCandlesReadResultSchema>

type DailyCandleLease = SymbolWaitLease<Map<string, CandlePoint[]>>

/**
 * The year series is read once and cached, not streamed, so this registry holds the bounded
 * one-shot readers rather than a standing subscription. A daily read completes on a finished
 * snapshot per symbol instead of a single event, and a partial year is still worth caching: the
 * reader keeps what arrived rather than failing the whole refresh because one thin symbol never
 * completed its snapshot.
 */
export class DailyCandleRequestRegistry {
  private readonly snapshots = new CandleSnapshotAccumulator()
  private readonly waits = new SymbolWaitRegistry<CandlePoint[]>({
    keepPartialOnTimeout: true,
    label: 'daily candles',
    onForget: (symbol) => this.snapshots.forget(symbol),
  })

  register(symbols: readonly string[], timeoutMs: number): DailyCandleLease {
    return this.waits.register(parseDailyCandleSymbols(symbols), timeoutMs)
  }

  /** Feed one upstream daily row; a completed snapshot settles every reader waiting on it. */
  accept(symbol: string, frame: CandleFrame): void {
    if (!this.waits.isDemanded(symbol)) return
    const result = this.snapshots.accept(symbol, frame, MAX_YEAR_CANDLES)
    // A daily bar outside a snapshot is that day's close ticking; the cached year does not
    // need it, so only a finished snapshot settles a reader.
    if (result.status !== 'complete') return
    this.waits.deliver(symbol, result.points)
  }

  demandSymbols(): Set<string> {
    return this.waits.demandSymbols()
  }

  reset(): void {
    this.snapshots.clear()
  }
}

/** Validate the entire subscription before normalization can change its cardinality. */
function parseMarketFeedSymbols(value: readonly string[]): string[] {
  return [...new Set(MarketFeedSymbolsSchema.parse(value))]
}

export function parseRequestedSymbols(url: URL): string[] {
  const parameters = url.searchParams.getAll('symbols')
  if (parameters.length !== 1) throw new Error('Exactly one symbols parameter is required.')
  return parseMarketFeedSymbols(parameters[0]!.split(','))
}

export function isSameOriginWebSocketRequest(request: Request): boolean {
  const origin = request.headers.get('Origin')
  return origin === new URL(request.url).origin
}
