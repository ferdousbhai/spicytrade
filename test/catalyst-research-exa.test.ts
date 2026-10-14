import { afterEach, describe, expect, it, vi } from 'vitest'

import { CATALYST_HORIZON_DAYS } from '../src/domain/catalyst'
import { MAX_EXA_RESULTS, runExaCatalystSearch } from '../src/server/catalyst-research-exa'
import { MAX_PAGE_MARKDOWN_CHARS } from '../src/server/research-page-retention'
import { pagesBrowser } from './fake-browser'

const NOW = new Date('2026-09-01T13:00:00.000Z')
const exaKey: SecretsStoreSecret = { get: async () => 'exa-key' }
const IR_PAGE = 'https://ir.bloomenergy.com/events'

/** An environment whose browser reads the given pages, by default the IR page naming 2026-10-14. */
function envWith(pages: Readonly<Record<string, string>> = { [IR_PAGE]: page('2026-10-14') }) {
  const browser = pagesBrowser(pages)
  return { browser, env: { BROWSER: browser, EXA_API_KEY: exaKey } }
}
const { env } = envWith()

/** The event fields Exa is asked to synthesize, as a test writes them. */
type ExaEventFixture = {
  date: string
  description?: string
  kind: string
  sourceUrl: string
  timing?: string
  title: string
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function page(date: string): string {
  return `Bloom Energy said the investor day is scheduled for ${date} at its headquarters.`
}

function exaResponse(events: readonly ExaEventFixture[]) {
  return Response.json({
    output: { content: { events } },
    results: [{ title: 'Bloom investor day', url: IR_PAGE }],
  })
}

function stubExa(response: Response) {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const investorDay = {
  date: '2026-10-14',
  description: 'Bloom hosts analysts and issues multi-year targets.',
  kind: 'investor-event',
  sourceUrl: 'https://ir.bloomenergy.com/events',
  timing: 'intraday',
  title: 'Bloom Energy investor day',
}

describe('exa catalyst search', () => {
  it('records a dated event its cited page states, and asks Exa for one bounded search', async () => {
    const fetchMock = stubExa(exaResponse([investorDay]))

    const run = await runExaCatalystSearch(env, 'BE', 'Bloom Energy Corporation', NOW)

    expect(run.catalysts).toEqual([{
      confidence: 'estimated',
      date: '2026-10-14',
      description: 'Bloom hosts analysts and issues multi-year targets.',
      id: 'exa:BE:investor-event:2026-10-14',
      kind: 'investor-event',
      source: 'Exa search · ir.bloomenergy.com',
      sourceUrl: 'https://ir.bloomenergy.com/events',
      symbol: 'BE',
      timing: 'intraday',
      title: 'Bloom Energy investor day',
      updatedAt: NOW.toISOString(),
    }])
    const [url, init] = fetchMock.mock.calls[0]!
    expect(url).toBe('https://api.exa.ai/search')
    expect(init.headers).toMatchObject({ 'x-api-key': 'exa-key' })
    const body = JSON.parse(String(init.body))
    expect(body).toMatchObject({ numResults: MAX_EXA_RESULTS, type: 'auto' })
    // Exa's copy of a page binds nothing here, so it is neither asked for nor paid for.
    expect(body).not.toHaveProperty('contents')
    // An IR calendar is neither news nor recently published, so neither filter is sent.
    expect(body).not.toHaveProperty('category')
    expect(body).not.toHaveProperty('startPublishedDate')
    expect(Object.keys(body.outputSchema.properties.events.items.properties)).not.toContain('confidence')
    expect(body.query).toContain('Bloom Energy Corporation (BE)')
    expect(body.query).toContain(`over the next ${CATALYST_HORIZON_DAYS} days`)
    expect(body.outputSchema.required).toEqual(['events'])
  })

  it('keeps a date its source page words without the year, inside the horizon', async () => {
    // Live reporting writes "Sept. 1" for 2026-09-01; inside the horizon that names one date.
    stubExa(exaResponse([{ ...investorDay, date: '2026-09-01' }]))

    await expect(runExaCatalystSearch(envWith({ [IR_PAGE]: 'Bloom will hold its call on Sept. 1.' }).env, 'BE', 'Bloom Energy', NOW))
      .resolves.toMatchObject({ catalysts: [{ date: '2026-09-01' }] })
  })

  it('drops an event its source page does not state', async () => {
    stubExa(exaResponse([{ ...investorDay, date: '2026-11-20' }]))

    const run = await runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)

    expect(run.catalysts).toEqual([])
    expect(run.rejected).toEqual(['catalyst 1: 2026-11-20 does not appear on its source page'])
  })

  it('never lets the grounding Exa returns bind a date its page text does not state', async () => {
    // Grounding is the same model vouching for its own answer, however confident it says it is.
    stubExa(Response.json({
      output: {
        content: { events: [{ ...investorDay, date: '2026-11-20' }] },
        grounding: [{
          citations: [{ url: 'https://ir.bloomenergy.com/events' }],
          confidence: 'high',
          field: 'events[0].date',
        }],
      },
      results: [{ url: IR_PAGE }],
    }))

    await expect(runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)).resolves.toEqual({
      catalysts: [],
      rejected: ['catalyst 1: 2026-11-20 does not appear on its source page'],
    })
  })

  it('drops an event from a page this run never read, a past date, and a duplicate', async () => {
    stubExa(exaResponse([
      { ...investorDay, sourceUrl: 'https://elsewhere.example/rumor' },
      { ...investorDay, date: '2026-08-14' },
      investorDay,
      investorDay,
      { ...investorDay, kind: 'not-a-kind' },
    ]))

    const run = await runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)

    expect(run.catalysts.map((catalyst) => catalyst.id)).toEqual(['exa:BE:investor-event:2026-10-14'])
    // Exa's own malformed shape is refused before binding; the binder reports the rest under
    // the same event numbers.
    expect(run.rejected).toEqual([
      expect.stringContaining('catalyst 5:'),
      'catalyst 1: source was not read this run',
      'catalyst 2: date is outside the 180-day horizon',
      'catalyst 4: duplicates exa:BE:investor-event:2026-10-14',
    ])
  })

  it('binds and stores the canonical address, and refuses one no citation may carry', async () => {
    stubExa(Response.json({
      output: {
        content: {
          events: [
            { ...investorDay, sourceUrl: 'https://ir.bloomenergy.com/events?utm_source=exa#calendar' },
            { ...investorDay, date: '2026-10-15', sourceUrl: 'http://ir.bloomenergy.com/events' },
            { ...investorDay, date: '2026-10-16', sourceUrl: `https://ir.bloomenergy.com/${'a'.repeat(2_000)}` },
          ],
        },
      },
      results: [{ url: IR_PAGE }],
    }))
    const { browser, env } = envWith()

    const run = await runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)

    expect(run.catalysts.map((catalyst) => catalyst.sourceUrl)).toEqual([IR_PAGE])
    // The Worker reads the canonical address, never the one the model wrote.
    expect(browser.reads).toEqual([IR_PAGE])
    expect(run.rejected).toEqual([
      'catalyst 2: source is not a citable https page address',
      'catalyst 3: source is not a citable https page address',
    ])
  })

  it('says a date may sit past what its own browser read cut off', async () => {
    const cut = 'Bloom Energy investor relations calendar. '.padEnd(MAX_PAGE_MARKDOWN_CHARS + 1, 'x')
    stubExa(exaResponse([investorDay]))

    const run = await runExaCatalystSearch(envWith({ [IR_PAGE]: cut }).env, 'BE', 'Bloom Energy', NOW)

    expect(run.catalysts).toEqual([])
    expect(run.rejected).toEqual([`catalyst 1: 2026-10-14 not found in a read cut at ${MAX_PAGE_MARKDOWN_CHARS} characters of its source page`])
  })

  it('refuses a date only Exa\'s copy of the page states, not the Worker\'s own read', async () => {
    // Exa returning text for a page is Exa's read, not this Worker's; only the browser read binds.
    stubExa(Response.json({
      output: { content: { events: [investorDay] } },
      results: [{ text: page('2026-10-14'), url: IR_PAGE }],
    }))

    const run = await runExaCatalystSearch(envWith({ [IR_PAGE]: page('2026-10-21') }).env, 'BE', 'Bloom Energy', NOW)

    expect(run).toEqual({ catalysts: [], rejected: ['catalyst 1: 2026-10-14 does not appear on its source page'] })
  })

  it('refuses the events of a page that will not open, and binds the rest', async () => {
    const other = 'https://www.bloomenergy.com/news'
    stubExa(Response.json({
      output: {
        content: {
          events: [
            { ...investorDay, sourceUrl: other },
            investorDay,
            { ...investorDay, date: '2026-10-15', sourceUrl: other },
          ],
        },
      },
      results: [{ url: IR_PAGE }, { url: other }],
    }))
    const { browser, env } = envWith()

    const run = await runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)

    expect(run.catalysts.map((catalyst) => catalyst.id)).toEqual(['exa:BE:investor-event:2026-10-14'])
    expect(run.rejected).toEqual([
      `catalyst 1: page did not open: ${other}`,
      `catalyst 3: page did not open: ${other}`,
    ])
    // Each distinct page is read once, however many events cite it.
    expect([...browser.reads].sort()).toEqual([IR_PAGE, other].sort())
  })

  it('spends no browser read on a page the search did not return', async () => {
    stubExa(exaResponse([{ ...investorDay, sourceUrl: 'https://elsewhere.example/rumor' }]))
    const { browser, env } = envWith({ 'https://elsewhere.example/rumor': page('2026-10-14') })

    const run = await runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)

    expect(run).toEqual({ catalysts: [], rejected: ['catalyst 1: source was not read this run'] })
    expect(browser.reads).toEqual([])
  })

  it('buys no search when it has no browser to bind the answer with', async () => {
    const fetchMock = stubExa(exaResponse([investorDay]))

    await expect(runExaCatalystSearch({ EXA_API_KEY: exaKey }, 'BE', 'Bloom Energy', NOW))
      .rejects.toThrow('CatalystSearch:page-reading-unavailable')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a response listing more pages than the search asked for', async () => {
    stubExa(Response.json({
      output: { content: { events: [] } },
      results: Array.from({ length: MAX_EXA_RESULTS + 1 }, (_, index) => ({ url: `${IR_PAGE}/${index}` })),
    }))

    await expect(runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)).rejects.toThrow()
  })

  it('fails a search that synthesized nothing rather than reading it as an empty one', async () => {
    stubExa(Response.json({ results: [] }))

    await expect(runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)).rejects.toThrow('ExaOutputMissing')
  })

  it('refuses a response without the pages it read instead of assuming none', async () => {
    stubExa(Response.json({ output: { content: { events: [] } } }))

    await expect(runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)).rejects.toThrow()
  })

  it('reads an empty synthesis over read pages as a search that found nothing', async () => {
    stubExa(exaResponse([]))

    await expect(runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)).resolves.toEqual({ catalysts: [], rejected: [] })
  })

  it('fails loudly when Exa refuses the request', async () => {
    stubExa(new Response('', { status: 429 }))

    await expect(runExaCatalystSearch(env, 'BE', 'Bloom Energy', NOW)).rejects.toThrow('ExaSearchFailed:429')
  })
})
