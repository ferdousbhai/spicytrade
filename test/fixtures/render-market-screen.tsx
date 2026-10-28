import { createElement } from 'react'
import { render } from '@testing-library/react'
import { vi } from 'vitest'

import { MarketScreen } from '../../src/components/market-screen'
import { marketSnapshotFixture } from './market'

type MarketScreenProps = Parameters<typeof MarketScreen>[0]

/**
 * Renders `MarketScreen` against the shared fixture snapshot. `symbol` is a convenience
 * over passing `selected` directly: it looks the ticker up by symbol in whichever
 * `tickers` array applies — the override if the caller passed one, else the fixture's —
 * so a test that only cares which row starts selected doesn't repeat that lookup itself.
 * This lives outside `./market` (a plain data module several node-environment tests
 * import) because pulling in React Testing Library there would drag a DOM renderer into
 * suites that never touch jsdom.
 */
export function renderMarketScreen(overrides: Partial<MarketScreenProps> & { symbol?: string } = {}): void {
  const { symbol, ...rest } = overrides
  const snapshot = marketSnapshotFixture()
  const tickers = rest.tickers ?? snapshot.tickers
  const selected = rest.selected ?? (symbol === undefined
    ? tickers[0]!
    : tickers.find((ticker) => ticker.symbol === symbol)!)
  render(createElement(MarketScreen, {
    activeWatchlist: { ...snapshot.watchlists[0]!, kind: 'public' as const },
    catalysts: snapshot.catalysts,
    onSelectTicker: () => undefined,
    onTogglePinned: () => undefined,
    pinnedSymbols: [],
    tickers,
    ...rest,
    selected,
  }))
}

/** A focus-card endpoint's answer, keyed by the path the card asks. */
type FocusCardAnswers = Partial<Record<'/api/public-symbol-evidence' | '/api/public-symbol-recommendation', () => Response>>

/**
 * Answers every request the focus card makes: no evidence, no recommendation, and an empty
 * catalyst read and search, unless `answers` replaces one. Returns the mock so a test can read
 * which paths were asked.
 */
export function stubFocusCardFetch(answers: FocusCardAnswers = {}): ReturnType<typeof vi.fn> {
  const routes = {
    '/api/public-symbol-evidence': () => Response.json({ evidence: [] }),
    '/api/public-symbol-recommendation': () => Response.json({ recommendation: null }),
    ...answers,
  } satisfies FocusCardAnswers
  const fetch = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    const route = Object.entries(routes).find(([path]) => url.startsWith(path))
    return route ? route[1]() : Response.json({ catalysts: [], ran: false })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}
