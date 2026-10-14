// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { marketSnapshotFixture } from './fixtures/market'
import { renderMarketScreen } from './fixtures/render-market-screen'

// Its own file: the year series is one request per module, and this case needs it to fail first.

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

it('retries failed year reads and renews successful reads on the next market date', async () => {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    addEventListener: () => undefined,
    matches: query.startsWith('(max-width'),
    removeEventListener: () => undefined,
  })))
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-01T16:00:00Z'))
  let yearOk = false
  let yearReads = 0
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/public-year-candles')) {
      yearReads += 1
      return yearOk
        ? Response.json({ asOf: '2026-08-31', series: [{ closes: [100, 104, 99, 110], symbol: 'NVDA' }] })
        : Response.json({ series: [{ closes: [-1], symbol: 'NVDA' }] })
    }
    return Response.json({ catalysts: [], evidence: [], ran: false })
  }))
  const snapshot = marketSnapshotFixture()
  for (const ticker of snapshot.tickers) ticker.sparkline = []

  renderMarketScreen({ tickers: snapshot.tickers })

  expect(await screen.findByText('Year charts are unavailable just now.')).toBeTruthy()
  expect(document.querySelector('.watch-row .year-sparkline')).toBeNull()

  yearOk = true
  // The failure text renders before React runs the passive effect that attaches the retry's
  // focus listener, so one focus dispatched right after it can land on no listener at all (it
  // did, under a loaded parallel run). Focus again on every poll, as a reader returning to the
  // tab would, until the retry lands.
  await waitFor(() => {
    window.dispatchEvent(new Event('focus'))
    expect(document.querySelector('.watch-row .year-sparkline')).not.toBeNull()
  })
  expect(screen.queryByText('Year charts are unavailable just now.')).toBeNull()
  const successfulReads = yearReads
  window.dispatchEvent(new Event('focus'))
  expect(yearReads).toBe(successfulReads)
  vi.setSystemTime(new Date('2026-09-02T16:00:00Z'))
  await waitFor(() => {
    window.dispatchEvent(new Event('focus'))
    expect(yearReads).toBe(successfulReads + 1)
  })
})
