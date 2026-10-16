import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  readYearAgoCloses,
  readYearCandleSeries,
  replaceYearCandles,
} from '../src/server/year-candle-store'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

const closes = [
  { time: 1_786_000_000_000, sequence: 0, close: 100 },
  { time: 1_786_086_400_000, sequence: 0, close: 104 },
]

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => {
  store.close()
})

describe('year candle store', () => {
  it('replaces a symbol series whole and reports absence for one never refreshed', async () => {
    await expect(readYearCandleSeries(store.database, ['SPY'])).resolves.toEqual({ asOf: undefined, series: new Map() })

    await replaceYearCandles(store.database, '2026-08-28', ['SPY'], new Map([['SPY', closes]]))
    await replaceYearCandles(store.database, '2026-08-31', ['SPY'], new Map([['SPY', closes.slice(0, 1)]]))

    // The later refresh replaced the series rather than appending to it, and left one row.
    await expect(readYearCandleSeries(store.database, ['SPY']))
      .resolves.toEqual({ asOf: '2026-08-31', series: new Map([['SPY', [100]]]) })
    expect(store.sqlite.prepare('SELECT count(*) AS count FROM year_candles').get()).toEqual({ count: 1 })
  })

  it('skips an empty series and treats a poisoned row as absent rather than fatal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await replaceYearCandles(store.database, '2026-08-31', ['SPY', 'NVDA'], new Map([['SPY', []], ['NVDA', closes]]))
    await expect(readYearCandleSeries(store.database, ['SPY', 'NVDA']))
      .resolves.toEqual({ asOf: '2026-08-31', series: new Map([['NVDA', [100, 104]]]) })
    expect(warn).not.toHaveBeenCalled()

    store.sqlite.prepare("UPDATE year_candles SET closes_json = '[{\"close\":-1}]' WHERE symbol = 'NVDA'").run()
    await expect(readYearCandleSeries(store.database, ['NVDA'])).resolves.toEqual({ asOf: undefined, series: new Map() })
    expect(warn).toHaveBeenLastCalledWith('YearCandleRowsSkipped', 1)
  })

  // The table's CHECK keeps invalid JSON out, but the read must not depend on a constraint it
  // cannot see: one row that is not JSON would otherwise throw out and 503 the whole route.
  it('skips a row whose closes are not JSON and still serves the rest', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    await replaceYearCandles(store.database, '2026-08-31', ['SPY', 'NVDA'], new Map([['SPY', closes], ['NVDA', closes]]))
    store.sqlite.exec('PRAGMA ignore_check_constraints = ON')
    store.sqlite.prepare("UPDATE year_candles SET closes_json = '{not json' WHERE symbol = 'NVDA'").run()

    await expect(readYearCandleSeries(store.database, ['SPY', 'NVDA']))
      .resolves.toEqual({ asOf: '2026-08-31', series: new Map([['SPY', [100, 104]]]) })
    expect(warn).toHaveBeenCalledWith('YearCandleRowsSkipped', 1)
  })

  // A symbol that fell out of the refreshed set would otherwise keep the anchor from the day it
  // left, and every later snapshot would print that as "a year ago".
  it('retires the rows of a symbol the refresh no longer covers', async () => {
    await replaceYearCandles(store.database, '2026-08-28', ['SPY', 'NVDA'], new Map([['SPY', closes], ['NVDA', closes]]))
    await replaceYearCandles(store.database, '2026-08-31', ['SPY'], new Map([['SPY', closes]]))

    await expect(readYearAgoCloses(store.database, ['SPY', 'NVDA'])).resolves.toEqual(new Map([['SPY', 100]]))
  })

  // An empty series is the provider saying it has no year for the symbol, not silence: the old
  // row would otherwise keep serving a stale `year_ago_close` as current.
  it('retires the previous row of a requested symbol whose snapshot arrived empty', async () => {
    await replaceYearCandles(store.database, '2026-08-28', ['SPY', 'NVDA'], new Map([['SPY', closes], ['NVDA', closes]]))
    await replaceYearCandles(store.database, '2026-08-31', ['SPY', 'NVDA'], new Map([['SPY', closes], ['NVDA', []]]))

    await expect(readYearAgoCloses(store.database, ['SPY', 'NVDA'])).resolves.toEqual(new Map([['SPY', 100]]))
    await expect(readYearCandleSeries(store.database, ['SPY', 'NVDA']))
      .resolves.toEqual({ asOf: '2026-08-31', series: new Map([['SPY', [100, 104]]]) })
  })

  it('keeps the previous row of a requested symbol whose snapshot did not arrive', async () => {
    await replaceYearCandles(store.database, '2026-08-28', ['SPY', 'NVDA'], new Map([['SPY', closes], ['NVDA', closes]]))
    await replaceYearCandles(store.database, '2026-08-31', ['SPY', 'NVDA'], new Map([['SPY', closes]]))

    // The oldest refresh among the rows is what the answer reports, so the kept row shows its age.
    await expect(readYearCandleSeries(store.database, ['SPY', 'NVDA'])).resolves.toEqual({
      asOf: '2026-08-28',
      series: new Map([['NVDA', [100, 104]], ['SPY', [100, 104]]]),
    })
  })
})

describe('year series read paths', () => {

  it('serves the series as bare closes, oldest first, for the named symbols only', async () => {
    await replaceYearCandles(store.database, '2026-08-31', ['SPY', 'NVDA'], new Map([['SPY', closes], ['NVDA', closes]]))

    // The chart spaces points by index, so the instants would be sent and never read; the one
    // instant that travels is the store's own refresh date, never the request's.
    await expect(readYearCandleSeries(store.database, ['SPY'])).resolves.toEqual({ asOf: '2026-08-31', series: new Map([['SPY', [100, 104]]]) })
  })
})
