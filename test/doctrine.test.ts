import { describe, expect, it } from 'vitest'

import { tradeIdeaPrompt } from '../src/server/doctrine'

describe('prompt arguments', () => {
  it('carries the caller-supplied thesis into the prompt without reinterpreting it', () => {
    for (const signedIn of [true, false]) {
      const prompt = tradeIdeaPrompt('NVDA', 'Supply constraints ease into the print', signedIn)
      expect(prompt).toContain('NVDA')
      expect(prompt).toContain('Supply constraints ease into the print')
    }
  })

  it('describes the order guards only to a caller who can place, and no account tool to one who cannot', () => {
    const member = tradeIdeaPrompt('NVDA', 'thesis', true)
    expect(member).toContain('dry-run')
    expect(member).toContain('read_account_snapshot')
    const anonymous = tradeIdeaPrompt('NVDA', 'thesis', false)
    expect(anonymous).not.toMatch(/read_account|account's|dry-run/)
  })
})
