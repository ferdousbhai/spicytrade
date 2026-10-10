import { describe, expect, it, vi } from 'vitest'
import { type ChartResultArray } from 'yahoo-finance2/modules/chart'

import { addDays } from '../src/domain/iso-date'
import { type JsonObject } from '../src/domain/json-payload'
import { CallerVisibleError } from '../src/server/caller-visible-error'

import {
  MAX_PRICE_HISTORY_RETURNED_ROWS,
  MAX_PRICE_HISTORY_SPAN_DAYS,
  type PriceHistoryProvider,
  PriceHistoryReadParameters,
  type PriceHistoryReadResult,
  type PriceHistoryRow,
} from '../src/server/market-research-contracts'
import {
  createMarketResearchTools,
  createYahooPriceHistoryProvider,
  readPriceHistory,
} from '../src/server/market-research-tools'

const now = new Date('2026-08-14T12:00:00.000Z')

function historyRows(count: number, start = '2026-07-01'): PriceHistoryRow[] {
  const first = new Date(`${start}T00:00:00.000Z`)
  return Array.from({ length: count }, (_, index) => {
    const date = new Date(first)
    date.setUTCDate(date.getUTCDate() + index)
    return {
      adjustedClose: index + 1,
      close: (index + 1) * 10,
      date: date.toISOString().slice(0, 10),
      high: (index + 1) * 10 + 1,
      low: (index + 1) * 10 - 1,
      open: (index + 1) * 10,
      volume: 1_000 + index,
    }
  })
}

function priceProvider(
  prices: PriceHistoryRow[],
  overrides: Partial<Awaited<ReturnType<PriceHistoryProvider['readDaily']>>> = {},
) {
  return {
    readDaily: vi.fn().mockResolvedValue({
      adjustmentMethodology: 'unadjusted OHLCV plus split- and dividend-adjusted close',
      currency: 'USD',
      delay: 'end-of-day' as const,
      exchange: 'US equities EOD',
      prices,
      provider: 'test-provider',
      skippedRowCount: 0,
      sourceUrl: 'https://provider.example/history?symbol=AAPL',
      symbol: 'AAPL',
      ...overrides,
    }),
  }
}

function chartDate(date: string): Date {
  return new Date(`${date}T13:30:00.000Z`)
}

function chartClient(quotes: ChartResultArray['quotes'], meta: JsonObject = {}) {
  return {
    chart: vi.fn().mockResolvedValue({
      meta: { currency: 'USD', exchangeName: 'NMS', symbol: 'AAPL', ...meta },
      quotes,
    }),
  }
}

/** One bar back out of the columns, so a row-shaped expectation still reads as one. */
function bar(prices: PriceHistoryReadResult['prices'], index: number) {
  return {
    adjustedClose: prices.adjustedClose[index],
    close: prices.close[index],
    date: prices.date[index],
    high: prices.high[index],
    low: prices.low[index],
    open: prices.open[index],
    volume: prices.volume[index],
  }
}

describe('market research tools', () => {
  it('returns adjusted history and aligns optional studies with the bounded row window', async () => {
    const provider = priceProvider(historyRows(30))
    const result = await readPriceHistory({
      endDate: '2026-07-30',
      interval: '1d',
      limit: 5,
      startDate: '2026-07-01',
      studies: [
        { kind: 'SMA', period: 3 },
        { kind: 'EMA', period: 3 },
        { kind: 'RSI', period: 3 },
        { kind: 'BBANDS', period: 3, standardDeviations: 2 },
        { fastPeriod: 3, kind: 'MACD', signalPeriod: 2, slowPeriod: 5 },
      ],
      symbol: 'AAPL',
    }, provider, now)

    expect(provider.readDaily).toHaveBeenCalledWith('AAPL', {
      endDate: '2026-07-30',
      startDate: '2026-07-01',
    })
    expect(result).toMatchObject({
      adjustment: 'adjusted-close',
      dataAsOf: '2026-07-30',
      delay: 'end-of-day',
      provider: 'test-provider',
      studyPriceField: 'adjustedClose',
      totalValidRowCount: 30,
      truncated: true,
    })
    expect(bar(result.prices, 0)).toMatchObject({ adjustedClose: 26, close: 260, date: '2026-07-26' })
    expect(result.studies).toHaveLength(5)
    // A study is positioned against the returned rows rather than re-dated point by point:
    // `firstDate` must be the date of the bar at `firstPriceIndex` or the alignment is a lie.
    expect(result.studies[0]).toEqual({
      kind: 'SMA',
      period: 3,
      series: { firstDate: '2026-07-26', firstPriceIndex: 0, values: [25, 26, 27, 28, 29] },
    })
    expect(result.studies[2]).toMatchObject({
      kind: 'RSI',
      series: { firstDate: result.prices.date[0]!, firstPriceIndex: 0, values: [100, 100, 100, 100, 100] },
    })
    const macd = result.studies[4]!
    expect(macd).toMatchObject({ fastPeriod: 3, kind: 'MACD', signalPeriod: 2, slowPeriod: 5 })
    if (macd.kind !== 'MACD') throw new Error('expected the MACD study')
    for (const series of [macd.histogram, macd.macd, macd.signal]) {
      expect(series.firstPriceIndex).toBe(0)
      expect(series.values).toHaveLength(5)
    }
    expect(result.studyAlignment).toContain('prices.date[firstPriceIndex + i]')
  })

  it('describes study alignment against the columns the payload actually carries', () => {
    // `prices` is columns, so `prices[firstPriceIndex + i]` names no bar at all.
    const [tool] = createMarketResearchTools(priceProvider(historyRows(1)))
    expect(tool!.description).toContain('prices.date[firstPriceIndex + i]')
    expect(tool!.description).not.toContain('prices[firstPriceIndex')
  })

  it('states a study that has no value in the returned window instead of padding it', async () => {
    const result = await readPriceHistory({
      studies: [{ kind: 'SMA', period: 20 }],
      symbol: 'AAPL',
    }, priceProvider(historyRows(5)), now)

    expect(result.studies[0]).toEqual({ kind: 'SMA', period: 20, series: { values: [] } })
    expect(result.prices.date).toHaveLength(5)
  })

  it('returns the bars as equal-length columns, and says so in the result', async () => {
    // Half the payload at the row ceiling was the seven field names, restated per bar. What
    // makes that safe to drop is that every array is the same length and dated by `date[i]`,
    // so the result carries that sentence beside the columns it governs.
    const result = await readPriceHistory({ symbol: 'AAPL' }, priceProvider(historyRows(5)), now)
    const columns = Object.values(result.prices)

    expect(columns).toHaveLength(7)
    for (const column of columns) expect(column).toHaveLength(result.prices.date.length)
    expect(result.priceColumns).toContain('date[i] dates the i-th bar')
  })

  it('rounds returned prices and study values to the finest increment a US equity trades in', async () => {
    const noisy = historyRows(3).map((row) => ({
      ...row,
      adjustedClose: 218.1199951171875,
      close: 218.1199951171875,
      high: 219.44999694824219,
      volume: 1_234_567,
    }))

    const result = await readPriceHistory({
      studies: [{ kind: 'SMA', period: 2 }],
      symbol: 'AAPL',
    }, priceProvider(noisy), now)

    expect(bar(result.prices, 0)).toMatchObject({ close: 218.12, high: 219.45, volume: 1_234_567 })
    expect(result.studies[0]).toMatchObject({ series: { values: [218.12, 218.12] } })
  })

  it('leaves a plain history free of the study alignment note', async () => {
    const result = await readPriceHistory({ symbol: 'AAPL' }, priceProvider(historyRows(3)), now)

    expect(result.studies).toEqual([])
    expect(result.studyAlignment).toBeUndefined()
  })

  it('defaults the inclusive range to the New York market date', async () => {
    const provider = priceProvider(historyRows(1, '2026-08-14'))

    const result = await readPriceHistory(
      { symbol: 'AAPL' },
      provider,
      new Date('2026-08-15T01:00:00.000Z'),
    )

    expect(result.requestedRange.endDate).toBe('2026-08-14')
    expect(provider.readDaily).toHaveBeenCalledWith('AAPL', expect.objectContaining({
      endDate: '2026-08-14',
    }))
  })

  it('refuses a range wider than the provider-row allocation as the caller\'s request', async () => {
    const provider = priceProvider(historyRows(1))

    // The widest window: MAX_PRICE_HISTORY_SPAN_DAYS inclusive calendar days.
    await expect(readPriceHistory({
      endDate: '2026-07-30',
      startDate: addDays('2026-07-30', -(MAX_PRICE_HISTORY_SPAN_DAYS - 1)),
      symbol: 'AAPL',
    }, provider, now)).resolves.toMatchObject({ prices: { date: [expect.any(String)] } })
    expect(provider.readDaily).toHaveBeenCalledTimes(1)

    // One day wider is refused before any fetch, whatever the interval asks for.
    for (const interval of ['1d', '1mo'] as const) {
      const refused = readPriceHistory({
        endDate: '2026-07-30',
        interval,
        startDate: addDays('2026-07-30', -MAX_PRICE_HISTORY_SPAN_DAYS),
        symbol: 'AAPL',
      }, provider, now)
      await expect(refused).rejects.toThrow(CallerVisibleError)
      await expect(refused).rejects.toThrow(`longer than ${MAX_PRICE_HISTORY_SPAN_DAYS} calendar days`)
    }
    await expect(readPriceHistory({
      endDate: '2026-07-30',
      interval: '1mo',
      startDate: '2006-07-30',
      symbol: 'AAPL',
    }, provider, now)).rejects.toThrow('calendar days')
    expect(provider.readDaily).toHaveBeenCalledTimes(1)
  })

  it('answers a window after the current market date as holding no sessions, without fetching', async () => {
    const provider = priceProvider(historyRows(1))

    const refused = readPriceHistory({
      endDate: '2026-08-20',
      startDate: '2026-08-15',
      symbol: 'AAPL',
    }, provider, now)
    await expect(refused).rejects.toThrow(CallerVisibleError)
    await expect(refused).rejects.toThrow('Price history window contains no trading sessions.')
    expect(provider.readDaily).not.toHaveBeenCalled()
  })

  it('fails before fetching on invalid ranges and duplicate or invalid studies', async () => {
    const provider = priceProvider(historyRows(1))
    await expect(readPriceHistory({
      endDate: '2026-02-31',
      symbol: 'AAPL',
    }, provider, now)).rejects.toThrow('end date')
    await expect(readPriceHistory({
      endDate: '2026-01-01',
      startDate: '2026-01-02',
      symbol: 'AAPL',
    }, provider, now)).rejects.toThrow('range')
    await expect(readPriceHistory({
      studies: [{ kind: 'SMA' }, { kind: 'SMA' }],
      symbol: 'AAPL',
    }, provider, now)).rejects.toThrow('Duplicate')
    await expect(readPriceHistory({
      studies: [{ fastPeriod: 26, kind: 'MACD', slowPeriod: 12 }],
      symbol: 'AAPL',
    }, provider, now)).rejects.toThrow('fast period')
    expect(provider.readDaily).not.toHaveBeenCalled()
  })

  it('allows study parameters up to the returned-row budget and no further', async () => {
    await expect(readPriceHistory({
      studies: [{ kind: 'SMA', period: 201 }, { kind: 'BBANDS', standardDeviations: 5.1 }],
      symbol: 'AAPL',
    }, priceProvider(historyRows(1)), now)).resolves.toMatchObject({
      studies: [{ kind: 'SMA', period: 201 }, { kind: 'BBANDS', standardDeviations: 5.1 }],
    })
    // The advertised `maximum` and the runtime bound are the same number, so a period the schema
    // accepts can never be one the reader refuses -- and nothing wider is advertised.
    const advertised = [...JSON.stringify(PriceHistoryReadParameters).matchAll(/"maximum":(\d+)/g)]
      .map((match) => Number(match[1]))
    expect(advertised.length).toBeGreaterThan(0)
    expect(Math.max(...advertised)).toBe(MAX_PRICE_HISTORY_RETURNED_ROWS)
    await expect(readPriceHistory({
      studies: [{ kind: 'SMA', period: MAX_PRICE_HISTORY_RETURNED_ROWS }],
      symbol: 'AAPL',
    }, priceProvider(historyRows(1)), now)).resolves.toMatchObject({
      studies: [{ kind: 'SMA', period: MAX_PRICE_HISTORY_RETURNED_ROWS }],
    })
    await expect(readPriceHistory({
      studies: [{ kind: 'SMA', period: MAX_PRICE_HISTORY_RETURNED_ROWS + 1 }],
      symbol: 'AAPL',
    }, priceProvider(historyRows(1)), now)).rejects.toThrow('SMA period')
    await expect(readPriceHistory({
      studies: [{ kind: 'BBANDS', period: 2, standardDeviations: Number.MAX_VALUE }],
      symbol: 'AAPL',
    }, priceProvider(historyRows(2).map((row, index) => ({
      ...row,
      adjustedClose: index === 0 ? 1 : 5,
    }))), now)).rejects.toThrow('non-finite result')
  })

  it('aggregates weekly and monthly bars locally without changing adjusted-close semantics', async () => {
    const rows = historyRows(10, '2026-07-27')
    const weekly = await readPriceHistory(
      { interval: '1wk', symbol: 'AAPL' },
      priceProvider(rows),
      now,
    )
    const monthly = await readPriceHistory(
      { interval: '1mo', symbol: 'AAPL' },
      priceProvider(rows),
      now,
    )

    expect(weekly.prices.date).toHaveLength(2)
    expect(bar(weekly.prices, 0)).toMatchObject({
      adjustedClose: 7,
      close: 70,
      date: '2026-08-02',
      high: 71,
      low: 9,
      open: 10,
    })
    expect(monthly.prices.date).toHaveLength(2)
    expect(bar(monthly.prices, 0)).toMatchObject({ adjustedClose: 5, date: '2026-07-31' })
    expect(bar(monthly.prices, 1)).toMatchObject({ adjustedClose: 10, date: '2026-08-05' })
  })

  it('normalizes Yahoo chart bars to ascending adjusted rows and skips incomplete ones', async () => {
    const client = chartClient([
      { adjclose: 101, close: 102, date: chartDate('2026-08-14'), high: 103, low: 100, open: 101, volume: 2_000 },
      { adjclose: 100, close: 101, date: chartDate('2026-08-13'), high: 102, low: 98, open: 99, volume: 1_000 },
      { adjclose: 98, close: 99, date: chartDate('2026-08-12'), high: 100, low: 98, open: null, volume: 900 },
    ], { longName: 'Apple Inc.' })
    const provider = createYahooPriceHistoryProvider(client)

    const result = await provider.readDaily('AAPL', { endDate: '2026-08-14', startDate: '2026-08-12' })

    expect(client.chart).toHaveBeenCalledWith('AAPL', {
      interval: '1d',
      period1: '2026-08-12',
      period2: '2026-08-15',
    })
    // The link names the request the client made: epoch seconds, with the exclusive end.
    const source = new URL(result.sourceUrl)
    expect(source.searchParams.get('period1')).toBe(String(Date.parse('2026-08-12') / 1_000))
    expect(source.searchParams.get('period2')).toBe(String(Date.parse('2026-08-15') / 1_000))
    expect(result).toMatchObject({
      currency: 'USD',
      exchange: 'NMS',
      name: 'Apple Inc.',
      provider: 'yahoo-finance-chart',
      skippedRowCount: 1,
      symbol: 'AAPL',
    })
    expect(result.prices).toEqual([
      { adjustedClose: 100, close: 101, date: '2026-08-13', high: 102, low: 98, open: 99, volume: 1_000 },
      { adjustedClose: 101, close: 102, date: '2026-08-14', high: 103, low: 100, open: 101, volume: 2_000 },
    ])
  })

  it('rejects Yahoo history when required adjusted close or market metadata is absent', async () => {
    const provider = createYahooPriceHistoryProvider(chartClient([
      { close: 10, date: chartDate('2026-08-14'), high: 11, low: 9, open: 10, volume: 1_000 },
    ]))
    const missingCurrency = createYahooPriceHistoryProvider(chartClient([
      { adjclose: 10, close: 10, date: chartDate('2026-08-14'), high: 11, low: 9, open: 10, volume: 1_000 },
    ], { currency: undefined }))
    const range = { endDate: '2026-08-14', startDate: '2026-08-14' }

    await expect(provider.readDaily('AAPL', range)).rejects.toThrow('invalid-response')
    await expect(missingCurrency.readDaily('AAPL', range)).rejects.toThrow('invalid-response')
  })

  it('rejects duplicate dates, cross-symbol responses, and empty Yahoo history', async () => {
    const bar = { adjclose: 10, close: 10, date: chartDate('2026-08-14'), high: 11, low: 9, open: 10, volume: 1_000 }
    const range = { endDate: '2026-08-14', startDate: '2026-08-14' }
    const duplicates = createYahooPriceHistoryProvider(chartClient([bar, { ...bar }]))
    const mismatch = createYahooPriceHistoryProvider(chartClient([bar], { symbol: 'MSFT' }))
    const unusable = createYahooPriceHistoryProvider(chartClient([{ ...bar, open: null }]))

    await expect(duplicates.readDaily('AAPL', range)).rejects.toThrow('invalid-response')
    await expect(mismatch.readDaily('AAPL', range)).rejects.toThrow('invalid-response')
    await expect(unusable.readDaily('AAPL', range)).rejects.toThrow('invalid-response')
  })

  it('answers a window Yahoo returns no bars for as holding no sessions, not a bad response', async () => {
    const weekend = createYahooPriceHistoryProvider(chartClient([]))

    const refused = weekend.readDaily('AAPL', { endDate: '2026-08-16', startDate: '2026-08-15' })
    await expect(refused).rejects.toThrow(CallerVisibleError)
    await expect(refused).rejects.toThrow('Price history window contains no trading sessions.')
  })

  it('translates class-share notation and reports provider failure as unavailable', async () => {
    const failing = {
      chart: vi.fn().mockRejectedValue(new Error('network down')),
    }

    await expect(createYahooPriceHistoryProvider(failing).readDaily('BRK/B', {
      endDate: '2026-08-14',
      startDate: '2026-08-14',
    })).rejects.toThrow('ResearchProvider:yahoo:unavailable')
    expect(failing.chart).toHaveBeenCalledWith('BRK-B', expect.any(Object))
  })
})

describe('price study defaults', () => {
  it('applies the defaults the tool description states, from one definition', async () => {
    const { normalizeStudies } = await import('../src/server/technical-studies')
    const contracts = await import('../src/server/market-research-contracts')
    expect(normalizeStudies([{ kind: 'RSI' }, { kind: 'BBANDS' }, { kind: 'MACD' }])).toEqual([
      { kind: 'RSI', period: contracts.DEFAULT_STUDY_PERIOD },
      { kind: 'BBANDS', period: contracts.DEFAULT_STUDY_PERIOD, standardDeviations: contracts.DEFAULT_BOLLINGER_DEVIATIONS },
      {
        fastPeriod: contracts.DEFAULT_MACD_FAST_PERIOD,
        kind: 'MACD',
        signalPeriod: contracts.DEFAULT_MACD_SIGNAL_PERIOD,
        slowPeriod: contracts.DEFAULT_MACD_SLOW_PERIOD,
      },
    ])
    const description = JSON.stringify(contracts.PriceHistoryReadParameters.properties.studies)
    expect(description).toContain(`period ${contracts.DEFAULT_STUDY_PERIOD}`)
    expect(description).toContain(
      `MACD ${contracts.DEFAULT_MACD_FAST_PERIOD}/${contracts.DEFAULT_MACD_SLOW_PERIOD}/${contracts.DEFAULT_MACD_SIGNAL_PERIOD}`,
    )
    expect(description).toContain(`deviations ${contracts.DEFAULT_BOLLINGER_DEVIATIONS}`)
    expect(() => normalizeStudies([{ kind: 'SMA', period: contracts.MIN_STUDY_PERIOD - 1 }])).toThrow()
  })
})
