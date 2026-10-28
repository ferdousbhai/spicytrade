// @vitest-environment jsdom

import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { publicTickerFromTicker } from '../src/domain/market'
import { marketSnapshotFixture } from './fixtures/market'
import { renderMarketScreen } from './fixtures/render-market-screen'

afterEach(() => {
  cleanup()
})

describe('searching beyond the loaded watchlist', () => {
  it('keeps favorites on top, ordered by relevance while searching and by the metric otherwise', () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ catalysts: [], evidence: [], series: [], ran: false })))
    const meta = marketSnapshotFixture().tickers.find((ticker) => ticker.symbol === 'META')!
    const tickers = [
      { ...meta, symbol: 'MET', name: 'Metals Company', volume: 1_000 },
      { ...meta, volume: 10 },
      { ...meta, symbol: 'METU', name: 'Meta ETF', volume: 100 },
    ]
    renderMarketScreen({
      tickers,
      pinnedSymbols: ['META', 'MET'],
      activeWatchlist: { id: 'watchlist', kind: 'public', name: 'Watchlist', symbols: tickers.map((ticker) => ticker.symbol) },
    })
    const rowSymbols = () => screen.getAllByRole('button', { name: /^(Unpin|Pin) / })
      .map((button) => button.getAttribute('aria-label'))

    expect(rowSymbols()).toEqual(['Unpin MET', 'Unpin META', 'Pin METU'])
    fireEvent.change(screen.getByLabelText('Search all symbols'), { target: { value: ' meta ' } })
    expect(rowSymbols()).toEqual(['Unpin META', 'Unpin MET', 'Pin METU'])
    fireEvent.click(screen.getByRole('button', { name: 'Volume' }))
    expect(rowSymbols()).toEqual(['Unpin META', 'Unpin MET', 'Pin METU'])
    fireEvent.click(screen.getByRole('button', { name: 'Volume' }))
    expect(rowSymbols()).toEqual(['Unpin MET', 'Unpin META', 'Pin METU'])
    fireEvent.change(screen.getByLabelText('Search all symbols'), { target: { value: '$META' } })
    expect(rowSymbols()).toEqual(['Unpin META', 'Unpin MET', 'Pin METU'])
    fireEvent.change(screen.getByLabelText('Search all symbols'), { target: { value: '' } })
    expect(rowSymbols()).toEqual(['Unpin MET', 'Unpin META', 'Pin METU'])
  })

  it.each(['META', 'F'])('looks up %s despite fuzzy loaded matches and passes its data to selection', async (symbol) => {
    const base = marketSnapshotFixture().tickers[0]!
    const lookup = { catalysts: [], ticker: publicTickerFromTicker({ ...base, symbol, name: `${symbol} Company` }), watchlisted: true }
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).startsWith('/api/public-symbol-search')) {
        requests.push(String(input))
        return Response.json(lookup)
      }
      return Response.json({ catalysts: [], evidence: [], series: [], ran: false })
    }))
    const onSelectTicker = vi.fn()
    const onTogglePinned = vi.fn()
    renderMarketScreen({ tickers: [{ ...base, symbol: 'OTHER', name: `${symbol} Fund` }], onSelectTicker, onTogglePinned })
    fireEvent.change(screen.getByLabelText('Search all symbols'), { target: { value: symbol } })
    await waitFor(() => expect(screen.getByRole('button', { name: `Pin ${symbol}` })).toBeTruthy())
    expect(requests).toEqual([`/api/public-symbol-search?q=${symbol}`])
    expect(screen.getByRole('button', { name: 'Pin OTHER' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: new RegExp(`${symbol}, ${symbol} Company`) }))
    expect(onSelectTicker).toHaveBeenCalledWith(symbol, lookup)
    fireEvent.click(screen.getByRole('button', { name: `Pin ${symbol}` }))
    expect(onTogglePinned).toHaveBeenCalledWith(symbol, lookup)
  })

  it('reports a failed catalog lookup even when local fuzzy matches remain visible', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    const base = marketSnapshotFixture().tickers[0]!
    renderMarketScreen({ tickers: [{ ...base, symbol: 'MET', name: 'Metals Company' }] })
    fireEvent.change(screen.getByLabelText('Search all symbols'), { target: { value: 'META' } })
    await waitFor(() => expect(screen.getByText('Symbol search is unavailable. Showing the loaded list only.')).toBeTruthy())
    expect(screen.getByRole('button', { name: 'Pin MET' })).toBeTruthy()
  })

  it('renders the symbol the catalog resolved, with the pin the reader can favorite it by', async () => {
    const lookupRequests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      // Reviewing a symbol with an empty month also asks for a catalyst search; this test
      // is about the symbol lookup, so only those requests are collected.
      if (url.startsWith('/api/public-catalyst-refresh')) {
        return Response.json({ catalysts: [], ran: false })
      }
      if (url.startsWith('/api/public-catalysts')) return Response.json({ catalysts: [] })
      if (url.startsWith('/api/public-year-candles')) return Response.json({ series: [] })
      // The focus card asks for the selected symbol's evidence cards and latest recommendation
      // for the same reason.
      if (url.startsWith('/api/public-symbol-evidence')) return Response.json({ evidence: [] })
      if (url.startsWith('/api/public-symbol-recommendation')) return Response.json({ recommendation: null })
      lookupRequests.push(url)
      return Response.json({
        catalysts: [],
        ticker: {
          symbol: 'TQQQ',
          name: 'ProShares UltraPro QQQ',
          assetType: 'etf',
          price: 92.4,
          change: 1.2,
          changePercent: 1.32,
          sparkline: [],
          ivRank: 41,
          ivPercentile: 47,
          ivIndex: 52.6,
          earningsDate: null,
          updatedAt: '2026-09-01T13:31:00.000Z',
        },
        watchlisted: true,
      })
    }))
    renderMarketScreen()

    fireEvent.change(screen.getByLabelText('Search all symbols'), { target: { value: 'TQQQ' } })

    await waitFor(() => expect(screen.getByRole('button', { name: /TQQQ, ProShares UltraPro QQQ/ })).toBeTruthy())
    expect(lookupRequests).toEqual(['/api/public-symbol-search?q=TQQQ'])
    expect(screen.getByRole('button', { name: 'Pin TQQQ' })).toBeTruthy()
    // The lookup only runs for a search the loaded list could not answer.
    fireEvent.change(screen.getByLabelText('Search all symbols'), { target: { value: 'NVDA' } })
    await waitFor(() => expect(screen.queryByRole('button', { name: /TQQQ/ })).toBeNull())
    expect(lookupRequests).toHaveLength(1)
  })

  it('says the market has no such symbol rather than that the list does not', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => (
      String(input).startsWith('/api/public-catalyst-refresh')
        ? Response.json({ catalysts: [], ran: false })
        : Response.json({ error: 'nothing' }, { status: 404 })
    )))
    renderMarketScreen()

    fireEvent.change(screen.getByLabelText('Search all symbols'), { target: { value: 'ZZZZ' } })

    await waitFor(() => expect(screen.getByText('No listed symbol matches your search.')).toBeTruthy())
  })
})
