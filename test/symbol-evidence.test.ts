import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { quoteBindingRefusal } from '../src/server/research-citation-binding'
import { MAX_PAGE_MARKDOWN_CHARS } from '../src/server/research-page-retention'
import { readSymbolEvidence } from '../src/server/symbol-evidence'
import { recordSymbolEvidence } from '../src/server/symbol-evidence-tool'
import { markdownBrowser, unreadableBrowser } from './fake-browser'
import { migrationStore, seedMember, type SqliteD1Store } from './sqlite-d1'

const NOW = new Date('2026-09-02T13:45:00.000Z')
const LATER = new Date('2026-09-04T09:00:00.000Z')
const RECORDER = 'member-1'
const SOURCE_URL = 'https://www.reuters.com/technology/nvidia-supply'
// The address a reader is given back is the canonical one, so the tracking parameters an agent
// copied out of its browser are not part of what the card cites.
const SUBMITTED_URL = `${SOURCE_URL}?utm_source=newsletter`
const PAGE_MARKDOWN = '# NVIDIA\n\nThe company **signed a multi-year supply agreement** this week.'

let store: SqliteD1Store

/** The member row exists in every case, because a card records the account behind it. */
beforeEach(async () => {
  store = await migrationStore()
  seedMember(store, RECORDER)
})

afterEach(() => store.close())

/** What the Worker's browser returns for the page the card cites. */
function recordingEnv(browser: BrowserRun = markdownBrowser(PAGE_MARKDOWN)) {
  return { BROWSER: browser, DB: store.database }
}

function evidence() {
  return {
    byline: 'volwatcher',
    note: 'Visibility into next year\'s demand, not this quarter\'s.',
    quote: 'signed a multi-year supply agreement',
    sourceTitle: 'NVIDIA supply agreement',
    sourceUrl: SUBMITTED_URL,
    symbol: 'nvda',
  }
}

describe('recording a quoted passage under a symbol', () => {
  it('binds the quote to the page the Worker read and returns it to every reader', async () => {
    const result = await recordSymbolEvidence(recordingEnv(), RECORDER, evidence(), NOW)

    expect(result.status).toBe('recorded')
    const cards = await readSymbolEvidence(store.database, 'NVDA')
    expect(cards).toEqual([{
      byline: 'volwatcher',
      id: result.status === 'recorded' ? result.id : '',
      note: 'Visibility into next year\'s demand, not this quarter\'s.',
      quote: 'signed a multi-year supply agreement',
      recordedAt: NOW.toISOString(),
      sourceTitle: 'NVIDIA supply agreement',
      sourceUrl: SOURCE_URL,
      symbol: 'NVDA',
    }])
    // The account behind the card never leaves the server: the row has the recorder, the
    // public read has no column for it, and the byline is the whole of the attribution.
    expect(Object.keys(cards[0]!)).not.toContain('recordedByUserId')
    expect(store.sqlite.prepare('SELECT recorded_by_user_id FROM symbol_evidence').get())
      .toEqual({ recorded_by_user_id: RECORDER })
  })

  it('refreshes the card when the same passage is recorded again, rather than duplicating it', async () => {
    const first = await recordSymbolEvidence(recordingEnv(), RECORDER, evidence(), NOW)
    // The same passage, spelled with the markdown emphasis the page renders it with, and
    // cited through the uncanonicalized address: the same card either way.
    const again = await recordSymbolEvidence(
      recordingEnv(),
      RECORDER,
      { ...evidence(), quote: '**signed a multi-year supply agreement**', sourceUrl: SOURCE_URL },
      LATER,
    )

    expect(again).toEqual(first)
    const cards = await readSymbolEvidence(store.database, 'NVDA')
    expect(cards).toHaveLength(1)
    expect(cards[0]?.recordedAt).toBe(LATER.toISOString())
  })

  it('returns the newest cards first', async () => {
    await recordSymbolEvidence(recordingEnv(), RECORDER, evidence(), NOW)
    const { byline: _byline, note: _note, ...unsigned } = evidence()
    await recordSymbolEvidence(
      recordingEnv(),
      RECORDER,
      { ...unsigned, quote: 'signed a multi-year' },
      LATER,
    )

    const cards = await readSymbolEvidence(store.database, 'NVDA')
    expect(cards.map((card) => card.quote)).toEqual([
      'signed a multi-year',
      'signed a multi-year supply agreement',
    ])
    // An omitted note and byline are absent, not empty strings a card would render a gap for.
    expect(cards[0]).toMatchObject({ byline: null, note: null })
  })

  it('refuses a quote the page it re-read does not contain, with the reason', async () => {
    const result = await recordSymbolEvidence(
      recordingEnv(markdownBrowser('# NVIDIA\n\nA page about something else entirely.')),
      RECORDER,
      evidence(),
      NOW,
    )

    expect(result).toEqual({
      rejected: ['quote absent from its source: "signed a multi-year supply agreement"'],
      status: 'rejected',
    })
    expect(store.sqlite.prepare('SELECT COUNT(*) AS rows FROM symbol_evidence').get()).toEqual({ rows: 0 })
  })

  it('refuses a quote that is only markup, which every page would otherwise contain', async () => {
    const result = await recordSymbolEvidence(
      recordingEnv(),
      RECORDER,
      { ...evidence(), quote: '** _ `> # |' },
      NOW,
    )

    expect(result).toEqual({ rejected: ['quote has no words to find on its source'], status: 'rejected' })
    expect(store.sqlite.prepare('SELECT COUNT(*) AS rows FROM symbol_evidence').get()).toEqual({ rows: 0 })
  })

  it('refuses an address that is not a readable https page, and a page that will not open', async () => {
    await expect(recordSymbolEvidence(
      recordingEnv(),
      RECORDER,
      { ...evidence(), sourceUrl: 'http://192.168.1.4/internal' },
      NOW,
    )).resolves.toEqual({
      rejected: ['sourceUrl: not a readable https page address'],
      status: 'rejected',
    })
    await expect(recordSymbolEvidence(recordingEnv(unreadableBrowser()), RECORDER, evidence(), NOW))
      .resolves.toEqual({ rejected: [`page did not open: ${SOURCE_URL}`], status: 'rejected' })
    expect(store.sqlite.prepare('SELECT COUNT(*) AS rows FROM symbol_evidence').get()).toEqual({ rows: 0 })
  })

  it('names a quote past the part of a long page it read as unread, not as absent', async () => {
    const longPage = `${'filler '.repeat(MAX_PAGE_MARKDOWN_CHARS / 'filler '.length + 1)}${PAGE_MARKDOWN}`
    await expect(recordSymbolEvidence(recordingEnv(markdownBrowser(longPage)), RECORDER, evidence(), NOW))
      .resolves.toEqual({
        rejected: [
          `quote not found in a read cut at ${MAX_PAGE_MARKDOWN_CHARS} characters of its source: "signed a multi-year supply agreement"`,
        ],
        status: 'rejected',
      })
    expect(store.sqlite.prepare('SELECT COUNT(*) AS rows FROM symbol_evidence').get()).toEqual({ rows: 0 })
  })

  it('fails closed when the Worker cannot read a page at all', async () => {
    await expect(recordSymbolEvidence({ DB: store.database }, RECORDER, evidence(), NOW))
      .rejects.toThrow('SymbolEvidence:page-reading-unavailable')
  })

  it('binds no page to a quote with no words, whoever asks the binder', () => {
    expect(quoteBindingRefusal({ markdown: PAGE_MARKDOWN, truncated: false }, '  **  ')).toBe('quote has no words to find on its source')
    expect(quoteBindingRefusal({ markdown: PAGE_MARKDOWN, truncated: false }, 'signed a multi-year')).toBeUndefined()
  })

  it('drops a member\'s cards with their account', async () => {
    await recordSymbolEvidence(recordingEnv(), RECORDER, evidence(), NOW)
    store.sqlite.prepare('DELETE FROM "user" WHERE "id" = ?').run(RECORDER)

    expect(await readSymbolEvidence(store.database, 'NVDA')).toEqual([])
  })
})
