// @vitest-environment jsdom

import { cleanup, fireEvent, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderMarketScreen } from './fixtures/render-market-screen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** A viewport that answers only the phone breakpoint, the way a 400px window does. */
function stubPhoneViewport(): void {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
    addEventListener: () => undefined,
    matches: query.startsWith('(max-width'),
    removeEventListener: () => undefined,
  })))
}

function renderMarket(): void {
  stubPhoneViewport()
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ catalysts: [], ran: false })))
  renderMarketScreen({ symbol: 'NVDA' })
}

describe('the phone list', () => {
  it('shows the selected ranking metric in every row', () => {
    renderMarket()

    const pill = (symbol: string) => [...document.querySelectorAll('.watch-row')]
      .find((row) => row.textContent?.includes(symbol))!
      .querySelector('.watch-pill')!
    const sortBy = screen.getByLabelText('Sort by')
    fireEvent.change(sortBy, { target: { value: 'premium' } })
    expect(pill('NVDA').textContent).toBe('Expensive 72')
    expect(pill('NVDA').getAttribute('data-tone')).toBe('rich')
    expect(pill('SPCX').textContent).toBe('Cheap 26')
    fireEvent.change(sortBy, { target: { value: 'volume' } })
    expect(pill('NVDA').textContent).toBe('128.4M')
    fireEvent.change(sortBy, { target: { value: 'marketCap' } })
    expect(pill('NVDA').textContent).toBe('$4.7T')
    fireEvent.change(sortBy, { target: { value: 'liquidity' } })
    expect(pill('NVDA').textContent).toMatch(/\/5$/)
    fireEvent.change(sortBy, { target: { value: 'year' } })
    // This snapshot has no year anchor; missing returns stay visibly unavailable.
    expect(pill('NVDA').textContent).toBe('—')
  })
})
