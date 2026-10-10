import { describe, expect, it, vi } from 'vitest'

import { CATALYST_HORIZON_DAYS } from '../src/domain/catalyst'
import { addDays } from '../src/domain/iso-date'
import { readUpcomingCatalysts } from '../src/server/catalysts'
import {
  readCatalysts,
} from '../src/server/research-read-tools'
import { persistResearchCatalysts } from '../src/server/catalysts'
import { unsupportedDatabase, unsupportedStatement } from './fake-d1'
import { migrationStore } from './sqlite-d1'

function d1WithResults(results: unknown[]) {
  const all = vi.fn().mockResolvedValue({ results })
  const bind = vi.fn(() => ({ ...unsupportedStatement(), all }))
  // The search receipts are a second read; these fakes have none, so every symbol is unsearched.
  const noRuns = { ...unsupportedStatement(), bind: () => ({ ...unsupportedStatement(), all: vi.fn().mockResolvedValue({ results: [] }) }) }
  const prepare = vi.fn((sql: string) => sql.includes('status AS state') ? noRuns : { ...unsupportedStatement(), bind })
  const DB: D1Database = { ...unsupportedDatabase(), prepare }
  return { bind, env: { DB }, prepare }
}

describe('research read tools', () => {
  it('queries bounded symbols for catalyst results', async () => {
    const catalyst = {
      id: 'tastytrade:NVDA:earnings', symbol: 'NVDA', kind: 'earnings', title: 'NVDA earnings',
      date: '2026-08-26', timing: 'after-hours', confidence: 'estimated',
      source: 'tastytrade market metrics', sourceUrl: 'https://example.com/metrics',
      updatedAt: '2026-08-13T10:00:00.000Z',
    }
    const db = d1WithResults([{ ...catalyst, nearest: 1 }])
    const result = await readCatalysts(db.env, ['NVDA', 'NVDA'], 30, new Date('2026-08-13T12:00:00.000Z'))

    const { id: _id, ...withoutId } = catalyst
    expect(result).toMatchObject({ catalysts: [withoutId], horizonDays: 30, symbols: ['NVDA'], truncated: false })
    // The agent's rows are a projection: `id` restates symbol, kind and date, and no tool takes
    // one back. The website's own reader is the reason the domain schema still carries it.
    expect(result.catalysts[0]).not.toHaveProperty('id')
    expect(result.catalysts[0]).not.toHaveProperty('nearest')
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('event_date BETWEEN ? AND ?'))
    expect(db.bind).toHaveBeenCalledWith('NVDA', '2026-08-13', '2026-09-12', 61)

    const site = d1WithResults([catalyst])
    await expect(readUpcomingCatalysts(site.env, ['NVDA'], new Date('2026-08-13T12:00:00.000Z')))
      .resolves.toEqual([catalyst])
  })

  it('hands the agent one row per event, and does not call a folded group a ceiling hit', async () => {
    // Every sighting of an event costs the agent context and reads as another thing on the
    // calendar. The ceiling counts events, so two sightings of one event are not truncation.
    const base = {
      symbol: 'INTC', kind: 'earnings', date: '2026-10-22', timing: 'unknown',
      description: null, source: 'tastytrade market metrics',
      sourceUrl: 'https://developer.tastytrade.com/open-api-spec/market-metrics/',
    }
    const db = d1WithResults([
      { ...base, id: 'exa:INTC:earnings:2026-10-22', confidence: 'estimated', title: 'Q3 2026 Earnings Report', updatedAt: '2026-09-21T17:54:02.486Z', nearest: 1 },
      { ...base, id: 'tastytrade:INTC:earnings', confidence: 'confirmed', title: 'INTC earnings', updatedAt: '2026-08-28T02:15:52.966Z', nearest: 1 },
    ])
    const result = await readCatalysts(db.env, ['INTC'], 60, new Date('2026-09-21T18:00:00.000Z'))

    expect(result.catalysts).toEqual([expect.objectContaining({ confidence: 'confirmed', title: 'INTC earnings' })])
    expect(result.truncated).toBe(false)
  })

  it('runs its own query against the real schema, and skips a superseded sighting', async () => {
    // The agent reads through the same source the site does, so a date one producer has since
    // moved is not handed to a model as a second event beside the one it moved to.
    const store = await migrationStore()
    try {
      const env = { DB: store.database }
      // The receipt a search leaves: it is what makes exa's later answer supersede its earlier.
      store.sqlite.prepare(
        `INSERT INTO catalyst_runs (symbol, source_provider, ran_at, catalyst_count, status)
         VALUES ('INTC', 'exa', '2026-08-21T18:00:00.000Z', 1, 'complete')`,
      ).run()
      const row = (date: string) => ({
        confidence: 'estimated' as const,
        date,
        id: `exa:INTC:earnings:${date}`,
        kind: 'earnings' as const,
        source: 'Exa search · example.com',
        sourceUrl: 'https://example.com/events',
        symbol: 'INTC',
        timing: 'unknown' as const,
        title: 'Q3 2026 earnings',
        updatedAt: '2026-09-21T17:54:02.486Z',
      })
      await persistResearchCatalysts(env, 'exa', [row('2026-10-22')], new Date('2026-08-21T18:00:00.000Z'))
      await persistResearchCatalysts(env, 'exa', [row('2026-10-23')], new Date('2026-09-21T18:00:00.000Z'))

      const result = await readCatalysts(env, ['INTC'], 60, new Date('2026-09-21T18:00:00.000Z'))
      expect(result.catalysts.map((catalyst) => catalyst.date)).toEqual(['2026-10-23'])
    } finally {
      store.close()
    }
  })

  it('caps whole events, so a group at the ceiling still shows its preferred sighting', async () => {
    // One more sighting than events before the last kept event, so a row cap would cut inside
    // that event's group -- after exa's estimated row and before tastytrade's confirmed one.
    const store = await migrationStore()
    try {
      const env = { DB: store.database }
      const insert = store.sqlite.prepare(
        `INSERT INTO catalysts (id, source_provider, symbol, kind, title, description, event_date,
            timing, confidence, source_label, source_url, updated_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, NULL, ?, 'unknown', ?, ?, 'https://example.com/events', ?, ?)`,
      )
      const seen = '2026-09-21T17:00:00.000Z'
      const date = (offset: number) => addDays('2026-09-22', offset)
      const exa = (symbol: string, kind: string, day: string) =>
        insert.run(`exa:${symbol}:${kind}:${day}`, 'exa', symbol, kind, `${symbol} ${kind}`, day, 'estimated', 'Exa search', seen, seen)
      const tastytrade = (symbol: string, day: string) =>
        insert.run(`tastytrade:${symbol}:earnings`, 'tastytrade', symbol, 'earnings', `${symbol} earnings`, day, 'confirmed', 'tastytrade market metrics', seen, seen)

      // Event 1 is sighted twice; events 2..59 once each.
      exa('AMD', 'earnings', date(0))
      tastytrade('AMD', date(0))
      for (let index = 1; index < 59; index += 1) exa('NVDA', 'conference', date(index))
      // Event 60, the last one kept, sighted by both producers.
      exa('INTC', 'earnings', date(59))
      tastytrade('INTC', date(59))

      const atCeiling = await readCatalysts(env, ['AMD', 'NVDA', 'INTC'], CATALYST_HORIZON_DAYS, new Date('2026-09-21T18:00:00.000Z'))
      expect(atCeiling.catalysts).toHaveLength(60)
      expect(atCeiling.catalysts.at(-1)).toMatchObject({ confidence: 'confirmed', date: date(59), symbol: 'INTC' })
      expect(atCeiling.truncated).toBe(false)

      // One event more: the first past the ceiling is left off, and `truncated` says so.
      exa('NVDA', 'conference', date(60))
      const past = await readCatalysts(env, ['AMD', 'NVDA', 'INTC'], CATALYST_HORIZON_DAYS, new Date('2026-09-21T18:00:00.000Z'))
      expect(past.catalysts).toHaveLength(60)
      expect(past.catalysts.at(-1)).toMatchObject({ confidence: 'confirmed', symbol: 'INTC' })
      expect(past.truncated).toBe(true)
    } finally {
      store.close()
    }
  })

  it('tells an unsearched symbol from one searched empty and one whose search failed', async () => {
    const store = await migrationStore()
    try {
      const env = { DB: store.database }
      const receipt = store.sqlite.prepare(
        `INSERT INTO catalyst_runs (symbol, source_provider, ran_at, catalyst_count, status, detail)
         VALUES (?, 'exa', ?, 0, ?, ?)`,
      )
      receipt.run('AMD', '2026-09-20T10:00:00.000Z', 'complete', null)
      receipt.run('MU', '2026-09-21T11:00:00.000Z', 'failed', 'provider said: secret note')
      receipt.run('ARM', '2026-09-21T17:59:30.000Z', 'running', null)
      // A claim that never reported, long past its run budget: a run that died, not one in flight.
      receipt.run('QCOM', '2026-09-21T12:00:00.000Z', 'running', null)

      const result = await readCatalysts(env, ['NVDA', 'AMD', 'MU', 'ARM', 'QCOM'], 60, new Date('2026-09-21T18:00:00.000Z'))
      expect(result.catalysts).toEqual([])
      expect(result.searches).toEqual([
        { state: 'unsearched', symbol: 'NVDA' },
        { ranAt: '2026-09-20T10:00:00.000Z', state: 'complete', symbol: 'AMD' },
        { ranAt: '2026-09-21T11:00:00.000Z', state: 'failed', symbol: 'MU' },
        { ranAt: '2026-09-21T17:59:30.000Z', state: 'running', symbol: 'ARM' },
        { ranAt: '2026-09-21T12:00:00.000Z', state: 'failed', symbol: 'QCOM' },
      ])
      // The receipt's failure note is the owner's; it never reaches a caller of any tier.
      expect(JSON.stringify(result)).not.toContain('secret note')
    } finally {
      store.close()
    }
  })

  it('rejects unbounded or malformed catalyst requests before D1', async () => {
    const db = d1WithResults([])
    await expect(readCatalysts(db.env, ['nvda'])).rejects.toThrow('symbols are invalid')
    await expect(readCatalysts(db.env, Array.from({ length: 21 }, (_, index) => `A${index}`))).rejects.toThrow('symbols are invalid')
    // A horizon is refused rather than rounded or widened past what any producer may write.
    await expect(readCatalysts(db.env, ['NVDA'], 30.5)).rejects.toThrow('horizon is invalid')
    await expect(readCatalysts(db.env, ['NVDA'], CATALYST_HORIZON_DAYS + 1)).rejects.toThrow('horizon is invalid')
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('reads the whole horizon a producer may write when none is asked for', async () => {
    const db = d1WithResults([])
    const result = await readCatalysts(db.env, ['NVDA'], undefined, new Date('2026-08-13T12:00:00.000Z'))

    expect(result.horizonDays).toBe(CATALYST_HORIZON_DAYS)
    expect(db.bind).toHaveBeenCalledWith('NVDA', '2026-08-13', '2027-02-09', 61)
  })
})
