import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { recordResearchCatalysts } from '../src/server/catalyst-record-tool'
import { type ResearchCatalystCandidate } from '../src/server/research-catalyst-output'
import { markdownBrowser, unreadableBrowser } from './fake-browser'
import { migrationStore, type SqliteD1Store } from './sqlite-d1'

const NOW = new Date('2026-09-02T13:45:00.000Z')
const SOURCE_URL = 'https://www.reuters.com/technology/nvidia-investor-day'
const PAGE_MARKDOWN = '# NVIDIA\n\nThe company set its investor day for September 15, 2026, and a product event for October 6, 2026.'

let store: SqliteD1Store

beforeEach(async () => {
  store = await migrationStore()
})

afterEach(() => store.close())

/** What the Worker's browser returns for the page the recording cites. */
function recordingEnv(browser: BrowserRun = markdownBrowser(PAGE_MARKDOWN)) {
  return { BROWSER: browser, DB: store.database }
}

function recording() {
  return {
    catalysts: [{
      date: '2026-09-15',
      description: null,
      kind: 'investor-event' as const,
      sourceIndex: 0,
      symbol: 'NVDA',
      timing: 'unknown' as const,
      title: 'NVIDIA investor day',
    }],
    sources: [{
      sourceUrl: SOURCE_URL,
    }],
  }
}

describe('recording catalysts a member researched', () => {
  it('re-reads the cited page and stores what binds under its own producer', async () => {
    const result = await recordResearchCatalysts(recordingEnv(), recording(), NOW)

    expect(result).toEqual({ catalystCount: 1, status: 'recorded', symbols: ['NVDA'] })
    // The row names the producer that wrote it, in its id and in what a reader sees.
    expect(store.sqlite.prepare(
      'SELECT id, source_provider, source_label, confidence FROM catalysts WHERE symbol = ?',
    ).get('NVDA')).toEqual({
      confidence: 'estimated',
      id: 'member-research:NVDA:investor-event:2026-09-15',
      source_label: 'Member research · reuters.com',
      source_provider: 'member-research',
    })
    // And it reaches every reader through the same view the site and the tools read.
    expect(store.sqlite.prepare(
      "SELECT source_provider FROM upcoming_catalysts WHERE id = 'member-research:NVDA:investor-event:2026-09-15'",
    ).get()).toEqual({ source_provider: 'member-research' })
  })

  it('writes nothing at all when one event of several fails to bind', async () => {
    const bound = recording()
    // The second event is dated a day off what the page states, which is the whole test: one
    // candidate binds, the other cannot, and neither is stored.
    const unbound: ResearchCatalystCandidate = {
      date: '2026-10-07',
      description: null,
      kind: 'product-event',
      sourceIndex: 0,
      symbol: 'NVDA',
      timing: 'unknown',
      title: 'NVIDIA product event',
    }
    const submitted = { ...bound, catalysts: [...bound.catalysts, unbound] }

    const result = await recordResearchCatalysts(recordingEnv(), submitted, NOW)

    expect(result.status).toBe('rejected')
    if (result.status !== 'rejected') throw new Error('expected rejection')
    // The reason names the candidate and the date, which is what an agent fixes and resends.
    expect(result.rejected).toEqual(['catalyst 2: 2026-10-07 does not appear on its source page'])
    // All-or-nothing: the event that did bind is not quietly kept beside the refusal.
    expect(store.sqlite.prepare('SELECT COUNT(*) AS rows FROM catalysts').get()).toEqual({ rows: 0 })
  })

  it('refuses a citation to a page it never read', async () => {
    const submitted = recording()
    submitted.catalysts[0]!.sourceIndex = 3

    const result = await recordResearchCatalysts(recordingEnv(), submitted, NOW)

    expect(result).toEqual({
      rejected: ['catalyst 1: source was not read this run'],
      status: 'rejected',
    })
  })

  it('reports the page that would not open rather than storing an unverified date', async () => {
    const result = await recordResearchCatalysts(recordingEnv(unreadableBrowser()), recording(), NOW)

    expect(result).toEqual({ rejected: [`page did not open: ${SOURCE_URL}`], status: 'rejected' })
    expect(store.sqlite.prepare('SELECT COUNT(*) AS rows FROM catalysts').get()).toEqual({ rows: 0 })
  })

  it('fails closed when the Worker cannot read a page at all', async () => {
    await expect(recordResearchCatalysts({ DB: store.database }, recording(), NOW))
      .rejects.toThrow('CatalystRecord:page-reading-unavailable')
  })
})
