import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { type JsonValue } from '../src/domain/json-payload'
import { type AppEnv } from '../src/server/env'
import {
  instrumentCatalogFromPayload,
  loadInstrumentCatalog,
  missingInstrumentCatalogSymbols,
  persistInstrumentCatalog,
  readInstrumentCatalog,
  sweepStaleUnresolvedInstruments,
  UNRESOLVED_INSTRUMENT_RETRY_MS,
  unresolvedInstrumentCatalogItem,
} from '../src/server/instrument-catalog'
import { BROKER_SYMBOL_CHUNK_SIZE } from '../src/server/tastytrade'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

/** The load-then-persist pair the tastytrade catalog refresh runs, with the provider stubbed. */
async function refreshCatalog(env: AppEnv, symbols: string[], payload: JsonValue, now: Date): Promise<void> {
  const { items } = await loadInstrumentCatalog(symbols, async () => payload, BROKER_SYMBOL_CHUNK_SIZE, now)
  await persistInstrumentCatalog(env, items)
}

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => store.close())

function providerRow(symbol = 'SPCX') {
  return {
    active: true,
    'borrow-rate': '0.0375',
    'bypass-manual-review': false,
    'country-of-incorporation': 'United States',
    'country-of-taxation': 'United States',
    description: 'SpaceX Corporation',
    'halted-at': null,
    'instrument-sub-type': 'Common Stock',
    'instrument-type': 'Equity',
    'is-closing-only': false,
    'is-etf': false,
    'is-fractional-quantity-eligible': true,
    'is-illiquid': false,
    'is-index': false,
    'is-options-closing-only': false,
    lendability: 'Locate Required',
    'listed-market': 'NASDAQ',
    'market-time-instrument-collection': 'Equity',
    'option-tick-sizes': [
      { symbol, threshold: '3', value: '0.05' },
      { symbol, threshold: 'Infinity', value: '0.10' },
    ],
    'overnight-trading-permitted': true,
    'pre-ipo': false,
    'short-description': 'SpaceX',
    'stops-trading-at': '2026-12-31T21:00:00Z',
    'streamer-symbol': symbol,
    symbol,
    'tick-sizes': { symbol, threshold: '1', value: '0.01' },
    'underlying-product-type': 'Equity',
  }
}

describe('typed tastytrade instrument catalog', () => {
  it('fails when catalog storage is unavailable instead of returning an empty catalog', async () => {
    await expect(readInstrumentCatalog({}, ['SPCX'])).rejects.toThrow('store-unavailable')
  })

  it('extracts the normalized Equity source record without retaining unused tick tiers or raw payload', () => {
    const [item] = instrumentCatalogFromPayload(
      { data: { items: [providerRow()] } },
      ['SPCX'],
      new Date('2026-08-26T12:00:00.000Z'),
    )

    expect(item).toMatchObject({
      active: true,
      borrowRate: 0.0375,
      countryOfIncorporation: 'United States',
      description: 'SpaceX Corporation',
      instrumentSubType: 'Common Stock',
      identitySource: 'equity-endpoint',
      isEtf: false,
      lendability: 'Locate Required',
      listedMarket: 'NASDAQ',
      overnightTradingPermitted: true,
      resolutionStatus: 'resolved',
      shortDescription: 'SpaceX',
      symbol: 'SPCX',
    })
    expect(item).not.toHaveProperty('tickSizes')
  })

  it('updates provider identity and status with stable creation time', async () => {
    const env = { DB: store.database }
    await refreshCatalog(env, ['SPCX'], { data: { items: [providerRow()] } },
      new Date('2026-08-26T12:00:00.000Z'))
    const updated = providerRow()
    updated.description = 'Space Exploration Technologies Corp.'
    updated.active = false
    updated['option-tick-sizes'] = []
    await refreshCatalog(env, ['SPCX'], [updated],
      new Date('2026-08-27T12:00:00.000Z'))

    const item = (await readInstrumentCatalog(env, ['SPCX'])).get('SPCX')
    expect(item).toMatchObject({
      description: 'Space Exploration Technologies Corp.',
    })
    expect(store.sqlite.prepare(
      'SELECT active, created_at, status_refreshed_at, updated_at FROM instrument_catalog WHERE symbol = ?',
    ).get('SPCX')).toEqual({
      active: 0,
      created_at: '2026-08-26T12:00:00.000Z',
      status_refreshed_at: '2026-08-27T12:00:00.000Z',
      updated_at: '2026-08-27T12:00:00.000Z',
    })
    expect(store.sqlite.prepare('SELECT count(*) AS count FROM instrument_tick_sizes').get()).toEqual({ count: 0 })
  })

  it('rejects provider rows for a different symbol or instrument type', () => {
    expect(() => instrumentCatalogFromPayload([providerRow('NVDA')], ['SPCX']))
      .toThrow('unexpected-symbol')
    expect(() => instrumentCatalogFromPayload([{ ...providerRow(), 'instrument-type': 'Equity Option' }], ['SPCX']))
      .toThrow('invalid-instrument-type')
    expect(() => instrumentCatalogFromPayload([{ ...providerRow(), description: 7 }], ['SPCX']))
      .toThrow('description-invalid')
  })

  it('represents a missing provider definition honestly without inventing a name or status', () => {
    expect(unresolvedInstrumentCatalogItem('VXD', new Date('2026-08-26T12:00:00.000Z'))).toMatchObject({
      active: null,
      description: null,
      identitySource: 'watchlist-symbol',
      resolutionStatus: 'unresolved',
      shortDescription: null,
      symbol: 'VXD',
    })
  })

  it('does not let a definitive unresolved result erase resolved identity', async () => {
    const env = { DB: store.database }
    await refreshCatalog(env, ['SPCX'], [providerRow()],
      new Date('2026-08-26T12:00:00.000Z'))
    await persistInstrumentCatalog(env, [
      unresolvedInstrumentCatalogItem('SPCX', new Date('2026-08-27T12:00:00.000Z')),
      unresolvedInstrumentCatalogItem('VXD', new Date('2026-08-27T12:00:00.000Z')),
    ])

    const catalog = await readInstrumentCatalog(env, ['SPCX', 'VXD'])
    expect(catalog.get('SPCX')).toMatchObject({
      description: 'SpaceX Corporation',
      resolutionStatus: 'resolved',
    })
    expect(catalog.get('VXD')).toMatchObject({
      description: null,
      resolutionStatus: 'unresolved',
    })
  })

  it('uses D1-sized multi-row writes across persistence chunks', async () => {
    const env = { DB: store.database }
    const symbols = ['A', 'B', 'C', 'D']
    const items = instrumentCatalogFromPayload(symbols.map(providerRow), symbols)

    await persistInstrumentCatalog(env, items)

    expect((await readInstrumentCatalog(env, symbols)).size).toBe(4)
    const additionalSymbols = Array.from(
      { length: 101 },
      (_, index) => `Z${index.toString(36).toUpperCase()}`,
    )
    await expect(persistInstrumentCatalog(
      env,
      additionalSymbols.map((symbol) => unresolvedInstrumentCatalogItem(symbol)),
    )).resolves.toBeUndefined()
    expect((await readInstrumentCatalog(env, additionalSymbols)).size).toBe(101)
  })

  it('puts an unresolved symbol to the broker again once its retry interval lapses', async () => {
    // A ticker searched before it lists must not stay unresolved forever, but a junk ticker must
    // not buy a broker lookup on every search either.
    const env = { DB: store.database }
    const missedAt = new Date('2026-08-26T12:00:00.000Z')
    await persistInstrumentCatalog(env, [unresolvedInstrumentCatalogItem('SPCX', missedAt)])

    const withinInterval = new Date(missedAt.getTime() + UNRESOLVED_INSTRUMENT_RETRY_MS - 1)
    expect(await missingInstrumentCatalogSymbols(env, ['SPCX', 'NEW'], withinInterval)).toEqual(['NEW'])

    const lapsed = new Date(missedAt.getTime() + UNRESOLVED_INSTRUMENT_RETRY_MS)
    expect(await missingInstrumentCatalogSymbols(env, ['SPCX'], lapsed)).toEqual(['SPCX'])

    // Still unlisted: the retry restamps the placeholder, which starts a new interval.
    await persistInstrumentCatalog(env, [unresolvedInstrumentCatalogItem('SPCX', lapsed)])
    expect(await missingInstrumentCatalogSymbols(env, ['SPCX'], lapsed)).toEqual([])

    // Listed: the resolved row overwrites the placeholder and is never missing again.
    const listedAt = new Date(lapsed.getTime() + UNRESOLVED_INSTRUMENT_RETRY_MS)
    await refreshCatalog(env, ['SPCX'], [providerRow()], listedAt)
    expect((await readInstrumentCatalog(env, ['SPCX'])).get('SPCX')).toMatchObject({
      description: 'SpaceX Corporation',
      resolutionStatus: 'resolved',
    })
    const muchLater = new Date(listedAt.getTime() + 10 * UNRESOLVED_INSTRUMENT_RETRY_MS)
    expect(await missingInstrumentCatalogSymbols(env, ['SPCX'], muchLater)).toEqual([])
  })

  it('sweeps only unresolved placeholders whose retry interval has lapsed', async () => {
    const env = { DB: store.database }
    const earlier = new Date('2026-08-26T12:00:00.000Z')
    const now = new Date(earlier.getTime() + UNRESOLVED_INSTRUMENT_RETRY_MS)
    await refreshCatalog(env, ['SPCX'], [providerRow()], earlier)
    await persistInstrumentCatalog(env, [
      unresolvedInstrumentCatalogItem('JUNK', earlier),
      unresolvedInstrumentCatalogItem('FRESH', new Date(now.getTime() - 1)),
    ])

    expect(await sweepStaleUnresolvedInstruments(env, now)).toBe(1)
    expect([...(await readInstrumentCatalog(env, ['SPCX', 'JUNK', 'FRESH'])).keys()].sort())
      .toEqual(['FRESH', 'SPCX'])
  })

  it('names a missing store binding instead of sweeping nothing', async () => {
    await expect(sweepStaleUnresolvedInstruments({})).rejects.toMatchObject({ name: 'BindingMissing' })
  })
})
