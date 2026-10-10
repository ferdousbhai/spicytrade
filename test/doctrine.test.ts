import { describe, expect, it } from 'vitest'

/** The per-turn ceiling `test/mcp.test.ts` holds the whole advertised surface to. */
const SPICE_MCP_INSTRUCTIONS_CHAR_BUDGET = 1_500
import { SPICE_GUIDE, PLACE_BROKERAGE_ORDER_DESCRIPTION, spiceMcpInstructions } from '../src/server/doctrine'
import { createOptionContractFindTool } from '../src/server/brokerage-read-tools'
import { createBrokerageReconciliationTool } from '../src/server/brokerage-reconciliation'

/*
 * The doctrine's wording is free to change. What is pinned here is only what no schema, guard,
 * or state machine enforces, and what changes what reaches the reader if it is lost. The
 * doctrine is split: standing posture rides on the server's MCP `instructions`, and a
 * rule that belongs to one tool rides on that tool's description, where a model is choosing
 * whether to call it. Each half is pinned where it actually lives.
 */
describe('server instructions', () => {
  const signedIn = spiceMcpInstructions(true)
  const anonymous = spiceMcpInstructions(false)

  it('says the one thing about sizing that applies to every turn', () => {
    // The rest of the sizing posture moved into the trade-idea prompt, which costs nothing
    // until someone invokes it. What stays here is the part that governs any answer at all.
    for (const instructions of [signedIn, anonymous]) expect(instructions).toContain('recommend nothing')
  })

  it('states that the server, not the advice, decides admissibility', () => {
    for (const instructions of [signedIn, anonymous]) {
      expect(instructions).toContain('guards decide what is admissible')
    }
  })

  it('tells each tier only what is true of the surface it was given', () => {
    // An anonymous caller has no order tools, so placement working rules are a rule about a
    // refusal it cannot reach; a signed-in one is not waiting to be told what signing in would add.
    expect(anonymous).not.toContain('tick-aligned mid')
    expect(anonymous).not.toContain('broker credential')
    expect(anonymous).toContain('public tier')
    expect(signedIn).not.toContain('public tier')
    expect(signedIn.length).toBeLessThan(SPICE_MCP_INSTRUCTIONS_CHAR_BUDGET)
    expect(anonymous.length).toBeLessThan(signedIn.length)
    expect(signedIn).toContain('tick-aligned mid')
    expect(signedIn).toContain('several sells at once')
    expect(signedIn).toContain('Planned size is not a fill quantity')
    expect(PLACE_BROKERAGE_ORDER_DESCRIPTION).not.toContain('tick-aligned mid')
  })
})

describe('the guide', () => {
  it('ties the search side effect to the tier that has it', () => {
    // The guide is one text for every caller, and only the anonymous search admits a name. A
    // member told their lookup grows the universe would skip the tool that actually does.
    expect(SPICE_GUIDE).not.toContain('`search_symbols` has a side effect')
    expect(SPICE_GUIDE).toContain('plain broker lookup that admits nothing')
    expect(SPICE_GUIDE).toContain('`remember_symbols`')
  })

  it('does not promise that a searched name stays tracked', () => {
    // A search can be refused when protected rows fill the list and pruned later; the result's
    // `watchlisted` is what says whether this one was kept.
    expect(SPICE_GUIDE).not.toContain('from then on')
    expect(SPICE_GUIDE).toContain('admitted when the list has room')
    expect(SPICE_GUIDE).toContain('"watchlisted" field says whether it\n  was kept')
  })
})

describe('rules that ride on the tool they govern', () => {
  it('requires a current chain lookup before any specific contract is named', () => {
    // Kept on the tool rather than in instructions: it governs whether to call this tool, and
    // it guards a failure that actually occurred -- a named contract that did not exist.
    expect(createOptionContractFindTool({}).description)
      .toContain('Only contracts this tool returns exist')
  })

  it('forbids automatically retrying an ambiguous broker mutation', () => {
    expect(createBrokerageReconciliationTool({}, undefined).description)
      .toContain('never automatically retry an ambiguous broker mutation')
  })
})

describe('prompt arguments', () => {
  it('carries the caller-supplied thesis into the prompt without reinterpreting it', async () => {
    const { tradeIdeaPrompt } = await import('../src/server/doctrine')
    for (const signedIn of [true, false]) {
      const prompt = tradeIdeaPrompt('NVDA', 'Supply constraints ease into the print', signedIn)
      expect(prompt).toContain('NVDA')
      expect(prompt).toContain('Supply constraints ease into the print')
      // The sizing posture lives here now, where it is free until someone asks for it.
      expect(prompt).toContain('Fractional Kelly is a ceiling')
      // The drawdown budget was replaced by the debit limit; no prompt may send an agent to it.
      expect(prompt).not.toMatch(/loss budget|drawdown/i)
    }
  })

  it('describes the order guards only to a caller who can place, and no account tool to one who cannot', async () => {
    const { tradeIdeaPrompt } = await import('../src/server/doctrine')
    const member = tradeIdeaPrompt('NVDA', 'thesis', true)
    expect(member).toContain('the most a new position can lose is the debit paid')
    expect(member).toContain('dry-run')
    expect(member).toContain('read_account_snapshot')
    const anonymous = tradeIdeaPrompt('NVDA', 'thesis', false)
    expect(anonymous).not.toMatch(/read_account|account's|dry-run/)
  })
})
