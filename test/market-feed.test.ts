import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  candleFeedPeriod,
  candleSubscription,
  isSameOriginWebSocketRequest,
  MarketFeedStatusSchema,
  MAX_OPTION_GREEKS_CONTRACTS,
  type OptionGreeksEvent,
  OptionGreeksRequestRegistry,
  optionGreeksFromRow,
  parseOptionStreamerSymbols,
  parseRequestedSymbols,
} from '../src/server/market-feed-contracts'
import { MAX_LIVE_STREAM_SYMBOLS } from '../src/domain/watchlist'

function greek(streamerSymbol: string, delta = 0.5): OptionGreeksEvent {
  return {
    delta,
    eventAt: '2026-08-13T14:00:00.000Z',
    gamma: 0.03,
    impliedVolatility: 0.42,
    impliedVolatilityUnit: 'decimal_ratio',
    optionPrice: 3.2,
    receivedAt: '2026-08-13T14:00:00.100Z',
    rho: 0.02,
    source: 'tastytrade-dxlink',
    streamerSymbol,
    theta: -0.04,
    vega: 0.12,
  }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('market feed subscription boundary', () => {
  it('validates explicit relay lifecycle frames separately from market data', () => {
    expect(MarketFeedStatusSchema.parse({
      asOf: '2026-08-14T14:00:00.000Z', state: 'live', type: 'feed-status',
    }).state).toBe('live')
    expect(MarketFeedStatusSchema.safeParse({
      asOf: '2026-08-14T14:00:00.000Z', state: 'healthy', type: 'feed-status',
    }).success).toBe(false)
  })

  it('normalizes and deduplicates only after the whole subscription is valid', () => {
    const url = new URL('https://spice.test/api/stream?symbols=spy,NVDA,spy,BRK/B')
    expect(parseRequestedSymbols(url)).toEqual(['SPY', 'NVDA', 'BRK/B'])
    expect(() => parseRequestedSymbols(new URL(
      'https://spice.test/api/stream?symbols=SPY,../secret,NVDA',
    ))).toThrow()
  })

  it('rejects missing, repeated, empty, and oversized symbol parameters', () => {
    expect(() => parseRequestedSymbols(new URL('https://spice.test/api/stream'))).toThrow()
    expect(() => parseRequestedSymbols(new URL('https://spice.test/api/stream?symbols='))).toThrow()
    expect(() => parseRequestedSymbols(new URL(
      'https://spice.test/api/stream?symbols=SPY&symbols=NVDA',
    ))).toThrow()
    const symbols = Array.from({ length: MAX_LIVE_STREAM_SYMBOLS + 1 }, (_, index) => `A${index}`)
    expect(() => parseRequestedSymbols(new URL(
      `https://spice.test/api/stream?symbols=${symbols.join(',')}`,
    ))).toThrow()
  })

  it('rejects cross-origin WebSocket handshakes', () => {
    expect(isSameOriginWebSocketRequest(new Request('https://spice.test/api/stream', {
      headers: { Origin: 'https://spice.test' },
    }))).toBe(true)
    expect(isSameOriginWebSocketRequest(new Request('https://spice.test/api/stream', {
      headers: { Origin: 'https://evil.test' },
    }))).toBe(false)
  })

  it('requests bounded regular-session candle history', () => {
    expect(candleSubscription('NVDA', 1_765_000_000_000, 'intraday')).toEqual({
      type: 'Candle',
      symbol: 'NVDA{=5m,tho=true}',
      fromTime: 1_765_000_000_000,
    })
  })

  it('keeps the two candle periods distinct in both directions', () => {
    expect(candleSubscription('NVDA', 1_765_000_000_000, 'daily')).toEqual({
      type: 'Candle',
      symbol: 'NVDA{=d}',
      fromTime: 1_765_000_000_000,
    })
    expect(candleFeedPeriod('NVDA{=5m,tho=true}')).toBe('intraday')
    expect(candleFeedPeriod('NVDA{=d}')).toBe('daily')
    // An unknown or absent suffix must not be guessed into one of the two series.
    expect(candleFeedPeriod('NVDA{=1h}')).toBeUndefined()
    expect(candleFeedPeriod('NVDA')).toBeUndefined()
  })

  it('parses complete finite Greeks with explicit event, receipt, source, and IV units', () => {
    expect(optionGreeksFromRow({
      eventSymbol: '.NVDA260814C250',
      time: 1_786_629_600_000,
      price: 3.2,
      volatility: 0.42,
      delta: 0.5,
      gamma: 0.03,
      theta: -0.04,
      rho: 0.02,
      vega: 0.12,
    }, new Date('2026-08-13T14:00:00.100Z'))).toEqual(greek('.NVDA260814C250'))
    expect(optionGreeksFromRow({
      eventSymbol: '.NVDA260814C250',
      time: 1_786_629_600_000,
      price: 3.2,
      volatility: Number.NaN,
      delta: 0.5,
      gamma: 0.03,
      theta: -0.04,
      rho: 0.02,
      vega: 0.12,
    })).toBeUndefined()
  })

  it('bounds and validates exact option streamer symbols at the DO boundary', () => {
    expect(parseOptionStreamerSymbols(['.NVDA260814C250', '.NVDA260814C250'])).toEqual(['.NVDA260814C250'])
    expect(() => parseOptionStreamerSymbols(['NVDA260814C250'])).toThrow()
    expect(() => parseOptionStreamerSymbols(Array.from({ length: MAX_OPTION_GREEKS_CONTRACTS + 1 }, (_, index) => `.NVDA260814C${index}`))).toThrow()
  })

  it('waits for every requested symbol and preserves request order', async () => {
    const registry = new OptionGreeksRequestRegistry()
    const lease = registry.register(['.NVDA260814C250', '.NVDA260814P250'], 1_000)
    let completed = false
    lease.promise.then(() => { completed = true }).catch(() => undefined)
    registry.accept(greek('.NVDA260814P250', -0.5))
    await Promise.resolve()
    expect(completed).toBe(false)
    registry.accept(greek('.NVDA260814C250'))
    await expect(lease.promise).resolves.toEqual([
      greek('.NVDA260814C250'),
      greek('.NVDA260814P250', -0.5),
    ])
    lease.release()
    expect(registry.demandSymbols()).toEqual(new Set())
  })

  it('shares observations across concurrent waiters and cleans refcounts independently', async () => {
    const registry = new OptionGreeksRequestRegistry()
    const pair = registry.register(['.NVDA260814C250', '.NVDA260814P250'], 1_000)
    const callOnly = registry.register(['.NVDA260814C250'], 1_000)
    expect(registry.demandSymbols()).toEqual(new Set(['.NVDA260814C250', '.NVDA260814P250']))
    registry.accept(greek('.NVDA260814C250'))
    await expect(callOnly.promise).resolves.toEqual([greek('.NVDA260814C250')])
    callOnly.release()
    expect(registry.demandSymbols()).toEqual(new Set(['.NVDA260814C250', '.NVDA260814P250']))
    registry.accept(greek('.NVDA260814P250', -0.5))
    await expect(pair.promise).resolves.toHaveLength(2)
    pair.release()
    expect(registry.activeRequestCount).toBe(0)
    expect(registry.demandSymbols()).toEqual(new Set())
  })

  it('times out with the missing symbols and releases all demand', async () => {
    vi.useFakeTimers()
    const registry = new OptionGreeksRequestRegistry()
    const lease = registry.register(['.NVDA260814C250', '.NVDA260814P250'], 25)
    registry.accept(greek('.NVDA260814C250'))
    const rejection = expect(lease.promise).rejects.toThrow('.NVDA260814P250')
    await vi.advanceTimersByTimeAsync(25)
    await rejection
    lease.release()
    expect(registry.activeRequestCount).toBe(0)
    expect(registry.demandSymbols()).toEqual(new Set())
  })
})
