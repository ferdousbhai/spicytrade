// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { addDays } from '../src/domain/iso-date'
import { marketDate, type Catalyst } from '../src/domain/catalyst'
import { renderMarketScreen } from './fixtures/render-market-screen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function catalyst(symbol: string, daysAhead: number): Catalyst {
  const date = addDays(marketDate(), daysAhead)
  return {
    confidence: 'estimated',
    date,
    id: `exa:${symbol}:conference:${date}`,
    kind: 'conference',
    source: 'Exa search · example.com',
    sourceUrl: 'https://example.com/events',
    symbol,
    timing: 'unknown',
    title: `${symbol} analyst day`,
    updatedAt: '2026-09-01T13:00:00.000Z',
  }
}

function renderMarket(symbol: string, catalysts: readonly Catalyst[], owner = false): void {
  renderMarketScreen({ symbol, catalysts: [...catalysts], owner })
}

describe('reviewing a symbol with an empty calendar', () => {
  it('searches, says so, and shows what the search found', async () => {
    const requested: string[] = []
    const found = catalyst('AAPL', 45)
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.startsWith('/api/public-catalysts') || url.startsWith('/api/public-year-candles')
        || url.startsWith('/api/public-symbol-evidence')) {
        return Response.json({ catalysts: [], evidence: [], series: [] })
      }
      requested.push(String(JSON.parse(String(init?.body)).symbol))
      return Response.json({ catalysts: [found], ran: true })
    }))

    renderMarket('AAPL', [])

    expect(screen.getByText(/spicytrade is searching for scheduled/)).toBeTruthy()
    await waitFor(() => expect(screen.getByText('AAPL analyst day')).toBeTruthy())
    expect(requested).toEqual(['AAPL'])
    // The found date is on the calendar now, not a promise of the next snapshot.
    expect(screen.queryByText(/spicytrade is searching for scheduled/)).toBeNull()
  })

  it('leaves a symbol alone when something is already scheduled this month', async () => {
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input))
      return Response.json({ catalysts: [], ran: false })
    }))

    renderMarket('TSLA', [catalyst('TSLA', 5)])

    await waitFor(() => expect(screen.getByText('TSLA analyst day')).toBeTruthy())
    // The focus card also asks for the symbol's evidence cards; what must not have been spent
    // here is a catalyst search, which a scheduled date this month makes unnecessary.
    expect(requested.filter((url) => url.startsWith('/api/public-catalyst-refresh'))).toEqual([])
  })

  it('says a search that ran and bound nothing found nothing, distinct from never searching', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ catalysts: [], ran: true })))

    renderMarket('META', [])

    expect(await screen.findByText('Searched — nothing scheduled.')).toBeTruthy()
    expect(screen.queryByText('Nothing is on the calendar.')).toBeNull()
  })

  it('does not claim a search found nothing when a receipt only refused one', async () => {
    // A refusal says the server searched within its window, not what this reader was told.
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/public-catalyst-refresh')
      ? Response.json({ catalysts: [], ran: false, reason: 'fresh' })
      : Response.json({ catalysts: [], evidence: [], series: [] })))

    renderMarket('INTC', [])

    expect(await screen.findByText('Nothing is on the calendar.')).toBeTruthy()
    expect(screen.queryByText('Searched — nothing scheduled.')).toBeNull()
  })

  it('shows the search running, then failed, each in its own words', async () => {
    let answer: (response: Response) => void = () => undefined
    vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => String(input).startsWith('/api/public-catalyst-refresh')
      ? new Promise<Response>((resolve) => { answer = resolve })
      : Promise.resolve(Response.json({ catalysts: [], evidence: [] }))))

    renderMarket('SPCX', [])

    expect(await screen.findByText('Looking for what’s coming.')).toBeTruthy()
    expect(screen.queryByText('Searched — nothing scheduled.')).toBeNull()
    answer(Response.json({ catalysts: [], ran: false, reason: 'failed' }))
    expect(await screen.findByText('The calendar search didn’t finish.')).toBeTruthy()
    expect(screen.queryByText('Searched — nothing scheduled.')).toBeNull()
  })

  it('treats a refresh request that errors as a failed search too', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/public-catalyst-refresh')
      ? new Response('', { status: 503 })
      : Response.json({ catalysts: [], evidence: [], series: [] })))

    renderMarket('AMD', [catalyst('AMD', 70)])

    expect(await screen.findByText(/dates didn’t finish/)).toBeTruthy()
  })
})

describe('owner catalyst refresh', () => {
  it('offers the owner another search on a thin calendar, and never a visitor', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ catalysts: [], ran: true })))

    renderMarket('BE', [])
    await screen.findByText('Searched — nothing scheduled.')
    // A visitor cannot spend a search: the call costs money and the window that bounds
    // incidental attention is the only thing standing between it and every reader.
    expect(screen.queryByRole('button', { name: 'Search again' })).toBeNull()

    cleanup()
    renderMarket('BE', [], true)
    expect(await screen.findByRole('button', { name: 'Search again' })).toBeTruthy()
  })

  it('reports a search running on a calendar that already has a far-off date on it', async () => {
    // Nothing resolves while the search is in flight, which is the state a reader was left
    // staring at with no sign anything was happening.
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => undefined)))

    // Dated past the near-term window, so the runway renders a row and a search still runs.
    renderMarket('QQQ', [catalyst('QQQ', 70)], true)

    expect(await screen.findByText(/Searching for nearer/)).toBeTruthy()
    // The control that would spend a second search is not offered while one is running.
    expect(screen.queryByRole('button', { name: 'Search again' })).toBeNull()
  })
})

describe('a calendar read that fails', () => {
  it('says the calendar is unknown rather than empty, and reads again on focus', async () => {
    let readOk = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      // The search ran and bound nothing; only the full read of the symbol's rows is failing.
      if (url.startsWith('/api/public-catalyst-refresh')) return Response.json({ catalysts: [], ran: true })
      if (url.startsWith('/api/public-catalysts')) {
        return readOk ? Response.json({ catalysts: [catalyst('IWM', 40)] }) : new Response('', { status: 503 })
      }
      return Response.json({ evidence: [], series: [] })
    }))

    renderMarket('IWM', [])

    expect(await screen.findByText('The calendar didn’t load.')).toBeTruthy()
    // A search that bound nothing cannot vouch for a calendar whose other rows never arrived.
    expect(screen.queryByText('Searched — nothing scheduled.')).toBeNull()

    readOk = true
    // The failure text renders before React runs the passive effect that attaches the retry's
    // focus listener, so one focus dispatched right after it can land on no listener at all.
    // Focus again on every poll, as a reader returning to the tab would, until the retry lands.
    await waitFor(() => {
      window.dispatchEvent(new Event('focus'))
      expect(screen.queryByText('IWM analyst day')).not.toBeNull()
    })
    expect(screen.queryByText('The calendar didn’t load.')).toBeNull()
  })

  it('keeps the dates it already had and says the rest did not load', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).startsWith('/api/public-catalysts')
      ? Response.json({ catalysts: [{}] })
      : Response.json({ catalysts: [], evidence: [], ran: false })))

    renderMarket('SPY', [catalyst('SPY', 5)])

    expect(await screen.findByText(/SPY’s full calendar didn’t load/)).toBeTruthy()
    expect(screen.getByText('SPY analyst day')).toBeTruthy()
  })
})

describe('a calendar search that fails', () => {
  it('searches again when the window regains focus, for a reader who cannot force one', async () => {
    const requested: string[] = []
    let searchOk = false
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (!String(input).startsWith('/api/public-catalyst-refresh')) {
        return Response.json({ catalysts: [], evidence: [], series: [] })
      }
      requested.push(String(JSON.parse(String(init?.body)).symbol))
      return searchOk
        ? Response.json({ catalysts: [catalyst('SPY', 30)], ran: true })
        : Response.json({ catalysts: [], ran: false, reason: 'failed' })
    }))

    // SPY's other cases here carry a date this month, so no search has spent it yet.
    renderMarket('SPY', [])

    expect(await screen.findByText('The calendar search didn’t finish.')).toBeTruthy()
    expect(requested).toEqual(['SPY'])

    searchOk = true
    // Same passive-effect race as the calendar-read retry above: focus again on every poll
    // until the retry's listener has attached and the search lands.
    await waitFor(() => {
      window.dispatchEvent(new Event('focus'))
      expect(screen.queryByText('SPY analyst day')).not.toBeNull()
    })
    // A reader dispatching focus more than once before the listener attaches can spend more
    // than one retry; what matters is that every retry it did spend was for this symbol.
    expect(requested.length).toBeGreaterThanOrEqual(2)
    expect(requested.every((symbol) => symbol === 'SPY')).toBe(true)
    expect(screen.queryByText('The calendar search didn’t finish.')).toBeNull()
  })
})
