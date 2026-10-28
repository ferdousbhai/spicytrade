// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { type DatedRecommendation } from '../src/domain/brief'
import { dailyBriefFixture } from './fixtures/market'
import { renderMarketScreen, stubFocusCardFetch } from './fixtures/render-market-screen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const archived: DatedRecommendation = {
  marketDate: '2026-08-11',
  recommendation: { ...dailyBriefFixture.recommendations[0]!, symbol: 'SPY', trade: 'Buy SPY 600p 9/18/26' },
}

function stubFetch(recommendation: DatedRecommendation | null, status = 200): ReturnType<typeof vi.fn> {
  return stubFocusCardFetch({
    '/api/public-symbol-recommendation': () => status === 200 ? Response.json({ recommendation }) : new Response('{}', { status }),
  })
}

describe('the latest recommendation for the selected symbol', () => {
  it('shows an earlier brief\'s recommendation with its market date and the disclaimer', async () => {
    stubFetch(archived)

    renderMarketScreen({ brief: dailyBriefFixture, symbol: 'SPY' })

    expect(await screen.findByText('Buy SPY 600p 9/18/26')).toBeTruthy()
    expect(screen.getByRole('heading', { name: /Recommendation/ }).querySelector('time')?.getAttribute('dateTime')).toBe('2026-08-11')
    expect(screen.getByText('Not financial advice.')).toBeTruthy()
    expect(screen.getByRole('link', { name: 'Disclosures' }).getAttribute('href')).toBe('/disclosures')
  })

  it('uses the standing brief without asking the archive', async () => {
    const fetch = stubFetch(null)

    renderMarketScreen({ brief: dailyBriefFixture, symbol: 'NVDA' })

    expect(screen.getByText('Buy NVDA 205c 10/16/26')).toBeTruthy()
    await waitFor(() => expect(fetch).toHaveBeenCalled())
    expect(fetch.mock.calls.some(([input]) => String(input).startsWith('/api/public-symbol-recommendation'))).toBe(false)
  })

  it('renders nothing for a name no brief recommended, and says so when the read fails', async () => {
    const fetch = stubFetch(null)
    renderMarketScreen({ symbol: 'SPY' })
    await waitFor(() => expect(fetch.mock.calls.some(([input]) => String(input).startsWith('/api/public-symbol-recommendation'))).toBe(true))
    expect(screen.queryByText('Not financial advice.')).toBeNull()
    cleanup()

    stubFetch(null, 503)
    renderMarketScreen({ symbol: 'SPY' })
    expect(await screen.findByText('Recommendation unavailable')).toBeTruthy()
  })
})
