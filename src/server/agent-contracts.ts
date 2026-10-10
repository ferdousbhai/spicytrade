import { z } from 'zod'

import { BROKER_ORDER_ID } from '../domain/broker'
import { EquitySymbolSchema } from '../domain/instrument'
import { ISO_DATE_REGEX } from '../domain/iso-date'
import { type JsonValue } from '../domain/json-payload'
import { zodTypeBoxSchema } from './zod-typebox'
import { CallerVisibleError } from './caller-visible-error'

import {
  AddWatchlistSymbolsSchema,
  RemoveWatchlistSymbolsSchema,
} from '../domain/watchlist'

/** Exact tastytrade leg actions, as the order placement contract advertises them. */
const OrderLegActionSchema = z.enum(['Buy to Open', 'Sell to Open', 'Buy to Close', 'Sell to Close'])

const OrderIdSchema = z.string().regex(BROKER_ORDER_ID)
const ExpiryDateSchema = z.string().regex(ISO_DATE_REGEX)
/** Limit prices are whole cents; the broker rejects finer increments. */
const LimitPriceSchema = z.number().positive().multipleOf(0.01)
// Quantity has no independent product ceiling. Fresh account state, contract
// multipliers, and closing inventory decide what is safe.
const QuantitySchema = z.number().int().positive()

const OptionActionSchema = z.object({
  kind: z.literal('place_option_order'),
  underlying: EquitySymbolSchema,
  optionType: z.enum(['C', 'P']),
  strike: z.number().positive(),
  expiry: ExpiryDateSchema,
  action: OrderLegActionSchema,
  quantity: QuantitySchema,
  limitPrice: LimitPriceSchema,
  priceEffect: z.enum(['Debit', 'Credit']),
})

const EquityActionSchema = z.object({
  kind: z.literal('place_equity_order'),
  symbol: EquitySymbolSchema,
  action: OrderLegActionSchema,
  quantity: QuantitySchema,
  limitPrice: LimitPriceSchema,
  priceEffect: z.enum(['Debit', 'Credit']),
})

const VerticalSpreadActionSchema = z.object({
  kind: z.literal('place_vertical_spread_order'),
  underlying: EquitySymbolSchema,
  optionType: z.enum(['C', 'P']),
  expiry: ExpiryDateSchema,
  longStrike: z.number().positive(),
  shortStrike: z.number().positive(),
  quantity: QuantitySchema,
  limitPrice: LimitPriceSchema,
  priceEffect: z.literal('Debit'),
}).superRefine((action, context) => {
  const isDebitVertical = action.optionType === 'C'
    ? action.longStrike < action.shortStrike
    : action.longStrike > action.shortStrike
  if (!isDebitVertical) {
    context.addIssue({ code: 'custom', message: 'The long strike must define a debit vertical.', path: ['longStrike'] })
  }
  if (action.limitPrice >= Math.abs(action.shortStrike - action.longStrike)) {
    context.addIssue({ code: 'custom', message: 'The debit must be less than the spread width.', path: ['limitPrice'] })
  }
})

const ReplaceOrderActionSchema = z.object({
  kind: z.literal('replace_order'),
  orderId: OrderIdSchema,
  limitPrice: LimitPriceSchema,
})

/** Cancelling one working order: the broker's own order id and nothing else. */
export const CancelOrderSchema = z.strictObject({ orderId: OrderIdSchema })

export const CancelOrderParameters = zodTypeBoxSchema(CancelOrderSchema)

/**
 * A single-leg open or close must name the price effect its direction implies. Shared so the
 * fresh-order union and the full placement union enforce it identically.
 */
function requireDirectionalPriceEffect(
  action: { kind: string } & Partial<{ action: string; priceEffect: string }>,
  context: z.RefinementCtx,
): void {
  if (!action.action || !action.priceEffect) return
  // A vertical carries no single direction and a replacement changes only price, so neither
  // names an action or an effect to reconcile.
  const expectedEffect = action.action.startsWith('Buy') ? 'Debit' : 'Credit'
  if (action.priceEffect !== expectedEffect) {
    // Fixed wording: this message reaches the caller, and it names the rule rather than
    // repeating the value it was given.
    context.addIssue({
      code: 'custom',
      message: 'A Buy action requires a debit and a Sell action requires a credit.',
      path: ['priceEffect'],
    })
  }
}

const FreshOrderPlacementSchema = z.discriminatedUnion('kind', [
  OptionActionSchema,
  EquityActionSchema,
  VerticalSpreadActionSchema,
]).superRefine(requireDirectionalPriceEffect)

/**
 * One discriminated union of four, not a union of a union: nesting them made the advertised
 * JSON Schema an `anyOf` wrapping a `oneOf`, which is both larger on every request and harder
 * for a model to satisfy than a flat discriminated union keyed on `kind`.
 */
export const OrderPlacementSchema = z.discriminatedUnion('kind', [
  OptionActionSchema,
  EquityActionSchema,
  VerticalSpreadActionSchema,
  ReplaceOrderActionSchema,
]).superRefine(requireDirectionalPriceEffect)

/** The model and security boundary share one order contract; Zod refinements run again before storage. */
export const OrderPlacementParameters = zodTypeBoxSchema(OrderPlacementSchema)

/**
 * The refusal for an order that fails the contract at the trust boundary.
 *
 * The published JSON Schema cannot carry the refinements (a debit vertical, a debit below the
 * spread width, direction against price effect), so an order the transport admitted can still
 * fail here, and a bare ZodError reaches the caller as its name alone. The check is named by the
 * schema's own field path, and only a refinement's message -- written in this file -- is passed
 * on; a built-in issue is named by its code, since its message can describe the input.
 */
function orderContractRefusal(error: z.ZodError): CallerVisibleError {
  const issue = error.issues[0]
  const field = issue?.path.map(String).join('.') || 'order'
  const reason = issue?.code === 'custom' ? issue.message : (issue?.code ?? 'invalid')
  return new CallerVisibleError(`OrderPlacement:invalid-${field}: ${reason}`)
}

/** An order from a caller, refused in this repository's words when it breaks the contract. */
export function parseOrderPlacement(untrusted: JsonValue): OrderPlacement {
  const parsed = OrderPlacementSchema.safeParse(untrusted)
  if (!parsed.success) throw orderContractRefusal(parsed.error)
  return parsed.data
}

/** A fresh order assembled from caller input (a replacement's new price), refused the same way. */
export function parseFreshOrderPlacement(untrusted: JsonValue): FreshOrderPlacement {
  const parsed = FreshOrderPlacementSchema.safeParse(untrusted)
  if (!parsed.success) throw orderContractRefusal(parsed.error)
  return parsed.data
}

export const StoredOrderPlacementSchema = z.union([
  FreshOrderPlacementSchema,
  ReplaceOrderActionSchema.extend({ replacementOrder: FreshOrderPlacementSchema }),
])

/**
 * Watchlist mutation only. Cancelling an order used to share this union, back when one chat
 * tool dispatched every direct account action; it is now its own tool with its own contract,
 * because the two need different authority — cancelling touches one member's account, while
 * removing a symbol changes what every reader sees.
 */
export const WatchlistActionSchema = z.discriminatedUnion('kind', [
  AddWatchlistSymbolsSchema,
  RemoveWatchlistSymbolsSchema,
])

export const WatchlistActionParameters = zodTypeBoxSchema(WatchlistActionSchema)

export type FreshOrderPlacement = z.infer<typeof FreshOrderPlacementSchema>
export type OrderPlacement = z.infer<typeof OrderPlacementSchema>
export type StoredOrderPlacement = z.infer<typeof StoredOrderPlacementSchema>
