import { describe, expect, it } from 'vitest'

import { MAX_WATCHLIST_SYMBOLS } from '../src/domain/watchlist'
import {
  WatchlistActionSchema,
  OrderPlacementSchema,
  parseFreshOrderPlacement,
  parseOrderPlacement,
} from '../src/server/agent-contracts'
import { toolErrorResult } from '../src/server/agent-tool-result'
import { CallerVisibleError } from '../src/server/caller-visible-error'
import { type JsonValue } from '../src/domain/json-payload'

describe('brokerage input boundary', () => {
  it('accepts a fully specified option order', () => {
    expect(OrderPlacementSchema.parse({
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: '2026-09-18', action: 'Buy to Open', quantity: 1, limitPrice: 5.2,
      priceEffect: 'Debit',
    }).kind).toBe('place_option_order')
  })

  it('leaves quantity authorization to the fresh portfolio guard', () => {
    expect(OrderPlacementSchema.safeParse({
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: '2026-09-18', action: 'Buy to Open', quantity: 101, limitPrice: 5.2,
      priceEffect: 'Debit',
    }).success).toBe(true)
    expect(OrderPlacementSchema.safeParse({
      kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open', quantity: 10_001,
      limitPrice: 1, priceEffect: 'Debit',
    }).success).toBe(true)
  })

  it('accepts only bounded debit verticals and price-only replacements', () => {
    expect(OrderPlacementSchema.parse({
      kind: 'place_vertical_spread_order', underlying: 'SPY', optionType: 'C',
      expiry: '2026-09-18', longStrike: 700, shortStrike: 710,
      quantity: 2, limitPrice: 3.5, priceEffect: 'Debit',
    }).kind).toBe('place_vertical_spread_order')
    expect(OrderPlacementSchema.safeParse({
      kind: 'place_vertical_spread_order', underlying: 'SPY', optionType: 'C',
      expiry: '2026-09-18', longStrike: 710, shortStrike: 700,
      quantity: 2, limitPrice: 3.5, priceEffect: 'Debit',
    }).success).toBe(false)
    // A debit at or above the width is a structure that cannot profit, whatever the model said.
    expect(OrderPlacementSchema.safeParse({
      kind: 'place_vertical_spread_order', underlying: 'SPY', optionType: 'C',
      expiry: '2026-09-18', longStrike: 700, shortStrike: 710,
      quantity: 2, limitPrice: 10, priceEffect: 'Debit',
    }).success).toBe(false)
    expect(OrderPlacementSchema.parse({ kind: 'replace_order', orderId: '12345', limitPrice: 3.55 }).kind)
      .toBe('replace_order')
  })

  it('rejects incomplete or inconsistent orders', () => {
    expect(() => OrderPlacementSchema.parse({
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: 'tomorrow', action: 'Buy to Open', quantity: 1_000, limitPrice: -1,
      priceEffect: 'Debit',
    })).toThrow()
    expect(OrderPlacementSchema.safeParse({
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700,
      expiry: '2026-09-18', action: 'Sell to Open', quantity: 1, limitPrice: 5,
      priceEffect: 'Debit',
    }).success).toBe(false)
    expect(OrderPlacementSchema.safeParse({
      kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open', quantity: 2_501,
      limitPrice: 1.999, priceEffect: 'Debit',
    }).success).toBe(false)
    expect(OrderPlacementSchema.safeParse({
      kind: 'place_equity_order', symbol: '.SPY', action: 'Buy to Open', quantity: 1,
      limitPrice: 1, priceEffect: 'Debit',
    }).success).toBe(false)
  })

  it('names the refinement a published schema cannot carry instead of surfacing a bare ZodError', () => {
    const vertical = {
      kind: 'place_vertical_spread_order', underlying: 'SPY', optionType: 'C', expiry: '2026-09-18',
      longStrike: 710, shortStrike: 700, quantity: 1, limitPrice: 2, priceEffect: 'Debit',
    }
    const refusal = (input: JsonValue, parse = parseOrderPlacement): Error => {
      try {
        parse(input)
      } catch (error) {
        if (error instanceof Error) return error
      }
      throw new Error('expected a refusal')
    }

    const credit = refusal(vertical)
    expect(credit).toBeInstanceOf(CallerVisibleError)
    expect(toolErrorResult('place_brokerage_order', credit).content[0]?.text)
      .toBe('OrderPlacement:invalid-longStrike: The long strike must define a debit vertical.')
    expect(refusal({ ...vertical, longStrike: 700, shortStrike: 705, limitPrice: 5 }, parseFreshOrderPlacement))
      .toMatchObject({ message: 'OrderPlacement:invalid-limitPrice: The debit must be less than the spread width.' })
    const direction = refusal({
      kind: 'place_equity_order', symbol: 'SPY', action: 'Sell to Open', quantity: 1, limitPrice: 5, priceEffect: 'Debit',
    })
    expect(direction).toMatchObject({
      message: 'OrderPlacement:invalid-priceEffect: A Buy action requires a debit and a Sell action requires a credit.',
    })
    // A built-in issue is named by its code; its message can describe the input, so it stays out.
    const mistyped = refusal({ ...vertical, quantity: 'lots' })
    expect(mistyped.message).toBe('OrderPlacement:invalid-quantity: invalid_type')
  })

  it('accepts only bounded mutations for the single internal watchlist', () => {
    const symbols = Array.from({ length: MAX_WATCHLIST_SYMBOLS }, (_, index) => `T${index}`)
    expect(WatchlistActionSchema.parse({
      kind: 'add_watchlist_symbols', symbols: ['NVDA', 'SPY'],
    }).kind).toBe('add_watchlist_symbols')
    expect(WatchlistActionSchema.safeParse({
      kind: 'add_watchlist_symbols', symbols,
    }).success).toBe(true)
    expect(WatchlistActionSchema.safeParse({
      kind: 'add_watchlist_symbols', symbols: [...symbols, 'OVER'],
    }).success).toBe(false)
    expect(WatchlistActionSchema.safeParse({
      kind: 'remove_watchlist_symbols', watchlistName: '../private', symbols: ['NVDA'],
    }).success).toBe(false)
    expect(WatchlistActionSchema.safeParse({
      kind: 'delete_watchlist', watchlistName: 'Old recommendations',
    }).success).toBe(false)
    expect(WatchlistActionSchema.safeParse({
      kind: 'rename_watchlist', watchlistName: 'Long vol', newName: 'Core recommendations',
    }).success).toBe(false)
  })
})
