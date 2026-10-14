import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { BriefScreen, publishedLabel } from '../src/components/brief-screen'
import { type DailyBrief } from '../src/domain/brief'
import { dailyBriefFixture } from './fixtures/market'

function render(latest: DailyBrief | undefined): string {
  return renderToStaticMarkup(createElement(BriefScreen, { latest, onSymbol: () => undefined }))
}

describe('the brief screen', () => {

  it('renders model markup as text, never as HTML', () => {
    const html = render({
      ...dailyBriefFixture,
      recommendations: [{ ...dailyBriefFixture.recommendations[0]!, thesis: '<img src=x onerror=alert(1)> and [x](javascript:alert(1))' }],
    })
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;')
    expect(html).not.toContain('href="javascript:')
    expect(html).toContain('[x](javascript:alert(1))')
  })

  it('puts the trades before the headlines, and shows a headline as its title, snippet and host', () => {
    const html = render({
      ...dailyBriefFixture,
      links: [
        { url: 'https://www.reuters.com/markets/us/capex-2026', title: 'Capex <b>holds</b>', snippet: 'Hyperscalers keep spending.' },
        { url: 'https://www.bloomberg.com/news/x' },
      ],
    })
    expect(html.indexOf('aria-label="Trades"')).toBeLessThan(html.indexOf('Headlines'))
    expect(html).not.toContain('Reading')
    expect(html).toContain('Capex &lt;b&gt;holds&lt;/b&gt;')
    expect(html).toContain('Hyperscalers keep spending.')
    expect(html).toContain('>www.reuters.com<')
    // A titled headline does not repeat its URL as text; an untitled one is titled by its host,
    // with its path, never a title derived from the slug.
    expect(html).not.toContain('>https://www.reuters.com/markets/us/capex-2026')
    expect(html).toContain('<span class="brief-headline-title">www.bloomberg.com<')
    expect(html).toContain('>/news/x<')
    expect(html).toContain('href="https://www.bloomberg.com/news/x"')
    expect(html).toContain('rel="noreferrer" target="_blank"')
  })

  it('says so when nothing has been published', () => {
    const html = render(undefined)
    expect(html).toContain('No brief yet')
    expect(html).not.toContain('Previous')
  })
})

describe('brief publication line', () => {

  it('keeps the date when the New York day differs from the market day', () => {
    // 02:00 UTC on Sep 26 is still Sep 25 in New York, so that is the same day...
    expect(publishedLabel({ marketDate: '2026-09-25', publishedAt: '2026-09-26T02:00:00.000Z' })).toBe('10:00 PM EDT')
    // ...while a republication days later names its own date.
    expect(publishedLabel({ marketDate: '2026-09-25', publishedAt: '2026-09-28T14:00:00.000Z' })).toBe('Sep 28, 2026, 10:00 AM EDT')
  })
})
