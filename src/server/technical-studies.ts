import { JsonObjectSchema } from '../domain/json-payload'
import {
  DEFAULT_BOLLINGER_DEVIATIONS,
  DEFAULT_MACD_FAST_PERIOD,
  DEFAULT_MACD_SIGNAL_PERIOD,
  DEFAULT_MACD_SLOW_PERIOD,
  DEFAULT_STUDY_PERIOD,
  MAX_PRICE_STUDIES,
  MAX_PRICE_STUDY_PERIOD,
  MIN_MACD_SLOW_PERIOD,
  MIN_STUDY_PERIOD,
  type PriceHistoryRow,
  type PriceStudyResult,
  type PriceStudySeries,
  roundPrice,
  type StudyInput,
} from './market-research-contracts'
import { boundedInteger, CallerVisibleError } from './caller-visible-error'

type NormalizedStudy =
  | { kind: 'SMA' | 'EMA' | 'RSI'; period: number }
  | { kind: 'BBANDS'; period: number; standardDeviations: number }
  | { fastPeriod: number; kind: 'MACD'; signalPeriod: number; slowPeriod: number }

/**
 * Position one computed series against the rows the caller will actually receive. Every study
 * here warms up once and then runs to the end of the series, so a series is fully described by
 * where its first value lands and the values from there on; an interior gap would break that
 * promise silently, so it throws instead of being padded back into the result.
 */
function alignSeries(
  values: Array<number | null>,
  returnedStart: number,
  dates: string[],
): PriceStudySeries {
  const returned = values.slice(returnedStart)
  const firstPriceIndex = returned.findIndex((value) => value !== null)
  if (firstPriceIndex < 0) return { values: [] }
  const aligned = returned.slice(firstPriceIndex)
  if (aligned.some((value) => value === null)) {
    throw new CallerVisibleError('Price study produced a discontinuous series.')
  }
  return {
    firstDate: dates[returnedStart + firstPriceIndex]!,
    firstPriceIndex,
    values: aligned.map((value) => roundPrice(value!)),
  }
}

function simpleMovingAverage(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null)
  let sum = 0
  for (let index = 0; index < values.length; index++) {
    sum += values[index]!
    if (index >= period) sum -= values[index - period]!
    if (index >= period - 1) result[index] = sum / period
  }
  return result
}

function exponentialMovingAverage(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null)
  if (values.length < period) return result
  const multiplier = 2 / (period + 1)
  let previous = values.slice(0, period).reduce((sum, value) => sum + value, 0) / period
  result[period - 1] = previous
  for (let index = period; index < values.length; index++) {
    previous = (values[index]! - previous) * multiplier + previous
    result[index] = previous
  }
  return result
}

function relativeStrengthIndex(values: number[], period: number): Array<number | null> {
  const result: Array<number | null> = Array(values.length).fill(null)
  if (values.length <= period) return result
  let gains = 0
  let losses = 0
  for (let index = 1; index <= period; index++) {
    const change = values[index]! - values[index - 1]!
    gains += Math.max(0, change)
    losses += Math.max(0, -change)
  }
  let averageGain = gains / period
  let averageLoss = losses / period
  const rsi = () => averageLoss === 0
    ? averageGain === 0 ? 50 : 100
    : 100 - 100 / (1 + averageGain / averageLoss)
  result[period] = rsi()
  for (let index = period + 1; index < values.length; index++) {
    const change = values[index]! - values[index - 1]!
    averageGain = (averageGain * (period - 1) + Math.max(0, change)) / period
    averageLoss = (averageLoss * (period - 1) + Math.max(0, -change)) / period
    result[index] = rsi()
  }
  return result
}

function bollingerBands(values: number[], period: number, deviations: number) {
  const middle = simpleMovingAverage(values, period)
  return values.map((_, index) => {
    if (index < period - 1) return { lower: null, middle: null, upper: null }
    const mean = middle[index]!
    const window = values.slice(index - period + 1, index + 1)
    const variance = window.reduce((sum, value) => sum + (value - mean) ** 2, 0) / period
    const width = Math.sqrt(variance) * deviations
    const lower = mean - width
    const upper = mean + width
    if (![lower, mean, upper].every(Number.isFinite)) {
      throw new CallerVisibleError('Bollinger study produced a non-finite result.')
    }
    return { lower, middle: mean, upper }
  })
}

function movingAverageConvergenceDivergence(
  values: number[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number,
) {
  const fast = exponentialMovingAverage(values, fastPeriod)
  const slow = exponentialMovingAverage(values, slowPeriod)
  const macd = values.map((_, index) => fast[index] === null || slow[index] === null
    ? null
    : fast[index]! - slow[index]!)
  const firstMacdIndex = macd.findIndex((value) => value !== null)
  // SAFETY: firstMacdIndex is the first non-null entry and the MACD series has no interior gaps,
  // so every value from that index onward is a number.
  const signalValues = firstMacdIndex < 0
    ? []
    : exponentialMovingAverage(macd.slice(firstMacdIndex) as number[], signalPeriod)
  return macd.map((value, index) => {
    const signal = firstMacdIndex < 0 || index < firstMacdIndex
      ? null
      : signalValues[index - firstMacdIndex] ?? null
    return {
      histogram: value === null || signal === null ? null : value - signal,
      macd: value,
      signal,
    }
  })
}

export function normalizeStudies(inputs: StudyInput[] | undefined): NormalizedStudy[] {
  if (!inputs) return []
  if (!Array.isArray(inputs) || inputs.length > MAX_PRICE_STUDIES) throw new CallerVisibleError('Price studies are invalid.')
  const seen = new Set<string>()
  const remember = (key: string) => {
    if (seen.has(key)) throw new CallerVisibleError('Duplicate price studies are not allowed.')
    seen.add(key)
  }
  return inputs.map((input) => {
    if (!JsonObjectSchema.safeParse(input).success) throw new CallerVisibleError('Price studies are invalid.')
    if (input.kind === 'SMA' || input.kind === 'EMA' || input.kind === 'RSI') {
      const period = boundedInteger(input.period, DEFAULT_STUDY_PERIOD, MIN_STUDY_PERIOD, MAX_PRICE_STUDY_PERIOD, `${input.kind} period`)
      remember(`${input.kind}:${period}`)
      return { kind: input.kind, period }
    }
    if (input.kind === 'BBANDS') {
      const period = boundedInteger(input.period, DEFAULT_STUDY_PERIOD, MIN_STUDY_PERIOD, MAX_PRICE_STUDY_PERIOD, 'Bollinger period')
      const standardDeviations = input.standardDeviations ?? DEFAULT_BOLLINGER_DEVIATIONS
      if (!Number.isFinite(standardDeviations) || standardDeviations <= 0) {
        throw new CallerVisibleError('Bollinger deviations are invalid.')
      }
      remember(`${input.kind}:${period}:${standardDeviations}`)
      return { kind: input.kind, period, standardDeviations }
    }
    // Reachable: `inputs` is untrusted model output, not yet a closed union.
    if (input.kind !== 'MACD') throw new CallerVisibleError('Price studies are invalid.')
    const fastPeriod = boundedInteger(
      input.fastPeriod, DEFAULT_MACD_FAST_PERIOD, MIN_STUDY_PERIOD, MAX_PRICE_STUDY_PERIOD, 'MACD fast period',
    )
    const slowPeriod = boundedInteger(
      input.slowPeriod, DEFAULT_MACD_SLOW_PERIOD, MIN_MACD_SLOW_PERIOD, MAX_PRICE_STUDY_PERIOD, 'MACD slow period',
    )
    const signalPeriod = boundedInteger(
      input.signalPeriod, DEFAULT_MACD_SIGNAL_PERIOD, MIN_STUDY_PERIOD, MAX_PRICE_STUDY_PERIOD, 'MACD signal period',
    )
    if (fastPeriod >= slowPeriod) throw new CallerVisibleError('MACD fast period must be less than slow period.')
    remember(`${input.kind}:${fastPeriod}:${slowPeriod}:${signalPeriod}`)
    return { fastPeriod, kind: input.kind, signalPeriod, slowPeriod }
  })
}

export function calculateStudies(
  rows: PriceHistoryRow[],
  inputs: NormalizedStudy[],
  returnedStart: number,
): PriceStudyResult[] {
  const dates = rows.map((row) => row.date)
  const prices = rows.map((row) => row.adjustedClose)
  const align = (values: Array<number | null>) => alignSeries(values, returnedStart, dates)
  return inputs.map((input): PriceStudyResult => {
    // MACD and BBANDS are tested first: each is the only member with its kind, so ruling them
    // out narrows what remains to the single-period studies with no runtime guard left over.
    if (input.kind === 'MACD') {
      const values = movingAverageConvergenceDivergence(
        prices,
        input.fastPeriod,
        input.slowPeriod,
        input.signalPeriod,
      )
      // Three series, each with its own warm-up: the signal line starts later than the MACD line
      // and the histogram exists only where both do, so each carries its own first row.
      return {
        fastPeriod: input.fastPeriod,
        histogram: align(values.map((point) => point.histogram)),
        kind: input.kind,
        macd: align(values.map((point) => point.macd)),
        signal: align(values.map((point) => point.signal)),
        signalPeriod: input.signalPeriod,
        slowPeriod: input.slowPeriod,
      }
    }
    if (input.kind === 'BBANDS') {
      const values = bollingerBands(prices, input.period, input.standardDeviations)
      return {
        kind: input.kind,
        lower: align(values.map((band) => band.lower)),
        middle: align(values.map((band) => band.middle)),
        period: input.period,
        standardDeviations: input.standardDeviations,
        upper: align(values.map((band) => band.upper)),
      }
    }
    const values = input.kind === 'SMA'
      ? simpleMovingAverage(prices, input.period)
      : input.kind === 'EMA'
        ? exponentialMovingAverage(prices, input.period)
        : relativeStrengthIndex(prices, input.period)
    return { kind: input.kind, period: input.period, series: align(values) }
  })
}
