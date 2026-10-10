import { z } from 'zod'

/**
 * Provider-neutral brokerage account vocabulary. Nothing here knows a REST path, a
 * provider field name, or a wire envelope: an adapter under `src/server/brokers/`
 * translates one broker into these shapes, and every account reader above the adapter
 * speaks only this file. Adding a broker adds an adapter, never a second vocabulary
 * for the same thing.
 */

/**
 * Every broker spicytrade can read an account from. Adding one means adding it here and
 * registering its adapter — the header parser parses against this list and the production
 * registry is type-checked against it (`satisfies Record<BrokerId, BrokerAdapter>`), so a new
 * id cannot be half-added and silently accepted by one and refused by the other.
 */
export const BrokerIdSchema = z.enum(['tastytrade'])

export type BrokerId = z.infer<typeof BrokerIdSchema>

/**
 * The longest broker order or record id spicytrade accepts. tastytrade issues these as integers, and
 * 40 characters holds the decimal form of any 128-bit value (39 digits) with room to spare; the
 * bound exists so an id read from a broker or a model cannot carry a payload into a URL path,
 * a stored row, or model context. Reads that report what the broker wrote apply the length;
 * ids spicytrade sends or trusts as an order's identity must also be all digits.
 */
export const BROKER_ORDER_ID_MAX_LENGTH = 40
export const BROKER_ORDER_ID = new RegExp(`^\\d{1,${BROKER_ORDER_ID_MAX_LENGTH}}$`)

/**
 * The longest symbol spicytrade reads from a broker row: a position, order leg, transaction or
 * quote of any instrument type, not only an equity. Like the order-id bound, it keeps text a
 * broker reports from carrying a payload into a stored row or model context. Why 128 in
 * particular is not recorded; it was carried over from the reads that first applied it.
 */
export const BROKER_SYMBOL_MAX_LENGTH = 128

/** The one account a presented credential resolves to. */
export interface BrokerAccountRef {
  accountNumber: string
  broker: BrokerId
}

export interface BrokerBalances {
  availableTradingFunds: number
  cashAvailableToWithdraw: number
  cashBalance: number
  dayTradingBuyingPower: number
  derivativeBuyingPower: number
  equityBuyingPower: number
  netLiquidatingValue: number
}

export interface BrokerPosition {
  averageOpenPrice?: number
  direction: 'Long' | 'Short'
  expiresAt?: string
  instrumentType: string
  quantity: number
  symbol: string
  underlying: string
}

interface BrokerOrderLeg {
  action: string
  instrumentType: string
  quantity: number
  symbol: string
}

export interface BrokerWorkingOrder {
  complexOrderId?: string
  id: string
  legs: BrokerOrderLeg[]
  price?: number
  priceEffect?: string
  status: string
  symbol: string
  timeInForce?: string
  type: string
}

/**
 * One completeness-checked account read. `orders` expands complex orders into their working
 * legs and dedupes them by id; the portfolio guard refuses the whole snapshot when any of the
 * position, balance, or live-order pages cannot be shown to be complete.
 */
export interface BrokerAccountSnapshot {
  asOf: string
  balances: BrokerBalances
  orders: BrokerWorkingOrder[]
  positions: BrokerPosition[]
}

/**
 * One order read back for a fingerprint comparison — a price-only replacement's echo check
 * and the ambiguous-submission reconciliation match. Every field is optional on purpose:
 * these two checks decide for themselves what a missing or unreadable field means (almost
 * always "not a match"), exactly as they did when they read the broker's JSON directly.
 * An adapter must not repair, default, or fail on a field here; it reports what it read.
 */
export interface BrokerOrderRecordLeg {
  action?: string
  /** Number of fills the broker reported, or undefined when it reported no readable fill list. */
  fillCount?: number
  instrumentType?: string
  quantity?: number
  remainingQuantity?: number
  symbol?: string
}

export interface BrokerOrderRecord {
  /** True only when the broker positively said the order is editable. */
  editable: boolean
  id?: string
  /** Undefined when the row carried no readable leg list; an entry is undefined when that leg was unreadable. */
  legs?: Array<BrokerOrderRecordLeg | undefined>
  orderType?: string
  price?: number
  priceEffect?: string
  receivedAt?: string
  /** True when the broker positively refused the order. Decided in the adapter, as `terminal` is. */
  rejected: boolean
  replacesOrderId?: string
  status?: string
  /**
   * True when the broker said the order is finished (filled, cancelled, rejected, expired or
   * removed, or stamped with a terminal time). Decided in the adapter from the provider's own
   * status words, so nothing above the adapter matches a provider string. False covers an
   * unfamiliar status too: only a verified terminal state is terminal.
   */
  terminal: boolean
  timeInForce?: string
  updatedAt?: string
}

/**
 * One page of order history for reconciliation. `complete` is false whenever the page
 * could still be hiding rows, so an absent order stays ambiguous rather than concluding
 * the submission never reached the broker.
 */
export interface BrokerOrderHistoryPage {
  complete: boolean
  orders: BrokerOrderRecord[]
}

export interface BrokerHistoryOrderLeg {
  action: string
  instrumentType: string
  quantity: number
  remainingQuantity?: number
  symbol: string
}

export interface BrokerHistoryOrder {
  id: string
  legs: BrokerHistoryOrderLeg[]
  orderType: string
  price?: number
  priceEffect?: string
  receivedAt?: string
  rejectReason?: string
  size?: number
  status: string
  timeInForce: string
  underlyingInstrumentType: string
  underlyingSymbol: string
  updatedAt: string
}

export interface BrokerHistoryTransaction {
  action?: string
  id: string
  instrumentType?: string
  netValue?: number
  occurredAt: string
  orderId?: string
  price?: number
  quantity?: number
  symbol?: string
  transactionSubType?: string
  transactionType: string
  underlyingSymbol?: string
  value?: number
}

/**
 * One page of account history as the read tool asked for it. `rowCount` is how many rows
 * the broker actually returned before the tool's own display limit, which is what makes
 * truncation observable rather than a silently short list.
 */
export interface BrokerAccountHistoryPage {
  items: BrokerHistoryOrder[] | BrokerHistoryTransaction[]
  rowCount: number
  totalItemCount?: number
}
