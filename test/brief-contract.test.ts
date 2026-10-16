import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { BRIEF_ENVELOPE } from '../src/domain/brief-envelope'
import { EquitySymbolSchema } from '../src/domain/instrument'
import { DailyBriefSubmissionSchema } from '../src/domain/brief'

// Receiver-owned wire examples are also produced by spicy-workflow's actual mapper.
const path = new URL('./fixtures/brief-contract.json', import.meta.url)
const bytes = readFileSync(path, 'utf8')
// SAFETY: this committed test fixture is checked against the publication schema below.
const contract = JSON.parse(bytes) as {
  version: number
  cases: Array<{ name: string; submission: unknown }>
  envelope: typeof BRIEF_ENVELOPE
  symbols: { accepted: string[]; refused: string[] }
}

it('keeps the publication fixture identical to the producer when checked out alongside it', () => {
  expect(contract.version).toBe(1)
  const sibling = new URL('../../spicy-workflow/test/fixtures/brief-contract.json', import.meta.url)
  if (existsSync(sibling)) expect(readFileSync(sibling, 'utf8')).toBe(bytes)
})

for (const entry of contract.cases) it(`accepts the shared publication contract: ${entry.name}`, () => {
  expect(DailyBriefSubmissionSchema.parse(entry.submission)).toEqual(entry.submission)
})

it('shares receiver-owned limits and the same envelope source', () => {
  expect(BRIEF_ENVELOPE).toEqual(contract.envelope)
  const sibling = new URL('../../spicy-workflow/src/domain/brief-envelope.ts', import.meta.url)
  if (existsSync(sibling)) expect(readFileSync(sibling, 'utf8'))
    .toBe(readFileSync(new URL('../src/domain/brief-envelope.ts', import.meta.url), 'utf8'))
})

it('holds the receiver symbol grammar to the shared accepted and refused cases', () => {
  for (const symbol of contract.symbols.accepted) expect(EquitySymbolSchema.safeParse(symbol).success).toBe(true)
  for (const symbol of contract.symbols.refused) expect(EquitySymbolSchema.safeParse(symbol).success).toBe(false)
})

it('accepts exact envelope boundaries and refuses the next unit without truncation', () => {
  const { envelope: e } = contract
  const recommendation = { symbol: 'AAPL', direction: 'bullish', trade: 'x'.repeat(e.trade), thesis: 'x'.repeat(e.thesis) }
  const link = { url: 'https://news.example/', title: 'x'.repeat(e.linkTitle), snippet: 'x'.repeat(e.linkSnippet) }
  const submission = { marketDate: '2026-10-15', model: 'x'.repeat(e.model), links: Array(e.links).fill(link), recommendations: Array(e.recommendations).fill(recommendation) }
  expect(DailyBriefSubmissionSchema.parse(submission)).toEqual(submission)
  for (const changed of [
    { ...submission, model: submission.model + 'x' },
    { ...submission, links: [...submission.links, link] },
    { ...submission, recommendations: [...submission.recommendations, recommendation] },
    { ...submission, recommendations: [{ ...recommendation, thesis: recommendation.thesis + 'x' }] },
    { ...submission, recommendations: [{ ...recommendation, trade: recommendation.trade + 'x' }] },
    { ...submission, links: [{ ...link, title: link.title + 'x' }] },
    { ...submission, links: [{ ...link, snippet: link.snippet + 'x' }] },
  ]) expect(DailyBriefSubmissionSchema.safeParse(changed).success).toBe(false)
})
