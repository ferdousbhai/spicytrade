import { type FreshOrderPlacement } from './agent-contracts'
import { type AppEnv } from './env'
import {
  envelopeRows,
  jsonNumber,
  jsonObject,
  jsonText,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { type EquityOptionContract } from './option-contract'
import { Decimal } from 'decimal.js'
import { parseTickSizes, tickSizeAt as sharedTickSizeAt } from 'tasty-agent/tastytrade'
import { brokerApi } from './tastytrade'
import { BrokerRefusalError, CallerVisibleError } from './caller-visible-error'

/**
 * The market guard's refusals. Each code is this repository's own and carries no quote value,
 * so it reaches the caller as it stands. The two refusals whose explanation is a broker figure
 * (the tick the limit must use, the bid/ask it fell outside) are `BrokerRefusalError`s instead,
 * with that figure in the labelled untrusted field rather than in the message.
 */
class OrderMarketError extends CallerVisibleError {
  constructor(code: string) {
    super(code)
    this.name = 'OrderMarketError'
  }
}

function offTick(tickSize: number): BrokerRefusalError {
  return new BrokerRefusalError(
    'limit-off-tick',
    'OrderMarket:limit-off-tick: the limit price is not a multiple of the instrument tick size.',
    { tickSize },
  )
}

function outsideQuote(bid: number, ask: number): BrokerRefusalError {
  return new BrokerRefusalError(
    'limit-outside-quote',
    'OrderMarket:limit-outside-quote: the limit price is outside the current bid/ask.',
    { ask, bid },
  )
}

type OrderMarket = {
  ask: number
  bid: number
  observedAt: string
  tickSize: number
}

/**
 * How far a provider timestamp may sit ahead of this Worker's clock before it is treated as
 * invalid rather than as clock skew. A named budget, the owner's choice: real skew between
 * network-time-synced servers is well under a second, so a minute is a wide safety margin that
 * still rejects a timestamp that is plainly wrong. Named once so every broker-timestamp check
 * shares it.
 */
export const BROKER_CLOCK_SKEW_MS = 60_000
/**
 * The oldest quote a limit price may be checked against: the owner's risk policy. An order is
 * priced against the market as it is now, and during a session a quote older than two minutes
 * means the feed has stalled, so the order is refused rather than checked against an old price.
 */
export const QUOTE_MAX_AGE_MS = 2 * 60_000

/** A two-sided quote that is present, ordered, and fresh at `now`; anything else is refused. */
function validatedQuote(quote: JsonObject | undefined, now: Date) {
  const bid = jsonNumber(quote?.bid)
  const ask = jsonNumber(quote?.ask)
  const observed = Date.parse(jsonText(quote?.['updated-at'] ?? quote?.updatedAt) ?? '')
  if (bid === undefined || ask === undefined || bid < 0 || ask <= 0 || bid > ask
    || !Number.isFinite(observed)
    || observed > now.getTime() + BROKER_CLOCK_SKEW_MS
    || now.getTime() - observed > QUOTE_MAX_AGE_MS) {
    throw new OrderMarketError('OrderMarketQuote:invalid-or-stale')
  }
  return { ask, bid, observed }
}

/** Market-data endpoints may also answer with a single `data` object rather than a collection. */
function quoteRows(payload: JsonValue): JsonValue[] | undefined {
  const rows = envelopeRows(payload)
  if (rows) return rows
  const body = jsonObject(payload)
  const data = jsonObject(body?.data ?? payload)
  return data ? [data] : undefined
}

function recordRows(payload: JsonValue, label: string): JsonObject[] {
  const rows = quoteRows(payload)
  if (!rows?.length) throw new OrderMarketError(`${label}:invalid-response`)
  return rows.map((value) => {
    const row = jsonObject(value)
    if (!row) throw new OrderMarketError(`${label}:invalid-response`)
    return row
  })
}

function exactlyOneRecord(payload: JsonValue, label: string): JsonObject {
  const rows = recordRows(payload, label)
  if (rows.length !== 1) throw new OrderMarketError(`${label}:invalid-response`)
  return rows[0]!
}

/**
 * The tick at `price` under a tastytrade schedule, read with the shared rule (a threshold is the
 * exclusive upper bound of its tier, for equities and options alike). Malformed, empty, ambiguous,
 * or incomplete schedules are refused in this file's own vocabulary.
 */
function tickSizeAt(rules: JsonValue, price: number): number {
  let tiers
  try {
    tiers = parseTickSizes(rules, 'OrderMarket')
  } catch {
    throw new OrderMarketError('OrderMarket:invalid-tick-rules')
  }
  if (!tiers.length) throw new OrderMarketError('OrderMarket:missing-tick-rules')
  try {
    return sharedTickSizeAt(tiers, new Decimal(price), 'OrderMarket').toNumber()
  } catch {
    throw new OrderMarketError('OrderMarket:ambiguous-tick-rules')
  }
}

function isTickAligned(price: number, tickSize: number): boolean {
  const units = price / tickSize
  return Math.abs(units - Math.round(units)) <= 1e-7
}

/**
 * The checks both order shapes end with: the instrument is the one ordered, and the limit sits on
 * its tick grid and inside the quote. One copy, so the single-leg and spread guards cannot drift.
 */
function checkedLimitTick(
  instrumentPayload: JsonValue,
  underlying: string,
  rules: 'option-tick-sizes' | 'tick-sizes',
  limitPrice: number,
  bid: number,
  ask: number,
): number {
  const instrument = exactlyOneRecord(instrumentPayload, 'OrderMarketInstrument')
  if (jsonText(instrument.symbol)?.toUpperCase() !== underlying) throw new OrderMarketError('OrderMarketInstrument:mismatch')
  const tickSize = tickSizeAt(instrument[rules], limitPrice)
  if (!isTickAligned(limitPrice, tickSize)) throw offTick(tickSize)
  if (limitPrice < bid || limitPrice > ask) {
    throw outsideQuote(bid, ask)
  }
  return tickSize
}

export function orderMarketFromPayloads(
  action: FreshOrderPlacement,
  quotePayload: JsonValue,
  instrumentPayload: JsonValue,
  resolvedOption: EquityOptionContract | undefined,
  now: Date,
): OrderMarket {
  if (action.kind === 'place_vertical_spread_order') throw new OrderMarketError('OrderMarket:use-spread-market')
  const expectedSymbol = action.kind === 'place_option_order' ? resolvedOption?.symbol : action.symbol
  if (!expectedSymbol) throw new OrderMarketError('OrderMarket:missing-contract')
  const expectedType = action.kind === 'place_option_order' ? 'Equity Option' : 'Equity'
  const quote = exactlyOneRecord(quotePayload, 'OrderMarketQuote')
  const responseSymbol = jsonText(quote.symbol)
  const responseType = jsonText(quote['instrument-type'] ?? quote.instrumentType)
  if (responseSymbol !== expectedSymbol || responseType !== expectedType) {
    throw new OrderMarketError('OrderMarketQuote:invalid-or-stale')
  }
  const { ask, bid, observed: observedTime } = validatedQuote(quote, now)

  const tickSize = action.kind === 'place_option_order'
    ? checkedLimitTick(instrumentPayload, action.underlying, 'option-tick-sizes', action.limitPrice, bid, ask)
    : checkedLimitTick(instrumentPayload, action.symbol, 'tick-sizes', action.limitPrice, bid, ask)
  return { ask, bid, observedAt: new Date(observedTime).toISOString(), tickSize }
}

export function spreadOrderMarketFromPayloads(
  action: Extract<FreshOrderPlacement, { kind: 'place_vertical_spread_order' }>,
  quotePayload: JsonValue,
  instrumentPayload: JsonValue,
  resolvedOptions: readonly EquityOptionContract[],
  now: Date,
): OrderMarket {
  if (resolvedOptions.length !== 2) throw new OrderMarketError('OrderMarket:missing-spread-contracts')
  const quotes = recordRows(quotePayload, 'OrderMarketQuote')
  if (quotes.length !== 2) throw new OrderMarketError('OrderMarketQuote:invalid-response')
  const bySymbol = new Map(quotes.map((quote) => [jsonText(quote.symbol), quote]))
  const parsed = resolvedOptions.map((contract) => {
    const quote = bySymbol.get(contract.symbol)
    if (jsonText(quote?.['instrument-type'] ?? quote?.instrumentType) !== 'Equity Option') {
      throw new OrderMarketError('OrderMarketQuote:invalid-or-stale')
    }
    return validatedQuote(quote, now)
  })
  const bid = Math.round(Math.max(0, parsed[0]!.bid - parsed[1]!.ask) * 1e8) / 1e8
  const ask = Math.round((parsed[0]!.ask - parsed[1]!.bid) * 1e8) / 1e8
  if (ask <= 0 || bid > ask) throw new OrderMarketError('OrderMarketQuote:invalid-spread-market')
  const tickSize = checkedLimitTick(instrumentPayload, action.underlying, 'option-tick-sizes', action.limitPrice, bid, ask)
  return {
    ask,
    bid,
    observedAt: new Date(Math.min(parsed[0]!.observed, parsed[1]!.observed)).toISOString(),
    tickSize,
  }
}

export async function assertOrderMarketSafe(
  env: AppEnv,
  action: FreshOrderPlacement,
  resolvedOptions: readonly EquityOptionContract[],
  now = new Date(),
): Promise<OrderMarket> {
  if (action.kind === 'place_vertical_spread_order') {
    if (resolvedOptions.length !== 2) throw new OrderMarketError('OrderMarket:missing-spread-contracts')
    const query = resolvedOptions.map((contract) => `equity-option=${encodeURIComponent(contract.symbol)}`).join('&')
    const [quotePayload, instrumentPayload] = await Promise.all([
      brokerApi().tastyRequest(env, `/market-data/by-type?${query}`),
      brokerApi().tastyRequest(env, `/instruments/equities/${encodeURIComponent(action.underlying)}`),
    ])
    return spreadOrderMarketFromPayloads(action, quotePayload, instrumentPayload, resolvedOptions, now)
  }
  const resolvedOption = resolvedOptions[0]
  const brokerSymbol = action.kind === 'place_option_order' ? resolvedOption?.symbol : action.symbol
  if (!brokerSymbol) throw new OrderMarketError('OrderMarket:missing-contract')
  const quoteQuery = action.kind === 'place_option_order'
    ? `equity-option=${encodeURIComponent(brokerSymbol)}`
    : `equity=${encodeURIComponent(brokerSymbol)}`
  const instrumentSymbol = action.kind === 'place_option_order' ? action.underlying : action.symbol
  const [quotePayload, instrumentPayload] = await Promise.all([
    brokerApi().tastyRequest(env, `/market-data/by-type?${quoteQuery}`),
    brokerApi().tastyRequest(env, `/instruments/equities/${encodeURIComponent(instrumentSymbol)}`),
  ])
  return orderMarketFromPayloads(action, quotePayload, instrumentPayload, resolvedOption, now)
}
