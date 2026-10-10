import { describe, expect, it } from 'vitest'

import {
  bindCatalystCandidates,
  type ResearchCatalystCandidate,
} from '../src/server/research-catalyst-output'
import { MAX_PAGE_MARKDOWN_CHARS, type ReadPage } from '../src/server/research-page-retention'

const NOW = new Date('2026-08-31T18:00:00.000Z')
const PAGE_URL = 'https://investors.example.com/events'
const SOURCES = [{ sourceUrl: PAGE_URL }]

function candidate(overrides: Partial<ResearchCatalystCandidate> = {}): ResearchCatalystCandidate {
  return {
    date: '2026-09-15',
    description: null,
    kind: 'investor-event',
    sourceIndex: 0,
    symbol: 'NVDA',
    timing: 'unknown',
    title: 'NVIDIA investor day',
    ...overrides,
  }
}

function retained(markdown: string, truncated = false): Map<string, ReadPage> {
  return new Map([[PAGE_URL, { markdown, truncated }]])
}

describe('structured catalyst output binding', () => {
  it('creates an estimated application-owned row from a page containing the exact date', () => {
    const result = bindCatalystCandidates(
      [candidate()],
      SOURCES,
      retained('NVIDIA will hold an investor day on September 15, 2026.'), NOW, 'member-research')

    expect(result.rejected).toEqual([])
    expect(result.catalysts).toEqual([{
      confidence: 'estimated',
      date: '2026-09-15',
      description: null,
      id: 'member-research:NVDA:investor-event:2026-09-15',
      kind: 'investor-event',
      source: 'Member research · investors.example.com',
      sourceUrl: PAGE_URL,
      symbol: 'NVDA',
      timing: 'unknown',
      title: 'NVIDIA investor day',
      updatedAt: NOW.toISOString(),
    }])
  })

  it('refuses an unread source or a date absent from the retained page', () => {
    expect(bindCatalystCandidates([candidate()], SOURCES, new Map(), NOW, 'member-research').rejected)
      .toEqual(['catalyst 1: source was not read this run'])
    expect(bindCatalystCandidates(
      [candidate()],
      SOURCES,
      retained('NVIDIA will hold an investor day next quarter.'), NOW, 'member-research').rejected).toEqual(['catalyst 1: 2026-09-15 does not appear on its source page'])
  })

  it('names a miss on a page read only in part as a miss in what was read', () => {
    // The date may sit past the cap; calling it absent from the page would be a claim about text
    // this Worker never read.
    expect(bindCatalystCandidates(
      [candidate()],
      SOURCES,
      retained('NVIDIA will hold an investor day next quarter.', true), NOW, 'member-research').rejected)
      .toEqual([`catalyst 1: 2026-09-15 not found in a read cut at ${MAX_PAGE_MARKDOWN_CHARS} characters of its source page`])
  })

  it('refuses out-of-horizon and duplicate updates instead of silently collapsing them', () => {
    expect(bindCatalystCandidates(
      [candidate({ date: '2027-09-15' })],
      SOURCES,
      retained('The investor day is September 15, 2027.'), NOW, 'member-research').rejected[0]).toContain('180-day horizon')

    expect(bindCatalystCandidates(
      [candidate(), candidate()],
      SOURCES,
      retained('The investor day is September 15, 2026.'), NOW, 'member-research').rejected).toEqual([
      'catalyst 2: duplicates member-research:NVDA:investor-event:2026-09-15',
    ])
  })
})
