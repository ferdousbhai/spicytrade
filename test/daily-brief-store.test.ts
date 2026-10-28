import { describe, expect, it } from 'vitest'

import { publishDailyBrief, readDailyBriefBefore, readLatestDailyBrief, readLatestRecommendation } from '../src/server/daily-brief-store'
import { dailyBriefFixture } from './fixtures/market'
import { migrationStore } from './sqlite-d1'

const { id: _id, publishedAt: _publishedAt, ...submission } = dailyBriefFixture

describe('daily brief store', () => {
  it('publishes a submission with its own id and instant, and replaces the same market date', async () => {
    const store = await migrationStore()
    const first = await publishDailyBrief(store.database, submission, new Date('2026-08-13T13:35:00.000Z'))
    expect(first.id).toBe('brief-2026-08-13')
    expect(first.publishedAt).toBe('2026-08-13T13:35:00.000Z')

    const second = await publishDailyBrief(store.database, { ...submission, recommendations: [] }, new Date('2026-08-13T14:00:00.000Z'))
    expect(second.id).toBe(first.id)
    await expect(readLatestDailyBrief(store.database)).resolves.toEqual(second)
    expect(store.sqlite.prepare('SELECT COUNT(*) AS n FROM daily_briefs').get()).toEqual({ n: 1 })
    store.close()
  })

  it('refuses a submission outside the contract before anything is written', async () => {
    const store = await migrationStore()
    await expect(publishDailyBrief(store.database, { ...submission, model: '' })).rejects.toThrow()
    // A caller's claim is not the contract: an id smuggled in with the submission is refused.
    // SAFETY: the widened value is exactly what this case exists to reject.
    await expect(publishDailyBrief(store.database, { ...submission, id: 'brief-2026-08-13' } as never)).rejects.toThrow()
    // One uncitable link refuses the whole brief rather than publishing it or the rest of it.
    await expect(publishDailyBrief(store.database, {
      ...submission,
      links: [...submission.links, { url: 'https://reuters.com@evil.example/x' }],
    })).rejects.toThrow()
    await expect(readLatestDailyBrief(store.database)).resolves.toBeUndefined()
    store.close()
  })

  it('walks the archive one issue at a time, by market date', async () => {
    const store = await migrationStore()
    await publishDailyBrief(store.database, { ...submission, marketDate: '2026-08-11' }, new Date('2026-08-11T13:35:00.000Z'))
    await publishDailyBrief(store.database, { ...submission, marketDate: '2026-08-12' }, new Date('2026-08-12T13:35:00.000Z'))
    const latest = await publishDailyBrief(store.database, submission, new Date('2026-08-13T13:35:00.000Z'))
    // A retried run republishes the oldest date last; its instant is now the newest of all.
    await publishDailyBrief(store.database, { ...submission, marketDate: '2026-08-11' }, new Date('2026-08-13T15:00:00.000Z'))

    const walked: string[] = []
    for (let cursor: string | undefined = latest.marketDate; cursor;) {
      const previous = await readDailyBriefBefore(store.database, cursor)
      if (previous) walked.push(previous.id)
      cursor = previous?.marketDate
    }
    expect(walked).toEqual(['brief-2026-08-12', 'brief-2026-08-11'])
    store.close()
  })

  it('keeps the newest market date standing when an older date is republished later', async () => {
    const store = await migrationStore()
    const latest = await publishDailyBrief(store.database, submission, new Date('2026-08-13T13:35:00.000Z'))
    await publishDailyBrief(store.database, { ...submission, marketDate: '2026-08-12' }, new Date('2026-08-13T15:00:00.000Z'))

    await expect(readLatestDailyBrief(store.database)).resolves.toEqual(latest)
    store.close()
  })

  it('refuses an archive cursor that is not a market date', async () => {
    const store = await migrationStore()
    await publishDailyBrief(store.database, submission, new Date('2026-08-13T13:35:00.000Z'))
    await expect(readDailyBriefBefore(store.database, '2026-08-14T00:00:00.000Z')).rejects.toThrow()
    store.close()
  })

  it('fails visibly on a stored row that no longer fits the contract', async () => {
    const store = await migrationStore()
    store.sqlite.prepare(
      'INSERT INTO daily_briefs (id, published_at, payload_json) VALUES (?, ?, ?)',
    ).run('brief-2026-08-13', '2026-08-13T13:35:00.000Z', JSON.stringify({ id: 'brief-2026-08-13', ideas: [] }))
    await expect(readLatestDailyBrief(store.database)).rejects.toThrow()
    store.close()
  })

  it('finds the newest market date that recommended a symbol, dated by that brief', async () => {
    const store = await migrationStore()
    const [nvda] = submission.recommendations
    await publishDailyBrief(store.database, { ...submission, marketDate: '2026-08-11', recommendations: [{ ...nvda!, trade: 'Older NVDA trade' }] })
    await publishDailyBrief(store.database, { ...submission, marketDate: '2026-08-12' })
    // The newest brief argues a different name, so NVDA's latest view is a day older.
    await publishDailyBrief(store.database, { ...submission, recommendations: [{ ...nvda!, symbol: 'AMD', trade: 'Buy AMD' }] })

    await expect(readLatestRecommendation(store.database, 'NVDA')).resolves.toEqual({ marketDate: '2026-08-12', recommendation: nvda })
    await expect(readLatestRecommendation(store.database, 'AMD')).resolves.toMatchObject({ marketDate: '2026-08-13' })
    await expect(readLatestRecommendation(store.database, 'SPY')).resolves.toBeNull()
    await expect(readLatestRecommendation(store.database, 'not a symbol')).rejects.toThrow()
    store.close()
  })
})
