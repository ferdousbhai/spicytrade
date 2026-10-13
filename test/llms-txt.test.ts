import { describe, expect, it } from 'vitest'

import { MCP_ENDPOINT } from '../src/domain/site'
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

  it('points agents at the MCP server first', () => {
    const text = llmsTxt()
    expect(text.indexOf('## MCP server')).toBeLessThan(text.indexOf('## Public JSON'))
    expect(text).toContain(`(${MCP_ENDPOINT})`)
  })

  it('carries the MCP guide in the full version, under the index rather than a second title', () => {
    const full = llmsFullTxt()
    expect(full.startsWith(llmsTxt())).toBe(true)
    expect(full).toContain('read_price_history')
    expect(full.match(/^# /gm)).toHaveLength(1)
  })
})
