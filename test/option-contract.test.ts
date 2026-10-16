import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type JsonObject } from '../src/domain/json-payload'
import {
  equityOptionContractFromChainTuple,
  resolveEquityOptionTuples,
} from '../src/server/option-contract'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'

const mocks = stubBroker()

beforeEach(() => setBrokerApi(mocks))
afterEach(() => resetBrokerApi())

const action = {
  kind: 'place_option_order' as const,
  underlying: 'NVDA',
  optionType: 'C' as const,
  strike: 250,
  expiry: '2026-08-14',
  action: 'Buy to Open' as const,
  quantity: 1,
  limitPrice: 0.01,
  priceEffect: 'Debit' as const,
}

function option(overrides: JsonObject = {}) {
  return {
    symbol: 'NVDA  260814C00250000',
    'instrument-type': 'Equity Option',
    active: true,
    'strike-price': '250.0',
    'root-symbol': 'NVDA',
    'underlying-symbol': 'NVDA',
    'expiration-date': '2026-08-14',
    'shares-per-contract': 100,
    'option-type': 'C',
    'option-chain-type': 'Standard',
    'is-closing-only': false,
    ...overrides,
  }
}

function payload(items: JsonObject[]) {
  return { data: { items } }
}

describe('equity option contract resolution', () => {
  it('resolves one exact active standard contract from detailed instruments', () => {
    expect(equityOptionContractFromChainTuple(payload([
      option(),
      option({ symbol: 'NVDA  260814P00250000', 'option-type': 'P' }),
      option({ symbol: 'NVDA  260814C00255000', 'strike-price': '255.0' }),
    ]), action, { opening: true })).toEqual({ symbol: 'NVDA  260814C00250000', sharesPerContract: 100 })
  })

  it('rejects adjusted, inactive, closing-only, and ambiguous matches', () => {
    expect(() => equityOptionContractFromChainTuple(payload([
      option({ 'option-chain-type': 'Adjusted' }),
    ]), action, { opening: true })).toThrow('Available standard expirations: none')
    expect(() => equityOptionContractFromChainTuple(payload([
      option({ active: false }),
    ]), action, { opening: true })).toThrow('inactive')
    expect(() => equityOptionContractFromChainTuple(payload([
      option({ 'is-closing-only': true }),
    ]), action, { opening: true })).toThrow('closing-only')
    expect(() => equityOptionContractFromChainTuple(payload([
      option({ 'is-closing-only': undefined }),
    ]), action, { opening: true })).toThrow('opening status could not be verified')
    expect(() => equityOptionContractFromChainTuple(payload([
      option({ 'is-closing-only': true }),
      option({ active: false, symbol: 'NVDA2 260814C00250000' }),
    ]), action, { opening: true })).toThrow('closing-only')
    expect(() => equityOptionContractFromChainTuple(payload([
      option(), option({ symbol: 'NVDA2 260814C00250000' }),
    ]), action, { opening: true })).toThrow('ambiguous')
    expect(() => equityOptionContractFromChainTuple(payload([
      option({ 'shares-per-contract': 0.5 }),
    ]), action, { opening: true })).toThrow('multiplier could not be verified')
    expect(() => equityOptionContractFromChainTuple(payload([
      option(), option({ 'shares-per-contract': 10 }),
    ]), action, { opening: true })).toThrow('ambiguous')
  })

  it('reports valid expirations or nearby strikes without guessing', () => {
    expect(() => equityOptionContractFromChainTuple(payload([
      option({ 'expiration-date': '2026-08-21' }),
    ]), action, { opening: true })).toThrow('Available standard expirations: 2026-08-21')
    expect(() => equityOptionContractFromChainTuple(payload([
      option({ 'strike-price': '245' }),
      option({ 'strike-price': '255', symbol: 'NVDA  260814C00255000' }),
    ]), action, { opening: true })).toThrow('Nearest call strikes: 245, 255')
  })

  it('allows a standard option root to differ from its underlying and returns its exact streamer symbol', () => {
    expect(equityOptionContractFromChainTuple(payload([
      option({ 'root-symbol': 'NVDAW', 'streamer-symbol': '.NVDA260814C250' }),
    ]), action, { requireStreamerSymbol: true })).toEqual({
      sharesPerContract: 100,
      streamerSymbol: '.NVDA260814C250',
      symbol: 'NVDA  260814C00250000',
    })
  })

  it('fails closed when exact live market-data identity is unavailable', () => {
    expect(() => equityOptionContractFromChainTuple(payload([option()]), action, {
      requireStreamerSymbol: true,
    })).toThrow('no verified market-data streamer symbol')
  })

  it('fetches each underlying once while preserving tuple order', async () => {
    mocks.tastyRequest.mockImplementation(async (_env, path: string) => {
      if (path === '/option-chains/NVDA') return payload([
        option({ 'streamer-symbol': '.NVDA260814C250' }),
        option({
          symbol: 'NVDA  260814P00250000',
          'option-type': 'P',
          'streamer-symbol': '.NVDA260814P250',
        }),
      ])
      if (path === '/option-chains/AAPL') return payload([option({
        symbol: 'AAPL  260814C00250000',
        'root-symbol': 'AAPL',
        'underlying-symbol': 'AAPL',
        'streamer-symbol': '.AAPL260814C250',
      })])
      throw new Error(`Unexpected path: ${path}`)
    })

    const resolved = await resolveEquityOptionTuples({}, [
      action,
      { ...action, optionType: 'P' },
      { ...action, underlying: 'AAPL' },
    ], { requireStreamerSymbol: true })

    expect(mocks.tastyRequest).toHaveBeenCalledTimes(2)
    expect(resolved.map((contract) => contract.streamerSymbol)).toEqual([
      '.NVDA260814C250', '.NVDA260814P250', '.AAPL260814C250',
    ])
  })
})
