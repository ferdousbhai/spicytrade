import { afterEach, expect, it, vi } from 'vitest'
import { marketSnapshotFixture } from './fixtures/market'

afterEach(() => {
  vi.useRealTimers()
  vi.resetModules()
})

it('reports a malformed catalyst response as a failed read, not an empty calendar, and retries it', async () => {
  const catalysts = marketSnapshotFixture().catalysts.filter((row) => row.symbol === 'NVDA')
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ catalysts: [{}] }))
    .mockResolvedValueOnce(Response.json({ catalysts }))
  vi.stubGlobal('fetch', fetchMock)
  const { loadPublicCatalysts } = await import('../src/data/public-catalysts')
  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual({ catalysts: [], failed: true })
  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual({ catalysts: catalysts, failed: false })
  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual({ catalysts: catalysts, failed: false })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('re-reads a symbol whose rows a search may have moved, rather than answering from the copy', async () => {
  // A search invalidates the copy immediately, even inside the normal read freshness window.
  const catalysts = marketSnapshotFixture().catalysts.filter((row) => row.symbol === 'NVDA')
  // A fresh Response per call: a body is read once, and this test asks for the same page twice.
  const fetchMock = vi.fn(() => Promise.resolve(Response.json({ catalysts })))
  vi.stubGlobal('fetch', fetchMock)
  const { forgetPublicCatalysts, loadPublicCatalysts } = await import('../src/data/public-catalysts')

  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual({ catalysts: catalysts, failed: false })
  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual({ catalysts: catalysts, failed: false })
  expect(fetchMock).toHaveBeenCalledTimes(1)

  forgetPublicCatalysts('NVDA')
  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual({ catalysts: catalysts, failed: false })
  expect(fetchMock).toHaveBeenCalledTimes(2)
  // A symbol nobody searched keeps its copy; forgetting one name is not clearing the cache.
  forgetPublicCatalysts('not a symbol')
  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual({ catalysts: catalysts, failed: false })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it('lets a request started before a search neither cache its rows nor clear the newer request', async () => {
  const after = marketSnapshotFixture().catalysts.filter((row) => row.symbol === 'NVDA')
  // The date a search since moved away from.
  const before = after.map((row) => ({ ...row, date: '2026-08-19' }))
  const pending: ((response: Response) => void)[] = []
  const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { pending.push(resolve) }))
  vi.stubGlobal('fetch', fetchMock)
  const { forgetPublicCatalysts, loadPublicCatalysts } = await import('../src/data/public-catalysts')

  const superseded = loadPublicCatalysts('NVDA')
  forgetPublicCatalysts('NVDA')
  const current = loadPublicCatalysts('NVDA')
  expect(fetchMock).toHaveBeenCalledTimes(2)

  // The pre-search answer lands first. Its caller still gets it, but the browser keeps nothing
  // from it and the newer request stays the one every later reader joins.
  pending[0]!(Response.json({ catalysts: before }))
  await expect(superseded).resolves.toEqual({ catalysts: before, failed: false })
  expect(loadPublicCatalysts('NVDA')).toBe(current)
  expect(fetchMock).toHaveBeenCalledTimes(2)

  pending[1]!(Response.json({ catalysts: after }))
  await expect(current).resolves.toEqual({ catalysts: after, failed: false })
  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual({ catalysts: after, failed: false })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})

it("expires a successful read so another reader’s changes are visible in the same session", async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const { CATALYST_BROWSER_REVALIDATE_MS } = await import('../src/data/catalyst-revalidation')
  const rows = marketSnapshotFixture().catalysts.filter((row) => row.symbol === 'NVDA')
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(Response.json({ catalysts: rows }))
    .mockResolvedValueOnce(Response.json({ catalysts: [] }))
  vi.stubGlobal('fetch', fetchMock)
  const { loadPublicCatalysts } = await import('../src/data/public-catalysts')
  await loadPublicCatalysts('NVDA')
  vi.setSystemTime(Date.now() + CATALYST_BROWSER_REVALIDATE_MS - 1)
  await expect(loadPublicCatalysts('NVDA')).resolves.toMatchObject({ catalysts: rows })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  vi.setSystemTime(Date.now() + 1)
  await expect(loadPublicCatalysts('NVDA')).resolves.toEqual({ catalysts: [], failed: false })
  expect(fetchMock).toHaveBeenCalledTimes(2)
})
