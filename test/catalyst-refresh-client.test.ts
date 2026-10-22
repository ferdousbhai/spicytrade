// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { useCatalystSearch, seedCatalystSearch } from '../src/data/catalyst-refresh'
import { CATALYST_BROWSER_REVALIDATE_MS } from '../src/data/catalyst-revalidation'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

it('rechecks a visible symbol after expiry and on returning to the tab without duplicating requests', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const fetchMock = vi.fn(async () => Response.json({ catalysts: [], ran: false, reason: 'fresh' }))
  vi.stubGlobal('fetch', fetchMock)
  await act(async () => { renderHook(() => useCatalystSearch('RIVN')) })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await act(async () => {
    seedCatalystSearch('RIVN')
    window.dispatchEvent(new Event('focus'))
  })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(CATALYST_BROWSER_REVALIDATE_MS) })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  // A suspended tab's clock moves without firing timers. Returning still checks again.
  vi.setSystemTime(Date.now() + CATALYST_BROWSER_REVALIDATE_MS)
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(fetchMock).toHaveBeenCalledTimes(3)
})

it('keeps a fresh calendar stable on focus and re-reads it once its copy expires', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const fetchMock = vi.fn(async () => Response.json({ catalysts: [] }))
  vi.stubGlobal('fetch', fetchMock)
  const { usePublicCatalysts } = await import('../src/data/public-catalysts')
  let renders = 0
  await act(async () => {
    renderHook(() => { renders += 1; return usePublicCatalysts('NVDA') })
  })
  const settledRenders = renders
  await act(async () => { window.dispatchEvent(new Event('focus')) })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(renders).toBe(settledRenders)
  await act(async () => { await vi.advanceTimersByTimeAsync(CATALYST_BROWSER_REVALIDATE_MS) })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('preserves a completed empty search across routine cooldown refusals', async () => {
  vi.useFakeTimers()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ catalysts: [], ran: true }))
    .mockResolvedValueOnce(Response.json({ catalysts: [], ran: false, reason: 'fresh' }))
  vi.stubGlobal('fetch', fetchMock)
  const { result } = renderHook(() => useCatalystSearch('GOOG'))
  await act(async () => {})
  expect(result.current.confirmedEmpty).toBe(true)
  await act(async () => { await vi.advanceTimersByTimeAsync(CATALYST_BROWSER_REVALIDATE_MS) })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  expect(result.current.confirmedEmpty).toBe(true)
})
