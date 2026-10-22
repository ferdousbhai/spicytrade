import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Value } from 'typebox/value'

import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { brokerCredential, stubBroker } from './broker-stub'
import {
  findOptionContracts,
  readAccountHistory,
  readAccountSnapshot,
  readMarketMetrics,
  readInstrumentQuotes,
  searchSymbols,
  createOptionContractFindTool,
  createSymbolSearchTool,
} from '../src/server/brokerage-read-tools'
import { FIND_OPTION_CONTRACTS_MODES, SPICE_GUIDE } from '../src/server/doctrine'
import { createPublicMarketReadTools } from '../src/server/public-market-tools'
import { MAX_QUERY_LENGTH } from '../src/server/symbol-search'
import {
  AccountHistoryReadParameters,
  DEFAULT_HISTORY_ITEMS,
  DEFAULT_ORDER_HISTORY_DAYS,
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_TRANSACTION_HISTORY_DAYS,
  MAX_HISTORY_ORDER_LEGS,
  UNDERLYING_SYMBOL,
} from '../src/server/brokerage-read-contracts'

const tastytrade = stubBroker()

beforeEach(() => setBrokerApi(tastytrade))
afterEach(() => resetBrokerApi())

const now = new Date('2026-08-13T12:00:00.000Z')

describe('brokerage read tools', () => {
  beforeEach(() => {
    tastytrade.resolveAccountNumber.mockReset().mockResolvedValue('PRIVATE123')
    tastytrade.tastyRequest.mockReset()
  })

  it('returns the full account snapshot without account identity', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/positions')) {
        return Promise.resolve({ data: { items: [{
          symbol: 'SPY option',
          'underlying-symbol': 'SPY',
          quantity: '2',
          'quantity-direction': 'Long',
          'instrument-type': 'Equity Option',
          'average-open-price': '1.1',
          'mark-price': '1.25',
          'expires-at': '2026-09-18T20:00:00Z',
        }] } })
      }
      if (path.endsWith('/balances')) {
        return Promise.resolve({ data: {
          'account-number': 'PRIVATE123',
          'available-trading-funds': '61000',
          'cash-available-to-withdraw': '65000',
          'cash-balance': '70000',
          'day-trading-buying-power': '320000',
          'derivative-buying-power': '80000',
          'equity-buying-power': '160000',
          'net-liquidating-value': '100000',
        } })
      }
      if (path.includes('/complex-orders/live')) return Promise.resolve({ data: { items: [] } })
      if (path.includes('/orders/live')) {
        return Promise.resolve({ data: { items: [{
          id: '101', status: 'Live', 'order-type': 'Limit', price: '1.20',
          'price-effect': 'Debit', 'time-in-force': 'Day',
          legs: [
            { action: 'Buy to Open', quantity: '1', symbol: 'SPY call', 'instrument-type': 'Equity Option' },
          ],
        }] } })
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    const result = await readAccountSnapshot({}, {}, brokerCredential)

    expect(result.source).toBe('tastytrade')
    expect(result.balances).toMatchObject({ cashBalance: 70_000, netLiquidatingValue: 100_000 })
    expect(result.positions).toEqual([{
      averageOpenPrice: 1.1,
      direction: 'Long',
      expiresAt: '2026-09-18T20:00:00Z',
      instrumentType: 'Equity Option',
      quantity: 2,
      symbol: 'SPY option',
      underlying: 'SPY',
    }])
    expect(result.positions?.[0]).not.toHaveProperty('markPrice')
    expect(result.orders).toMatchObject([{ id: '101', legs: [{ symbol: 'SPY call' }] }])
    expect(Object.keys(result).sort()).toEqual(['asOf', 'balances', 'orders', 'positions', 'source'])
    expect(JSON.stringify(result)).not.toContain('PRIVATE123')
    expect(tastytrade.tastyRequest).toHaveBeenCalledTimes(4)
  })

  it('returns only the requested snapshot parts and still loads the complete account', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/positions')) {
        return Promise.resolve({ data: { items: [{
          symbol: 'SPY',
          'underlying-symbol': 'SPY',
          quantity: '10',
          'quantity-direction': 'Long',
          'instrument-type': 'Equity',
        }] } })
      }
      if (path.endsWith('/balances')) {
        return Promise.resolve({ data: {
          'available-trading-funds': '61000',
          'cash-available-to-withdraw': '65000',
          'cash-balance': '70000',
          'day-trading-buying-power': '320000',
          'derivative-buying-power': '80000',
          'equity-buying-power': '160000',
          'net-liquidating-value': '100000',
        } })
      }
      if (path.includes('/orders/live') || path.includes('/complex-orders/live')) {
        return Promise.resolve({ data: { items: [] } })
      }
      throw new Error(`Unexpected path: ${path}`)
    })

    const result = await readAccountSnapshot({}, { include: ['positions'] }, brokerCredential)

    expect(Object.keys(result).sort()).toEqual(['asOf', 'positions', 'source'])
    expect(result.positions).toEqual([{
      direction: 'Long', instrumentType: 'Equity', quantity: 10, symbol: 'SPY', underlying: 'SPY',
    }])
    expect(result.balances).toBeUndefined()
    expect(result.orders).toBeUndefined()
    expect(tastytrade.tastyRequest).toHaveBeenCalledTimes(4)
  })

  it('rejects an empty or duplicate include list rather than returning an empty snapshot', async () => {
    await expect(readAccountSnapshot({}, { include: [] }, brokerCredential))
      .rejects.toThrow('Account snapshot include is invalid.')
    await expect(readAccountSnapshot({}, { include: ['positions', 'positions'] }, brokerCredential))
      .rejects.toThrow('Account snapshot include is invalid.')
    expect(tastytrade.resolveAccountNumber).not.toHaveBeenCalled()
  })

  it('names a snapshot that cannot be verified rather than returning a partial account', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path.includes('/positions')) return Promise.resolve({ data: { unexpected: [] } })
      if (path.endsWith('/balances')) {
        return Promise.resolve({ data: {
          'available-trading-funds': '61000',
          'cash-available-to-withdraw': '65000',
          'cash-balance': '70000',
          'day-trading-buying-power': '320000',
          'derivative-buying-power': '80000',
          'equity-buying-power': '160000',
          'net-liquidating-value': '100000',
        } })
      }
      return Promise.resolve({ data: { items: [] } })
    })

    await expect(readAccountSnapshot({}, {}, brokerCredential))
      .rejects.toThrow('could not verify every open position')
  })

  it('normalizes transaction history, strips account number, and reports pagination', async () => {
    tastytrade.tastyRequest.mockResolvedValue({
      data: {
        items: [{
          id: 42,
          'account-number': 'PRIVATE123',
          action: 'Buy to Open',
          'executed-at': '2026-08-12T14:30:00.000Z',
          'instrument-type': 'Equity Option',
          'net-value': '315.50',
          'net-value-effect': 'Debit',
          'order-id': 99,
          price: '3.15',
          quantity: '1',
          symbol: 'AAPL  260918C00200000',
          'transaction-sub-type': 'Buy',
          'transaction-type': 'Trade',
          'underlying-symbol': 'AAPL',
        }],
      },
      pagination: { 'total-items': 3 },
    })

    const result = await readAccountHistory({}, {
      days: 30,
      limit: 1,
      pageOffset: 0,
      transactionType: 'Trade',
      type: 'transactions',
      underlyingSymbol: 'AAPL',
    }, brokerCredential, now)

    expect(tastytrade.tastyRequest).toHaveBeenCalledWith(
      {},
      '/accounts/PRIVATE123/transactions?page-offset=0&per-page=1&sort=Desc&start-date=2026-07-14&underlying-symbol=AAPL&type=Trade',
      {},
      brokerCredential,
    )
    expect(result).toMatchObject({
      asOf: now.toISOString(),
      totalItemCount: 3,
      truncated: true,
    })
    expect(result.items[0]).toEqual({
      action: 'Buy to Open',
      id: '42',
      instrumentType: 'Equity Option',
      netValue: -315.5,
      occurredAt: '2026-08-12T14:30:00.000Z',
      orderId: '99',
      price: 3.15,
      quantity: 1,
      symbol: 'AAPL  260918C00200000',
      transactionSubType: 'Buy',
      transactionType: 'Trade',
      underlyingSymbol: 'AAPL',
      value: undefined,
    })
    expect(JSON.stringify(result)).not.toContain('PRIVATE123')
  })

  it('reads a zero-value transaction whose effect is None, and refuses None beside moved money', async () => {
    const expiration = {
      id: 43,
      action: 'Sell to Close',
      'executed-at': '2026-08-12T20:00:00.000Z',
      'net-value': '0.0',
      'net-value-effect': 'None',
      'transaction-type': 'Receive Deliver',
      value: '0.0',
      'value-effect': 'None',
    }
    tastytrade.tastyRequest.mockResolvedValueOnce({ data: { items: [expiration] }, pagination: { 'total-items': 1 } })
    await expect(readAccountHistory({}, { type: 'transactions' }, brokerCredential, now))
      .resolves.toMatchObject({ items: [{ id: '43', netValue: 0, value: 0 }] })

    tastytrade.tastyRequest.mockResolvedValueOnce({ data: { items: [{ ...expiration, value: '5.00' }] } })
    await expect(readAccountHistory({}, { type: 'transactions' }, brokerCredential, now)).rejects.toThrow('invalid response')

    tastytrade.tastyRequest.mockResolvedValueOnce({ data: { items: [{ ...expiration, 'value-effect': 'Sideways' }] } })
    await expect(readAccountHistory({}, { type: 'transactions' }, brokerCredential, now)).rejects.toThrow('invalid response')
  })

  it('redacts account identity from broker history errors', async () => {
    tastytrade.tastyRequest.mockRejectedValue(new Error('TastytradeApi:500:/accounts/PRIVATE123/transactions'))
    // Capture the outcome rather than asserting inside a catch: a call that stopped throwing
    // would skip the catch entirely and the redaction check — the point of this test — with it.
    const failure = await readAccountHistory({}, { type: 'transactions' }, brokerCredential, now)
      .then(() => 'resolved', String)
    expect(failure).toContain('transactions are unavailable')
    expect(failure).not.toContain('PRIVATE123')
  })

  it('allows pagination to continue until the broker reports completion', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [] }, pagination: { 'total-items': 0 } })

    await expect(readAccountHistory({}, {
      days: 366,
      pageOffset: 1_001,
      type: 'orders',
    }, brokerCredential, now)).resolves.toMatchObject({ pageOffset: 1_001, truncated: false })
    expect(tastytrade.tastyRequest).toHaveBeenCalledWith(
      {},
      '/accounts/PRIVATE123/orders?page-offset=1001&per-page=25&sort=Desc&start-date=2025-08-12',
      {},
      brokerCredential,
    )
  })

  it('applies the history defaults it advertises', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [] }, pagination: { 'total-items': 0 } })
    const startDate = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString().slice(0, 10)

    await readAccountHistory({}, { type: 'transactions' }, brokerCredential, now)
    await readAccountHistory({}, { type: 'orders' }, brokerCredential, now)
    expect(tastytrade.tastyRequest.mock.calls.map(([, path]) => path)).toEqual([
      `/accounts/PRIVATE123/transactions?page-offset=0&per-page=${DEFAULT_HISTORY_ITEMS}&sort=Desc&start-date=${startDate(DEFAULT_TRANSACTION_HISTORY_DAYS)}`,
      `/accounts/PRIVATE123/orders?page-offset=0&per-page=${DEFAULT_HISTORY_ITEMS}&sort=Desc&start-date=${startDate(DEFAULT_ORDER_HISTORY_DAYS)}`,
    ])
    expect(AccountHistoryReadParameters).toMatchObject({ properties: {
      days: {
        description: `Calendar-day lookback. Defaults to ${DEFAULT_TRANSACTION_HISTORY_DAYS} for transactions and ${DEFAULT_ORDER_HISTORY_DAYS} for orders.`,
      },
      limit: { description: `Maximum rows to return. Defaults to ${DEFAULT_HISTORY_ITEMS}.` },
    } })
  })

  it('refuses a history order with more legs than a row may carry rather than truncating it', async () => {
    const leg = { action: 'Buy to Open', 'instrument-type': 'Equity Option', quantity: 1, symbol: 'SPY   260918C00700000' }
    const order = (legs: number) => ({ data: { items: [{
      id: 7, legs: Array.from({ length: legs }, () => leg), 'order-type': 'Limit', status: 'Filled',
      'time-in-force': 'Day', 'underlying-instrument-type': 'Equity', 'underlying-symbol': 'SPY',
      'updated-at': '2026-08-12T14:30:00.000Z',
    }] } })
    tastytrade.tastyRequest.mockResolvedValueOnce(order(MAX_HISTORY_ORDER_LEGS))
    await expect(readAccountHistory({}, { type: 'orders' }, brokerCredential, now)).resolves.toMatchObject({ items: [{ id: '7' }] })
    tastytrade.tastyRequest.mockResolvedValueOnce(order(MAX_HISTORY_ORDER_LEGS + 1))
    await expect(readAccountHistory({}, { type: 'orders' }, brokerCredential, now)).rejects.toThrow('invalid response')
  })

  it('rejects order-only transaction filters and malformed history envelopes', async () => {
    await expect(readAccountHistory({}, {
      transactionType: 'Trade',
      type: 'orders',
    }, brokerCredential, now)).rejects.toThrow('valid only for transaction history')
    expect(tastytrade.resolveAccountNumber).not.toHaveBeenCalled()

    tastytrade.tastyRequest.mockResolvedValue({ data: {} })
    await expect(readAccountHistory({}, { type: 'transactions' }, brokerCredential, now)).rejects.toThrow('invalid response')
  })

  it('returns compact metrics in request order with explicit missing symbols', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [{
      symbol: 'NVDA',
      beta: '1.7',
      'earnings-per-share': '4.20',
      'historical-volatility-30-day': '42',
      // Points, not a ratio, and equal to the index's number: 51 - 42 = the 9 below.
      'implied-volatility-30-day': '51',
      'implied-volatility-index': '0.51',
      'implied-volatility-index-rank': '0.72',
      'implied-volatility-percentile': '0.81',
      'iv-hv-30-day-difference': '9',
      'liquidity-rank': '0.98',
      'liquidity-rating': 5,
      'liquidity-value': '12.5',
      'market-cap': '3000000000000',
      'price-earnings-ratio': '35.4',
      'updated-at': '2026-08-13T11:55:00.000Z',
      earnings: {
        estimated: true,
        'expected-report-date': '2026-08-26',
        'time-of-day': 'After Market',
      },
    }] } })

    const result = await readMarketMetrics({}, ['NVDA', 'AAPL', 'NVDA'], now)

    expect(tastytrade.tastyRequest).toHaveBeenCalledWith({}, '/market-metrics?symbols=NVDA,AAPL')
    expect(result).toMatchObject({
      asOf: now.toISOString(),
      missingSymbols: ['AAPL'],
      volatilityUnit: 'percentage_points',
    })
    expect(result.metrics).toEqual([expect.objectContaining({
      earningsDate: '2026-08-26',
      historicalVolatility30Day: 42,
      impliedHistoricalVolatility30DayDifference: 9,
      impliedVolatility30Day: 51,
      impliedVolatilityIndex: 51,
      impliedVolatilityRank: 72,
      liquidityRating: 5,
      marketCap: 3_000_000_000_000,
      symbol: 'NVDA',
    })])
  })

  /**
   * The 100x bug this guards: `implied-volatility-30-day` arrives as points and
   * `implied-volatility-index` as a ratio, both carrying the same number. Reading the 30-day as
   * a ratio published NVDA at 3468 under a `percentage_points` label. The provider's own
   * difference field is the invariant that catches it.
   */
  it('keeps the 30-day implied volatility in the same points as the difference tastytrade reports', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [{
      symbol: 'AAPL',
      'historical-volatility-30-day': '22.89',
      'implied-volatility-30-day': '24.59',
      'implied-volatility-index': '0.2459',
      'iv-hv-30-day-difference': '1.7',
      'updated-at': '2026-09-21T12:02:13.037Z',
    }] } })

    const [metric] = (await readMarketMetrics({}, ['AAPL'], now)).metrics

    expect(metric.impliedVolatility30Day).toBe(24.59)
    expect(metric.impliedVolatilityIndex).toBe(24.59)
    expect(
      Math.round((metric.impliedVolatility30Day! - metric.historicalVolatility30Day!) * 100) / 100,
    ).toBe(metric.impliedHistoricalVolatility30DayDifference)
  })

  it('reads a metrics row for a symbol as wide as the grammar admits', async () => {
    // Nine and ten characters: a full six-character root with a two- and three-character class.
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [
      { symbol: 'ABCDEF/GH', 'updated-at': '2026-08-13T11:55:00.000Z' },
      { symbol: 'ABCDEF/GHI', 'updated-at': '2026-08-13T11:55:00.000Z' },
    ] } })

    const result = await readMarketMetrics({}, ['ABCDEF/GH', 'ABCDEF/GHI'], now)

    expect(result.metrics.map((metric) => metric.symbol)).toEqual(['ABCDEF/GH', 'ABCDEF/GHI'])
  })

  it('leaves the capitalization tastytrade reports as zero out of the row', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [{
      symbol: 'TQQQ',
      'market-cap': '0.0',
      'updated-at': '2026-08-13T11:55:00.000Z',
    }] } })

    const result = await readMarketMetrics({}, ['TQQQ'], now)

    expect(result.metrics[0]?.marketCap).toBeUndefined()
  })

  it('rejects duplicate market metrics', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [
      { symbol: 'NVDA' },
      { symbol: 'NVDA' },
    ] } })
    await expect(readMarketMetrics({}, ['NVDA'], now)).rejects.toThrow('invalid response')
  })

  it('bounds and compacts symbol search results', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [
      { symbol: 'AAPL', description: 'Apple Inc.', options: true, 'instrument-type': 'Equity', 'listed-market': 'NASDAQ' },
      { symbol: 'AAP', description: 'Advance Auto Parts', options: true, 'instrument-type': 'Equity' },
    ] } })

    const result = await searchSymbols({}, 'Apple', 1, now)

    expect(tastytrade.tastyRequest).toHaveBeenCalledWith({}, '/symbols/search/Apple')
    expect(result).toMatchObject({ totalResultCount: 2, truncated: true })
    expect(result.results).toEqual([{
      description: 'Apple Inc.',
      hasOptions: true,
      instrumentType: 'Equity',
      listedMarket: 'NASDAQ',
      symbol: 'AAPL',
    }])
  })

  it('applies and advertises the default search size', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: Array.from({ length: DEFAULT_SEARCH_RESULTS + 1 }, (_, index) => ({
      symbol: `A${index}`, description: `Name ${index}`,
    })) } })
    await expect(searchSymbols({}, 'A')).resolves.toMatchObject({ truncated: true })
    await expect(searchSymbols({}, 'A').then((result) => result.results.length)).resolves.toBe(DEFAULT_SEARCH_RESULTS)
    expect(createSymbolSearchTool({}).parameters)
      .toMatchObject({ properties: { limit: { description: `Maximum results to return. Defaults to ${DEFAULT_SEARCH_RESULTS}.` } } })
  })

  it('bounds the query exactly as the anonymous search_symbols does', async () => {
    // Same tool name at both tiers, so the same size must be admitted at both.
    const anonymous = createPublicMarketReadTools({}, () => undefined).find((tool) => tool.name === 'search_symbols')
    expect(anonymous?.parameters).toMatchObject({ properties: { query: { maxLength: MAX_QUERY_LENGTH } } })
    expect(createSymbolSearchTool({}).parameters)
      .toMatchObject({ properties: { query: { maxLength: MAX_QUERY_LENGTH } } })
    await expect(searchSymbols({}, 'A'.repeat(MAX_QUERY_LENGTH + 1), 1, now))
      .rejects.toThrow('Symbol search query is invalid.')
    expect(tastytrade.tastyRequest).not.toHaveBeenCalled()
  })

  it('refuses at runtime a query of only whitespace and LIKE wildcards, as the schema does', async () => {
    await expect(searchSymbols({}, ' %_ ', 1, now)).rejects.toThrow('Symbol search query is invalid.')
    expect(tastytrade.tastyRequest).not.toHaveBeenCalled()
  })

  it('refuses a query that would be a dot segment of the broker path, at both tiers', async () => {
    // `encodeURIComponent` leaves dots, so `/symbols/search/..` would reach another broker path.
    const anonymous = createPublicMarketReadTools({}, () => undefined).find((tool) => tool.name === 'search_symbols')
    for (const query of ['.', '..', ' .. ']) {
      await expect(searchSymbols({}, query, 1, now)).rejects.toThrow('Symbol search query is invalid.')
      expect(Value.Check(createSymbolSearchTool({}).parameters, { query })).toBe(false)
      expect(Value.Check(anonymous!.parameters, { query })).toBe(false)
    }
    expect(tastytrade.tastyRequest).not.toHaveBeenCalled()
    // A dot inside a real query is not a path segment of its own.
    for (const query of ['...', 'BRK.B', '.A']) {
      expect(Value.Check(createSymbolSearchTool({}).parameters, { query })).toBe(true)
    }
  })

  it('finds only exact active Standard option contracts, and returns nothing a caller cannot act on', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path === '/option-chains/AAPL') {
        return Promise.resolve({ data: { items: [
          {
            active: true,
            'expiration-date': '2026-09-18',
            'instrument-type': 'Equity Option',
            'is-closing-only': false,
            'option-chain-type': 'Standard',
            'option-type': 'C',
            'root-symbol': 'AAPL',
            'shares-per-contract': 100,
            'streamer-symbol': '.AAPL260918C200',
            'strike-price': '200',
            symbol: 'AAPL  260918C00200000',
            'underlying-symbol': 'AAPL',
          },
          {
            active: false,
            'expiration-date': '2026-09-18',
            'instrument-type': 'Equity Option',
            'option-chain-type': 'Standard',
            'option-type': 'C',
            'root-symbol': 'AAPL',
            'shares-per-contract': 100,
            'strike-price': '200',
            symbol: 'INACTIVE',
            'underlying-symbol': 'AAPL',
          },
          {
            active: true,
            'expiration-date': '2026-09-18',
            'instrument-type': 'Equity Option',
            'option-chain-type': 'Non-standard',
            'option-type': 'C',
            'root-symbol': 'AAPL',
            'shares-per-contract': 150,
            'strike-price': '200',
            symbol: 'ADJUSTED',
            'underlying-symbol': 'AAPL',
          },
        ] } })
      }
      if (path === '/market-data/by-type?equity-option=AAPL%20%20260918C00200000') {
        return Promise.resolve({ data: { items: [{
          symbol: 'AAPL  260918C00200000',
          'open-interest': 4_200,
          volume: 88,
        }] } })
      }
      throw new Error(`Unexpected path ${path}`)
    })

    const result = await findOptionContracts({}, {
      expiry: '2026-09-18', optionType: 'C', strike: 200, underlying: 'AAPL',
    }, now)

    expect(tastytrade.tastyRequest).toHaveBeenCalledWith({}, '/option-chains/AAPL')
    expect(result).toMatchObject({
      mode: 'contracts',
      truncated: false,
    })
    if (result.mode !== 'contracts') throw new Error('Expected contract mode')
    // The OCC symbol and the DXLink streamer symbol are deliberately absent: every tool that
    // takes a contract takes the tuple and resolves those server-side, so returning them was
    // two long strings per row that nothing could be done with.
    expect(result.contracts).toEqual([{
      expirationDate: '2026-09-18',
      isClosingOnly: false,
      openInterest: 4_200,
      optionType: 'C',
      sharesPerContract: 100,
      strikePrice: 200,
      volume: 88,
    }])
  })

  it('returns contracts across every expiration for a strike with no expiry, as its description says', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path === '/option-chains/AAPL') {
        return Promise.resolve({ data: { items: ['2026-09-18', '2026-10-16'].map((expiry) => ({
          active: true,
          'expiration-date': expiry,
          'instrument-type': 'Equity Option',
          'is-closing-only': false,
          'option-chain-type': 'Standard',
          'option-type': 'C',
          'shares-per-contract': 100,
          'strike-price': '200',
          symbol: `AAPL ${expiry} 200`,
          'underlying-symbol': 'AAPL',
        })) } })
      }
      if (path.startsWith('/market-data/by-type?')) return Promise.resolve({ data: { items: [] } })
      throw new Error(`Unexpected path ${path}`)
    })

    const result = await findOptionContracts({}, { optionType: 'C', strike: 200, underlying: 'AAPL' }, now)
    if (result.mode !== 'contracts') throw new Error('Expected contract mode')
    expect(result.contracts.map((contract) => contract.expirationDate)).toEqual(['2026-09-18', '2026-10-16'])

    // The tool description and the guide state that one rule, from one constant.
    expect(FIND_OPTION_CONTRACTS_MODES).toMatch(/no expiry, strike, or nearStrike, lists expirations/)
    expect(FIND_OPTION_CONTRACTS_MODES).toMatch(/across every listed expiration unless expiry names one/)
    expect(createOptionContractFindTool({}).description.startsWith(FIND_OPTION_CONTRACTS_MODES)).toBe(true)
    expect(SPICE_GUIDE).toContain(FIND_OPTION_CONTRACTS_MODES)
  })

  it('returns listed contracts nearest a target strike', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path === '/option-chains/AAPL') {
        return Promise.resolve({ data: { items: [180, 200, 220].map((strike) => ({
          active: true,
          'expiration-date': '2026-09-18',
          'instrument-type': 'Equity Option',
          'is-closing-only': false,
          'option-chain-type': 'Standard',
          'option-type': 'C',
          'shares-per-contract': 100,
          'strike-price': String(strike),
          symbol: `AAPL ${strike}`,
          'underlying-symbol': 'AAPL',
        })) } })
      }
      if (path.startsWith('/market-data/by-type?')) {
        return Promise.resolve({ data: { items: [
          { symbol: 'AAPL 180', 'open-interest': 9_000, volume: 1 },
          { symbol: 'AAPL 200', 'open-interest': 50, volume: 400 },
          { symbol: 'AAPL 220', 'open-interest': 800, volume: 20 },
        ] } })
      }
      throw new Error(`Unexpected path ${path}`)
    })

    const result = await findOptionContracts({}, {
      expiry: '2026-09-18', nearStrike: 205, optionType: 'C', underlying: 'AAPL',
    }, now)

    if (result.mode !== 'contracts') throw new Error('Expected contract mode')
    expect(result.contracts.map((contract) => contract.strikePrice)).toEqual([200, 220, 180])
    expect(result.contracts.map((contract) => contract.openInterest)).toEqual([50, 800, 9_000])
  })

  it('ranks an expiry by open interest then volume when no strike target is given', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path === '/option-chains/AAPL') {
        return Promise.resolve({ data: { items: [
          { strike: 180, symbol: 'AAPL 180' },
          { strike: 200, symbol: 'AAPL 200' },
          { strike: 220, symbol: 'AAPL 220' },
          { strike: 240, symbol: 'AAPL 240' },
        ].map(({ strike, symbol }) => ({
          active: true,
          'expiration-date': '2026-09-18',
          'instrument-type': 'Equity Option',
          'is-closing-only': false,
          'option-chain-type': 'Standard',
          'option-type': 'C',
          'shares-per-contract': 100,
          'strike-price': String(strike),
          symbol,
          'underlying-symbol': 'AAPL',
        })) } })
      }
      if (path.startsWith('/market-data/by-type?')) {
        return Promise.resolve({ data: { items: [
          { symbol: 'AAPL 180', 'open-interest': 100, volume: 5 },
          { symbol: 'AAPL 200', 'open-interest': 500, volume: 1 },
          { symbol: 'AAPL 220', 'open-interest': 500, volume: 40 },
          { symbol: 'AAPL 240', volume: 9_000 },
        ] } })
      }
      throw new Error(`Unexpected path ${path}`)
    })

    const result = await findOptionContracts({}, {
      expiry: '2026-09-18', optionType: 'C', underlying: 'AAPL',
    }, now)

    if (result.mode !== 'contracts') throw new Error('Expected contract mode')
    expect(result.contracts.map((contract) => contract.strikePrice)).toEqual([220, 200, 180, 240])
    expect(result.contracts.map((contract) => ({
      openInterest: contract.openInterest,
      volume: contract.volume,
    }))).toEqual([
      { openInterest: 500, volume: 40 },
      { openInterest: 500, volume: 1 },
      { openInterest: 100, volume: 5 },
      { volume: 9_000 },
    ])
  })

  it('lists expirations without a market-data round trip', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [{
      active: true,
      'expiration-date': '2026-09-18',
      'instrument-type': 'Equity Option',
      'is-closing-only': false,
      'option-chain-type': 'Standard',
      'option-type': 'C',
      'shares-per-contract': 100,
      'strike-price': '200',
      symbol: 'AAPL  260918C00200000',
      'underlying-symbol': 'AAPL',
    }] } })

    const result = await findOptionContracts({}, { underlying: 'AAPL' }, now)

    expect(result).toEqual({
      asOf: now.toISOString(),
      expirationDates: ['2026-09-18'],
      mode: 'expirations',
      source: 'tastytrade',
      truncated: false,
    })
    expect(tastytrade.tastyRequest).toHaveBeenCalledTimes(1)
    expect(tastytrade.tastyRequest).toHaveBeenCalledWith({}, '/option-chains/AAPL')
  })

  it('rejects malformed option rows instead of silently returning an empty chain', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [{
      active: true,
      'instrument-type': 'Equity Option',
      'option-chain-type': 'Standard',
      'option-type': 'C',
      'underlying-symbol': 'AAPL',
    }] } })

    await expect(findOptionContracts({}, { underlying: 'AAPL' }, now)).rejects.toThrow('invalid response')
  })

  it.each(['symbols', 'contracts'])('refuses explicit null %s even when the other quote input is valid', async (field) => {
    await expect(readInstrumentQuotes({}, {
      symbols: ['AAPL'],
      contracts: [{ underlying: 'AAPL', expiry: '2026-09-18', optionType: 'C', strike: 200 }],
      [field]: null,
    }, now)).rejects.toThrow('Quote instruments are invalid.')
    expect(tastytrade.tastyRequest).not.toHaveBeenCalled()
  })

  it('resolves an option tuple and returns a complete non-crossed exact quote', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path === '/option-chains/AAPL') return Promise.resolve({ data: { items: [{
        active: true, 'expiration-date': '2026-09-18', 'instrument-type': 'Equity Option',
        'is-closing-only': false, 'option-chain-type': 'Standard', 'option-type': 'C',
        'shares-per-contract': 100, 'strike-price': '200', symbol: 'AAPL  260918C00200000',
        'underlying-symbol': 'AAPL',
      }] } })
      if (path.startsWith('/market-data/by-type?')) return Promise.resolve({ data: { items: [{
        symbol: 'AAPL  260918C00200000', instrumentType: 'Equity Option',
        bid: 3.1, ask: 3.3, bidSize: 12, askSize: 9, updatedAt: '2026-08-13T11:59:59.000Z',
      }] } })
      throw new Error(`Unexpected path ${path}`)
    })

    const result = await readInstrumentQuotes({}, { contracts: [{
      underlying: 'AAPL', expiry: '2026-09-18', optionType: 'C', strike: 200,
    }] }, now)

    expect(result).toMatchObject({
      source: 'tastytrade-rest-market-data',
      quotes: [{ bid: 3.1, ask: 3.3, mid: 3.2, underlying: 'AAPL' }],
    })
    expect(tastytrade.tastyRequest).toHaveBeenCalledWith(
      {}, '/market-data/by-type?equity-option=AAPL%20%20260918C00200000',
    )
  })

  it('collapses duplicate option tuples instead of blaming the broker for one quote row', async () => {
    tastytrade.tastyRequest.mockImplementation((_env, path: string) => {
      if (path === '/option-chains/AAPL') return Promise.resolve({ data: { items: [{
        active: true, 'expiration-date': '2026-09-18', 'instrument-type': 'Equity Option',
        'is-closing-only': false, 'option-chain-type': 'Standard', 'option-type': 'C',
        'shares-per-contract': 100, 'strike-price': '200', symbol: 'AAPL  260918C00200000',
        'underlying-symbol': 'AAPL',
      }] } })
      if (path.startsWith('/market-data/by-type?')) return Promise.resolve({ data: { items: [{
        symbol: 'AAPL  260918C00200000', instrumentType: 'Equity Option',
        bid: 3.1, ask: 3.3, updatedAt: '2026-08-13T11:59:59.000Z',
      }] } })
      throw new Error(`Unexpected path ${path}`)
    })
    const contract = { underlying: 'AAPL', expiry: '2026-09-18', optionType: 'C' as const, strike: 200 }

    const result = await readInstrumentQuotes({}, { contracts: [contract, { ...contract }] }, now)

    expect(result.quotes).toHaveLength(1)
    expect(tastytrade.tastyRequest).toHaveBeenCalledWith(
      {}, '/market-data/by-type?equity-option=AAPL%20%20260918C00200000',
    )
  })

  it('rejects crossed quotes', async () => {
    tastytrade.tastyRequest.mockResolvedValue({ data: { items: [{
      symbol: 'AAPL', instrumentType: 'Equity', bid: 200, ask: 199,
      updatedAt: '2026-08-13T11:59:59.000Z',
    }] } })
    await expect(readInstrumentQuotes({}, { symbols: ['AAPL'] }, now)).rejects.toThrow('invalid response')
  })
})

describe('account history underlying filter', () => {
  it('admits a share class and a futures root as tastytrade writes them', () => {
    for (const symbol of ['AAPL', 'BRK/B', '/ES', 'BF.B']) expect(UNDERLYING_SYMBOL.test(symbol)).toBe(true)
    for (const symbol of ['', '/', '//ES', 'brk/b']) expect(UNDERLYING_SYMBOL.test(symbol)).toBe(false)
  })
})
