import { describe, expect, it, vi } from 'vitest'

import { PublicMarketSnapshotSchema } from '../src/domain/market'
import { isWatchDocument, readPublicSnapshotForDocument, renderWatchSummary, SUMMARY_TIMEOUT_MS } from '../src/server/watch-summary'
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


describe('document snapshot boundary', () => {
  const request = new Request('https://spicy.trade/watch', { headers: { Authorization: 'Bearer private', Cookie: 'session=private' } })

  it('reads anonymously and clears the latency timer after success', async () => {
    vi.useFakeTimers()
    try {
      const serve = vi.fn(async (input: Request) => {
        expect(input.headers.get('Authorization')).toBeNull()
        expect(input.headers.get('Cookie')).toBeNull()
        expect(new URL(input.url).pathname).toBe('/api/public-snapshot')
        return Response.json(snapshot)
      })
      expect(await readPublicSnapshotForDocument(request, serve)).toEqual(snapshot)
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it.each([
    async () => new Response(null, { status: 502 }),
    async () => Response.json({ invalid: true }),
    async () => new Response('invalid json'),
    async () => { throw new Error('unavailable') },
  ])('reports an unusable snapshot as unavailable', async (serve) => {
    expect(await readPublicSnapshotForDocument(request, serve)).toBeUndefined()
  })

  it('bounds a stalled read by the document latency budget', async () => {
    vi.useFakeTimers()
    try {
      const result = readPublicSnapshotForDocument(request, () => new Promise(() => undefined))
      await vi.advanceTimersByTimeAsync(SUMMARY_TIMEOUT_MS)
      expect(await result).toBeUndefined()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })
})
