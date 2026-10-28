// @vitest-environment jsdom

import { cleanup, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { type SymbolEvidence } from '../src/domain/symbol-evidence'
import { renderMarketScreen, stubFocusCardFetch } from './fixtures/render-market-screen'

afterEach(() => {
  cleanup()
})

function card(overrides: Partial<SymbolEvidence> = {}): SymbolEvidence {
  return {
    byline: 'volwatcher',
    id: 'member-evidence:one',
    note: 'Visibility into next year, not this quarter.',
    quote: 'signed a multi-year supply agreement',
    recordedAt: '2026-09-02T13:45:00.000Z',
    sourceTitle: 'NVIDIA supply agreement',
    sourceUrl: 'https://www.reuters.com/technology/nvidia-supply',
    symbol: 'NVDA',
    ...overrides,
  }
}

function stubFetch(evidence: readonly SymbolEvidence[]): void {
  stubFocusCardFetch({ '/api/public-symbol-evidence': () => Response.json({ evidence }) })
}

describe('evidence recorded under the selected symbol', () => {
  it('shows the quote, the recorder\'s reading of it, and the page it came from', async () => {
    stubFetch([card()])

    renderMarketScreen({ symbol: 'NVDA' })

    expect(await screen.findByText('signed a multi-year supply agreement')).toBeTruthy()
    expect(screen.getByText('Visibility into next year, not this quarter.')).toBeTruthy()
    // The byline the member chose is the whole of the attribution a reader sees.
    expect(screen.getByText('volwatcher')).toBeTruthy()
    const source = screen.getByRole('link', { name: /reuters\.com/ })
    expect(source.getAttribute('href')).toBe('https://www.reuters.com/technology/nvidia-supply')
    expect(source.getAttribute('target')).toBe('_blank')
    expect(source.getAttribute('rel')).toBe('noreferrer')
    // The wide layout flows evidence with the rest of the reading only because it shares the
    // flow wrapper; outside it, evidence would fall out of the balanced columns.
    expect(document.querySelector('.focus-flow > .focus-evidence')).not.toBeNull()
  })

  it('says the evidence is unavailable when the read fails, rather than passing for an empty name', async () => {
    stubFocusCardFetch({ '/api/public-symbol-evidence': () => new Response('{}', { status: 503 }) })

    renderMarketScreen({ symbol: 'NVDA' })

    expect(await screen.findByText('Evidence unavailable')).toBeTruthy()
    expect(document.querySelector('.evidence-cards')).toBeNull()

    // The read is asked again when the window regains focus, and a recovered read shows its cards.
    stubFetch([card()])
    await waitFor(() => {
      window.dispatchEvent(new Event('focus'))
      expect(document.querySelector('.evidence-cards')).not.toBeNull()
    })
    expect(screen.queryByText('Evidence unavailable')).toBeNull()
  })

  it('dates a card by the New York day it was recorded, not the UTC one', async () => {
    // 02:30 UTC on the 2nd is still the evening of the 1st in New York.
    stubFetch([card({ recordedAt: '2026-09-02T02:30:00.000Z' })])

    renderMarketScreen({ symbol: 'NVDA' })

    const recorded = await screen.findByText('Sep 1, 2026')
    expect(recorded.getAttribute('datetime')).toBe('2026-09-02T02:30:00.000Z')
  })
})
