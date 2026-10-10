import { z } from 'zod'

import { EquitySymbolSchema, type InstrumentCatalogItem } from '../domain/instrument'
import { isValidIsoDate } from '../domain/iso-date'
import {
  type MarketSnapshot,
  type Ticker,
} from '../domain/market'
import {
  envelopeRows,
  jsonNumber,
  JsonObjectArraySchema,
  jsonObject,
  jsonText,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { marketDate } from '../domain/catalyst'
import { earningsDateFromMetric } from './catalysts'
import {
  type TastytradeMarketMetricRecord,
  type TastytradeMarketQuoteRecord,
} from './tastytrade-market-store'
import { CallerVisibleError } from './caller-visible-error'

function numeric(value: JsonValue, field: string): number {
  const parsed = jsonNumber(value)
  if (parsed === undefined) throw new CallerVisibleError(`TastytradeSnapshot:invalid-${field}`)
  return parsed
}

// tastytrade uses both omission and JSON null for an optional observation that
// it did not report. Neither form asserts a value; every other value is parsed.
function unreported(value: JsonValue): value is null | undefined {
  return value === undefined || value === null
}

function optionalNumeric(value: JsonValue, field: string): number | undefined {
  if (unreported(value)) return undefined
  return numeric(value, field)
}

function nonnegative(value: JsonValue, field: string): number {
  const parsed = numeric(value, field)
  if (parsed < 0) throw new CallerVisibleError(`TastytradeSnapshot:invalid-${field}`)
  return parsed
}

function optionalNonnegative(value: JsonValue, field: string): number | undefined {
  if (unreported(value)) return undefined
  return nonnegative(value, field)
}

function positive(value: JsonValue, field: string): number {
  const parsed = numeric(value, field)
  if (parsed <= 0) throw new CallerVisibleError(`TastytradeSnapshot:invalid-${field}`)
  return parsed
}

function optionalPositive(value: JsonValue, field: string): number | undefined {
  if (unreported(value)) return undefined
  return positive(value, field)
}

function optionalText(value: JsonValue, field: string): string | undefined {
  if (unreported(value)) return undefined
  const parsed = jsonText(value)
  if (!parsed) throw new CallerVisibleError(`TastytradeSnapshot:invalid-${field}`)
  return parsed
}

function optionalBoolean(value: JsonValue, field: string): boolean | undefined {
  if (unreported(value)) return undefined
  const parsed = z.boolean().safeParse(value)
  if (!parsed.success) throw new CallerVisibleError(`TastytradeSnapshot:invalid-${field}`)
  return parsed.data
}

/*
 * tastytrade market metrics mix two units, established from production D1 rows
 * rather than documentation: `implied-volatility-index`, its rank, percentile,
 * 5-day change, and per-expiration IVs are decimal ratios (0.261 = 26.1%), while
 * `historical-volatility-30-day` (30.8), `iv-hv-30-day-difference` (-4.7), the
 * annual `borrow-rate` (1.5 for Easy To Borrow, 951.15 for PCLA Locate Required), and
 * `implied-volatility-30-day` (24.59) are already percentage points. Multiplying those by 100
 * rejected or distorted real observations: `percentagePoints` and `optionalPercentagePoints`
 * convert only the ratio fields, and the points fields are read as reported through
 * `optionalNumeric` and `optionalNonnegative`.
 *
 * `implied-volatility-30-day` is the trap in that list: it carries the same number as
 * `implied-volatility-index` in the other unit, so reading it as a ratio looks plausible and
 * silently publishes 100x. `iv-hv-30-day-difference` is what separates them, and it is checked
 * in the MCP reader's tests. This list is the single record of these units -- the reader in
 * `brokerage-read-normalization.ts` defers to it rather than keeping its own.
 */
/**
 * Decimal places kept on a number this module computed rather than read.
 *
 * A provider decimal becomes a float64 the moment it is multiplied or subtracted, and the
 * artifact is published verbatim: a 0.155 move serializes as `0.15500000000000114`, a 26.1%
 * implied volatility as `26.100000000000001`. Across one snapshot that is around 12,000
 * characters of digits no observation contains, paid for by every reader and every agent on
 * the public tier. Four places outlive any precision tastytrade reports -- it quotes ratios to
 * six significant digits and prices to the cent -- so this rounds off only what our own
 * arithmetic invented. Values read from the provider untouched are never rounded here.
 */
const PROJECTED_DECIMAL_PLACES = 4

function projected(value: number): number {
  const scale = 10 ** PROJECTED_DECIMAL_PLACES
  return Math.round(value * scale) / scale
}

/**
 * The same rounding for a value on its way back out of the store.
 *
 * Applied only to the figures `percentagePoints` produced before they were written -- IV rank,
 * percentile, index, its five-day change and the term IVs -- so storage only delays the
 * publication of the same digits. A figure stored as the provider reported it (30-day HV, the
 * IV-HV difference, liquidity) is never rounded here, or the stored read would publish digits
 * the live read does not. For the converted figures, a row written before that rounding
 * existed keeps `18.371153200000002` until its symbol next reaches the provider, which outside
 * market hours is deliberately a long time. Rounding again here is a no-op on a row written
 * since, and cleans one written before.
 */
function projectedMetric(value: number | undefined): number | undefined {
  return value === undefined ? undefined : projected(value)
}

function percentagePoints(value: JsonValue, field: string): number {
  return projected(numeric(value, field) * 100)
}

function optionalPercentagePoints(value: JsonValue, field: string): number | undefined {
  if (unreported(value)) return undefined
  return percentagePoints(value, field)
}

function optionTermStructure(metrics: JsonObject, symbol: string): Ticker['ivTermStructure'] {
  const value = metrics['option-expiration-implied-volatilities'] ?? metrics.optionExpirationImpliedVolatilities
  if (unreported(value)) return undefined
  if (!Array.isArray(value)) throw new CallerVisibleError(`TastytradeSnapshot:invalid-option-term-structure:${symbol}`)
  const candidates = value.flatMap((candidate) => {
    const row = jsonObject(candidate)
    if (!row) throw new CallerVisibleError(`TastytradeSnapshot:invalid-option-term-row:${symbol}`)
    const rawExpiration = optionalText(
      row['expiration-date'] ?? row.expirationDate,
      `option-expiration:${symbol}`,
    )
    const impliedVolatility = optionalPercentagePoints(
      row['implied-volatility'] ?? row.impliedVolatility,
      `option-implied-volatility:${symbol}`,
    )
    const chainType = optionalText(
      row['option-chain-type'] ?? row.optionChainType,
      `option-chain-type:${symbol}`,
    ) ?? ''
    // Incomplete optional rows assert no term observation; malformed reported
    // fields still fail in the parsers above.
    if (rawExpiration === undefined || impliedVolatility === undefined) return []
    const expiration = rawExpiration.slice(0, 10)
    if (!isValidIsoDate(expiration)) throw new CallerVisibleError(`TastytradeSnapshot:invalid-option-expiration:${symbol}`)
    if (impliedVolatility < 0) throw new CallerVisibleError(`TastytradeSnapshot:invalid-option-implied-volatility:${symbol}`)
    return [{
      chainType,
      expiration,
      impliedVolatility,
    }]
  }).sort((left, right) => left.expiration.localeCompare(right.expiration)
    || Number(right.chainType === 'Standard') - Number(left.chainType === 'Standard')
    || left.chainType.localeCompare(right.chainType))
  const distinct = [...new Map(candidates.map((candidate) => [candidate.expiration, candidate])).values()]
  const [front, back] = distinct
  return front && back ? {
    backExpiration: back.expiration,
    backIv: back.impliedVolatility,
    frontExpiration: front.expiration,
    frontIv: front.impliedVolatility,
  } : undefined
}

function assetType(instrument: JsonObject | undefined): Ticker['assetType'] {
  if (!instrument) return undefined
  const isIndex = optionalBoolean(instrument['is-index'] ?? instrument.isIndex, 'is-index')
  const isEtf = optionalBoolean(instrument['is-etf'] ?? instrument.isEtf, 'is-etf')
  if (isIndex && isEtf) throw new CallerVisibleError('TastytradeSnapshot:conflicting-asset-type')
  if (isIndex) return 'index'
  if (isEtf) return 'etf'
  return isIndex === false && isEtf === false ? 'stock' : undefined
}

export function strictTastytradeRows(payload: JsonValue, label: string): JsonObject[] {
  const candidate = envelopeRows(payload)
  const rows = candidate && JsonObjectArraySchema.safeParse(candidate).data
  if (!rows) throw new CallerVisibleError(`${label}:invalid-response`)
  return rows
}

/**
 * Index provider rows by the symbol they answer for. A row for a symbol nobody asked for, or a
 * second row for one, is a broken response and throws; a requested symbol with no row is left
 * absent, and the caller counts it.
 */
export function tastytradeRowsByRequestedSymbol(
  rows: readonly JsonObject[],
  requestedSymbols: readonly string[],
  label: string,
): Map<string, JsonObject> {
  const requested = new Set(requestedSymbols)
  const bySymbol = new Map<string, JsonObject>()
  for (const row of rows) {
    const parsed = EquitySymbolSchema.safeParse(jsonText(row.symbol))
    if (!parsed.success) throw new CallerVisibleError(`${label}:invalid-symbol`)
    const symbol = parsed.data
    if (!requested.has(symbol)) throw new CallerVisibleError(`${label}:unexpected-symbol`)
    if (bySymbol.has(symbol)) throw new CallerVisibleError(`${label}:duplicate-symbol`)
    bySymbol.set(symbol, row)
  }
  return bySymbol
}

type NormalizedTastytradeMarketTicker = {
  metricRecord: TastytradeMarketMetricRecord
  quoteRecord: TastytradeMarketQuoteRecord
  ticker: Ticker
}

export function normalizeTastytradeMarketTicker(
  symbol: string,
  metrics: JsonObject | undefined,
  quote: JsonObject | undefined,
  instrument?: JsonObject,
): NormalizedTastytradeMarketTicker {
  if (!metrics) throw new CallerVisibleError(`TastytradeSnapshot:missing-metrics:${symbol}`)
  if (!quote) throw new CallerVisibleError(`TastytradeSnapshot:missing-quote:${symbol}`)
  const price = positive(quote.mark ?? quote['mark-price'] ?? quote.last ?? quote['last-price'] ?? quote.close, 'price')
  const previousClose = positive(
    quote.prevClose
      ?? quote['prev-close']
      ?? quote.previousClose
      ?? quote['previous-close']
      ?? quote.prevDayClose
      ?? quote['prev-day-close'],
    'previous-close',
  )
  // tastytrade reports mark and previous close, not day-change fields. Day move
  // is therefore a read-model projection, never a synthesized source record.
  const change = projected(price - previousClose)
  const changePercent = projected((change / previousClose) * 100)
  const ivIndex = optionalPercentagePoints(
    metrics['implied-volatility-index'],
    `implied-volatility-index:${symbol}`,
  )
  const ivRank = optionalPercentagePoints(
    metrics['implied-volatility-index-rank'] ?? metrics['implied-volatility-rank'],
    `implied-volatility-rank:${symbol}`,
  )
  const ivPercentile = optionalPercentagePoints(
    metrics['implied-volatility-percentile'],
    `implied-volatility-percentile:${symbol}`,
  )
  const liquidity = optionalNumeric(metrics['liquidity-rating'], `liquidity-rating:${symbol}`)
  // tastytrade writes a zero capitalization for instruments it publishes none for (ETFs,
  // indices), so a zero is an unreported reading rather than a zero-dollar issuer.
  const reportedMarketCap = optionalNonnegative(metrics['market-cap'] ?? metrics.marketCap, 'market-cap')
  const marketCap = reportedMarketCap === 0 ? undefined : reportedMarketCap
  const volume = optionalNonnegative(quote.volume ?? quote['day-volume'], 'volume')
  const yearLow = optionalPositive(quote.yearLowPrice ?? quote['year-low-price'], 'year-low')
  const yearHigh = optionalPositive(quote.yearHighPrice ?? quote['year-high-price'], 'year-high')
  // An equal high and low is a name that has not moved all year: a real reading the read model
  // shows as no range position. Only an inverted range is a broken frame.
  if (yearLow !== undefined && yearHigh !== undefined && yearHigh < yearLow) {
    throw new CallerVisibleError('TastytradeSnapshot:invalid-year-range')
  }
  const quoteUpdatedAt = optionalText(quote.updatedAt ?? quote['updated-at'], 'updated-at')
  const quoteTime = Date.parse(quoteUpdatedAt ?? '')
  if (!Number.isFinite(quoteTime)) throw new CallerVisibleError('TastytradeSnapshot:invalid-updated-at')
  const updatedAt = new Date(quoteTime).toISOString()
  // Borrow status is read from the instrument catalog alone, as the stored read reads it: the
  // metrics table keeps no lendability, so preferring the metrics value here showed a live
  // reader a status the stored snapshot of the same name could not.
  const lendability = optionalText(instrument?.lendability, 'lendability')
  const ivIndex5DayChange = optionalPercentagePoints(
    metrics['implied-volatility-index-5-day-change'] ?? metrics.impliedVolatilityIndex5DayChange,
    'implied-volatility-index-5-day-change',
  )
  const historicalVolatility30Day = optionalNonnegative(
    metrics['historical-volatility-30-day'] ?? metrics.historicalVolatility30Day,
    'historical-volatility-30-day',
  )
  const ivHistoricalVolatility30DayDifference = optionalNumeric(
    metrics['iv-hv-30-day-difference'] ?? metrics.ivHv30DayDifference,
    'iv-hv-30-day-difference',
  )
  const ivTermStructure = optionTermStructure(metrics, symbol)
  const earningsDate = earningsDateFromMetric(metrics)
  // The provider's own instant for the metrics. A quote is refused without one; metrics are
  // kept without one, since the readings are still the readings, but a malformed instant is
  // refused rather than replaced by the moment this Worker happened to ask.
  const metricsUpdatedAtText = optionalText(metrics['updated-at'] ?? metrics.updatedAt, 'metrics-updated-at')
  const metricsUpdatedAtTime = metricsUpdatedAtText === undefined ? undefined : Date.parse(metricsUpdatedAtText)
  if (metricsUpdatedAtTime !== undefined && !Number.isFinite(metricsUpdatedAtTime)) {
    throw new CallerVisibleError('TastytradeSnapshot:invalid-metrics-updated-at')
  }
  const metricsUpdatedAt = metricsUpdatedAtTime === undefined ? undefined : new Date(metricsUpdatedAtTime).toISOString()
  const metricRecord: TastytradeMarketMetricRecord = {
    // The same upcoming, provider-visible date the live ticker carries. Storing the raw
    // reported value instead let a stored read show an earnings date the live path filtered
    // out, so the two read models are written from one derivation. Every other field the two
    // share comes from one source too; lendability, which neither record stores, is the
    // catalog's in both.
    earningsDate,
    historicalVolatility30Day,
    ivHistoricalVolatility30DayDifference,
    ivIndex,
    ivIndex5DayChange,
    ivPercentile,
    ivRank,
    ivTermStructure,
    liquidity,
    marketCap,
    providerUpdatedAt: metricsUpdatedAt,
    symbol,
  }
  const quoteRecord: TastytradeMarketQuoteRecord = {
    previousClose,
    price,
    providerUpdatedAt: updatedAt,
    symbol,
    volume,
    yearHigh,
    yearLow,
  }
  return { metricRecord, quoteRecord, ticker: {
    symbol,
    name: optionalText(
      instrument?.description ?? instrument?.['short-description'] ?? quote.description,
      'instrument-name',
    ) ?? symbol,
    assetType: assetType(instrument),
    lendability,
    marketCap,
    price,
    change,
    changePercent,
    sparkline: [],
    ivRank,
    ivPercentile,
    ivIndex,
    ivIndex5DayChange,
    historicalVolatility30Day,
    ivHistoricalVolatility30DayDifference,
    ivTermStructure,
    liquidity,
    volume,
    yearHigh,
    yearLow,
    earningsDate,
    updatedAt,
    metricsUpdatedAt,
  } }
}

/**
 * Rebuild the UI read model from what the store already holds, so a visitor can be served a
 * snapshot without any call reaching the provider. The stored records are the normalized facts
 * `normalizeTastytradeMarketTicker` produced, so this re-derives only what the tables do not
 * carry: the instrument identity, and the move against the previous close.
 */
export function tickerFromStoredRecords(
  symbol: string,
  metric: TastytradeMarketMetricRecord | undefined,
  quote: TastytradeMarketQuoteRecord,
  instrument?: JsonObject,
  yearAgoClose?: number,
  now = new Date(),
): Ticker {
  const change = projected(quote.price - quote.previousClose)
  return {
    symbol,
    name: optionalText(
      instrument?.description ?? instrument?.['short-description'],
      'instrument-name',
    ) ?? symbol,
    assetType: assetType(instrument),
    lendability: optionalText(instrument?.lendability, 'lendability'),
    marketCap: metric?.marketCap,
    price: quote.price,
    change,
    changePercent: projected((change / quote.previousClose) * 100),
    // Candle history is live-only state; a stored snapshot carries no intraday chart.
    sparkline: [],
    yearAgoClose,
    ivRank: projectedMetric(metric?.ivRank),
    ivPercentile: projectedMetric(metric?.ivPercentile),
    ivIndex: projectedMetric(metric?.ivIndex),
    ivIndex5DayChange: projectedMetric(metric?.ivIndex5DayChange),
    historicalVolatility30Day: metric?.historicalVolatility30Day,
    ivHistoricalVolatility30DayDifference: metric?.ivHistoricalVolatility30DayDifference,
    ivTermStructure: metric?.ivTermStructure && {
      ...metric.ivTermStructure,
      backIv: projected(metric.ivTermStructure.backIv),
      frontIv: projected(metric.ivTermStructure.frontIv),
    },
    liquidity: metric?.liquidity,
    volume: quote.volume,
    yearHigh: quote.yearHigh,
    yearLow: quote.yearLow,
    // A stored row outlives the date it holds, so an earnings date the store was right about
    // when it was written is dropped once it is past -- the same filter the live path applies.
    earningsDate: metric?.earningsDate && metric.earningsDate >= marketDate(now) ? metric.earningsDate : null,
    updatedAt: quote.providerUpdatedAt,
    metricsUpdatedAt: metric?.providerUpdatedAt,
  }
}

export function catalogTickerInstrument(item: InstrumentCatalogItem | undefined): JsonObject | undefined {
  if (!item) return undefined
  return {
    description: item.description,
    'is-etf': item.isEtf,
    'is-index': item.isIndex,
    lendability: item.lendability,
    'short-description': item.shortDescription,
  }
}

/** The session object, whether the provider wrapped it in `data` or sent it bare. */
function sessionObject(payload: JsonValue): JsonObject | undefined {
  return jsonObject(jsonObject(payload)?.data ?? payload)
}

export function marketStateFromTastytradeSession(payload: JsonValue): MarketSnapshot['marketState'] {
  const session = sessionObject(payload)
  if (!session) throw new CallerVisibleError('TastytradeMarketSession:invalid-response')
  const rawState = optionalText(session.state, 'market-state')?.toLowerCase()
  if (!rawState) throw new CallerVisibleError('TastytradeMarketSession:missing-state')
  if (rawState === 'open') return 'open'
  if (rawState.includes('pre')) return 'pre'
  if (rawState.includes('after') || rawState.includes('extended')) return 'after'
  if (rawState === 'closed') return 'closed'
  return 'unknown'
}

/**
 * A session instant: absent (or null) is the provider not naming one, which the reader sees as no
 * countdown; present but unparseable is the provider saying something this reader cannot
 * believe, and is refused as `marketStateFromTastytradeSession` refuses a bad state, rather than
 * shown as the same quiet absence.
 */
function sessionInstant(value: JsonValue, check: string): number | undefined {
  if (unreported(value)) return undefined
  const instant = Date.parse(jsonText(value) ?? '')
  if (!Number.isFinite(instant)) throw new CallerVisibleError(`TastytradeMarketSession:${check}`)
  return instant
}

/**
 * The next bell. The provider is the only thing that knows about holidays and half days, so
 * the instant comes from the session it describes rather than from a clock: the current
 * session's open while that is still ahead, otherwise the next session's. A payload naming
 * neither ahead of now yields nothing, and the reader gets the state without a countdown.
 */
export function marketOpensAtFromTastytradeSession(payload: JsonValue, now = new Date()): string | undefined {
  const session = sessionObject(payload)
  if (!session) return undefined
  // Absent (or null) is the provider naming no next session; present but not an object is a
  // payload this reader cannot believe, refused like a bad instant rather than read as absent.
  const nextValue = session['next-session']
  const next = jsonObject(nextValue)
  if (!unreported(nextValue) && !next) {
    throw new CallerVisibleError('TastytradeMarketSession:invalid-next-session')
  }
  const candidates = [session['open-at'], next?.['open-at']]
    .map((value) => sessionInstant(value, 'invalid-open-at'))
    .filter((instant): instant is number => instant !== undefined && instant > now.getTime())
  if (!candidates.length) return undefined
  return new Date(Math.min(...candidates)).toISOString()
}

/** The current session's close while it is still ahead. A close already behind yields nothing. */
export function marketClosesAtFromTastytradeSession(payload: JsonValue, now = new Date()): string | undefined {
  const session = sessionObject(payload)
  if (!session) return undefined
  const close = sessionInstant(session['close-at'], 'invalid-close-at')
  if (close === undefined || close <= now.getTime()) return undefined
  return new Date(close).toISOString()
}
