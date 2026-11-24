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

  it('names the server-rendered brief archive and symbol pages', () => {
    expect(llmsTxt()).toContain('(https://spicy.trade/briefs)')
    expect(llmsTxt()).toContain('`/briefs/YYYY-MM-DD`')
    expect(llmsTxt()).toContain('`/options/SYMBOL`')
  })

  it('gives an existing agent a setup path it runs itself, with nothing to register or restart', () => {
    expect(llmsTxt()).toContain(CONNECT_GUIDE_URL)
    const guide = connectGuide()
    expect(guide).toContain('--connector-only')
    expect(guide).toContain('If ~/.local/bin/spicytrade already exists, skip this step')
    expect(guide).toContain('Run ~/.local/bin/spicytrade connect from the user\'s current workspace')
    expect(guide).toContain('There is nothing to register with the agent and nothing to restart')
    // The agent uses it from its own shell, and an order is never part of setup.
    expect(guide).toContain('~/.local/bin/spicytrade tools')
    expect(guide).toContain('~/.local/bin/spicytrade call <name>')
    expect(guide).toContain('Do not place a trade as part of setup')
    // Nothing of the stdio server the command used to register is left to follow.
    for (const retired of ['connect_spicytrade', 'setup_required', 'spicytrade integration', 'claude mcp add']) expect(guide).not.toContain(retired)
  })

  it('carries the MCP guide in the full version, under the index rather than a second title', () => {
    const full = llmsFullTxt()
    expect(full.startsWith(llmsTxt())).toBe(true)
    expect(full).toContain('read_price_history')
    expect(full.match(/^# /gm)).toHaveLength(1)
  })
})
