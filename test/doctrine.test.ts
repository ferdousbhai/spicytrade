import { describe, expect, it } from 'vitest'

describe('prompt arguments', () => {
  it('carries the caller-supplied thesis into the prompt without reinterpreting it', async () => {
    const { tradeIdeaPrompt } = await import('../src/server/doctrine')
    for (const signedIn of [true, false]) {
      const prompt = tradeIdeaPrompt('NVDA', 'Supply constraints ease into the print', signedIn)
      expect(prompt).toContain('NVDA')
      expect(prompt).toContain('Supply constraints ease into the print')
    }
  })

  it('describes the order guards only to a caller who can place, and no account tool to one who cannot', async () => {
    const { tradeIdeaPrompt } = await import('../src/server/doctrine')
    const member = tradeIdeaPrompt('NVDA', 'thesis', true)
    expect(member).toContain('dry-run')
    expect(member).toContain('read_account_snapshot')
    const anonymous = tradeIdeaPrompt('NVDA', 'thesis', false)
    expect(anonymous).not.toMatch(/read_account|account's|dry-run/)
  })
})
