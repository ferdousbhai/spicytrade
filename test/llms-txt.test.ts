import { describe, expect, it } from 'vitest'

import { CONNECT_GUIDE_URL } from '../src/domain/site'
import { connectGuide } from '../src/server/connect-guide'
import { llmsFullTxt, llmsTxt } from '../src/server/llms-txt'

describe('llms.txt', () => {
  it('follows the llmstxt.org shape: a title, a summary, then sections of absolute links', () => {
    const lines = llmsTxt().split('\n')
    expect(lines[0]).toBe('# spicytrade')
    expect(lines[2]).toMatch(/^> /)
    const links = lines.filter((line) => line.startsWith('- '))
    expect(links.length).toBeGreaterThan(0)
    for (const link of links) expect(link).toMatch(/^- \[[^\]]+\]\(https:\/\/spicy\.trade\/[^)]*\)/)
  })

  it('gives an existing agent a connector-only setup path and explicit refresh limits', () => {
    expect(llmsTxt()).toContain(CONNECT_GUIDE_URL)
    const guide = connectGuide()
    expect(guide).toContain('--connector-only')
    expect(guide).toContain('connect_spicytrade')
    expect(guide).toContain('Configure only this harness')
    expect(guide).toContain('Do not promise that every harness supports hot reload')
    expect(guide).toContain('spicytrade integration')
  })

  it('carries the MCP guide in the full version, under the index rather than a second title', () => {
    const full = llmsFullTxt()
    expect(full.startsWith(llmsTxt())).toBe(true)
    expect(full).toContain('read_price_history')
    expect(full.match(/^# /gm)).toHaveLength(1)
  })
})
