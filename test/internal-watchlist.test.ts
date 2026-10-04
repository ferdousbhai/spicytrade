import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  ensureInternalWatchlistSymbols,
  readInternalWatchlist,
  readInternalWatchlistCatalogCandidates,
  readInternalWatchlistFocus,
  readInternalWatchlistSymbolDetails,
  removeInternalWatchlistSymbols,
} from '../src/server/internal-watchlist'
import { MAX_WATCHLIST_SYMBOLS } from '../src/domain/watchlist'
import {
  instrumentCatalogFromPayload,
  persistInstrumentCatalog,
} from '../src/server/instrument-catalog'
import { publishInternalWatchlistUniverse } from '../src/server/public-market-universe'
import {
  migrationStore,
  seededItems,
  seedWatchlist,
  type SeededWatchlistSource,
  type SqliteD1Store,
} from './sqlite-d1'
import { symbolAt } from './symbols'

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => store.close())

/** The retained broker lists the provenance reads and the ranking join against. */
const LISTS: SeededWatchlistSource[] = [
  {
    kind: 'private',
    name: 'Long vol',
    metadata: { name: 'Long vol', 'group-name': 'recommendations', 'order-index': 7, custom: { color: 'orange' } },
    entries: [
      { symbol: 'NVDA', metadata: { symbol: 'NVDA', 'instrument-type': 'Equity', note: 'core' } },
      { symbol: 'NVDA  260918C00225000', instrumentType: 'Equity Option' },
    ],
  },
  {
    kind: 'public',
    name: 'Public movers',
    entries: [
      { symbol: 'NVDA', metadata: { symbol: 'NVDA', 'instrument-type': 'Equity', rank: 3 } },
      { symbol: 'PLTR', metadata: { symbol: 'PLTR', 'instrument-type': 'Equity', rank: 8 } },
    ],
  },
]

/** The maintained items those lists produced: each equity, carrying the ids of its lists. */
function seedLists(): void {
  seedWatchlist(store, [
    { symbol: 'NVDA', metadata: { seedSourceIds: ['tastytrade-private-0', 'tastytrade-public-0'] } },
    { symbol: 'PLTR', metadata: { seedSourceIds: ['tastytrade-public-0'] } },
  ], LISTS)
}

describe('a database without the one-time seed', () => {
  it('serves and grows the live list rather than refusing it as unseeded', async () => {
    const env = { DB: store.database }
    await expect(readInternalWatchlist(env)).resolves.toEqual([])
    await expect(readInternalWatchlistCatalogCandidates(env)).resolves.toEqual([])
    await expect(ensureInternalWatchlistSymbols(env, ['NVDA'], 'owner')).resolves.toEqual(['NVDA'])
    await expect(readInternalWatchlistFocus(env)).resolves.toEqual(['NVDA'])
    await expect(removeInternalWatchlistSymbols(env, ['NVDA'])).resolves.toEqual(['NVDA'])
  })
})

describe('the maintained watchlist', () => {
  it('reads each symbol with every retained list and entry field it came from', async () => {
    const env = { DB: store.database }
    seedLists()

    expect((await readInternalWatchlist(env)).map((item) => item.symbol)).toEqual(['NVDA', 'PLTR'])
    await expect(readInternalWatchlistSymbolDetails(env, 'NVDA')).resolves.toMatchObject({
      symbol: 'NVDA',
      metadata: { seedSourceIds: ['tastytrade-private-0', 'tastytrade-public-0'] },
      seedMemberships: [
        {
          sourceKind: 'private',
          sourceName: 'Long vol',
          sourceMetadata: { 'group-name': 'recommendations', 'order-index': 7, custom: { color: 'orange' } },
          entryMetadata: { note: 'core' },
        },
        { sourceKind: 'public', sourceName: 'Public movers', entryMetadata: { rank: 3 } },
      ],
    })
  })

  it('selects a bounded metrics focus without returning its private priority metadata', async () => {
    const env = { DB: store.database }
    seedLists()
    await ensureInternalWatchlistSymbols(env, ['ZZZ'], 'owner', new Date('2026-08-26T11:00:00.000Z'))

    const focus = await readInternalWatchlistFocus(env, 2)

    expect(focus).toEqual(['ZZZ', 'NVDA'])
    expect(JSON.stringify(focus)).not.toContain('private')
    expect(JSON.stringify(focus)).not.toContain('tastytrade')
  })

  it('uses retained high-options-volume order only after personal symbols', async () => {
    const env = { DB: store.database }
    const volume = ['TSLA', 'AAPL', 'PLTR']
    seedWatchlist(store, seededItems(['AAPL', 'NVDA', 'PLTR', 'TSLA']), [
      { kind: 'private', name: 'Long vol', entries: [{ symbol: 'NVDA' }] },
      { kind: 'public', name: 'High Options Volume', entries: volume.map((symbol) => ({ symbol })) },
    ])
    await persistInstrumentCatalog(env, instrumentCatalogFromPayload(
      volume.map((symbol) => ({ active: true, 'instrument-type': 'Equity', symbol })),
      volume,
    ))
    await ensureInternalWatchlistSymbols(env, ['MSFT'], 'owner', new Date('2026-08-25T10:00:00.000Z'))
    await ensureInternalWatchlistSymbols(env, ['GOOG'], 'trade-intent', new Date('2026-08-25T10:00:00.000Z'))

    await expect(readInternalWatchlistFocus(env, 4)).resolves.toEqual(['MSFT', 'GOOG', 'NVDA', 'TSLA'])
  })

  it('keeps a searched curated name in its curated tier', async () => {
    // A search overwrites a seed row's origin; the ranking used to read that origin first and
    // dropped a private-list name below every volume member and beside any other search.
    const env = { DB: store.database }
    seedWatchlist(store, seededItems(['AAPL', 'NVDA', 'PLTR', 'TSLA']), [
      { kind: 'private', name: 'Long vol', entries: [{ symbol: 'NVDA' }] },
      { kind: 'public', name: 'High Options Volume', entries: [{ symbol: 'TSLA' }] },
    ])
    await persistInstrumentCatalog(env, instrumentCatalogFromPayload(
      [{ active: true, 'instrument-type': 'Equity', symbol: 'TSLA' }],
      ['TSLA'],
    ))
    await ensureInternalWatchlistSymbols(env, ['NVDA', 'PLTR'], 'visitor-search', new Date('2026-08-27T10:00:00.000Z'))
    await expect(readInternalWatchlistSymbolDetails(env, 'NVDA')).resolves.toMatchObject({ origin: 'visitor-search' })

    // Private list, then volume, then the search that earned its place, then the plain seed.
    await expect(readInternalWatchlistFocus(env)).resolves.toEqual(['NVDA', 'TSLA', 'PLTR', 'AAPL'])
  })

  // The prune and the focus used to rank separately, and only the focus capped the volume list at
  // `MAX_WATCHLIST_SYMBOLS`: a seed member ranked past it kept its volume tier in the prune and
  // lost it in the focus, where it fell behind a seed member with no volume rank at all.
  it('ranks a volume member past the list bound the same way in the prune and the focus', async () => {
    const env = { DB: store.database }
    const volume = Array.from({ length: MAX_WATCHLIST_SYMBOLS + 1 }, (_, index) => symbolAt(index))
    const deepVolume = volume.at(-1)!
    seedWatchlist(store, [
      { symbol: deepVolume },
      { symbol: 'ZZZZ', updatedAt: '2026-08-27T10:00:00.000Z' },
    ], [{ kind: 'public', name: 'High Options Volume', entries: volume.map((symbol) => ({ symbol })) }])
    await persistInstrumentCatalog(env, instrumentCatalogFromPayload(
      volume.map((symbol) => ({ active: true, 'instrument-type': 'Equity', symbol })),
      volume,
    ))

    await expect(readInternalWatchlistFocus(env, 1)).resolves.toEqual([deepVolume])
    // An addition runs the prune in the same batch; it ranks the same way and drops nothing.
    await ensureInternalWatchlistSymbols(env, ['MSFT'], 'owner')
    await expect(readInternalWatchlistFocus(env, 2)).resolves.toEqual(['MSFT', deepVolume])
  })

  it('prunes only the maintained list and does not repopulate an explicit deletion', async () => {
    const symbols = Array.from({ length: MAX_WATCHLIST_SYMBOLS }, (_, index) => symbolAt(index))
    const owned = ['ZZZA', 'ZZZB', 'ZZZC']
    const env = { DB: store.database }
    // The newest seed members rank first among equals, so the oldest are the ones a prune drops.
    seedWatchlist(store, symbols.map((symbol, index) => ({
      symbol, updatedAt: new Date(Date.UTC(2026, 7, 26, 0, 0, symbols.length - index)).toISOString(),
    })), [{ kind: 'private', name: 'Legacy private list', entries: symbols.map((symbol) => ({ symbol })) }])

    await expect(ensureInternalWatchlistSymbols(env, owned, 'owner')).resolves.toEqual(owned)
    const items = await readInternalWatchlist(env)
    expect(items).toHaveLength(MAX_WATCHLIST_SYMBOLS)
    expect(items.map((item) => item.symbol)).toEqual(expect.not.arrayContaining(symbols.slice(-owned.length)))
    // The prune drops live membership only; the retained seed stays whole.
    expect(store.sqlite.prepare('SELECT count(*) AS count FROM internal_watchlist_seed_entries').get())
      .toEqual({ count: MAX_WATCHLIST_SYMBOLS })
    await expect(readInternalWatchlistCatalogCandidates(env)).resolves.toHaveLength(MAX_WATCHLIST_SYMBOLS)

    await removeInternalWatchlistSymbols(env, [symbols[0]!])
    await ensureInternalWatchlistSymbols(env, ['ZZZD'], 'owner')
    await expect(readInternalWatchlistFocus(env, MAX_WATCHLIST_SYMBOLS))
      .resolves.toEqual(expect.not.arrayContaining([symbols[0]!]))
    expect(await readInternalWatchlist(env)).toHaveLength(MAX_WATCHLIST_SYMBOLS)
  })

  it('keeps the retained seed as catalog candidates after an explicit deletion', async () => {
    const env = { DB: store.database }
    seedLists()
    await expect(readInternalWatchlistSymbolDetails(env, 'PLTR')).resolves.toMatchObject({
      origin: 'tastytrade-seed',
      metadata: { seedSourceIds: ['tastytrade-public-0'] },
      seedMemberships: [{ sourceKind: 'public', sourceName: 'Public movers' }],
    })
    await removeInternalWatchlistSymbols(env, ['PLTR'])
    expect((await readInternalWatchlist(env)).some((item) => item.symbol === 'PLTR')).toBe(false)
    await expect(readInternalWatchlistCatalogCandidates(env)).resolves.toEqual(['NVDA', 'PLTR'])
  })

  it('offers exactly the seed entries the symbol grammar admits, and throws on none it does not', async () => {
    const env = { DB: store.database }
    seedWatchlist(store, [], [{
      kind: 'public',
      name: 'Mixed notation',
      entries: [
        'BRK/B', 'brk/a', '1810', 'BF.B', 'ABCDEFGH', '/ES', 'AAPL',
        // The widest shape the grammar admits, and each way past its bounds.
        'ABCDEF/XYZ', 'ABCDEFG', 'ABC/WXYZ', 'ABC/', 'A/B/C', 'A//B', 'ÄPPL',
      ].map((symbol) => ({ symbol })),
    }])
    await expect(readInternalWatchlistCatalogCandidates(env)).resolves.toEqual(['1810', 'AAPL', 'ABCDEF/XYZ', 'BRK/A', 'BRK/B'])
  })

  it('reads the largest item metadata the importer could write, and refuses anything larger', async () => {
    const env = { DB: store.database }
    // Every list of both kinds at the importer's per-kind ceiling of 100 names the symbol.
    const seedSourceIds = (['private', 'public'] as const)
      .flatMap((kind) => Array.from({ length: 100 }, (_, index) => `tastytrade-${kind}-${index}`))
    seedWatchlist(store, [{ symbol: 'NVDA', metadata: { seedSourceIds } }])
    await expect(readInternalWatchlist(env)).resolves.toMatchObject([{ metadata: { seedSourceIds } }])

    store.sqlite.prepare('UPDATE internal_watchlist_items SET metadata_json = ?')
      .run(JSON.stringify({ seedSourceIds, extra: 'x' }))
    await expect(readInternalWatchlist(env)).rejects.toThrow()
  })

  it('promotes an existing public-seed member without losing retained seed provenance', async () => {
    const env = { DB: store.database }
    seedLists()

    await ensureInternalWatchlistSymbols(env, ['PLTR'], 'owner', new Date('2026-08-26T11:00:00.000Z'))

    await expect(readInternalWatchlistSymbolDetails(env, 'PLTR')).resolves.toMatchObject({
      origin: 'owner',
      seedMemberships: [{ sourceKind: 'public', sourceName: 'Public movers' }],
      updatedAt: '2026-08-26T11:00:00.000Z',
    })

    await ensureInternalWatchlistSymbols(env, ['PLTR'], 'trade-intent', new Date('2026-08-26T12:00:00.000Z'))
    await expect(readInternalWatchlistSymbolDetails(env, 'PLTR')).resolves.toMatchObject({
      origin: 'owner',
      updatedAt: '2026-08-26T11:00:00.000Z',
    })
  })

  it('applies the canonical origin order without allowing a downgrade', async () => {
    const env = { DB: store.database }
    seedLists()
    const origins = [
      'visitor-search',
      'agent-discussion',
      'trade-intent',
      'owner',
    ] as const

    for (const [index, origin] of origins.entries()) {
      await ensureInternalWatchlistSymbols(
        env,
        ['PLTR'],
        origin,
        new Date(`2026-08-27T10:0${index}:00.000Z`),
      )
      await expect(readInternalWatchlistSymbolDetails(env, 'PLTR')).resolves.toMatchObject({ origin })
    }

    for (const origin of [...origins].reverse()) {
      await ensureInternalWatchlistSymbols(env, ['PLTR'], origin)
      await expect(readInternalWatchlistSymbolDetails(env, 'PLTR')).resolves.toMatchObject({ origin: 'owner' })
    }
  })

  it('reads a stored position-sync row but refuses to write that origin', async () => {
    // Only the removed finalization wrote `position-sync`; rows it wrote stay readable and
    // outrank a discussion, and no live caller may mint a new one.
    const env = { DB: store.database }
    seedWatchlist(store, [{ symbol: 'NVDA', origin: 'position-sync' }])
    await ensureInternalWatchlistSymbols(env, ['NVDA'], 'agent-discussion')
    await expect(readInternalWatchlistSymbolDetails(env, 'NVDA')).resolves.toMatchObject({ origin: 'position-sync' })
    // SAFETY: the cast forges exactly the input the type forbids, to prove the runtime refuses it.
    await expect(ensureInternalWatchlistSymbols(env, ['PLTR'], 'position-sync' as 'owner')).rejects.toThrow()
    // SAFETY: as above, a forged seed origin the type forbids, to prove the runtime refuses it.
    await expect(ensureInternalWatchlistSymbols(env, ['PLTR'], 'tastytrade-seed' as 'owner')).rejects.toThrow()
  })

  it('reads a stored scheduled-research row but refuses to write that origin', async () => {
    // No live path writes `scheduled-research`; rows a retired run wrote stay readable and
    // protected, a stronger live origin still promotes them, and no caller may mint a new one.
    const env = { DB: store.database }
    seedWatchlist(store, [{ symbol: 'NVDA', origin: 'scheduled-research' }])
    await expect(readInternalWatchlistSymbolDetails(env, 'NVDA')).resolves.toMatchObject({ origin: 'scheduled-research' })
    await ensureInternalWatchlistSymbols(env, ['NVDA'], 'trade-intent')
    await expect(readInternalWatchlistSymbolDetails(env, 'NVDA')).resolves.toMatchObject({ origin: 'trade-intent' })
    // SAFETY: the cast forges exactly the input the type forbids, to prove the runtime refuses it.
    await expect(ensureInternalWatchlistSymbols(env, ['PLTR'], 'scheduled-research' as 'owner')).rejects.toThrow()
  })

  it('never downgrades owner provenance or publishes an addition discarded by the cap', async () => {
    const env = { DB: store.database }
    seedLists()
    const ownerSymbols = Array.from({ length: MAX_WATCHLIST_SYMBOLS }, (_, index) => symbolAt(index))
    await expect(ensureInternalWatchlistSymbols(env, [...ownerSymbols, 'ZZZ'], 'owner'))
      .rejects.toThrow('too-many-symbols')
    await expect(ensureInternalWatchlistSymbols(env, ownerSymbols, 'owner'))
      .resolves.toHaveLength(MAX_WATCHLIST_SYMBOLS)

    await expect(ensureInternalWatchlistSymbols(env, ['A'], 'trade-intent'))
      .resolves.toEqual(['A'])
    await expect(ensureInternalWatchlistSymbols(env, ['ZZZ'], 'trade-intent'))
      .resolves.toEqual([])
    await expect(ensureInternalWatchlistSymbols(env, ['ZZZ'], 'owner'))
      .resolves.toEqual([])

    const items = await readInternalWatchlist(env)
    expect(items).toHaveLength(MAX_WATCHLIST_SYMBOLS)
    expect(items.find((item) => item.symbol === 'A')?.origin).toBe('owner')
    expect(items.some((item) => item.symbol === 'ZZZ')).toBe(false)
    const publicRow = store.sqlite.prepare(
      `SELECT payload_json FROM public_market_universe WHERE id = 'primary'`,
    ).get()
    expect(publicRow).toBeDefined()
    expect(JSON.parse(String(publicRow?.payload_json))).toEqual({ symbols: items.map((item) => item.symbol) })
  })
})

describe('a list full of reader searches', () => {
  it('admits a protected addition by evicting a search instead of refusing it', async () => {
    // Admission and the prune must agree on what is evictable: a search the prune would drop
    // cannot be allowed to hold a protected slot against an owner or trade-intent addition.
    const env = { DB: store.database }
    // With no seed member on the list, searches alone fill it to its bound. They are written
    // directly: one search per call would be `MAX_WATCHLIST_SYMBOLS` sequential batches, and the
    // behavior under test is admission against a full list, not how it filled.
    const searched = Array.from({ length: MAX_WATCHLIST_SYMBOLS }, (_, index) => symbolAt(index))
    seedWatchlist(store, searched.map((symbol, index) => ({
      symbol, origin: 'visitor-search', updatedAt: new Date(Date.UTC(2026, 7, 27, 0, 0, index)).toISOString(),
    })))
    const full = await readInternalWatchlist(env)
    expect(full).toHaveLength(MAX_WATCHLIST_SYMBOLS)
    expect(full.every((item) => item.origin === 'visitor-search')).toBe(true)

    await expect(ensureInternalWatchlistSymbols(env, ['ZZZ'], 'owner')).resolves.toEqual(['ZZZ'])
    await expect(ensureInternalWatchlistSymbols(env, ['ZZY'], 'trade-intent')).resolves.toEqual(['ZZY'])
    // Promoting a search to a protected origin takes a protected slot too, and is admitted.
    await expect(ensureInternalWatchlistSymbols(env, [searched[0]!], 'owner')).resolves.toEqual([searched[0]])

    const items = await readInternalWatchlist(env)
    expect(items).toHaveLength(MAX_WATCHLIST_SYMBOLS)
    expect(items.find((item) => item.symbol === 'ZZZ')?.origin).toBe('owner')
    expect(items.find((item) => item.symbol === 'ZZY')?.origin).toBe('trade-intent')
    expect(items.find((item) => item.symbol === searched[0])?.origin).toBe('owner')
    expect(items.filter((item) => item.origin === 'visitor-search')).toHaveLength(MAX_WATCHLIST_SYMBOLS - 3)
  })
})

describe("a member agent's remembered names", () => {
  // Any signed-in member can call `remember_symbols` with a whole list's worth of names. Were
  // `agent-discussion` protected, that flood would fill the protected capacity and refuse every
  // later owner and trade-intent addition.
  it('cannot fill the list against an owner or trade-intent addition', async () => {
    const env = { DB: store.database }
    const flooded = Array.from({ length: MAX_WATCHLIST_SYMBOLS }, (_, index) => symbolAt(index))
    await expect(ensureInternalWatchlistSymbols(env, flooded, 'agent-discussion'))
      .resolves.toHaveLength(MAX_WATCHLIST_SYMBOLS)

    await expect(ensureInternalWatchlistSymbols(env, ['ZZZ'], 'owner')).resolves.toEqual(['ZZZ'])
    await expect(ensureInternalWatchlistSymbols(env, ['ZZY'], 'trade-intent')).resolves.toEqual(['ZZY'])

    const items = await readInternalWatchlist(env)
    expect(items).toHaveLength(MAX_WATCHLIST_SYMBOLS)
    expect(items.find((item) => item.symbol === 'ZZZ')?.origin).toBe('owner')
    expect(items.find((item) => item.symbol === 'ZZY')?.origin).toBe('trade-intent')
    expect(items.filter((item) => item.origin === 'agent-discussion')).toHaveLength(MAX_WATCHLIST_SYMBOLS - 2)
  })

  it('cannot demote a protected row to a prunable one by naming it', async () => {
    const env = { DB: store.database }
    // Scheduled research is the weakest protected origin, and so the one a discussion once
    // outranked. No live path writes it any more, so the stored row is inserted directly.
    seedWatchlist(store, [{ symbol: 'NVDA', origin: 'scheduled-research' }])
    await ensureInternalWatchlistSymbols(env, ['NVDA'], 'agent-discussion')
    await expect(readInternalWatchlistSymbolDetails(env, 'NVDA')).resolves.toMatchObject({ origin: 'scheduled-research' })
  })

  it('outranks reader searches in the prune, and yields to curated names', async () => {
    const env = { DB: store.database }
    // The searches are the most recently touched, so only the tier can put the discussed names
    // ahead of them; the private-list seed row is the oldest and outranks both.
    const searched = Array.from({ length: MAX_WATCHLIST_SYMBOLS - 1 }, (_, index) => symbolAt(index))
    seedWatchlist(store, [
      { symbol: 'ZZZA', updatedAt: '2026-08-01T00:00:00.000Z' },
      ...searched.map((symbol) => ({ symbol, origin: 'visitor-search' as const, updatedAt: '2026-08-27T00:00:00.000Z' })),
    ], [{ kind: 'private', name: 'Long vol', entries: [{ symbol: 'ZZZA' }] }])

    await expect(ensureInternalWatchlistSymbols(env, ['ZZZB', 'ZZZC'], 'agent-discussion', new Date('2026-08-02T00:00:00.000Z')))
      .resolves.toEqual(['ZZZB', 'ZZZC'])

    const items = await readInternalWatchlist(env)
    expect(items).toHaveLength(MAX_WATCHLIST_SYMBOLS)
    expect(items.some((item) => item.symbol === 'ZZZA')).toBe(true)
    expect(items.filter((item) => item.origin === 'visitor-search')).toHaveLength(MAX_WATCHLIST_SYMBOLS - 3)
    await expect(readInternalWatchlistFocus(env, 3)).resolves.toEqual(['ZZZA', 'ZZZB', 'ZZZC'])
  })
})

describe('delisted names', () => {
  it('keeps a name the broker no longer trades off the public universe', async () => {
    const env = { DB: store.database }
    seedWatchlist(store, seededItems(['ATVI', 'BE']))
    // ATVI was acquired: the catalog still carries the row, and must, because a citation or a
    // held position may still need to resolve it. It just may not be offered to a reader.
    await persistInstrumentCatalog(env, [
      ...instrumentCatalogFromPayload([
        { active: false, description: 'Activision Blizzard', 'instrument-type': 'Equity', symbol: 'ATVI' },
        { active: true, description: 'Bloom Energy', 'instrument-type': 'Equity', symbol: 'BE' },
      ], ['ATVI', 'BE']),
    ])

    await publishInternalWatchlistUniverse(env)
    const stored = store.sqlite
      .prepare("SELECT payload_json FROM public_market_universe WHERE id='primary'").get()
    const published = z.object({ symbols: z.array(z.string()) })
      .parse(JSON.parse(z.object({ payload_json: z.string() }).parse(stored).payload_json))
      .symbols
    expect(published).toContain('BE')
    expect(published).not.toContain('ATVI')
    // Still on the maintained list -- excluded from readers, not deleted from the record.
    expect((await readInternalWatchlist(env)).map((item) => item.symbol)).toContain('ATVI')
  })
})
