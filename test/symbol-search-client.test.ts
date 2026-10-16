// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { lookupSymbol, useSymbolSearch } from '../src/data/symbol-search'
import { publicTickerFromTicker } from '../src/domain/market'
import { marketSnapshotFixture } from './fixtures/market'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('distinguishes a rejected query from a completed search with no match', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 400 })))
  await expect(lookupSymbol('invalid')).rejects.toThrow('Symbol search failed (400)')
  vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })))
  await expect(lookupSymbol('missing')).resolves.toBeUndefined()
})

it('ignores a late response after the reader searches for another ticker', async () => {
  vi.useFakeTimers()
  let finishOld!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finishOld = resolve })))
  const { result, rerender } = renderHook(({ query }) => useSymbolSearch(query, true), { initialProps: { query: 'META' } })
  await act(async () => { await vi.runOnlyPendingTimersAsync() })
  rerender({ query: 'F' })
  await act(async () => {
    finishOld(Response.json({
      ticker: publicTickerFromTicker({ ...marketSnapshotFixture().tickers[0]!, symbol: 'META' }),
      catalysts: [], watchlisted: true,
    }))
  })
  expect(result.current.status).toBe('searching')
})
