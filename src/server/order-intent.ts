import {
  parseFreshOrderPlacement,
  StoredOrderPlacementSchema,
  type FreshOrderPlacement,
  type OrderPlacement,
  type StoredOrderPlacement,
} from './agent-contracts'
import { type AppEnv } from './env'
import { type JsonValue } from '../domain/json-payload'
import { type BrokerOrderRecord } from '../domain/broker'
import { brokerAdapterFor } from './brokers'
import {
  buildOrderPayload,
  echoesOrderPayload,
  OrderPayloadSchema,
  sameOrderPayload,
  type OrderPayload,
} from './order-payload'
import { resolveEquityOptionTuples, type EquityOptionContract } from './option-contract'
import { type BrokerCredential } from './broker-credential'
import { CallerVisibleError } from './caller-visible-error'

export type ResolvedOrderIntent = {
  effectiveAction: FreshOrderPlacement
  optionContracts: EquityOptionContract[]
  payload: OrderPayload
  replaceOrderId?: string
  storedAction: StoredOrderPlacement
}

function effectiveStoredOrder(action: StoredOrderPlacement): FreshOrderPlacement {
  return action.kind === 'replace_order' ? action.replacementOrder : action
}

/**
 * `execution` resolves a contract that can be traded now: active, and not closing-only for an
 * opening leg. `identity` only names which listed contract a tuple meant, for reading back an
 * order that was already sent; it is never used to build anything submitted.
 */
type ResolutionMode = 'execution' | 'identity'

async function resolveFreshOrder(
  env: AppEnv,
  action: FreshOrderPlacement,
  mode: ResolutionMode = 'execution',
): Promise<{ optionContracts: EquityOptionContract[]; payload: OrderPayload }> {
  if (action.kind === 'place_equity_order') {
    return { optionContracts: [], payload: buildOrderPayload(action, [action.symbol]) }
  }
  if (action.kind === 'place_option_order') {
    const [contract] = await resolveEquityOptionTuples(env, [
      { underlying: action.underlying, expiry: action.expiry, optionType: action.optionType, strike: action.strike },
    ], mode === 'execution' ? { opening: action.action.endsWith('to Open') } : { identityOnly: true })
    return { optionContracts: [contract!], payload: buildOrderPayload(action, [contract!.symbol]) }
  }
  const contracts = await resolveEquityOptionTuples(env, [
    { underlying: action.underlying, expiry: action.expiry, optionType: action.optionType, strike: action.longStrike },
    { underlying: action.underlying, expiry: action.expiry, optionType: action.optionType, strike: action.shortStrike },
  ], mode === 'execution' ? { opening: true } : { identityOnly: true })
  if (contracts[0]!.sharesPerContract !== contracts[1]!.sharesPerContract) {
    throw new CallerVisibleError('OrderIntent:spread-multiplier-mismatch')
  }
  return {
    optionContracts: contracts,
    payload: buildOrderPayload(action, contracts.map((contract) => contract.symbol)),
  }
}

/** The shared echo, plus: nothing on it has filled, so the whole order is still working. */
function sameOrderEcho(order: BrokerOrderRecord, intended: OrderPayload): boolean {
  return echoesOrderPayload(order, intended)
    && (order.legs ?? []).every((leg) => leg?.remainingQuantity === leg?.quantity
      && (leg?.fillCount === undefined || leg.fillCount === 0))
}

export function assertReplaceableOrder(order: BrokerOrderRecord, orderId: string, intended: OrderPayload): void {
  if (order.id !== orderId
    || !order.editable
    || !order.status
    || order.terminal
    || !sameOrderEcho(order, intended)) {
    throw new CallerVisibleError('OrderReplacement:order-changed-or-not-editable')
  }
}

/**
 * The action spicytrade placed as `orderId`, read only from this broker account's own rows. The broker
 * re-verifies the live order afterwards, but another account's row must never be the source of an
 * order's shape: the per-account rule holds here too, not only at the broker. Rows carried forward
 * by migration 0029 have an empty account number and so are never found; they were all Day
 * orders placed long before it, so none of them is still working to be replaced.
 */
async function sourceOrderAction(
  env: AppEnv,
  broker: string,
  accountNumber: string,
  orderId: string,
): Promise<StoredOrderPlacement> {
  if (!env.DB) throw new CallerVisibleError('OrderReplacement:action-store-unavailable')
  const result = await env.DB.prepare(
    `SELECT payload_json FROM broker_submissions
      WHERE broker_id = ? AND account_number = ? AND provider_order_id = ? AND status = 'executed'
      ORDER BY submitted_at DESC LIMIT 2`,
  ).bind(broker, accountNumber, orderId).all<{ payload_json: string }>()
  const rows = result.results ?? []
  if (rows.length !== 1) throw new CallerVisibleError('OrderReplacement:source-order-not-found')
  return StoredOrderPlacementSchema.parse(JSON.parse(rows[0]!.payload_json))
}

async function expandReplacement(
  env: AppEnv,
  action: Extract<OrderPlacement, { kind: 'replace_order' }>,
  accountNumber: string,
  credential: BrokerCredential | undefined,
): Promise<ResolvedOrderIntent> {
  const adapter = brokerAdapterFor(credential)
  const source = effectiveStoredOrder(await sourceOrderAction(env, adapter.id, accountNumber, action.orderId))
  const sourceResolved = await resolveFreshOrder(env, source)
  const current = await adapter.readOrder(
    env,
    { accountNumber, broker: adapter.id },
    action.orderId,
    credential,
  )
  assertReplaceableOrder(current, action.orderId, sourceResolved.payload)
  const replacementOrder = parseFreshOrderPlacement({ ...source, limitPrice: action.limitPrice })
  // Only the limit price differs from the source, so the contracts just resolved from the live
  // chain are the replacement's contracts too. Resolving again would fetch the whole chain a
  // second time and could, in between, name a different contract than the one checked above.
  return {
    effectiveAction: replacementOrder,
    optionContracts: sourceResolved.optionContracts,
    payload: buildOrderPayload(replacementOrder, sourceResolved.payload.legs.map((leg) => leg.symbol)),
    replaceOrderId: action.orderId,
    storedAction: { ...action, replacementOrder },
  }
}

export async function resolveOrderIntent(
  env: AppEnv,
  action: OrderPlacement,
  accountNumber: string,
  credential: BrokerCredential | undefined,
): Promise<ResolvedOrderIntent> {
  if (action.kind === 'replace_order') return expandReplacement(env, action, accountNumber, credential)
  const resolved = await resolveFreshOrder(env, action)
  return { effectiveAction: action, ...resolved, storedAction: action }
}

/**
 * The exact order a claimed submission sent, for reconciliation, with no live-chain lookup.
 *
 * Claimed rows store the resolved order beside the action. It is rebuilt from the stored action
 * and the stored leg symbols and must equal the stored order field for field, so the two columns
 * cannot disagree about what was sent; a row where they do is refused, never repaired. Resolving
 * from today's chain instead would fail forever for a contract that has since expired, gone
 * closing-only, or left the chain -- which is exactly when an ambiguous 0DTE order is reconciled.
 *
 * A row claimed before the resolved order was stored has only the action. Its contract is
 * re-resolved by identity alone (listed, standard, exact tuple), without the activity and
 * opening checks that only matter for an order about to be sent. A contract no longer listed at
 * all cannot be identified that way, and that row stays quarantined.
 */
export async function resolveStoredOrderFingerprint(
  env: AppEnv,
  untrustedAction: JsonValue,
  untrustedResolvedPayload: JsonValue | undefined,
): Promise<{ action: StoredOrderPlacement; payload: OrderPayload }> {
  const action = StoredOrderPlacementSchema.parse(untrustedAction)
  const effective = effectiveStoredOrder(action)
  if (untrustedResolvedPayload === undefined) {
    const resolved = await resolveFreshOrder(env, effective, 'identity')
    return { action, payload: resolved.payload }
  }
  const stored = OrderPayloadSchema.safeParse(untrustedResolvedPayload)
  if (!stored.success) throw new CallerVisibleError('TastytradeReconciliation:invalid-stored-order')
  const rebuilt = buildOrderPayload(effective, stored.data.legs.map((leg) => leg.symbol))
  if (!sameOrderPayload(rebuilt, stored.data)) {
    throw new CallerVisibleError('TastytradeReconciliation:stored-order-disagrees-with-action')
  }
  return { action, payload: stored.data }
}
