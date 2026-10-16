import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  instrumentCatalogFromPayload,
  persistInstrumentCatalog,
  unresolvedInstrumentCatalogItem,
} from '../src/server/instrument-catalog'
import {
  CATALYST_CONTRADICTED_REFRESH_MS,
  CATALYST_NEAR_EVENT_DAYS,
  CATALYST_NEAR_EVENT_REFRESH_DAYS,
  CATALYST_REFRESH_INTERVAL_DAYS,
  CATALYST_FAILED_RETRY_MS,
  CATALYST_RUN_BUDGET_MS,
  attemptCatalystRefresh,
  refreshCatalystsForSymbol,
} from '../src/server/catalyst-refresh'
import { persistResearchCatalysts } from '../src/server/catalysts'
import { addDays } from '../src/domain/iso-date'
import { markdownBrowser } from './fake-browser'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

const NOW = new Date('2026-09-01T13:00:00.000Z')

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function storeWithCatalog(): Promise<SqliteD1Store> {
  const store = await migrationStore()
  await persistInstrumentCatalog({ DB: store.database }, [
    ...instrumentCatalogFromPayload([{
      active: true,
      description: 'Bloom Energy Corporation',
      'instrument-type': 'Equity',
      symbol: 'BE',
    }], ['BE']),
    unresolvedInstrumentCatalogItem('HUH'),
  ])
  // Incidental attention only spends a search on a name the site tracks, so the fixture puts it
  // on the maintained list -- which is where a symbol a reader can reach has always come from.
  await store.database.prepare(
    `INSERT INTO internal_watchlist_items (symbol, instrument_type, origin, created_at, updated_at)
     VALUES ('BE', 'Equity', 'visitor-search', ?, ?)`,
  ).bind(NOW.toISOString(), NOW.toISOString()).run()
  return store
}

function stubExa() {
  const fetchMock = vi.fn(async () => Response.json({
    output: {
      content: {
        events: [{
          date: '2026-10-14',
          kind: 'investor-event',
          sourceUrl: 'https://ir.bloomenergy.com/events',
          title: 'Bloom Energy investor day',
        }],
      },
    },
    results: [{ url: 'https://ir.bloomenergy.com/events' }],
  }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const exaKey: SecretsStoreSecret = { get: async () => 'exa-key' }

function env(store: SqliteD1Store) {
  // The Worker's own read of the cited page, which is what the search's dates bind against.
  return {
    BROWSER: markdownBrowser('The investor day is scheduled for Oct. 14.'),
    DB: store.database,
    EXA_API_KEY: exaKey,
  }
}

function catalystRows(store: SqliteD1Store): unknown[] {
  return store.sqlite.prepare("SELECT id, symbol FROM catalysts WHERE source_provider = 'exa'").all()
}

describe('catalyst coverage seeded by favorites', () => {
  it('searches a favorited symbol once and stores what the search bound', async () => {
    const store = await storeWithCatalog()
    const fetchMock = stubExa()

    await expect(refreshCatalystsForSymbol(env(store), 'BE', NOW))
      .resolves.toMatchObject({ ran: true, catalysts: [{ id: 'exa:BE:investor-event:2026-10-14' }] })

    expect(catalystRows(store)).toEqual([{ id: 'exa:BE:investor-event:2026-10-14', symbol: 'BE' }])
    expect(store.sqlite.prepare('SELECT symbol, status, catalyst_count FROM catalyst_runs').all())
      .toEqual([{ symbol: 'BE', status: 'complete', catalyst_count: 1 }])
    expect(fetchMock).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('records a search whose synthesis never happened as failed, not as searched and empty', async () => {
    const store = await storeWithCatalog()
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ results: [] })))

    await expect(refreshCatalystsForSymbol(env(store), 'BE', NOW))
      .resolves.toEqual({ catalysts: [], ran: false, reason: 'failed' })
    expect(store.sqlite.prepare('SELECT status, catalyst_count FROM catalyst_runs').all())
      .toEqual([{ status: 'failed', catalyst_count: 0 }])
    store.close()
  })

  it('records a run without page reading as failed, and buys no search', async () => {
    // A complete, empty receipt would hold the symbol for the whole window on a search that bound
    // nothing because it could not read.
    const store = await storeWithCatalog()
    const fetchMock = stubExa()
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    try {
      const { BROWSER: _browser, ...withoutBrowser } = env(store)

      await expect(refreshCatalystsForSymbol(withoutBrowser, 'BE', NOW))
        .resolves.toEqual({ catalysts: [], ran: false, reason: 'failed' })
      expect(store.sqlite.prepare('SELECT status, detail FROM catalyst_runs').get())
        .toEqual({ status: 'failed', detail: 'CatalystSearch:page-reading-unavailable' })
      expect(fetchMock).not.toHaveBeenCalled()
      expect(catalystRows(store)).toEqual([])
    } finally {
      store.close()
    }
  })

  it('buys no second search inside the refresh window, and one again after it', async () => {
    const store = await storeWithCatalog()
    const fetchMock = stubExa()
    await refreshCatalystsForSymbol(env(store), 'BE', NOW)

    const withinWindow = new Date(NOW.getTime() + (CATALYST_REFRESH_INTERVAL_DAYS - 1) * 86_400_000)
    await expect(refreshCatalystsForSymbol(env(store), 'BE', withinWindow))
      .resolves.toEqual({ catalysts: [], ran: false, reason: 'fresh' })
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const afterWindow = new Date(NOW.getTime() + (CATALYST_REFRESH_INTERVAL_DAYS + 1) * 86_400_000)
    await expect(refreshCatalystsForSymbol(env(store), 'BE', afterWindow))
      .resolves.toMatchObject({ ran: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    store.close()
  })

  it('searches again sooner once an event is near', async () => {
    const store = await storeWithCatalog()
    const fetchMock = stubExa()
    // The search binds BE's investor day on Oct 14; from Oct 2 that is inside the near window.
    const searchedAt = new Date('2026-10-02T13:00:00.000Z')
    expect(addDays('2026-10-02', CATALYST_NEAR_EVENT_DAYS) >= '2026-10-14').toBe(true)
    await refreshCatalystsForSymbol(env(store), 'BE', searchedAt)

    const day = (days: number) => new Date(searchedAt.getTime() + days * 86_400_000)
    await expect(refreshCatalystsForSymbol(env(store), 'BE', day(CATALYST_NEAR_EVENT_REFRESH_DAYS - 1)))
      .resolves.toMatchObject({ ran: false, reason: 'fresh' })
    // Still inside the week a quiet calendar is held for, but the event is close.
    expect(CATALYST_NEAR_EVENT_REFRESH_DAYS + 1).toBeLessThan(CATALYST_REFRESH_INTERVAL_DAYS)
    await expect(refreshCatalystsForSymbol(env(store), 'BE', day(CATALYST_NEAR_EVENT_REFRESH_DAYS + 1)))
      .resolves.toMatchObject({ ran: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    store.close()
  })

  it('searches again once a confirmed earnings date contradicts the estimate it found', async () => {
    const estimate = {
      confidence: 'estimated' as const,
      date: '2026-11-05',
      id: 'exa:BE:earnings:2026-11-05',
      kind: 'earnings' as const,
      source: 'Exa search · example.com',
      sourceUrl: 'https://example.com/be',
      symbol: 'BE',
      timing: 'unknown' as const,
      title: 'Bloom Energy Q3 earnings',
      updatedAt: NOW.toISOString(),
    }
    const confirmedAt = async (updatedAt: string) => {
      const store = await storeWithCatalog()
      await refreshCatalystsForSymbol(env(store), 'BE', NOW)
      // What the search at NOW reported for earnings, and the broker's confirmation of the
      // same report a week later, stamped by the provider at `updatedAt`.
      await persistResearchCatalysts({ DB: store.database }, 'exa', [estimate], NOW)
      await persistResearchCatalysts({ DB: store.database }, 'tastytrade', [{
        ...estimate,
        confidence: 'confirmed',
        date: '2026-11-12',
        id: 'tastytrade:BE:earnings',
        source: 'tastytrade market metrics',
        sourceUrl: 'https://developer.tastytrade.com/open-api-spec/market-metrics/',
        updatedAt,
      }], NOW)
      return store
    }
    // Past the day's floor, inside the week, and no event near: only the contradiction says go.
    const later = new Date(NOW.getTime() + (CATALYST_CONTRADICTED_REFRESH_MS + 86_400_000))
    expect(later.getTime() - NOW.getTime()).toBeLessThan(CATALYST_REFRESH_INTERVAL_DAYS * 86_400_000)

    const fetchMock = stubExa()
    const confirmedAfter = await confirmedAt(new Date(NOW.getTime() + 3_600_000).toISOString())
    await expect(refreshCatalystsForSymbol(env(confirmedAfter), 'BE', new Date(NOW.getTime() + 3_600_000 * 2)))
      .resolves.toMatchObject({ ran: false, reason: 'fresh' })
    await expect(refreshCatalystsForSymbol(env(confirmedAfter), 'BE', later)).resolves.toMatchObject({ ran: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    confirmedAfter.close()

    // A confirmation the search could already have seen is not news to it.
    const confirmedBefore = await confirmedAt(new Date(NOW.getTime() - 3_600_000).toISOString())
    await expect(refreshCatalystsForSymbol(env(confirmedBefore), 'BE', later)).resolves.toMatchObject({ ran: false, reason: 'fresh' })
    confirmedBefore.close()
  })

  it('will not let incidental attention spend a search on a name the site does not track', async () => {
    // The window bounds how often one symbol is searched; it says nothing about how many symbols
    // are reachable. Without this the reachable set was the whole instrument catalog -- thousands
    // of names, spendable with no credential, since attention has always been anonymous.
    const store = await storeWithCatalog()
    const fetchMock = stubExa()
    try {
      await store.database.prepare('DELETE FROM internal_watchlist_items WHERE symbol = ?')
        .bind('BE').run()

      await expect(refreshCatalystsForSymbol(env(store), 'BE', NOW))
        .resolves.toEqual({ catalysts: [], ran: false, reason: 'untracked' })
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      store.close()
    }
  })

  it('spends nothing on a symbol the catalog cannot name', async () => {
    const store = await storeWithCatalog()
    const fetchMock = stubExa()

    await expect(refreshCatalystsForSymbol(env(store), 'HUH', NOW))
      .resolves.toEqual({ catalysts: [], ran: false, reason: 'unknown-symbol' })
    await expect(refreshCatalystsForSymbol(env(store), 'ZZZZ', NOW))
      .resolves.toEqual({ catalysts: [], ran: false, reason: 'unknown-symbol' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.sqlite.prepare('SELECT count(*) AS count FROM catalyst_runs').get()).toEqual({ count: 0 })
    store.close()
  })

  it('tells a caller budgeting searches a failed run from a failure\'s backoff', async () => {
    // A reader sees both as `failed`; only the first bought a search.
    const store = await storeWithCatalog()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 500 })))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(attemptCatalystRefresh(env(store), 'BE', NOW)).resolves.toEqual({
      claimed: true, refresh: { catalysts: [], ran: false, reason: 'failed' },
    })
    await expect(attemptCatalystRefresh(env(store), 'BE', new Date(NOW.getTime() + 1))).resolves.toEqual({
      claimed: false, refresh: { catalysts: [], ran: false, reason: 'failed' },
    })
    store.close()
  })

  it('reports a failed search as failed, not as a calendar searched and found empty', async () => {
    const store = await storeWithCatalog()
    const fetchMock = vi.fn(async () => new Response('', { status: 500 }))
    vi.stubGlobal('fetch', fetchMock)
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)

    await expect(refreshCatalystsForSymbol(env(store), 'BE', NOW))
      .resolves.toEqual({ catalysts: [], ran: false, reason: 'failed' })

    // The private receipt keeps the cause; the log line carries only the error's name.
    expect(store.sqlite.prepare('SELECT status, detail FROM catalyst_runs').get())
      .toEqual({ status: 'failed', detail: 'ExaSearchFailed:500' })
    expect(logged).toHaveBeenCalledWith('CatalystRefreshFailed', 'Error')

    // Inside the retry backoff every other look -- each reader's window regaining focus -- is
    // answered from the receipt: still failed, never searched-and-empty, and not paid for again.
    const retryFetch = stubExa()
    const insideBackoff = new Date(NOW.getTime() + CATALYST_FAILED_RETRY_MS - 1)
    await expect(refreshCatalystsForSymbol(env(store), 'BE', insideBackoff))
      .resolves.toEqual({ catalysts: [], ran: false, reason: 'failed' })
    expect(retryFetch).not.toHaveBeenCalled()

    // Past it the failure holds nothing back, so the calendar is not left unknown for the whole hold.
    const pastBackoff = new Date(NOW.getTime() + CATALYST_FAILED_RETRY_MS)
    await expect(refreshCatalystsForSymbol(env(store), 'BE', pastBackoff))
      .resolves.toMatchObject({ ran: true, catalysts: [{ id: 'exa:BE:investor-event:2026-10-14' }] })
    expect(store.sqlite.prepare('SELECT status FROM catalyst_runs').get()).toEqual({ status: 'complete' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(retryFetch).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('lets a run that outlived its budget close only its own receipt, not a newer claim', async () => {
    const store = await storeWithCatalog()
    const reclaimedAt = new Date(NOW.getTime() + CATALYST_RUN_BUDGET_MS).toISOString()
    const answer = stubExa()
    // While this run's search is still out, its budget lapses and a newer look claims the symbol.
    vi.stubGlobal('fetch', vi.fn(async () => {
      store.sqlite.prepare("UPDATE catalyst_runs SET ran_at = ?, status = 'running'").run(reclaimedAt)
      return answer()
    }))

    await expect(refreshCatalystsForSymbol(env(store), 'BE', NOW)).resolves.toMatchObject({ ran: true })

    expect(store.sqlite.prepare('SELECT ran_at, status FROM catalyst_runs').get())
      .toEqual({ ran_at: reclaimedAt, status: 'running' })
    store.close()
  })

  it('holds a running receipt only for the run budget, so an abandoned run frees its symbol', async () => {
    const store = await storeWithCatalog()
    const fetchMock = stubExa()
    // A run cut off mid-flight -- a reader who disconnected, or attention work that outlived its
    // invocation -- leaves exactly this behind.
    await store.database.prepare(
      `INSERT INTO catalyst_runs (symbol, source_provider, ran_at, catalyst_count, status)
       VALUES ('BE', 'exa', ?, 0, 'running')`,
    ).bind(NOW.toISOString()).run()

    const insideBudget = new Date(NOW.getTime() + CATALYST_RUN_BUDGET_MS - 1)
    await expect(refreshCatalystsForSymbol(env(store), 'BE', insideBudget))
      .resolves.toEqual({ catalysts: [], ran: false, reason: 'fresh' })
    expect(fetchMock).not.toHaveBeenCalled()

    const pastBudget = new Date(NOW.getTime() + CATALYST_RUN_BUDGET_MS)
    await expect(refreshCatalystsForSymbol(env(store), 'BE', pastBudget))
      .resolves.toMatchObject({ ran: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    store.close()
  })

  it('lets exactly one of two concurrent looks buy the search', async () => {
    // Many readers on the public route, or attention and a reader at once, reach the claim
    // together. Deciding in one statement and writing in another let both see the same expired
    // receipt and both pay; the claim is one guarded upsert, so only one of them changes the row.
    const store = await storeWithCatalog()
    const fetchMock = stubExa()
    try {
      const results = await Promise.all([
        refreshCatalystsForSymbol(env(store), 'BE', NOW),
        refreshCatalystsForSymbol(env(store), 'BE', NOW),
      ])

      expect(results.filter((result) => result.ran)).toHaveLength(1)
      expect(results).toContainEqual({ catalysts: [], ran: false, reason: 'fresh' })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      store.close()
    }
  })

  it('reads a receipt whose timestamp will not parse as expired', async () => {
    // Text orders as time only in the fixed form this module writes. A receipt in any other form
    // must not compare above every cutoff and hold its symbol unsearchable for good.
    const store = await storeWithCatalog()
    const fetchMock = stubExa()
    try {
      await store.database.prepare(
        `INSERT INTO catalyst_runs (symbol, source_provider, ran_at, catalyst_count, status)
         VALUES ('BE', 'exa', 'not a timestamp', 0, 'complete')`,
      ).run()

      await expect(refreshCatalystsForSymbol(env(store), 'BE', NOW))
        .resolves.toMatchObject({ ran: true })
      expect(fetchMock).toHaveBeenCalledTimes(1)
    } finally {
      store.close()
    }
  })

  it('fails closed without the run store', async () => {
    await expect(refreshCatalystsForSymbol({}, 'BE', NOW)).rejects.toThrow('CatalystRunStoreUnavailable')
  })
})
