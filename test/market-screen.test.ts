import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { MarketScreen } from '../src/components/market-screen'
import { type MarketSnapshot } from '../src/domain/market'
import { marketSnapshotFixture } from './fixtures/market'

function renderMarket(
  snapshot: ReturnType<typeof marketSnapshotFixture>,
  overrides: {
    catalysts?: MarketSnapshot['catalysts']
    symbol: string
  },
): string {
  return renderToStaticMarkup(createElement(MarketScreen, {
    activeWatchlist: { ...snapshot.watchlists[0]!, kind: 'public' },
    brief: snapshot.brief,
    catalysts: overrides.catalysts ?? snapshot.catalysts,
    owner: false,
    onSelectTicker: () => undefined,
    onTogglePinned: () => undefined,
    pinnedSymbols: [],
    selected: snapshot.tickers.find((ticker) => ticker.symbol === overrides.symbol)!,
    tickers: snapshot.tickers,
  }))
}

describe('selected market context', () => {
  it('leads with the selected symbol\'s recommendation from the brief and shows none for another name', () => {
    const snapshot = marketSnapshotFixture()
    expect(renderMarket(snapshot, { symbol: 'NVDA' })).toContain('Buy NVDA 205c 10/16/26')
    expect(renderMarket(snapshot, { symbol: 'SPY' })).not.toContain('Recommendation')
  })

  it('lists every upcoming catalyst nearest first and drops past dates', () => {
    const snapshot = marketSnapshotFixture()
    const template = snapshot.catalysts[0]!
    const catalysts = [
      { ...template, id: 'test:NVDA:later', date: '2099-06-01', kind: 'regulatory' as const, title: 'Later NVDA review' },
      { ...template, id: 'test:NVDA:past', date: '2000-01-01', title: 'Stale NVDA event' },
      { ...template, id: 'test:NVDA:sooner', date: '2099-01-01', title: 'Sooner NVDA print', confidence: 'confirmed' as const },
    ]

    const html = renderMarket(snapshot, { catalysts, symbol: 'NVDA' })

    expect(html).not.toContain('Stale NVDA event')
    expect(html.indexOf('Sooner NVDA print')).toBeLessThan(html.indexOf('Later NVDA review'))
  })

  it('cites a member-recorded date by its host and says it is estimated, like any research row', () => {
    const snapshot = marketSnapshotFixture()
    const recorded = {
      ...snapshot.catalysts[0]!,
      confidence: 'estimated' as const,
      date: '2099-03-02',
      id: 'member-research:NVDA:conference:2099-03-02',
      source: 'Member research · reuters.com',
      sourceUrl: 'https://www.reuters.com/technology/nvidia-analyst-day',
      title: 'NVIDIA analyst day',
    }

    const html = renderMarket(snapshot, { catalysts: [recorded], symbol: 'NVDA' })

    // The producer is ours to know; what a reader is shown is the page and how sure the date is.
    expect(html).toContain('NVIDIA analyst day')
    expect(html).toContain('https://www.reuters.com/technology/nvidia-analyst-day')
    expect(html).toContain('reuters.com')
    expect(html).toContain('estimated')
    expect(html).not.toContain('member-research')
  })

  it('states that nothing is scheduled instead of leaving a gap', () => {
    const snapshot = marketSnapshotFixture()

    const html = renderMarket(snapshot, {
      catalysts: [],
      symbol: 'SPY',
    })

    expect(html).toContain('Nothing is on the calendar.')
    expect(html).toContain('spicytrade tracks earnings, regulatory, clinical, investor day, product launch, conference and shareholder vote dates for SPY')
    expect(html).not.toContain('Recommendation')
  })
})

describe('watchlist market data', () => {

  it('dates the quote and the metrics separately, and says when the metrics carry no date', () => {
    const snapshot = marketSnapshotFixture()
    const nvda = snapshot.tickers.find((ticker) => ticker.symbol === 'NVDA')!
    nvda.metricsUpdatedAt = '2026-08-13T05:00:00.000Z'

    const dated = renderMarket(snapshot, { symbol: 'NVDA' })
    const freshness = dated.match(/<p class="focus-freshness">(.*?)<\/p>/s)?.[1]
    expect(freshness).toContain('dateTime="2026-08-13T13:31:00.000Z"')
    expect(freshness).toContain('dateTime="2026-08-13T05:00:00.000Z"')
    expect(freshness).toMatch(/Quote <time[^>]*>\d+ days? ago<\/time>/)
    expect(freshness).toMatch(/IV &amp; liquidity <time[^>]*>\d+ days? ago<\/time>/)

    const undated = renderMarket(snapshot, { symbol: 'SPY' })
    expect(undated.match(/<p class="focus-freshness">(.*?)<\/p>/s)?.[1]).toContain('age not reported')
  })
})
