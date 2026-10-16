import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import {
  EQUITY_SYMBOL_PATTERN,
  equitySymbolFromModelText,
  equitySymbolsFromModelText,
  EquitySymbolSchema,
  MAX_EQUITY_SYMBOL_LENGTH,
  MODEL_TEXT_EQUITY_SYMBOL_PATTERN,
} from '../src/domain/instrument'
import { WatchlistActionParameters } from '../src/server/agent-contracts'
import {
  AccountHistoryReadParameters,
  InstrumentQuoteReadParameters,
  MarketMetricsReadParameters,
  OptionContractFindParameters,
  SymbolSearchParameters,
} from '../src/server/brokerage-read-contracts'
import { PriceHistoryReadParameters } from '../src/server/market-research-contracts'
import { ExactOptionGreeksReadParameters } from '../src/server/option-greeks-tool'
import { WatchlistReadParameters } from '../src/server/watchlist-tool'

type SchemaNode = {
  anyOf?: SchemaNode[]
  items?: SchemaNode
  oneOf?: SchemaNode[]
  pattern?: string
  properties?: Record<string, SchemaNode>
}

const SchemaNodeSchema: z.ZodType<SchemaNode> = z.lazy(() => z.looseObject({
  anyOf: z.array(SchemaNodeSchema).optional(),
  items: SchemaNodeSchema.optional(),
  oneOf: z.array(SchemaNodeSchema).optional(),
  pattern: z.string().optional(),
  properties: z.record(z.string(), SchemaNodeSchema).optional(),
}))

function advertisedPatterns(node: SchemaNode): string[] {
  return [
    ...(node.anyOf ?? []).flatMap(advertisedPatterns),
    ...node.pattern === undefined ? [] : [node.pattern],
    ...node.items === undefined ? [] : advertisedPatterns(node.items),
    ...(node.oneOf ?? []).flatMap(advertisedPatterns),
    ...Object.values(node.properties ?? {}).flatMap(advertisedPatterns),
  ]
}

/**
 * The equity symbol rule is a single source of truth. Every tool contract, Zod schema, and
 * D1 constraint follows `EQUITY_SYMBOL_PATTERN`; a second copy anywhere is the bug this
 * file exists to catch.
 */
describe('equity symbol rule', () => {
  it('advertises the strict symbol shape, and the model-text one only where text is the source', () => {
    const patterns = [
      AccountHistoryReadParameters, InstrumentQuoteReadParameters, MarketMetricsReadParameters,
      OptionContractFindParameters, SymbolSearchParameters, WatchlistActionParameters,
      ExactOptionGreeksReadParameters, PriceHistoryReadParameters, WatchlistReadParameters,
    ].flatMap((contract) => advertisedPatterns(SchemaNodeSchema.parse(contract)))

    const equityPatterns = patterns.filter((pattern) => {
      const rule = new RegExp(pattern)
      return rule.test('AAPL') && !rule.test('/ES')
    })
    expect(equityPatterns.length).toBeGreaterThan(1)
    // Zod escapes `/` when serializing its RegExp to JSON Schema; JSON Schema has
    // no slash delimiters, so the spellings are equivalent.
    // Two shapes, deliberately: contracts fed by the owner's own words take the strict
    // symbol, and the discovery-facing reads take the one that also reads X's cashtag.
    // Anything beyond these two is drift.
    expect(new Set(equityPatterns.map((pattern) => pattern.replaceAll('\\/', '/'))))
      .toEqual(new Set([EQUITY_SYMBOL_PATTERN, MODEL_TEXT_EQUITY_SYMBOL_PATTERN]))
  })

  it('normalizes case and surrounding whitespace before matching', () => {
    expect(EquitySymbolSchema.parse('  nvda ')).toBe('NVDA')
  })

  it('admits nothing longer than the length migration 0014 bounds D1 to', () => {
    const longest = `${'A'.repeat(6)}/${'B'.repeat(3)}`
    expect(longest).toHaveLength(MAX_EQUITY_SYMBOL_LENGTH)
    expect(EquitySymbolSchema.parse(longest)).toBe(longest)
    expect(EquitySymbolSchema.safeParse(`${longest}C`).success).toBe(false)
  })

  // https://developer.tastytrade.com/api-overview/#tastytrade-symbology: "Equity symbols
  // contain only alphanumeric characters (A-Z, 0-9) with an occasional `/`."
  it.each([
    ['AAPL', 'the documented plain example'],
    ['BRK/A', 'the documented class-share example'],
    ['BRK/B', 'the class share spicytrade actually holds'],
    ['V2X', 'a listed equity carrying a digit'],
    ['F', 'a single-character root'],
    ['GOOGL', 'a five-character root'],
  ])('accepts %s (%s)', (symbol) => {
    expect(EquitySymbolSchema.parse(symbol)).toBe(symbol)
  })

  it.each([
    ['BRK.B', 'the NASDAQ dot rendering the broker 404s on'],
    ['BRK-B', "Yahoo's dash rendering"],
    ['/ES', 'a futures symbol, which never enters an equity field'],
    ['BRK/', 'a trailing slash'],
    ['A/B/C', 'more than one slash'],
    ['ABCDEFG', 'a root wider than the OCC root field'],
    ['SPY   221118C00400000', 'an OCC option symbol'],
    ['BRK B', 'a space'],
    ['', 'an empty symbol'],
  ])('rejects %s (%s)', (symbol) => {
    expect(EquitySymbolSchema.safeParse(symbol).success).toBe(false)
  })
})

describe('reading a symbol out of model text', () => {
  it.each([
    ['NXE', 'NXE'],
    ['$NXE', 'NXE'],
    ['$nxe', 'NXE'],
    [' $NXE ', 'NXE'],
    ['brk/a', 'BRK/A'],
  ])('reads %s as %s', (written, expected) => {
    expect(equitySymbolFromModelText(written)).toBe(expected)
  })

  it.each(['BRK.B', '#NXE', 'NXE.TO', 'TOOLONGSYMBOL', 'SoFi Technologies', ''])('refuses %s', (written) => {
    // Only the convention the owner named is read; any other venue's notation stays a
    // visible refusal rather than being guessed at.
    expect(equitySymbolFromModelText(written)).toBeUndefined()
  })

  it('reads a list, or names the first unreadable value', () => {
    expect(equitySymbolsFromModelText(['$nvda', 'AAPL'])).toEqual({ symbols: ['NVDA', 'AAPL'] })
    expect(equitySymbolsFromModelText(['NVDA', 'BRK.B'])).toEqual({ unreadable: 'BRK.B' })
  })
})
