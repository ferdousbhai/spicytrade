import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { type PublicSymbolLookup } from '../src/domain/market'
import { COLD_STORE_RETRY_DELAYS_MS, type PublicSnapshotCache } from '../src/server/public-snapshot-cache'
import { servePublicSymbolSearch } from '../src/server/public-symbol-search'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { marketSnapshotFixture } from './fixtures/market'

const SEARCH_URL = 'https://spicy.trade/api/public-symbol-search'
const broker = stubBroker()

class MemoryCache implements PublicSnapshotCache {
  private readonly responses = new Map<string, Response>()

  putCalls = 0

  async match(request: Request): Promise<Response | undefined> {
    return this.responses.get(request.url)?.clone()
  }

  async put(request: Request, response: Response): Promise<void> {
    this.putCalls += 1
    this.responses.set(request.url, response.clone())
  }
}

function lookup(): PublicSymbolLookup {
  return { catalysts: [], ticker: marketSnapshotFixture().tickers[0]!, watchlisted: true }
}

function serve(query: string, cache: PublicSnapshotCache): Promise<Response> {
  return servePublicSymbolSearch(
    new Request(`${SEARCH_URL}?q=${encodeURIComponent(query)}`),
    {},
    cache,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  setBrokerApi(broker)
})

afterEach(() => {
  vi.useRealTimers()
  broker.claimMarketRefresh.mockResolvedValue(true)
  broker.releaseMarketRefresh.mockResolvedValue(undefined)
  broker.lookupStoredMarketSymbol.mockResolvedValue(undefined)
  resetBrokerApi()
})

const WAIT_MS = COLD_STORE_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)

/**
 * The shared lease every location claims against, with the store's semantics: one holder per id
 * until its expiry, and a release that frees only the holder's own claim.
 */
function sharedLease() {
  const held = new Map<string, number>()
  broker.claimMarketRefresh.mockImplementation(async (_env, leaseMs, now = new Date(), id = 'public-snapshot') => {
    const expiry = held.get(id)
    if (expiry !== undefined && expiry > now.getTime()) return false
    held.set(id, now.getTime() + leaseMs)
    return true
  })
  broker.releaseMarketRefresh.mockImplementation(async (_env, leaseMs, claimedAt, id) => {
    if (held.get(id) === claimedAt.getTime() + leaseMs) held.delete(id)
  })
  return held
}

/** A provider lookup that takes `ms` to say nothing matched, recording how many ran at once. */
function slowMiss(ms: number) {
  const concurrency = { inFlight: 0, peak: 0 }
  broker.lookupPublicMarketSymbol.mockImplementation(async () => {
    concurrency.inFlight += 1
    concurrency.peak = Math.max(concurrency.peak, concurrency.inFlight)
    await new Promise((resolve) => setTimeout(resolve, ms))
    concurrency.inFlight -= 1
    return undefined
  })
  return concurrency
}

describe('public symbol search route', () => {
  it('answers one lookup and replays it for the same search', async () => {
    broker.lookupPublicMarketSymbol.mockResolvedValue(lookup())
    const cache = new MemoryCache()

    const first = await serve('tqqq', cache)
    expect(first.status).toBe(200)
    await expect(first.json()).resolves.toMatchObject({ watchlisted: true })
    expect(cache.putCalls).toBe(1)

    // The same search in any letter case is the same question, so it costs no second
    // broker read and no second maintained-list write.
    const replay = await serve(' TQQQ ', cache)
    expect(replay.status).toBe(200)
    expect(broker.lookupPublicMarketSymbol).toHaveBeenCalledTimes(1)
    expect(cache.putCalls).toBe(1)
  })

  it('keeps a search that matched nothing, and never asks the broker for an empty one', async () => {
    broker.lookupPublicMarketSymbol.mockResolvedValue(undefined)
    const cache = new MemoryCache()

    const missing = await serve('zzzz', cache)
    expect(missing.status).toBe(404)
    expect(cache.putCalls).toBe(1)

    const blank = await serve('   ', cache)
    expect(blank.status).toBe(400)
    expect(broker.lookupPublicMarketSymbol).toHaveBeenCalledTimes(1)
  })

  it('reports an unavailable search without storing the failure', async () => {
    broker.lookupPublicMarketSymbol.mockRejectedValue(new Error('TastytradeUnavailable'))
    const cache = new MemoryCache()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    const failed = await serve('tqqq', cache)

    expect(failed.status).toBe(503)
    expect(failed.headers.get('Cache-Control')).toContain('no-store')
    expect(cache.putCalls).toBe(0)
  })
  it('waits for the claim holder instead of calling the provider on a lost first-time claim', async () => {
    vi.useFakeTimers()
    broker.claimMarketRefresh.mockResolvedValue(false)
    // Nothing stored when this caller looks; the winner's write lands while it waits.
    broker.lookupStoredMarketSymbol
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(lookup())
    const cache = new MemoryCache()

    const pending = serve('tqqq', cache)
    await vi.advanceTimersByTimeAsync(WAIT_MS)
    const answered = await pending

    expect(answered.status).toBe(200)
    expect(broker.lookupPublicMarketSymbol).not.toHaveBeenCalled()
  })

  it('keeps the claim after a found answer, so other locations read the store instead of the broker', async () => {
    const held = sharedLease()
    broker.lookupPublicMarketSymbol.mockResolvedValue(lookup())

    const here = await serve('tqqq', new MemoryCache())
    expect(here.status).toBe(200)
    expect(held.size).toBe(1)

    // The found answer is in the shared store; a location that loses the still-held claim reads it.
    broker.lookupStoredMarketSymbol.mockResolvedValue(lookup())
    const elsewhere = await serve('tqqq', new MemoryCache())
    expect(elsewhere.status).toBe(200)
    expect(broker.lookupPublicMarketSymbol).toHaveBeenCalledTimes(1)
  })

  it('gives the claim back once its lookup finishes, so another location can ask at once', async () => {
    const held = sharedLease()
    broker.lookupPublicMarketSymbol.mockResolvedValue(undefined)

    // A search that matched nothing is kept only in the location that answered it.
    const here = await serve('zzzz', new MemoryCache())
    expect(here.status).toBe(404)
    expect(held.size).toBe(0)

    const elsewhere = await serve('zzzz', new MemoryCache())
    expect(elsewhere.status).toBe(404)
    expect(broker.lookupPublicMarketSymbol).toHaveBeenCalledTimes(2)
  })

  it('takes over a lookup whose holder finished while it waited, one lookup at a time', async () => {
    vi.useFakeTimers()
    sharedLease()
    // The holder is slower than the first wait but done before the last one, and its miss
    // landed only in its own location.
    const concurrency = slowMiss(COLD_STORE_RETRY_DELAYS_MS[0]! + 500)

    const holder = serve('zzzz', new MemoryCache())
    const waiter = serve('zzzz', new MemoryCache())
    await vi.advanceTimersByTimeAsync(WAIT_MS + COLD_STORE_RETRY_DELAYS_MS[0]! + 500)

    expect((await holder).status).toBe(404)
    expect((await waiter).status).toBe(404)
    expect(broker.lookupPublicMarketSymbol).toHaveBeenCalledTimes(2)
    expect(concurrency.peak).toBe(1)
  })

  it('still answers busy while a slow holder has not finished, without a second lookup', async () => {
    vi.useFakeTimers()
    const held = sharedLease()
    const concurrency = slowMiss(WAIT_MS + 1_000)

    const holder = serve('zzzz', new MemoryCache())
    const waiter = serve('zzzz', new MemoryCache())
    await vi.advanceTimersByTimeAsync(WAIT_MS)
    expect((await waiter).status).toBe(503)

    await vi.advanceTimersByTimeAsync(1_000)
    expect((await holder).status).toBe(404)
    expect(concurrency.peak).toBe(1)
    expect(broker.lookupPublicMarketSymbol).toHaveBeenCalledTimes(1)
    expect(held.size).toBe(0)
  })

  it('releases the claim when the lookup it guarded fails', async () => {
    const held = sharedLease()
    broker.lookupPublicMarketSymbol.mockRejectedValue(new Error('TastytradeUnavailable'))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    expect((await serve('tqqq', new MemoryCache())).status).toBe(503)
    expect(held.size).toBe(0)
  })

  it('answers try-again rather than a provider call when the claim holder never lands', async () => {
    vi.useFakeTimers()
    broker.claimMarketRefresh.mockResolvedValue(false)
    broker.lookupStoredMarketSymbol.mockResolvedValue(undefined)
    const cache = new MemoryCache()

    const pending = serve('tqqq', cache)
    await vi.advanceTimersByTimeAsync(WAIT_MS)
    const busy = await pending

    expect(busy.status).toBe(503)
    expect(busy.headers.get('Cache-Control')).toContain('no-store')
    expect(broker.lookupPublicMarketSymbol).not.toHaveBeenCalled()
    expect(broker.lookupStoredMarketSymbol).toHaveBeenCalledTimes(1 + COLD_STORE_RETRY_DELAYS_MS.length)
    expect(cache.putCalls).toBe(0)
  })
})
