import { describe, expect, it, vi } from 'vitest'

import {
  catalystLabel,
  catalystSourceLink,
  hasNearTermCatalyst,
  MAX_CATALYSTS_PER_SYMBOL,
  nextCatalystsBySymbol,
  upcomingCatalystsForSymbol,
  type Catalyst,
} from '../src/domain/catalyst'
import {
  catalystsFromMarketMetrics,
  catalystUpsertStatements,
  earningsDateFromMetric,
  persistAndLoadCatalysts,
  persistResearchCatalysts,
  readUpcomingCatalysts,
  readUpcomingCatalystsForSymbol,
} from '../src/server/catalysts'
import { D1_MAX_BOUND_PARAMETERS } from '../src/server/d1-limits'
import { d1Result, unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

const NOW = new Date('2026-08-13T16:00:00.000Z')

describe('catalyst store reads', () => {
  it('carries at most the nearest events per symbol, however many a producer bound', async () => {
    // The store only grows, and members' agents write to it now, so "every upcoming row" is not
    // a size the snapshot can be left to inherit. What a symbol spends its budget on is its
    // nearest events; the far end of its calendar is what the cap drops.
    const store = await migrationStore()
    try {
      const crowded = Array.from({ length: MAX_CATALYSTS_PER_SYMBOL + 4 }, (_, index) => ({
        confidence: 'estimated' as const,
        date: `2026-09-${String(14 + index).padStart(2, '0')}`,
        id: `member-research:NVDA:investor-event:2026-09-${String(14 + index).padStart(2, '0')}`,
        kind: 'investor-event' as const,
        source: 'Member research · investors.example.com',
        sourceUrl: 'https://investors.example.com/events',
        symbol: 'NVDA',
        timing: 'unknown' as const,
        title: `NVDA event ${index}`,
        updatedAt: NOW.toISOString(),
      }))
      const other = {
        ...crowded[0]!,
        id: 'member-research:META:investor-event:2026-12-01',
        date: '2026-12-01',
        symbol: 'META',
        title: 'META event',
      }
      await store.database.batch(catalystUpsertStatements(
        store.database, 'member-research', [...crowded, other], NOW.toISOString(),
      ))

      const upcoming = await readUpcomingCatalysts({ DB: store.database }, ['NVDA', 'META'], NOW)
      const nvda = upcoming.filter((catalyst) => catalyst.symbol === 'NVDA')

      expect(nvda).toHaveLength(MAX_CATALYSTS_PER_SYMBOL)
      expect(nvda.map((catalyst) => catalyst.date)).toEqual(
        crowded.slice(0, MAX_CATALYSTS_PER_SYMBOL).map((catalyst) => catalyst.date),
      )
      // One symbol's crowded calendar never costs another symbol its place.
      expect(upcoming.filter((catalyst) => catalyst.symbol === 'META')).toHaveLength(1)
    } finally {
      store.close()
    }
  })

  it('counts events against the cap, not every producer\'s sighting of one', async () => {
    // Two producers seeing the same ten events write twenty rows. A cap on rows kept five
    // events and dropped the other five, which the reader's fold then could not bring back.
    const store = await migrationStore()
    try {
      const events = Array.from({ length: MAX_CATALYSTS_PER_SYMBOL + 2 }, (_, index) => {
        const date = `2026-09-${String(14 + index).padStart(2, '0')}`
        return {
          confidence: 'estimated' as const,
          date,
          id: `member-research:NVDA:investor-event:${date}`,
          kind: 'investor-event' as const,
          source: 'Member research · investors.example.com',
          sourceUrl: 'https://investors.example.com/events',
          symbol: 'NVDA',
          timing: 'unknown' as const,
          title: `NVDA event ${index}`,
          updatedAt: NOW.toISOString(),
        }
      })
      const env = { DB: store.database }
      await persistResearchCatalysts(env, 'member-research', events, NOW)
      await persistResearchCatalysts(env, 'exa', events.map((event) => ({
        ...event,
        id: event.id.replace('member-research:', 'exa:'),
        source: 'Exa search · investors.example.com',
      })), NOW)
      const nearest = events.slice(0, MAX_CATALYSTS_PER_SYMBOL).map((event) => event.date)

      for (const rows of [
        await readUpcomingCatalysts(env, ['NVDA'], NOW),
        await readUpcomingCatalystsForSymbol(env, 'NVDA', NOW),
      ]) {
        expect(rows).toHaveLength(MAX_CATALYSTS_PER_SYMBOL * 2)
        expect(upcomingCatalystsForSymbol('NVDA', rows, NOW).map((row) => row.date)).toEqual(nearest)
      }
    } finally {
      store.close()
    }
  })

  it('stays within the D1 parameter limit when refreshing one statement of symbols', async () => {
    const boundParameterCounts: number[] = []
    const batch = vi.fn(async () => [])
    const database: D1Database = {
      ...unsupportedDatabase(),
      batch,
      prepare: vi.fn(() => ({
        ...unsupportedStatement(),
        bind: (...values: unknown[]) => {
          boundParameterCounts.push(values.length)
          if (values.length > D1_MAX_BOUND_PARAMETERS) throw new Error('too many SQL variables')
          return {
            ...unsupportedStatement(),
            all: async () => d1Result([]),
          }
        },
      })),
    }

    const symbols = Array.from({ length: D1_MAX_BOUND_PARAMETERS }, (_, index) => `T${index}`)
    await expect(persistAndLoadCatalysts({ DB: database }, [], { answered: symbols, requested: symbols }, NOW)).resolves.toEqual([])

    expect(batch).toHaveBeenCalledOnce()
    // The delete binds one symbol each; the read that follows binds the market date, the
    // symbols as one JSON array, and the per-symbol cap.
    expect(boundParameterCounts).toEqual([D1_MAX_BOUND_PARAMETERS, 3])
  })
})

describe('tastytrade catalyst normalization', () => {
  it('extracts upcoming earnings and ignores dividend fields', () => {
    const catalysts = catalystsFromMarketMetrics([{
      symbol: 'NVDA',
      'updated-at': '2026-08-13T15:00:00Z',
      earnings: {
        estimated: true,
        visible: true,
        'expected-report-date': '2026-08-26',
        'time-of-day': 'After Market',
        'updated-at': '2026-08-12T20:00:00Z',
      },
      'dividend-ex-date': '2026-09-10',
      'dividend-pay-date': '2026-10-02',
      'dividend-updated-at': '2026-08-01T10:00:00Z',
    }], NOW)

    expect(catalysts).toMatchObject([
      { id: 'tastytrade:NVDA:earnings', date: '2026-08-26', timing: 'after-hours', confidence: 'estimated' },
    ])
    expect(earningsDateFromMetric({ earnings: { visible: true, 'expected-report-date': '2026-08-26' } }, NOW)).toBe('2026-08-26')
  })

  it('does not surface hidden or malformed dates', () => {
    expect(catalystsFromMarketMetrics([{
      symbol: 'AAPL',
      earnings: { visible: false, 'expected-report-date': '2026-02-31' },
    }], NOW)).toEqual([])
    expect(() => catalystsFromMarketMetrics([{
      symbol: 'AAPL',
      'updated-at': '2026-08-13T15:00:00Z',
      earnings: { visible: true, 'expected-report-date': '2026-02-31' },
    }], NOW)).toThrow('invalid-earnings-date')
  })

  it('rejects malformed provider timestamps instead of substituting observation time', () => {
    expect(() => catalystsFromMarketMetrics([{
      symbol: 'AAPL',
      'updated-at': 'not-a-timestamp',
      earnings: { visible: true, 'expected-report-date': '2026-08-26' },
    }], NOW)).toThrow('invalid-updated-at')
  })

  it('rejects a recent report date that has already passed', () => {
    expect(catalystsFromMarketMetrics([{
      symbol: 'AAPL',
      earnings: { visible: true, estimated: false, 'expected-report-date': '2026-07-30' },
    }], NOW)).toEqual([])
    expect(earningsDateFromMetric({
      earnings: { visible: true, 'expected-report-date': '2026-07-30' },
    }, NOW)).toBeNull()
  })

})

describe('when a symbol is worth searching', () => {
  const catalyst = (symbol: string, date: string): Catalyst => ({
    confidence: 'estimated',
    date,
    id: `exa:${symbol}:conference:${date}`,
    kind: 'conference',
    source: 'Exa search · example.com',
    sourceUrl: 'https://example.com/events',
    symbol,
    timing: 'unknown',
    title: `${symbol} conference`,
    updatedAt: NOW.toISOString(),
  })

  it('counts only what falls inside the next month, for that symbol', () => {
    const catalysts = [catalyst('NVDA', '2026-09-05'), catalyst('BE', '2026-11-30')]

    expect(hasNearTermCatalyst('NVDA', catalysts, NOW)).toBe(true)
    // Dated, but two months out: the reader still learns nothing about the coming weeks.
    expect(hasNearTermCatalyst('BE', catalysts, NOW)).toBe(false)
    expect(hasNearTermCatalyst('TSLA', catalysts, NOW)).toBe(false)
  })

  it('ignores a date that has already passed', () => {
    expect(hasNearTermCatalyst('NVDA', [catalyst('NVDA', '2026-08-01')], NOW)).toBe(false)
  })

  it('holds the boundary day and refuses the one after it', () => {
    expect(hasNearTermCatalyst('NVDA', [catalyst('NVDA', '2026-09-12')], NOW)).toBe(true)
    expect(hasNearTermCatalyst('NVDA', [catalyst('NVDA', '2026-09-13')], NOW)).toBe(false)
  })
})

describe('what a catalyst shows a reader', () => {
  const base = {
    date: '2026-10-14',
    kind: 'conference' as const,
    symbol: 'DELL' as const,
    timing: 'intraday' as const,
    title: 'Citi 2026 Global TMT Conference',
    updatedAt: '2026-09-01T13:00:00.000Z',
  }

  it('shows the host a date was read from, never the producer that wrote the row', () => {
    // Stored labels carry provenance like "Codex web · investors.delltechnologies.com".
    // A reader checking where a date came from is looking for the site, not for ours.
    expect(catalystSourceLink({
      ...base,
      confidence: 'estimated',
      id: 'daily-research:DELL:conference:2026-10-14',
      source: 'Codex web · Dell Technologies Investor Relations',
      sourceUrl: 'https://www.investors.delltechnologies.com/events',
    })).toEqual({ host: 'investors.delltechnologies.com', url: 'https://www.investors.delltechnologies.com/events' })
  })

  it('offers no link for the broker feed, whose source is an API specification', () => {
    expect(catalystSourceLink({
      ...base,
      confidence: 'confirmed',
      id: 'tastytrade:DELL:earnings',
      kind: 'earnings',
      source: 'tastytrade market metrics',
      sourceUrl: 'https://developer.tastytrade.com/open-api-spec/market-metrics/',
    })).toBeUndefined()
  })
})

describe('research catalyst storage', () => {
  it('holds every write to the citation envelope, while reads still admit older rows', async () => {
    const store = await migrationStore()
    try {
      const row: Catalyst = {
        confidence: 'estimated',
        date: '2026-09-15',
        id: 'exa:NVDA:conference:2026-09-15',
        kind: 'conference',
        source: 'Exa search · example.com',
        sourceUrl: `https://example.com/${'a'.repeat(2_000)}`,
        symbol: 'NVDA',
        timing: 'unknown',
        title: 'NVDA conference',
        updatedAt: NOW.toISOString(),
      }
      await expect(persistResearchCatalysts({ DB: store.database }, 'exa', [row], NOW)).rejects.toThrow()
      // A row stored before the bound existed is still read, rather than failing the snapshot.
      store.sqlite.prepare(
        `INSERT INTO catalysts (id, source_provider, symbol, kind, title, event_date, timing,
           confidence, source_label, source_url, updated_at, last_seen_at)
         VALUES (?, 'exa', 'NVDA', 'conference', ?, ?, 'unknown', 'estimated', ?, ?, ?, ?)`,
      ).run(row.id, row.title, row.date, row.source!, row.sourceUrl!, row.updatedAt, row.updatedAt)
      expect((await readUpcomingCatalystsForSymbol({ DB: store.database }, 'NVDA', NOW)).map((read) => read.id))
        .toEqual([row.id])
    } finally {
      store.close()
    }
  })

  it('fails when authoritative catalyst storage is unavailable', async () => {
    await expect(persistAndLoadCatalysts({}, [], { answered: [], requested: [] }, NOW)).rejects.toThrow('CatalystStoreUnavailable')
    await expect(persistResearchCatalysts({}, 'member-research', [], NOW)).rejects.toThrow('CatalystStoreUnavailable')
  })

  it('splits a large research write into statements under D1\'s bound-parameter limit', async () => {
    const boundParameterCounts: number[] = []
    let batchStatementCount = 0
    const batch = vi.fn(async (statements: D1PreparedStatement[]) => {
      batchStatementCount = statements.length
      return []
    })
    const database: D1Database = {
      ...unsupportedDatabase(),
      batch,
      prepare: vi.fn(() => ({
        ...unsupportedStatement(),
        bind: (...values: unknown[]) => {
          boundParameterCounts.push(values.length)
          if (values.length > D1_MAX_BOUND_PARAMETERS) throw new Error('too many SQL variables')
          return unsupportedStatement()
        },
      })),
    }
    const catalysts: Catalyst[] = Array.from({ length: 1_000 }, (_, index) => ({
      confidence: 'estimated',
      date: '2026-09-15',
      id: `member-research:T${index}:2026-09-15:investor-event`,
      kind: 'investor-event',
      source: 'Example Investor Relations',
      sourceUrl: `https://example.com/events/${index}`,
      symbol: `T${index}`,
      timing: 'unknown',
      title: `T${index} investor event`,
      updatedAt: NOW.toISOString(),
    }))

    await persistResearchCatalysts({ DB: database }, 'member-research', catalysts, NOW)

    expect(batch).toHaveBeenCalledOnce()
    // 1,000 rows bound at more than one column each cannot fit one statement under the limit,
    // so a single batch call splitting into several statements is what proves the split happened.
    expect(batchStatementCount).toBeGreaterThan(1)
    expect(Math.max(...boundParameterCounts)).toBeLessThanOrEqual(D1_MAX_BOUND_PARAMETERS)
  })
})

describe('catalyst ordering', () => {
  const catalyst = (symbol: string, date: string): Catalyst => ({
    id: `tastytrade:${symbol}:earnings`,
    symbol,
    kind: 'earnings',
    title: `${symbol} earnings`,
    date,
    timing: 'unknown',
    confidence: 'estimated',
    source: 'tastytrade market metrics',
    sourceUrl: 'https://developer.tastytrade.com/open-api-spec/market-metrics/',
    updatedAt: NOW.toISOString(),
  })

  it('indexes the nearest upcoming catalyst and ignores past dates', () => {
    const catalysts = [catalyst('AAPL', '2026-10-29'), catalyst('NVDA', '2026-08-26')]
    expect(nextCatalystsBySymbol(catalysts, NOW).get('NVDA')?.date).toBe('2026-08-26')
    expect(catalystLabel(catalysts[1]!, NOW)).toBe('EARN 13D')
    expect(nextCatalystsBySymbol([catalyst('NVDA', '2026-08-12')], NOW).has('NVDA')).toBe(false)
  })
})

describe('one event that several producers saw', () => {
  // The pair the live surface showed: tastytrade's confirmed earnings row for INTC, and the
  // Exa search a reader spent on the same symbol binding the very same date from a page that
  // calls it projected. Two rows, one event, and the runway drew both.
  const broker: Catalyst = {
    confidence: 'confirmed',
    date: '2026-10-22',
    id: 'tastytrade:INTC:earnings',
    kind: 'earnings',
    source: 'tastytrade market metrics',
    sourceUrl: 'https://developer.tastytrade.com/open-api-spec/market-metrics/',
    symbol: 'INTC',
    timing: 'unknown',
    title: 'INTC earnings',
    updatedAt: '2026-08-28T02:15:52.966Z',
  }
  const searched: Catalyst = {
    confidence: 'estimated',
    date: '2026-10-22',
    description: 'Projected date for Q3 2026 earnings report.',
    id: 'exa:INTC:earnings:2026-10-22',
    kind: 'earnings',
    source: 'Exa search · nextearningsdate.com',
    sourceUrl: 'https://www.nextearningsdate.com/intc.html',
    symbol: 'INTC',
    timing: 'after-hours',
    title: 'Q3 2026 Earnings Report',
    updatedAt: '2026-09-21T17:54:02.486Z',
  }
  const NOW = new Date('2026-09-21T18:00:00.000Z')

  it('draws the runway once, on the row that can say the date is confirmed', () => {
    expect(upcomingCatalystsForSymbol('INTC', [searched, broker], NOW)).toEqual([broker])
    // Whole rows, never a splice: the search's after-hours timing does not reappear beside a
    // confidence that came from the broker, under a link to a page that calls the date
    // projected.
    expect(upcomingCatalystsForSymbol('INTC', [broker, searched], NOW)).toEqual([broker])
  })

  it('shows the list the same row the runway opens with', () => {
    expect(nextCatalystsBySymbol([searched, broker], NOW).get('INTC')).toEqual(broker)
  })

  it('prefers the more recent sighting when neither producer can confirm', () => {
    const stale: Catalyst = {
      ...searched,
      id: 'member-research:INTC:earnings:2026-10-22',
      source: 'Member research · example.com',
      sourceUrl: 'https://example.com/ir',
      title: 'Intel Q3 results',
      updatedAt: '2026-09-02T09:00:00.000Z',
    }
    expect(upcomingCatalystsForSymbol('INTC', [stale, searched], NOW)).toEqual([searched])
  })

  it('keeps two producers that disagree on the date as the two claims they are', () => {
    const moved: Catalyst = { ...searched, date: '2026-10-23', id: 'exa:INTC:earnings:2026-10-23' }
    expect(upcomingCatalystsForSymbol('INTC', [moved, broker], NOW).map((row) => row.date))
      .toEqual(['2026-10-22', '2026-10-23'])
  })
})

describe('a producer that looked again', () => {
  const NOW = new Date('2026-09-21T18:00:00.000Z')
  const FIRST_RUN = new Date('2026-08-21T18:00:00.000Z')

  /** What `claimRun` leaves behind: the receipt that says this producer answers for this name. */
  function seedRun(store: SqliteD1Store, symbol: string, provider: string): void {
    store.sqlite.prepare(
      `INSERT INTO catalyst_runs (symbol, source_provider, ran_at, catalyst_count, status)
       VALUES (?, ?, ?, 0, 'complete')`,
    ).run(symbol, provider, FIRST_RUN.toISOString())
  }

  const searched = (kind: Catalyst['kind'], date: string, title: string): Catalyst => ({
    confidence: 'estimated',
    date,
    id: `exa:INTC:${kind}:${date}`,
    kind,
    source: 'Exa search · example.com',
    sourceUrl: 'https://example.com/events',
    symbol: 'INTC',
    timing: 'unknown',
    title,
    updatedAt: NOW.toISOString(),
  })

  it('retires its own moved date without touching what it did not answer again', async () => {
    const store = await migrationStore()
    try {
      const env = { DB: store.database }
      seedRun(store, 'INTC', 'exa')
      // A first search finds the earnings date and two conferences.
      await persistResearchCatalysts(env, 'exa', [
        searched('earnings', '2026-10-22', 'Q3 2026 earnings'),
        searched('conference', '2026-11-05', 'Citi TMT'),
        searched('conference', '2026-11-06', 'UBS Tech'),
      ], FIRST_RUN)
      // A month later it searches again and reports the earnings a day later. It says nothing
      // about the conferences, which is silence rather than a retraction.
      await persistResearchCatalysts(env, 'exa', [searched('earnings', '2026-10-23', 'Q3 2026 earnings')], NOW)

      const upcoming = await readUpcomingCatalystsForSymbol(env, 'INTC', NOW)

      expect(upcoming.map((row) => row.date)).toEqual(['2026-10-23', '2026-11-05', '2026-11-06'])
      // The row is retired from the read, not deleted: it stays answerable to its producer.
      expect(store.sqlite.prepare('SELECT COUNT(*) AS rows FROM catalysts WHERE symbol = ?').get('INTC'))
        .toEqual({ rows: 4 })
    } finally {
      store.close()
    }
  })

  it('leaves what another producer reports standing, and says it to every reader', async () => {
    const store = await migrationStore()
    try {
      const env = { DB: store.database }
      seedRun(store, 'INTC', 'exa')
      await persistResearchCatalysts(env, 'exa', [searched('earnings', '2026-10-22', 'Q3 2026 earnings')], FIRST_RUN)
      await persistResearchCatalysts(env, 'member-research', [{
        ...searched('earnings', '2026-10-22', 'Intel Q3 results'),
        id: 'member-research:INTC:earnings:2026-10-22',
      }], FIRST_RUN)
      await persistResearchCatalysts(env, 'exa', [searched('earnings', '2026-10-23', 'Q3 2026 earnings')], NOW)

      // One producer moving its own estimate says nothing about what another producer reports.
      expect((await readUpcomingCatalystsForSymbol(env, 'INTC', NOW)).map((row) => row.id))
        .toEqual(['member-research:INTC:earnings:2026-10-22', 'exa:INTC:earnings:2026-10-23'])
      expect((await readUpcomingCatalysts(env, ['INTC'], NOW)).map((row) => row.id))
        .toEqual(['member-research:INTC:earnings:2026-10-22', 'exa:INTC:earnings:2026-10-23'])
    } finally {
      store.close()
    }
  })

  it('never lets a superseded run that lands last move a sighting backwards', async () => {
    // An attention search claimed at LATE_START is still in flight when the owner forces a newer
    // one at NOW that finishes first; the older run's persist then arrives last.
    const LATE_START = new Date('2026-09-21T17:59:00.000Z')
    const store = await migrationStore()
    try {
      const env = { DB: store.database }
      seedRun(store, 'INTC', 'exa')
      await persistResearchCatalysts(env, 'exa', [
        searched('earnings', '2026-10-23', 'Q3 2026 earnings'),
        searched('conference', '2026-11-05', 'Citi TMT'),
      ], NOW)
      await persistResearchCatalysts(env, 'exa', [
        { ...searched('earnings', '2026-10-23', 'stale title'), updatedAt: LATE_START.toISOString() },
      ], LATE_START)

      const upcoming = await readUpcomingCatalystsForSymbol(env, 'INTC', NOW)
      // The newer run's rows all still stand, and the late run's fields did not replace them.
      expect(upcoming.map((row) => [row.date, row.title])).toEqual([
        ['2026-10-23', 'Q3 2026 earnings'],
        ['2026-11-05', 'Citi TMT'],
      ])
      expect(store.sqlite.prepare('SELECT last_seen_at FROM catalysts WHERE id = ?').get('exa:INTC:earnings:2026-10-23'))
        .toEqual({ last_seen_at: NOW.toISOString() })
    } finally {
      store.close()
    }
  })

  it('never lets one member retire what another member recorded', async () => {
    // `member-research` is not one voice: every member's agent writes under it. A second member
    // recording a conference is not the first one looking again, so nothing of theirs is
    // superseded -- which is why this is gated on a run receipt rather than on the label.
    const store = await migrationStore()
    try {
      const env = { DB: store.database }
      const recorded = (date: string, title: string): Catalyst => ({
        ...searched('conference', date, title),
        id: `member-research:INTC:conference:${date}`,
      })
      await persistResearchCatalysts(env, 'member-research', [recorded('2026-11-05', 'Citi TMT')], FIRST_RUN)
      await persistResearchCatalysts(env, 'member-research', [recorded('2026-11-06', 'UBS Tech')], NOW)

      expect((await readUpcomingCatalystsForSymbol(env, 'INTC', NOW)).map((row) => row.date))
        .toEqual(['2026-11-05', '2026-11-06'])
    } finally {
      store.close()
    }
  })
})
