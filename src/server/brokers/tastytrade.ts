import {
  BROKER_SYMBOL_MAX_LENGTH,
  type BrokerAccountHistoryPage,
  type BrokerAccountRef,
  type BrokerAccountSnapshot,
  type BrokerHistoryOrder,
  type BrokerHistoryOrderLeg,
  type BrokerHistoryTransaction,
  type BrokerOrderHistoryPage,
  type BrokerOrderRecord,
  type BrokerOrderRecordLeg,
  type BrokerPosition,
  type BrokerWorkingOrder,
} from '../../domain/broker'
import {
  JsonArraySchema,
  jsonLooseText,
  jsonNumber,
  jsonObject,
  jsonText,
  type JsonObject,
  type JsonValue,
} from '../../domain/json-payload'
import { MAX_HISTORY_ITEMS, MAX_HISTORY_ORDER_LEGS } from '../brokerage-read-contracts'
import {
  finiteNumber,
  invalidResponse,
  itemEnvelope,
  optionalDate,
  optionalNumber,
  optionalText,
  optionalTimestamp,
  requiredIdentifier,
  requiredText,
  requiredTimestamp,
} from '../brokerage-read-normalization'
import { type BrokerCredential } from '../broker-credential'
import { errorName, failureCode, toError } from '../../domain/failure'
import { type AppEnv } from '../env'
import { brokerApi } from '../tastytrade'
import {
  BrokerCancellationAmbiguousError,
  BrokerSnapshotError,
  type BrokerAdapter,
  type BrokerHistoryQuery,
  type BrokerSnapshotPart,
} from './contract'
import {
  accountBalancesFromPayload,
  BROKER_ACCOUNT_PAGE_SIZE,
  completeAccountRows,
  isWorkingOrderRecord,
  workingOrderRecords,
} from './tastytrade-payload'
import { CallerVisibleError } from '../caller-visible-error'

// The reconciliation history request asks for one page this wide; `readOrderHistory`
// treats a page that did not fill as the whole history, so this is the completeness
// boundary for deciding that an ambiguous submission never reached the broker. A named product
// bound, the owner's choice: a hundred recent orders spans the reconciliation window
// (`FINAL_ABSENCE_DELAY_MS`) many times over for any account spicytrade expects to reconcile.
const RECONCILIATION_HISTORY_PAGE_SIZE = 100

/**
 * What of a record-parsing failure may reach the caller. Only this repository's own codes pass;
 * anything else -- a TypeError or ZodError from a parser, whose message can quote the payload --
 * is reported by its name alone.
 */
function detail(cause: unknown): string {
  const error = toError(cause)
  return failureCode(error) ?? errorName(error)
}

/**
 * `completeAccountRows` names its own failure (`TastytradeAccount:incomplete-positions`
 * and friends). Those names reach a caller-visible message through the portfolio guard and
 * the account snapshot tool, so they are carried verbatim and only tagged with which read
 * they came from.
 */
function accountRows(payload: JsonValue, part: BrokerSnapshotPart): JsonObject[] {
  try {
    return completeAccountRows(payload, part)
  } catch (cause) {
    throw new BrokerSnapshotError(part, 'page', detail(cause))
  }
}

function positionFromRecord(row: JsonObject): BrokerPosition | undefined {
  const symbol = jsonText(row.symbol)
  const underlying = jsonText(row['underlying-symbol'])?.toUpperCase()
  const quantity = jsonNumber(row.quantity)
  const direction = jsonText(row['quantity-direction'])
  const instrumentType = jsonText(row['instrument-type'])
  if (!symbol || !underlying || quantity === undefined || quantity < 0 || !instrumentType) {
    throw new Error('TastytradeAccount:invalid-position')
  }
  // A flat row holds nothing, and tastytrade labels its direction `Zero`, so it is skipped
  // before the direction check an open position must pass. Any other word is still refused.
  if (quantity === 0 && (direction === 'Zero' || direction === 'Long' || direction === 'Short')) return undefined
  if (quantity === 0 || (direction !== 'Long' && direction !== 'Short')) {
    throw new Error('TastytradeAccount:invalid-position')
  }
  const averageOpenPrice = jsonNumber(row['average-open-price'])
  if (row['average-open-price'] !== undefined && row['average-open-price'] !== null
    && averageOpenPrice === undefined) throw new Error('TastytradeAccount:invalid-position-average-open-price')
  const rawExpiry = jsonText(row['expires-at'])
  if (row['expires-at'] !== undefined && row['expires-at'] !== null
    && (!rawExpiry || !Number.isFinite(Date.parse(rawExpiry)))) {
    throw new Error('TastytradeAccount:invalid-position-expiry')
  }
  const position: BrokerPosition = { direction, instrumentType, quantity, symbol, underlying }
  if (averageOpenPrice !== undefined) position.averageOpenPrice = averageOpenPrice
  if (rawExpiry) position.expiresAt = rawExpiry
  return position
}

function normalizedPositions(payload: JsonValue): BrokerPosition[] {
  const rows = accountRows(payload, 'positions')
  try {
    return rows.flatMap((row) => {
      const position = positionFromRecord(row)
      return position ? [position] : []
    })
  } catch (cause) {
    throw new BrokerSnapshotError('positions', 'record', detail(cause))
  }
}

function expandedOrders(rows: readonly JsonObject[], part: BrokerSnapshotPart): BrokerWorkingOrder[] {
  try {
    return rows.flatMap(workingOrderRecords)
  } catch (cause) {
    throw new BrokerSnapshotError(part, 'record', detail(cause))
  }
}

function normalizedOrders(ordinaryPayload: JsonValue, complexPayload: JsonValue): BrokerWorkingOrder[] {
  const expanded = [
    ...expandedOrders(accountRows(ordinaryPayload, 'orders'), 'orders'),
    ...expandedOrders(accountRows(complexPayload, 'complex-orders'), 'complex-orders'),
  ]
  return [...new Map(expanded.map((order) => [order.id, order])).values()]
}

async function resolveAccountRef(
  env: AppEnv,
  credential: BrokerCredential | undefined,
): Promise<BrokerAccountRef> {
  // Account discovery is transport -- the customer-accounts read beside `tastyRequest` on the
  // `brokerApi()` seam. The adapter owns the ref shape every account reader above it uses,
  // placement and cancellation included.
  return { accountNumber: await brokerApi().resolveAccountNumber(env, credential), broker: 'tastytrade' }
}

async function loadAccountSnapshot(
  env: AppEnv,
  ref: BrokerAccountRef,
  credential: BrokerCredential | undefined,
): Promise<BrokerAccountSnapshot> {
  const account = encodeURIComponent(ref.accountNumber)
  // Transport failures propagate untouched. "The broker would not answer" is a different
  // fact from "the broker answered something we refuse to believe", and only the second
  // arrives as a BrokerSnapshotError; callers report them differently.
  const [positionPayload, balancePayload, orderPayload, complexOrderPayload] = await Promise.all([
    brokerApi().tastyRequest(env, `/accounts/${account}/positions?per-page=${BROKER_ACCOUNT_PAGE_SIZE}`, {}, credential),
    brokerApi().tastyRequest(env, `/accounts/${account}/balances`, {}, credential),
    brokerApi().tastyRequest(env, `/accounts/${account}/orders/live?per-page=${BROKER_ACCOUNT_PAGE_SIZE}`, {}, credential),
    brokerApi().tastyRequest(env, `/accounts/${account}/complex-orders/live?per-page=${BROKER_ACCOUNT_PAGE_SIZE}`, {}, credential),
  ])
  // Positions are parsed first, then balances, then orders, so the failure a caller sees is the
  // same whichever of the other pages is also malformed.
  const positions = normalizedPositions(positionPayload)
  let balances
  try {
    balances = accountBalancesFromPayload(balancePayload, ref.accountNumber)
  } catch (cause) {
    throw new BrokerSnapshotError('balances', 'record', detail(cause))
  }
  return {
    asOf: new Date().toISOString(),
    balances,
    positions,
    orders: normalizedOrders(orderPayload, complexOrderPayload),
  }
}

function historyOrderLeg(value: JsonValue): BrokerHistoryOrderLeg {
  const label = 'Tastytrade order history'
  const row = jsonObject(value) ?? invalidResponse(label)
  return {
    action: requiredText(row, ['action'], label, 64),
    instrumentType: requiredText(row, ['instrument-type'], label, 64),
    quantity: finiteNumber(row.quantity, label),
    remainingQuantity: optionalNumber(row, ['remaining-quantity'], label),
    symbol: requiredText(row, ['symbol'], label, BROKER_SYMBOL_MAX_LENGTH),
  }
}

function historyOrder(row: JsonObject): BrokerHistoryOrder {
  const label = 'Tastytrade order history'
  if (!Array.isArray(row.legs) || row.legs.length < 1 || row.legs.length > MAX_HISTORY_ORDER_LEGS) return invalidResponse(label)
  return {
    id: requiredIdentifier(row, 'id', label),
    legs: row.legs.map(historyOrderLeg),
    orderType: requiredText(row, ['order-type'], label, 64),
    price: optionalNumber(row, ['price'], label),
    priceEffect: optionalText(row, ['price-effect'], label, 32),
    receivedAt: optionalTimestamp(row, ['received-at'], label),
    rejectReason: optionalText(row, ['reject-reason'], label, 160),
    size: optionalNumber(row, ['size'], label),
    status: requiredText(row, ['status'], label, 64),
    timeInForce: requiredText(row, ['time-in-force'], label, 64),
    underlyingInstrumentType: requiredText(row, ['underlying-instrument-type'], label, 64),
    underlyingSymbol: requiredText(row, ['underlying-symbol'], label, 64),
    updatedAt: requiredTimestamp(row, ['updated-at'], label),
  }
}

function historyTransaction(row: JsonObject): BrokerHistoryTransaction {
  const label = 'Tastytrade transaction history'
  const transactionType = requiredText(row, ['transaction-type'], label, 64)
  const occurredAt = optionalTimestamp(row, ['executed-at'], label)
    ?? optionalDate(row, ['transaction-date'], label)
    ?? invalidResponse(label)
  const orderId = row['order-id'] === undefined || row['order-id'] === null
    ? undefined
    : requiredIdentifier(row, 'order-id', label)
  const signedMoney = (valueKey: string, effectKey: string) => {
    const value = optionalNumber(row, [valueKey], label)
    if (value === undefined) return undefined
    const effect = requiredText(row, [effectKey], label, 16)
    // tastytrade marks a zero-value row (an expiration, a receive/deliver) with effect `None`.
    // That is only coherent with a zero amount; `None` beside money that moved is refused.
    if (effect === 'None') return value === 0 ? 0 : invalidResponse(label)
    if (effect !== 'Debit' && effect !== 'Credit') return invalidResponse(label)
    return effect === 'Debit' ? -Math.abs(value) : Math.abs(value)
  }
  return {
    action: optionalText(row, ['action'], label, 64),
    id: requiredIdentifier(row, 'id', label),
    instrumentType: optionalText(row, ['instrument-type'], label, 64),
    netValue: signedMoney('net-value', 'net-value-effect'),
    occurredAt,
    orderId,
    price: optionalNumber(row, ['price'], label),
    quantity: optionalNumber(row, ['quantity'], label),
    symbol: optionalText(row, ['symbol'], label, BROKER_SYMBOL_MAX_LENGTH),
    transactionSubType: optionalText(row, ['transaction-sub-type'], label, 64),
    transactionType,
    underlyingSymbol: optionalText(row, ['underlying-symbol'], label, 64),
    value: signedMoney('value', 'value-effect'),
  }
}

async function readAccountHistory(
  env: AppEnv,
  ref: BrokerAccountRef,
  request: BrokerHistoryQuery,
  credential: BrokerCredential | undefined,
): Promise<BrokerAccountHistoryPage> {
  const query = new URLSearchParams({
    'page-offset': String(request.pageOffset),
    'per-page': String(request.limit),
    sort: 'Desc',
    'start-date': request.startDate,
  })
  if (request.underlyingSymbol) query.set('underlying-symbol', request.underlyingSymbol)
  if (request.transactionType) query.set('type', request.transactionType)
  let payload: JsonValue
  try {
    payload = await brokerApi().tastyRequest(
      env,
      `/accounts/${encodeURIComponent(ref.accountNumber)}/${request.type}?${query.toString()}`,
      {},
      credential,
    )
  } catch {
    throw new CallerVisibleError(`Tastytrade ${request.type} are unavailable.`)
  }
  const label = request.type === 'transactions' ? 'Tastytrade transaction history' : 'Tastytrade order history'
  // The envelope ceiling is deliberately wider than the model-context budget: it rejects an
  // anomalous upstream fan-out before normalization walks arbitrarily many rows.
  const envelope = itemEnvelope(payload, label, MAX_HISTORY_ITEMS * 2)
  const items = request.type === 'transactions'
    ? envelope.rows.map(historyTransaction)
    : envelope.rows.map(historyOrder)
  if (request.transactionType && items.some((item) => (
    'transactionType' in item && item.transactionType !== request.transactionType
  ))) return invalidResponse(label)
  const page: BrokerAccountHistoryPage = { items, rowCount: envelope.rows.length }
  if (envelope.totalItems !== undefined) page.totalItemCount = envelope.totalItems
  return page
}

function orderRecordLeg(value: JsonValue): BrokerOrderRecordLeg | undefined {
  const row = jsonObject(value)
  if (!row) return undefined
  const fills = JsonArraySchema.safeParse(row.fills).data
  return {
    action: jsonLooseText(row.action),
    fillCount: fills?.length,
    instrumentType: jsonLooseText(row['instrument-type']),
    quantity: jsonNumber(row.quantity),
    remainingQuantity: jsonNumber(row['remaining-quantity']),
    symbol: jsonLooseText(row.symbol),
  }
}

/**
 * Report an order row exactly as read, repairing nothing. The replacement echo check and
 * the reconciliation fingerprint decide for themselves what an unreadable field means, and
 * both must keep treating it as "not a match" rather than as a parse failure.
 */
export function tastytradeOrderRecord(row: JsonObject): BrokerOrderRecord {
  return {
    editable: row.editable === true,
    id: jsonLooseText(row.id),
    legs: JsonArraySchema.safeParse(row.legs).data?.map(orderRecordLeg),
    orderType: jsonLooseText(row['order-type']),
    price: jsonNumber(row.price),
    priceEffect: jsonLooseText(row['price-effect']),
    receivedAt: jsonLooseText(row['received-at']),
    rejected: jsonLooseText(row.status)?.toLowerCase() === 'rejected',
    replacesOrderId: jsonLooseText(row['replaces-order-id']),
    status: jsonLooseText(row.status),
    terminal: !isWorkingOrderRecord(row),
    timeInForce: jsonLooseText(row['time-in-force']),
    updatedAt: jsonLooseText(row['updated-at']),
  }
}

/** Unwrap the single-order envelope. Exported so the replacement echo check can be
 *  exercised against a real broker body rather than a hand-built record. */
export function tastytradeOrderFromPayload(payload: JsonValue): BrokerOrderRecord {
  const body = jsonObject(payload)
  const data = jsonObject(body?.data ?? payload)
  // A collection where one order was asked for is ambiguous, never the first row.
  // The failure name is preserved verbatim: it is the existing caller-visible one.
  if (!data || JsonArraySchema.safeParse(data.items).success) throw new CallerVisibleError('OrderReplacement:invalid-order')
  return tastytradeOrderRecord(data)
}

async function readOrder(
  env: AppEnv,
  ref: BrokerAccountRef,
  orderId: string,
  credential: BrokerCredential | undefined,
): Promise<BrokerOrderRecord> {
  return tastytradeOrderFromPayload(await brokerApi().tastyRequest(
    env,
    `/accounts/${encodeURIComponent(ref.accountNumber)}/orders/${encodeURIComponent(orderId)}`,
    {},
    credential,
  ))
}

async function cancelOrder(
  env: AppEnv,
  ref: BrokerAccountRef,
  orderId: string,
  credential: BrokerCredential | undefined,
): Promise<void> {
  try {
    await brokerApi().tastyRequest(
      env,
      `/accounts/${encodeURIComponent(ref.accountNumber)}/orders/${encodeURIComponent(orderId)}`,
      { method: 'DELETE' },
      credential,
    )
  } catch (error) {
    // A provider 4xx proves the cancellation was rejected. A network loss, timeout, 5xx, or
    // unreadable success response after DELETE means the broker may have received it, so it
    // must never become an automatic retry.
    if (error instanceof Error && error.name === 'TastytradeApiError') throw error
    throw new BrokerCancellationAmbiguousError()
  }
}

async function readOrderHistory(
  env: AppEnv,
  ref: BrokerAccountRef,
  options: { startDate: string },
  credential: BrokerCredential | undefined,
): Promise<BrokerOrderHistoryPage> {
  const payload = await brokerApi().tastyRequest(
    env,
    `/accounts/${encodeURIComponent(ref.accountNumber)}/orders?per-page=${RECONCILIATION_HISTORY_PAGE_SIZE}`
      + `&sort=Desc&start-date=${options.startDate}`,
    {},
    credential,
  )
  const { rows, totalItems } = itemEnvelope(payload, 'Tastytrade order history', RECONCILIATION_HISTORY_PAGE_SIZE)
  // The history request asks for a full page, so a page that did not fill is the whole
  // history. A declared total decides instead; one that cannot be read has already failed
  // above, which keeps an ambiguous mutation quarantined rather than concluding it is absent.
  const complete = totalItems !== undefined
    ? totalItems <= rows.length
    : rows.length < RECONCILIATION_HISTORY_PAGE_SIZE
  return { complete, orders: rows.map(tastytradeOrderRecord) }
}

export const tastytradeAdapter: BrokerAdapter = {
  cancelOrder,
  id: 'tastytrade',
  loadAccountSnapshot,
  readAccountHistory,
  readOrder,
  readOrderHistory,
  resolveAccountRef,
}
