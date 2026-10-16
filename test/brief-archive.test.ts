import { describe, expect, it, vi } from 'vitest'

import { loadPreviousDailyBrief } from '../src/data/brief-archive'
import { dailyBriefFixture } from './fixtures/market'

describe('the brief archive reader', () => {
  it('asks for the brief before the market date the reader is on', async () => {
    const fetcher = vi.fn(async () => Response.json({ brief: dailyBriefFixture }))
    vi.stubGlobal('fetch', fetcher)

    await expect(loadPreviousDailyBrief('2026-08-14')).resolves.toEqual(dailyBriefFixture)
    expect(fetcher).toHaveBeenCalledWith('/api/public-daily-briefs?before=2026-08-14', expect.any(Object))
  })
})
