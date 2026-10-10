import { describe, expect, it } from 'vitest'

import { toError } from '../src/domain/failure'
import { readBoundedJson, readBoundedText } from '../src/server/bounded-response'
import { boundedYahooFetch } from '../src/server/yahoo-finance-transport'

describe('bounded upstream response reader', () => {
  it('reads within the byte boundary and parses JSON', async () => {
    await expect(readBoundedJson(Response.json({ ok: true }), 100, 'Test')).resolves.toEqual({ ok: true })
  })

  it('rejects declared and streamed bodies before allocating beyond the limit', async () => {
    await expect(readBoundedText(new Response('small', {
      headers: { 'Content-Length': '1000' },
    }), 10, 'Test')).rejects.toThrow('response-too-large')

    await expect(readBoundedText(new Response('12345678901'), 10, 'Test'))
      .rejects.toThrow('response-too-large')
  })

  it('names the provider when an upstream body is malformed or truncated', async () => {
    const truncated = new Response('{"catalysts":[{"symbol":"NVDA"', {
      headers: { 'Content-Type': 'application/json' },
    })

    await expect(readBoundedJson(truncated, 100_000, 'XCatalystProvider'))
      .rejects.toThrow(/^XCatalystProvider:invalid-json:/)

    await expect(readBoundedJson(new Response(''), 100_000, 'RedditListing'))
      .rejects.toThrow('RedditListing:invalid-json:0-chars')
  })

  it('keeps the malformed body out of the labeled error', async () => {
    const secretish = `{"session-token":"${'s'.repeat(400)}"`
    let message = ''
    try {
      await readBoundedJson(new Response(secretish), 100_000, 'TastytradeMemberGrant')
    } catch (cause) {
      message = toError(cause)?.message ?? ''
    }

    expect(message).toContain('TastytradeMemberGrant:invalid-json:')
    expect(message).not.toContain('session-token')
    // A refusal stays short: the label and the structural hint, never the provider body.
    expect(message.length).toBeLessThan(80)
  })

  it('bounds Yahoo bodies before its client can buffer them', async () => {
    const oversized = new Response('x'.repeat(2_000_001))
    const fetchYahoo = boundedYahooFetch(async () => oversized)

    await expect(fetchYahoo('https://query1.finance.yahoo.com/test'))
      .rejects.toThrow('YahooFinance:response-too-large')
  })
})
