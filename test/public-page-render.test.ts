// @vitest-environment jsdom

import { createElement, type ReactElement } from 'react'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { BriefArchivePage, BriefPage } from '../src/components/brief-page'
import { briefArchiveHead, briefPageHead, symbolPageHead } from '../src/components/public-page-head'
import { SymbolPage } from '../src/components/symbol-page'
import { PublicTickerSchema } from '../src/domain/market'
import { type SymbolPageData } from '../src/domain/public-page'
import { dailyBriefFixture, marketSnapshotFixture } from './fixtures/market'

afterEach(cleanup)

/**
 * The real tree would pull in every API route, so the page renders under a bare root beside
 * stand-ins for the routes its links name: enough for the router to write each href.
 */
async function renderPage(page: ReactElement): Promise<HTMLElement> {
  // The router scrolls to the top after a load; jsdom has no viewport to scroll.
  vi.stubGlobal('scrollTo', () => undefined)
  const root = createRootRoute()
  const paths = ['/watch', '/recommendations', '/terms', '/privacy', '/disclosures', '/briefs', '/briefs/$date', '/options/$symbol']
  const routes = [
    createRoute({ component: () => page, getParentRoute: () => root, path: '/' }),
    ...paths.map((path) => createRoute({ getParentRoute: () => root, path })),
  ]
  const router = createRouter({ history: createMemoryHistory({ initialEntries: ['/'] }), routeTree: root.addChildren(routes) })
  await router.load()
  // SAFETY: the provider is typed for the app's registered router; this stand-in tree has the same shape.
  return render(createElement(RouterProvider, { router } as never)).container
}

const hrefs = (container: HTMLElement) => [...container.querySelectorAll('a')].map((link) => link.getAttribute('href'))

const HOSTILE = '<script>alert(1)</script>'
const nvda = PublicTickerSchema.parse(marketSnapshotFixture().tickers.find((ticker) => ticker.symbol === 'NVDA'))

const symbolPage: SymbolPageData = {
  catalysts: [{
    confidence: 'estimated',
    date: '2026-09-22',
    description: `Roadmap ${HOSTILE}`,
    id: 'exa:NVDA:investor-event:2026-09-22',
    kind: 'investor-event',
    sourceUrl: 'https://investor.nvidia.com/events/default.aspx',
    symbol: 'NVDA',
    timing: 'pre-market',
    title: 'Investor <b>day</b>',
    updatedAt: '2026-08-13T13:31:00.000Z',
  }],
  marketState: 'closed',
  recommendation: { marketDate: '2026-08-13', recommendation: { ...dailyBriefFixture.recommendations[0]!, thesis: `**Catalyst:** capex.\n\n${HOSTILE}` } },
  syncedAt: '2026-08-13T13:31:00.000Z',
  ticker: { ...nvda, name: 'NVIDIA <i>Corporation</i> - Common Stock' },
}

describe('symbol page', () => {
  it('prints the public readings, the stored calendar and the dated recommendation as text', async () => {
    const container = await renderPage(createElement(SymbolPage, { page: symbolPage }))
    const text = container.textContent ?? ''
    expect(container.querySelector('h1')?.textContent).toBe('NVDA options')
    expect(text).toContain('Market closed')
    expect(text).toContain('IV rank72')
    expect(text).toContain('IV percentile81')
    expect(text).toContain('Price$191.68')
    expect(text).toContain('Sep 22, 2026 · investor day · estimated · Pre-market')
    expect(text).toContain('Bullish · argued on Aug 13, 2026')
    expect(text).toContain('Buy NVDA 205c 10/16/26')
    expect(text).toContain('Not financial advice.')
    expect(hrefs(container)).toEqual(expect.arrayContaining([
      '/watch', '/briefs/2026-08-13', '/disclosures', 'https://investor.nvidia.com/events/default.aspx',
    ]))
  })

  it('keeps provider and model text as text, never markup', async () => {
    const container = await renderPage(createElement(SymbolPage, { page: symbolPage }))
    expect(container.querySelector('main script, main i, main b')).toBeNull()
    expect(container.textContent).toContain(HOSTILE)
    expect(container.textContent).toContain('NVIDIA <i>Corporation</i>')
    expect(container.textContent).toContain('Investor <b>day</b>')
    // The thesis still goes through the site's Markdown subset: bold is the renderer's own element.
    expect(container.querySelector('.thesis strong')?.textContent).toBe('Catalyst:')
  })

  it('says a reading was not reported by leaving it out, and that an empty calendar is not a search', async () => {
    const { ivRank: _ivRank, ivPercentile: _ivPercentile, ...unranked } = symbolPage.ticker
    const container = await renderPage(createElement(SymbolPage, { page: { ...symbolPage, catalysts: [], recommendation: null, ticker: unranked } }))
    const text = container.textContent ?? ''
    expect(text).not.toContain('IV rank')
    expect(text).toContain('No upcoming dated event is stored for NVDA. This page shows what is already on the calendar and does not run a search.')
    expect(text).toContain('No published brief has recommended NVDA.')
  })
})

describe('brief pages', () => {
  const brief = {
    ...dailyBriefFixture,
    links: [{ snippet: `Snippet ${HOSTILE}`, title: 'Capex <img src=x onerror=alert(1)>', url: 'https://www.reuters.com/markets/us/capex-2026' }],
    recommendations: [
      { ...dailyBriefFixture.recommendations[0]!, thesis: `**Catalyst:** capex.\n\n- IV rank 22.\n\n${HOSTILE}\n\n[bad](javascript:alert(1))` },
      { direction: 'bearish' as const, symbol: 'TSLA', thesis: 'Unlisted.', trade: 'Buy TSLA 300p' },
    ],
  }
  const page = { brief, newerMarketDate: '2026-08-14', olderMarketDate: '2026-08-12', symbolsWithPages: ['NVDA'] }

  it('prints each trade, thesis and headline as text and links the archive neighbours', async () => {
    const container = await renderPage(createElement(BriefPage, { page }))
    const text = container.textContent ?? ''
    expect(container.querySelector('h1')?.textContent).toBe('Options brief, Aug 13, 2026')
    expect(text).toContain('NVDA · Bullish')
    expect(text).toContain('TSLA · Bearish')
    expect(text).toContain('Buy NVDA 205c 10/16/26')
    expect(text).toContain('generated by @cf/zai-org/glm-5.3')
    expect(text).toContain('Not financial advice.')
    expect(container.querySelector('.thesis li')?.textContent).toBe('IV rank 22.')
    expect(container.querySelector('time[datetime="2026-08-13T13:35:00.000Z"]')).not.toBeNull()
    const links = hrefs(container)
    expect(links).toEqual(expect.arrayContaining(['/briefs/2026-08-12', '/briefs/2026-08-14', '/briefs', '/options/NVDA', '/disclosures']))
    // A name the snapshot no longer shows has no page, so it is printed without a link to a 404.
    expect(links).not.toContain('/options/TSLA')
  })

  it('escapes model and third-party text and publishes no uncitable address', async () => {
    const container = await renderPage(createElement(BriefPage, { page }))
    expect(container.querySelector('main script, main img')).toBeNull()
    expect(container.textContent).toContain(HOSTILE)
    expect(container.textContent).toContain('Capex <img src=x onerror=alert(1)>')
    expect(hrefs(container).some((href) => href?.startsWith('javascript:'))).toBe(false)
  })

  it('omits a neighbour the archive does not have and says when a brief argued nothing', async () => {
    const container = await renderPage(createElement(BriefPage, {
      page: { brief: { ...brief, recommendations: [] }, newerMarketDate: null, olderMarketDate: null, symbolsWithPages: [] },
    }))
    expect(container.textContent).toContain('No trades')
    expect(container.textContent).not.toContain('Previous')
    expect(container.textContent).not.toContain('Next')
  })

  it('lists the archive newest first as given, linking each market date', async () => {
    const container = await renderPage(createElement(BriefArchivePage, {
      briefs: [{ marketDate: '2026-08-13', symbols: ['NVDA', 'BRK/B'] }, { marketDate: '2026-08-12', symbols: [] }],
    }))
    const rows = [...container.querySelectorAll('.public-brief-archive li')].map((row) => row.textContent)
    expect(rows).toEqual(['Aug 13, 2026NVDA, BRK/B', 'Aug 12, 2026No trades'])
    expect(hrefs(container)).toEqual(expect.arrayContaining(['/briefs/2026-08-13', '/briefs/2026-08-12', '/recommendations']))
    const empty = await renderPage(createElement(BriefArchivePage, { briefs: [] }))
    expect(empty.textContent).toContain('No brief has been published yet.')
  })
})

describe('public page heads', () => {
  const metaContent = (head: { meta: Array<{ content?: string; name?: string; property?: string; title?: string }> }, key: string) =>
    head.meta.find((entry) => entry.name === key || entry.property === key)?.content

  it('titles a symbol page without a figure, names the company, and gives the canonical address', () => {
    const head = symbolPageHead({ name: 'NVIDIA Corporation - Common Stock', symbol: 'NVDA' })
    expect(head.meta[0]).toEqual({ title: 'NVDA options: IV rank, implied volatility and catalysts | spicytrade' })
    expect(head.meta[0]?.title).not.toMatch(/\d/)
    expect(metaContent(head, 'description')).toContain('NVIDIA Corporation (NVDA) options')
    expect(metaContent(head, 'og:title')).toBe(head.meta[0]?.title)
    expect(head.links).toEqual([{ href: 'https://spicy.trade/options/NVDA', rel: 'canonical' }])
    expect(symbolPageHead({ name: 'Berkshire Hathaway Inc. Class B Common Stock', symbol: 'BRK/B' }).links[0]?.href)
      .toBe('https://spicy.trade/options/BRK%2FB')
  })

  it('titles a brief by its market date and names, and the archive by what it is', () => {
    const head = briefPageHead(dailyBriefFixture)
    expect(head.meta[0]).toEqual({ title: 'Options brief for Aug 13, 2026: NVDA | spicytrade' })
    expect(head.links).toEqual([{ href: 'https://spicy.trade/briefs/2026-08-13', rel: 'canonical' }])
    expect(metaContent(briefPageHead({ marketDate: '2026-08-13', recommendations: [] }), 'description')).toContain('no trades')
    expect(briefArchiveHead().links).toEqual([{ href: 'https://spicy.trade/briefs', rel: 'canonical' }])
  })
})
