import { describe, expect, it } from 'vitest'

import {
  fiftyTwoWeekPosition,
  formatMarketMetric,
  isCashOpenMinute,
  issuerName,
  MarketSnapshotSchema,
  marketSnapshotFromPublic,
  PublicMarketSnapshotSchema,
  volatilityVerdict,
} from '../src/domain/market'
import { marketSnapshotFixture } from './fixtures/market'
import { normalizeTastytradeMarketTicker, tickerFromStoredRecords } from '../src/server/tastytrade-market-normalization'

/** The ticker the live snapshot path builds, without the stored records it persists beside it. */
function liveTicker(...args: Parameters<typeof normalizeTastytradeMarketTicker>) {
  return normalizeTastytradeMarketTicker(...args).ticker
}

describe('ticker metric presentation', () => {
  it('formats market metrics with at most one decimal place', () => {
    expect(formatMarketMetric(26.9097222)).toBe('26.9')
    expect(formatMarketMetric(72)).toBe('72')
  })

  it('treats low rank and percentile as cheap', () => {
    expect(volatilityVerdict({ ivRank: 22, ivPercentile: 27 })).toBe('cheap')
  })

  it('treats high rank and percentile as rich', () => {
    expect(volatilityVerdict({ ivRank: 75, ivPercentile: 82 })).toBe('rich')
    expect(volatilityVerdict({ ivRank: 70, ivPercentile: 80 })).toBe('rich')
  })

  it('calls a split reading fair on either side', () => {
    expect(volatilityVerdict({ ivRank: 75, ivPercentile: 60 })).toBe('fair')
    expect(volatilityVerdict({ ivRank: 50, ivPercentile: 82 })).toBe('fair')
    expect(volatilityVerdict({ ivRank: 20, ivPercentile: 50 })).toBe('fair')
    expect(volatilityVerdict({ ivRank: 50, ivPercentile: 20 })).toBe('fair')
  })

  it('keeps missing premium observations explicit', () => {
    expect(volatilityVerdict({ ivRank: undefined, ivPercentile: 82 })).toBe('unavailable')
  })

  // Every string here is a description this catalog serves today.
  it('cuts the security class the provider appends, however it is written', () => {
    expect(issuerName('NVIDIA Corporation - Common Stock')).toBe('NVIDIA Corporation')
    expect(issuerName('Ford Motor Company Common Stock')).toBe('Ford Motor Company')
    expect(issuerName('Dell Technologies Inc. Class C Common Stock')).toBe('Dell Technologies Inc.')
    expect(issuerName('Alphabet Inc. - Class C Capital Stock')).toBe('Alphabet Inc.')
    expect(issuerName('Warner Bros. Discovery, Inc. - Series A Common Stock')).toBe('Warner Bros. Discovery, Inc.')
    expect(issuerName('Shopify Inc. - Class A Subordinate Voting Shares')).toBe('Shopify Inc.')
    expect(issuerName('XPLR Infrastructure, LP Common Units representing limited partner interests'))
      .toBe('XPLR Infrastructure, LP')
    expect(issuerName('Service Properties Trust - Common Shares of Beneficial Interest'))
      .toBe('Service Properties Trust')
    expect(issuerName('ASML Holding N.V. - New York Registry Shares')).toBe('ASML Holding N.V.')
  })

  it('reads an issuer the provider states twice once, and leaves a different name beside it whole', () => {
    expect(issuerName('Sunstone Hotel Investors, Inc. Sunstone Hotel Investors, Inc. Common Shares'))
      .toBe('Sunstone Hotel Investors, Inc.')
    expect(issuerName('Petroleo Brasileiro S.A. Petrobras ADS')).toBe('Petroleo Brasileiro S.A. Petrobras')
    expect(issuerName('Duos Technologies Group, Inc.')).toBe('Duos Technologies Group, Inc.')
  })

  it('cuts a depositary-share tail whether it is named or described', () => {
    expect(issuerName('Nokia Corporation Sponsored American Depositary Shares')).toBe('Nokia Corporation')
    expect(issuerName('NIO Inc. American depositary shares, each representing one Class A ordinary share'))
      .toBe('NIO Inc.')
    expect(issuerName('KE Holdings Inc American Depositary Shares (each representing three Class A Ordinary Shares)'))
      .toBe('KE Holdings Inc')
  })

  it('drops a trailing qualifier and the abbreviated name the tape carries', () => {
    expect(issuerName('Walt Disney Company (The) Common Stock')).toBe('Walt Disney Company')
    expect(issuerName('Merck & Company, Inc. Common Stock (new)')).toBe('Merck & Company, Inc.')
    expect(issuerName('Energy Fuels Inc Ordinary Shares (Canada)')).toBe('Energy Fuels Inc')
    expect(issuerName('CAREVIEW COMMUNS INC by Careview Communications, Inc.'))
      .toBe('Careview Communications, Inc.')
  })

  it('reads the abbreviated class a shouted tape string appends', () => {
    expect(issuerName('CATALENT INC COM')).toBe('CATALENT INC')
    expect(issuerName('GORES HLD XI CL A OS')).toBe('GORES HLD XI')
    expect(issuerName('SEALED AIR CORP NEW')).toBe('SEALED AIR CORP')
    expect(issuerName('ATENTO S A SHS')).toBe('ATENTO S A')
    expect(issuerName('MARSH & MCLENNAN COMPANIES INC')).toBe('MARSH & MCLENNAN COMPANIES INC')
  })

  it('leaves a name that carries no class tail whole', () => {
    expect(issuerName('iShares 20+ Year Treasury Bond ETF')).toBe('iShares 20+ Year Treasury Bond ETF')
    expect(issuerName('SPDR Gold Shares')).toBe('SPDR Gold Shares')
    expect(issuerName('iPath Series B S&P 500 VIX Short-Term Futures ETN'))
      .toBe('iPath Series B S&P 500 VIX Short-Term Futures ETN')
    expect(issuerName('Natural Grocers by Vitamin Cottage, Inc. Common Stock'))
      .toBe('Natural Grocers by Vitamin Cottage, Inc.')
    expect(issuerName('ADS-TEC ENERGY PLC - Ordinary Shares')).toBe('ADS-TEC ENERGY PLC')
    expect(issuerName('AT&T Inc.')).toBe('AT&T Inc.')
  })

  it('places the current price within a valid 52-week range', () => {
    expect(fiftyTwoWeekPosition({ price: 75, yearLow: 50, yearHigh: 100 })).toBe(50)
    expect(fiftyTwoWeekPosition({ price: 125, yearLow: 50, yearHigh: 100 })).toBe(100)
    expect(fiftyTwoWeekPosition({ price: 75, yearLow: 50 })).toBeUndefined()
  })
})

describe('snapshot contract', () => {
  it('validates a complete tastytrade snapshot', () => {
    expect(MarketSnapshotSchema.parse(marketSnapshotFixture()).tickers.length).toBeGreaterThan(3)
    expect(() => MarketSnapshotSchema.parse({ ...marketSnapshotFixture(), watchlists: [] })).toThrow()
  })

  it('admits only the public watchlist kind on the public wire and rejects unknown fields; marketSnapshotFromPublic round-trips tickers', () => {
    const owner = marketSnapshotFixture()
    const publicValue = {
      ...owner,
      watchlists: [{ ...owner.watchlists[0]!, kind: 'public' as const }],
    }

    expect(PublicMarketSnapshotSchema.parse(publicValue).tickers[0]).toEqual(owner.tickers[0])
    expect(() => PublicMarketSnapshotSchema.parse(owner)).toThrow()
    // Derived from the owner schema, the public one still refuses a field it does not name.
    expect(() => PublicMarketSnapshotSchema.parse({ ...publicValue, accountNumber: 'owner-only' })).toThrow()
    expect(marketSnapshotFromPublic(publicValue).tickers).toEqual(owner.tickers)
  })
})

describe('tastytrade normalization', () => {
  it('preserves present optional volatility observations without plausibility caps', () => {
    const ticker = liveTicker('BE', {
      symbol: 'BE',
      'historical-volatility-30-day': '0',
      'implied-volatility-index': '0.18',
      'implied-volatility-index-5-day-change': '-99',
      'implied-volatility-index-rank': '0.25',
      'implied-volatility-percentile': '0.3',
      'iv-hv-30-day-difference': '2001',
      'liquidity-rating': '5',
    }, {
      symbol: 'BE', mark: '700', 'previous-close': '695',
      'updated-at': '2026-08-13T13:31:00.000Z',
    })

    expect(ticker).toMatchObject({ symbol: 'BE', ivRank: 25 })
    expect(ticker.historicalVolatility30Day).toBe(0)
    expect(ticker.ivIndex5DayChange).toBe(-9_900)
    expect(ticker.ivHistoricalVolatility30DayDifference).toBe(2_001)
  })

  it('keeps the provider term observation without an arbitrary volatility ceiling', () => {
    const ticker = liveTicker('BE', {
      symbol: 'BE', 'implied-volatility-index': '0.18',
      'implied-volatility-index-rank': '0.25', 'implied-volatility-percentile': '0.3',
      'liquidity-rating': '5',
      'option-expiration-implied-volatilities': [
        { 'expiration-date': '2026-09-04T20:00:00Z', 'implied-volatility': '0.21', 'option-chain-type': 'Standard' },
        { 'expiration-date': '2026-09-11T20:00:00Z', 'implied-volatility': '99', 'option-chain-type': 'Standard' },
      ],
    }, {
      symbol: 'BE', mark: '700', 'previous-close': '695',
      'updated-at': '2026-08-13T13:31:00.000Z',
    })

    expect(ticker.ivTermStructure?.backIv).toBe(9_900)
  })

  it('rejects incomplete live ticker facts instead of filling estimates', () => {
    const quote = {
      symbol: 'SPY', mark: '700', 'previous-close': '695',
      volume: '12345678',
      'updated-at': '2026-08-13T13:31:00.000Z',
    }
    const metrics = {
      symbol: 'SPY', 'implied-volatility-index': '0.18',
      'implied-volatility-index-rank': '0.25', 'implied-volatility-percentile': '0.3',
      'liquidity-rating': '5', 'market-cap': '900000000000',
    }
    expect(liveTicker('SPY', metrics, quote)).toMatchObject({
      symbol: 'SPY', price: 700, ivIndex: 18, ivRank: 25, ivPercentile: 30,
      marketCap: 900_000_000_000, volume: 12_345_678,
      updatedAt: '2026-08-13T13:31:00.000Z',
      sparkline: [], change: 5, changePercent: expect.closeTo(0.7194244604),
    })
    expect(liveTicker('SPY', { ...metrics, 'market-cap': '0' }, quote).marketCap)
      .toBeUndefined()
    expect(liveTicker('SPCX', metrics, quote, {
      symbol: 'SPCX', description: 'SpaceX Corporation',
    })).toMatchObject({ assetType: undefined, name: 'SpaceX Corporation' })
    expect(liveTicker('SPCX', metrics, quote, {
      symbol: 'SPCX', description: 'SpaceX Corporation', 'is-etf': false, 'is-index': false,
    }).assetType).toBe('stock')
    expect(liveTicker('SPY', metrics, {
      symbol: 'SPY', mark: '700', prevDayClose: '695',
      updatedAt: '2026-08-13T13:31:00.000Z',
    }).change).toBe(5)
    expect(() => liveTicker('SPY', undefined, quote)).toThrow('missing-metrics')
    expect(() => liveTicker('SPY', metrics, { ...quote, 'updated-at': undefined }))
      .toThrow('invalid-updated-at')
    expect(liveTicker('SPY', {
      symbol: 'SPY',
      'implied-volatility-index': null,
      'implied-volatility-percentile': null,
      'implied-volatility-rank': null,
      'liquidity-rating': null,
    }, quote)).toMatchObject({
      ivIndex: undefined,
      ivPercentile: undefined,
      ivRank: undefined,
      liquidity: undefined,
    })
    expect(() => liveTicker('SPY', metrics, { ...quote, volume: 'many' }))
      .toThrow('invalid-volume')
  })

  it('reads lendability from the catalog on the live path, as the stored path does', () => {
    const instrument = { symbol: 'SPY', description: 'SPDR S&P 500 ETF', lendability: 'Easy To Borrow', 'is-etf': true }
    const live = normalizeTastytradeMarketTicker('SPY', { symbol: 'SPY', lendability: 'Locate Required' }, {
      symbol: 'SPY', mark: '700', 'previous-close': '695', 'updated-at': '2026-08-13T13:31:00.000Z',
    }, instrument)
    const stored = tickerFromStoredRecords('SPY', live.metricRecord, live.quoteRecord, instrument)
    expect(live.ticker.lendability).toBe('Easy To Borrow')
    expect(stored.lendability).toBe(live.ticker.lendability)
  })

  it('keeps a 52-week range whose high equals its low and refuses only an inverted one', () => {
    const quote = {
      symbol: 'FLAT', mark: '10', 'previous-close': '10',
      'updated-at': '2026-08-13T13:31:00.000Z',
      'year-high-price': '10', 'year-low-price': '10',
    }
    const ticker = liveTicker('FLAT', { symbol: 'FLAT' }, quote)
    expect(ticker).toMatchObject({ yearHigh: 10, yearLow: 10 })
    expect(fiftyTwoWeekPosition(ticker)).toBeUndefined()
    expect(() => liveTicker('FLAT', { symbol: 'FLAT' }, { ...quote, 'year-low-price': '11' }))
      .toThrow('invalid-year-range')
  })

  it('normalizes optional volatility, instrument, borrow, and 52-week enrichment', () => {
    const ticker = liveTicker('SPY', {
      symbol: 'SPY',
      'historical-volatility-30-day': '14',
      'implied-volatility-index': '0.18',
      'implied-volatility-index-5-day-change': '-0.02',
      'implied-volatility-index-rank': '0.25',
      'implied-volatility-percentile': '0.3',
      'iv-hv-30-day-difference': '4',
      'liquidity-rating': '5',
      'option-expiration-implied-volatilities': [
        { 'expiration-date': null, 'implied-volatility': null },
        { 'expiration-date': '2026-09-11T20:00:00Z', 'implied-volatility': '0.19', 'option-chain-type': 'Standard' },
        { 'expiration-date': '2026-09-04T20:00:00Z', 'implied-volatility': '0.21', 'option-chain-type': 'Standard' },
      ],
    }, {
      symbol: 'SPY', mark: '700', 'previous-close': '695',
      'updated-at': '2026-08-13T13:31:00.000Z',
      'year-high-price': '710', 'year-low-price': '480',
    }, {
      symbol: 'SPY', description: 'SPDR S&P 500 ETF',
      lendability: 'Easy To Borrow', 'is-etf': true,
    })

    expect(ticker).toMatchObject({
      assetType: 'etf',
      historicalVolatility30Day: 14,
      ivHistoricalVolatility30DayDifference: 4,
      ivIndex5DayChange: -2,
      ivTermStructure: {
        frontExpiration: '2026-09-04', frontIv: 21,
        backExpiration: '2026-09-11', backIv: 19,
      },
      lendability: 'Easy To Borrow',
      name: 'SPDR S&P 500 ETF',
      yearHigh: 710,
      yearLow: 480,
    })
  })
})

describe('the cash-open minute', () => {
  it('is 09:30 America/New_York on a weekday, in either DST offset', () => {
    expect(isCashOpenMinute(new Date('2026-09-16T13:30:00.000Z'))).toBe(true)
    expect(isCashOpenMinute(new Date('2026-09-16T14:30:00.000Z'))).toBe(false)
    expect(isCashOpenMinute(new Date('2026-01-14T14:30:00.000Z'))).toBe(true)
    expect(isCashOpenMinute(new Date('2026-01-14T13:30:00.000Z'))).toBe(false)
  })

  it('does not treat a weekend 09:30 as the cash open', () => {
    expect(isCashOpenMinute(new Date('2026-09-19T13:30:00.000Z'))).toBe(false)
  })
})
