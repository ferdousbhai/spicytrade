import { type Static, Type } from 'typebox'

import { EquitySymbolType } from '../domain/instrument'
import { ISO_DATE_PATTERN } from '../domain/iso-date'
import { StringEnum } from '../domain/string-enum'

/**
 * Provider rows are the allocation boundary; returned rows and study count are
 * smaller model-context budgets.
 */
export const MAX_PRICE_HISTORY_PROVIDER_ROWS = 4_000
export const MAX_PRICE_HISTORY_RETURNED_ROWS = 250
/**
 * The widest inclusive calendar window a read may ask for. Every interval is aggregated from
 * daily bars, and a calendar span cannot hold more sessions than it has days, so a window no
 * wider than the provider-row allocation can never overflow it. A wider one is refused as the
 * caller's request up front, instead of reaching the provider and reading as a bad response.
 */
export const MAX_PRICE_HISTORY_SPAN_DAYS = MAX_PRICE_HISTORY_PROVIDER_ROWS
export const MAX_PRICE_STUDIES = 5
/**
 * What an omitted `limit` returns: about six months of daily bars, the recent trend a first read
 * is for, at under half the returned-row budget. A caller that wants the rest asks for it.
 */
export const DEFAULT_PRICE_HISTORY_ROWS = 120
/**
 * What an omitted `startDate` reaches back: one calendar year, roughly 250 sessions, so the
 * default rows arrive with a warm-up behind them for the default study periods, and a weekly or
 * monthly interval still has a year of bars to aggregate.
 */
export const DEFAULT_PRICE_HISTORY_LOOKBACK_DAYS = 365
/**
 * A study period wider than the rows the tool will ever return describes a window no part of
 * which is in the answer: the caller sees at most `MAX_PRICE_HISTORY_RETURNED_ROWS` rows, and
 * the warm-up behind a longer period is neither returned nor checkable against anything that
 * is. So the returned-row budget, not the provider allocation ceiling, is the widest period
 * this contract can account for, and it is what both the schema and `normalizeStudies` state.
 */
export const MAX_PRICE_STUDY_PERIOD = MAX_PRICE_HISTORY_RETURNED_ROWS

/**
 * Provider closes arrive as float64 renderings of float32 storage -- `218.1199951171875` for a
 * price the provider observed as 218.12 -- and serializing every digit spent a third of the
 * price rows on noise. Four decimals is the finest increment a US equity trades in (SEC Rule
 * 612 sets the minimum price variation at $0.0001 below $1.00 and $0.01 at or above it), so
 * rounding there drops the rendering artifact and no observed price. Study values share it:
 * they are averages of these same closes, and a fifth decimal would claim precision the inputs
 * never had. Volume is a count, not a price, and is never rounded.
 */
const PRICE_DECIMAL_PLACES = 4
const PRICE_ROUNDING_FACTOR = 10 ** PRICE_DECIMAL_PLACES

/** Applied at the serialization boundary only; studies are computed from full-precision rows. */
export function roundPrice(value: number): number {
  return Math.round(value * PRICE_ROUNDING_FACTOR) / PRICE_ROUNDING_FACTOR
}

/**
 * Study defaults are each study's published convention, so an omitted parameter means what a
 * reader of any chart expects: Wilder's 14-bar period (also applied to SMA/EMA, one default for
 * every scalar study), Bollinger's two standard deviations, and Appel's 12/26/9 MACD.
 */
export const DEFAULT_STUDY_PERIOD = 14
export const DEFAULT_BOLLINGER_DEVIATIONS = 2
export const DEFAULT_MACD_FAST_PERIOD = 12
export const DEFAULT_MACD_SLOW_PERIOD = 26
export const DEFAULT_MACD_SIGNAL_PERIOD = 9
/**
 * A one-bar average is the bar itself and a one-bar RSI has no change to measure, so two is the
 * narrowest period that computes anything. MACD's slow period must exceed its fast one, so its
 * floor is one above.
 */
export const MIN_STUDY_PERIOD = 2
export const MIN_MACD_SLOW_PERIOD = MIN_STUDY_PERIOD + 1

const ScalarStudyParameters = Type.Object({
  kind: StringEnum(['SMA', 'EMA', 'RSI']),
  period: Type.Optional(Type.Integer({ maximum: MAX_PRICE_STUDY_PERIOD, minimum: MIN_STUDY_PERIOD })),
}, { additionalProperties: false })

const BollingerStudyParameters = Type.Object({
  kind: StringEnum(['BBANDS']),
  period: Type.Optional(Type.Integer({ maximum: MAX_PRICE_STUDY_PERIOD, minimum: MIN_STUDY_PERIOD })),
  standardDeviations: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
}, { additionalProperties: false })

const MacdStudyParameters = Type.Object({
  fastPeriod: Type.Optional(Type.Integer({ maximum: MAX_PRICE_STUDY_PERIOD, minimum: MIN_STUDY_PERIOD })),
  kind: StringEnum(['MACD']),
  signalPeriod: Type.Optional(Type.Integer({ maximum: MAX_PRICE_STUDY_PERIOD, minimum: MIN_STUDY_PERIOD })),
  slowPeriod: Type.Optional(Type.Integer({ maximum: MAX_PRICE_STUDY_PERIOD, minimum: MIN_MACD_SLOW_PERIOD })),
}, { additionalProperties: false })

const PriceStudyParameters = Type.Union([
  ScalarStudyParameters,
  BollingerStudyParameters,
  MacdStudyParameters,
])

export const PriceHistoryReadParameters = Type.Object({
  endDate: Type.Optional(Type.String({
    description: 'Inclusive end date in YYYY-MM-DD form. Defaults to today.',
    pattern: ISO_DATE_PATTERN,
  })),
  interval: Type.Optional(StringEnum(['1d', '1wk', '1mo'], { description: 'Daily by default.' })),
  limit: Type.Optional(Type.Integer({
    description: `Most recent rows to return. Defaults to ${DEFAULT_PRICE_HISTORY_ROWS}.`,
    maximum: MAX_PRICE_HISTORY_RETURNED_ROWS,
    minimum: 1,
  })),
  startDate: Type.Optional(Type.String({
    description: 'Start date in YYYY-MM-DD form. Defaults to one year before endDate. '
      + `The inclusive range spans at most ${MAX_PRICE_HISTORY_SPAN_DAYS} calendar days, whatever the interval.`,
    pattern: ISO_DATE_PATTERN,
  })),
  studies: Type.Optional(Type.Array(PriceStudyParameters, {
    // The kinds are already literals in the schema, but they arrive as an `anyOf` of three
    // object branches and a model reading the flattened description misses them -- a first call
    // guesses `"sma"` or a bare string, and pays a round trip to be told. Naming them in prose
    // costs a line and buys the call.
    description: 'Optional studies from adjusted closes; kind is SMA, EMA, RSI, BBANDS or MACD, uppercase. '
      + `Defaults: period ${DEFAULT_STUDY_PERIOD}; MACD ${DEFAULT_MACD_FAST_PERIOD}/${DEFAULT_MACD_SLOW_PERIOD}/`
      + `${DEFAULT_MACD_SIGNAL_PERIOD}; Bollinger deviations ${DEFAULT_BOLLINGER_DEVIATIONS}.`,
    maxItems: MAX_PRICE_STUDIES,
  })),
  symbol: EquitySymbolType,
}, { additionalProperties: false })

export type StudyInput = Static<typeof PriceStudyParameters>
export type PriceHistoryReadInput = Static<typeof PriceHistoryReadParameters>

export type PriceHistoryRow = {
  adjustedClose: number
  close: number
  date: string
  high: number
  low: number
  open: number
  volume: number
}

/**
 * One study series, positioned against the returned bars instead of re-dating every point:
 * `values[i]` is the value for bar `firstPriceIndex + i`, and `firstDate` restates that bar's
 * date so a reader can check the alignment rather than trust it. The rows before
 * `firstPriceIndex` are the study's warm-up, which is stated here rather than transmitted --
 * padding it with one dated null per row was a quarter of the whole result.
 *
 * Both positions are absent exactly when `values` is empty: a study whose warm-up outruns the
 * returned window has no row to align to, and says so by carrying nothing.
 */
export type PriceStudySeries = {
  firstDate?: string
  firstPriceIndex?: number
  values: number[]
}

/** Restated in every result: a model that reads one without the tool description still aligns it. */
export const STUDY_ALIGNMENT_NOTE
  = 'Each series values[i] is the study value for the bar at prices.date[firstPriceIndex + i]; earlier bars are warm-up and have no value.'

export type PriceStudyResult =
  | { kind: 'SMA' | 'EMA' | 'RSI'; period: number; series: PriceStudySeries }
  | {
    kind: 'BBANDS'
    lower: PriceStudySeries
    middle: PriceStudySeries
    period: number
    standardDeviations: number
    upper: PriceStudySeries
  }
  | {
    fastPeriod: number
    histogram: PriceStudySeries
    kind: 'MACD'
    macd: PriceStudySeries
    signal: PriceStudySeries
    signalPeriod: number
    slowPeriod: number
  }

/**
 * The returned bars, as columns rather than a row per bar.
 *
 * Every array is the same length and `date[i]` dates the i-th bar in all of them, which is the
 * position a study series already aligns to. A row per bar repeated all seven field names for
 * every one of them: at the tool's own 250-row ceiling that was 16,750 characters of key names
 * against 32,123 of result -- half the payload spent restating the shape of a table. The site's
 * own stored year series has always been spaced by index for the same reason.
 */
export type PriceHistoryColumns = { [Field in keyof PriceHistoryRow]: Array<PriceHistoryRow[Field]> }

/** Restated in every result, beside the columns it governs, for a reader without the tool list. */
export const PRICE_COLUMN_NOTE
  = 'prices holds one array per field; date[i] dates the i-th bar and every array has that length.'

export type PriceHistoryReadResult = {
  adjustment: 'adjusted-close'
  adjustmentMethodology: string
  currency: string
  dataAsOf: string
  delay: 'end-of-day'
  exchange: string
  fetchedAt: string
  interval: '1d' | '1mo' | '1wk'
  name?: string
  priceColumns: typeof PRICE_COLUMN_NOTE
  prices: PriceHistoryColumns
  requestedRange: { endDate: string; startDate: string }
  skippedRowCount: number
  provider: string
  sourceUrl: string
  studies: PriceStudyResult[]
  // Present only when studies were asked for; a plain history has nothing to align.
  studyAlignment?: typeof STUDY_ALIGNMENT_NOTE
  studyPriceField: 'adjustedClose'
  symbol: string
  totalValidRowCount: number
  truncated: boolean
}

type ProviderPriceHistory = {
  adjustmentMethodology: string
  currency: string
  delay: 'end-of-day'
  exchange: string
  name?: string
  prices: PriceHistoryRow[]
  provider: string
  skippedRowCount: number
  sourceUrl: string
  symbol: string
}

export type PriceHistoryProvider = {
  readDaily(symbol: string, range: { endDate: string; startDate: string }): Promise<ProviderPriceHistory>
}
