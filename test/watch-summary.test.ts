import { describe, expect, it } from 'vitest'

import { PublicMarketSnapshotSchema } from '../src/domain/market'
import { isWatchDocument, renderWatchSummary } from '../src/server/watch-summary'
import { marketSnapshotFixture } from './fixtures/market'

const fixture = marketSnapshotFixture()
const [first, second] = fixture.tickers
const snapshot = PublicMarketSnapshotSchema.parse({
  ...fixture,
  marketState: 'closed',
  syncedAt: '2026-10-15T08:12:59.466Z',
  watchlists: [{ id: 'public', kind: 'public', name: 'Options Watch', symbols: [] }],
  tickers: [
    { ...first, changePercent: 0.5089, ivRank: 24.5881, name: 'American Airlines <Group>', price: 11.85, symbol: 'AAL' },
    { ...second, changePercent: -1.2, ivRank: undefined, price: 250, symbol: 'AAPL' },
  ],
})

describe('watch summary', () => {
  it('renders market state, update time and ticker rows from the public snapshot', () => {
    const html = renderWatchSummary(snapshot)
    expect(html).toContain('Market closed · updated <time datetime="2026-10-15T08:12:59.466Z">')
    expect(html).toContain('<th scope="row">AAL</th>')
    expect(html).toContain('$11.85</td><td>+0.51%</td><td>24.6</td>')
    expect(html).toContain('-1.20%</td><td>—</td>')
    expect(html).toContain('Showing 2 of 2 symbols')
  })

  it('escapes provider text', () => {
    expect(renderWatchSummary(snapshot)).toContain('American Airlines &lt;Group&gt;')
  })

  it('applies to the watch document only', () => {
    expect(isWatchDocument('/watch')).toBe(true)
    expect(isWatchDocument('/connect')).toBe(false)
  })
})
