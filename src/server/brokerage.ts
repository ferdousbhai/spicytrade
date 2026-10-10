import { type AppEnv } from './env'
import { BROKER_ORDER_ID } from '../domain/broker'
import { errorName, toError } from '../domain/failure'
import {
  JsonObjectArraySchema,
  jsonObjectOrEmpty,
  jsonText,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { type OrderPlacement } from './agent-contracts'
import { claimSubmission, settleSubmission, SUBMISSION_TRANSPORT_BUDGET_MS } from './brokerage-reconciliation'
import { resolveOrderIntent, type ResolvedOrderIntent } from './order-intent'
import { echoesOrderPayload, replacementOrderPayload, type OrderPayload } from './order-payload'
import { tastytradeOrderRecord } from './brokers/tastytrade'
import { brokerApi } from './tastytrade'
import { tradeGuards } from './trade-guards'
import { BrokerRefusalError, CallerVisibleError } from './caller-visible-error'
import { BrokerCredentialMissingError, type BrokerCredential } from './broker-credential'

type OrderResponseReceipt = { id?: string; warnings: string[] }
type PlacedOrderReceipt = { id: string; warnings: string[] }
type ReplacementReceipt = { id: string }

/**
 * A broker response this repository refuses to believe. The code is our own vocabulary and
 * carries no response value, so it reaches the caller as it stands.
 */
class TastytradeOrderResponseError extends CallerVisibleError {
  constructor(code: 'echo-mismatch' | 'invalid-message' | 'invalid-messages' | 'missing-order-or-buying-power') {
    super(`TastytradeOrderResponse:${code}`)
    this.name = 'TastytradeOrderResponseError'
  }
}

// Broker messages are untrusted presentation text. Preserve a small diagnostic packet without
// allowing a rejection body to dominate logs, stored errors, or the agent response.
const MAX_BROKER_MESSAGE_LENGTH = 160
const MAX_BROKER_MESSAGES_PER_KIND = 5

function messageRows(value: JsonValue): JsonObject[] {
  if (value === undefined || value === null) return []
  const items = JsonObjectArraySchema.safeParse(value).data
  if (!items) throw new TastytradeOrderResponseError('invalid-messages')
  return items
}

function messageText(row: JsonObject): string {
  const value = jsonText(row.message ?? row.code)
  if (value === undefined) throw new TastytradeOrderResponseError('invalid-message')
  return value.length > MAX_BROKER_MESSAGE_LENGTH
    ? `${value.slice(0, MAX_BROKER_MESSAGE_LENGTH - 1)}…`
    : value
}

function messagePacket(value: JsonValue, kind: string): string[] {
  const messages = messageRows(value)
  const selected = messages.slice(0, MAX_BROKER_MESSAGES_PER_KIND).map(messageText)
  const omitted = messages.length - selected.length
  return omitted ? [...selected, `${omitted} more broker ${kind} omitted`] : selected
}

/**
 * The dry-run check. A dry-run whose exact echo says Rejected is a refusal even with no errors
 * array: counting it clean would claim the submission and send the real order. Nothing is
 * claimed yet at this point, so there is nothing to settle.
 */
export function validateOrderResponse(payload: JsonValue, intended: OrderPayload): OrderResponseReceipt {
  const { id, rejected, warnings } = readOrderResponse(payload, intended)
  if (rejected) throw new TastytradeOrderRejectedError([])
  return { id, warnings }
}

/** The receipt plus whether the echoed order itself says the broker rejected it. */
function readOrderResponse(payload: JsonValue, intended: OrderPayload): OrderResponseReceipt & { rejected: boolean } {
  const body = jsonObjectOrEmpty(payload)
  const data = jsonObjectOrEmpty(body.data ?? body)
  const errors = messagePacket(data.errors ?? body.errors, 'errors')
  if (errors.length) {
    throw new TastytradeOrderRejectedError(errors)
  }
  const warnings = messagePacket(data.warnings ?? body.warnings, 'warnings')
  const order = jsonObjectOrEmpty(data.order ?? body.order)
  const buyingPower = jsonObjectOrEmpty(data['buying-power-effect'] ?? body['buying-power-effect'])
  if (!Object.keys(order).length || !Object.keys(buyingPower).length) {
    throw new TastytradeOrderResponseError('missing-order-or-buying-power')
  }
  // Only the presence of a buying-power effect is required: it is a different fact from the
  // order's price effect. A Buy to Close debit on a short frees margin, so its buying-power
  // effect is a Credit, and requiring the two to agree refused exactly the risk-reducing orders.
  const record = tastytradeOrderRecord(order)
  if (!echoesOrderPayload(record, intended)) {
    throw new TastytradeOrderResponseError('echo-mismatch')
  }
  const id = order.id === undefined || order.id === null ? undefined : String(order.id)
  return { id: id && BROKER_ORDER_ID.test(id) ? id : undefined, rejected: record.rejected, warnings }
}

export class BrokerageSubmissionUnknownError extends CallerVisibleError {
  constructor() {
    super('Tastytrade may have received this order, but spicytrade could not verify the result. Reconciliation is required before another trade.')
    this.name = 'BrokerageSubmissionUnknownError'
  }
}

// The broker's own words for a refusal are untrusted and stay out of the message: the check is
// named here, and the bounded `messagePacket` goes to the caller only in the labelled field.
class TastytradeOrderRejectedError extends BrokerRefusalError {
  constructor(readonly messages: readonly string[], addendum?: string) {
    const refused = 'Tastytrade rejected this order, so it was not placed.'
    super('broker-rejected', addendum ? `${refused} ${addendum}` : refused, { messages })
    this.name = 'TastytradeOrderRejectedError'
  }
}

/**
 * Said beside any verified result whose settlement could not be written. The claimed row then
 * stays `unresolved`, which quarantines the account, so the caller must hear why the next
 * placement will be refused and what clears it.
 */
const UNRECORDED_RESULT = 'spicytrade could not record this result, so this account stays quarantined until reconcile_brokerage_action confirms it.'

class TastytradeOrderWarningError extends BrokerRefusalError {
  constructor(warnings: readonly string[]) {
    super('broker-warning', 'Tastytrade returned a preflight warning, so the order was not submitted.', { messages: warnings })
    this.name = 'TastytradeOrderWarningError'
  }
}

export function rejectDryRunWarnings(warnings: readonly string[]): void {
  if (warnings.length) throw new TastytradeOrderWarningError(warnings)
}

export function validateReplacementReceipt(
  payload: JsonValue,
  replacedOrderId: string,
  intended: OrderPayload,
): ReplacementReceipt {
  let receipt: ReplacementReceipt & { rejected: boolean }
  try {
    const body = jsonObjectOrEmpty(payload)
    const order = jsonObjectOrEmpty(body.data ?? body)
    const id = String(order.id ?? '')
    const record = tastytradeOrderRecord(order)
    const exact = BROKER_ORDER_ID.test(id)
      && record.replacesOrderId === replacedOrderId
      && echoesOrderPayload(record, intended)
    if (!exact) throw new Error('TastytradeReplacementResponse:echo-mismatch')
    receipt = { id, rejected: record.rejected }
  } catch {
    throw new BrokerageSubmissionUnknownError()
  }
  // A 2xx whose exact echo says Rejected is a verified refusal, exactly as reconciliation reads
  // the same record in order history; reporting it replaced would be a false success.
  if (receipt.rejected) throw new TastytradeOrderRejectedError([])
  return { id: receipt.id }
}

/** Once placement returned 2xx, anything short of a verified rejection or exact receipt is ambiguous. */
export function validatePlacedOrderResponse(payload: JsonValue, intended: OrderPayload): PlacedOrderReceipt {
  let receipt: OrderResponseReceipt & { rejected: boolean }
  try {
    receipt = readOrderResponse(payload, intended)
  } catch (error) {
    if (error instanceof TastytradeOrderRejectedError) throw error
    throw new BrokerageSubmissionUnknownError()
  }
  // The echoed order is ours, and it says the broker rejected it: a verified refusal, settled
  // failed by the caller, never an accepted order.
  if (receipt.rejected) throw new TastytradeOrderRejectedError([])
  // A 2xx placement without a usable broker order id is ambiguous, never a success.
  if (!receipt.id) throw new BrokerageSubmissionUnknownError()
  return { id: receipt.id, warnings: receipt.warnings }
}

/**
 * `detail` is this repository's wording. Warnings the broker attached to an accepted order are
 * its own text, so they travel beside it in a field named as untrusted rather than inside it.
 */
export type SubmissionReceipt = { detail: string; orderId: string; untrustedBrokerWarnings?: string[] }

/** Bookkeeping for an accepted order, and the platform hook that keeps it alive past the reply. */
type AcceptedOrderFollowUp = {
  run: (intent: ResolvedOrderIntent) => Promise<void>
  waitUntil: (task: Promise<unknown>) => void
}

/**
 * Resolve, guard, dry-run, and submit one order under the account's mutation lease.
 *
 * The account number and the intent are resolved once, by the caller and inside the lease
 * respectively. `onAccepted` starts only once the broker has accepted the order, after the lease
 * is released, and it can never change the outcome: it is scheduled with `waitUntil` rather than
 * awaited, and a failure there is logged under a fixed event name. Running it any earlier let a
 * refused order earn the provenance it records, let a store hiccup refuse an order (a
 * risk-reducing close included), and held the lease across writes that have nothing to do
 * with the submission. Awaiting it let its latency push the reply past the local proxy's
 * budget after the broker had accepted, losing the receipt and inviting a duplicate retry.
 */
export async function executeOrderPlacement(
  env: AppEnv,
  action: OrderPlacement,
  credential: BrokerCredential | undefined,
  accountNumber: string,
  onAccepted?: AcceptedOrderFollowUp,
): Promise<SubmissionReceipt> {
  if (!credential) throw new BrokerCredentialMissingError()
  const broker = credential.broker
  const { intent, receipt } = await brokerApi().withBrokerMutationLease(env, accountNumber, async (lease) => {
    const intent = await resolveOrderIntent(env, action, accountNumber, credential)
    await tradeGuards().assertPortfolioActionAllowed(env, intent.effectiveAction, credential, {
      accountNumber,
      optionContracts: intent.optionContracts,
    })
    await tradeGuards().assertOrderMarketSafe(env, intent.effectiveAction, intent.optionContracts)
    const account = encodeURIComponent(accountNumber)
    const orderPath = intent.replaceOrderId
      ? `/accounts/${account}/orders/${encodeURIComponent(intent.replaceOrderId)}`
      : `/accounts/${account}/orders`
    const body = intent.replaceOrderId ? replacementOrderPayload(intent.payload) : intent.payload
    await lease.renew()
    const dryRun = await brokerApi().tastyRequest(
      env,
      `${orderPath}/dry-run`,
      { method: 'POST', body },
      credential,
    )
    rejectDryRunWarnings(validateOrderResponse(dryRun, intent.payload).warnings)
    // Everything that can fail without sending anything happens before the claim and the try
    // below: a lost lease here is a plain failure, never an ambiguous submission.
    await lease.renew()
    // Armed before the claim records `submitted_at`, so the broker can only have received this
    // request within the budget after that instant -- the upper edge reconciliation matches by.
    // A deadline that fires while the request waits on the account's gate aborts it unsent,
    // which is still treated as ambiguous below and so still quarantines.
    const submissionDeadline = AbortSignal.timeout(SUBMISSION_TRANSPORT_BUDGET_MS)
    const submissionId = await claimSubmission(env, {
      accountNumber,
      broker,
      resolvedPayload: intent.payload,
      storedAction: intent.storedAction,
    })
    let placed: JsonValue
    try {
      placed = await brokerApi().tastyRequest(env, orderPath, {
        method: intent.replaceOrderId ? 'PUT' : 'POST',
        body,
        signal: submissionDeadline,
      }, credential)
    } catch (error) {
      // A provider 4xx: the broker positively refused the request, so nothing was placed.
      if (error instanceof Error && error.name === 'TastytradeApiError') {
        const settled = await settleSubmission(env, submissionId, { errorCode: 'TastytradeApiError', status: 'failed' })
        if (!settled) {
          throw new CallerVisibleError(`Tastytrade refused this order (${error.name}), so it was not placed. ${UNRECORDED_RESULT}`)
        }
        throw error
      }
      // Ambiguous: the claimed row stays `unresolved`, which is the quarantine.
      throw new BrokerageSubmissionUnknownError()
    }
    let receipt: SubmissionReceipt
    try {
      if (intent.replaceOrderId) {
        const replaced = validateReplacementReceipt(placed, intent.replaceOrderId, intent.payload)
        receipt = { detail: `Order #${intent.replaceOrderId} replaced by order #${replaced.id}.`, orderId: replaced.id }
      } else {
        const accepted = validatePlacedOrderResponse(placed, intent.payload)
        receipt = accepted.warnings.length
          ? {
            detail: `Order #${accepted.id} accepted by tastytrade with broker warnings.`,
            orderId: accepted.id,
            untrustedBrokerWarnings: accepted.warnings,
          }
          : { detail: `Order #${accepted.id} accepted by tastytrade.`, orderId: accepted.id }
      }
    } catch (error) {
      if (error instanceof TastytradeOrderRejectedError) {
        const settled = await settleSubmission(env, submissionId, { errorCode: 'TastytradeOrderRejected', status: 'failed' })
        if (!settled) throw new TastytradeOrderRejectedError(error.messages, UNRECORDED_RESULT)
      }
      throw error
    }
    const settled = await settleSubmission(env, submissionId, { providerOrderId: receipt.orderId, status: 'executed' })
    // The order is placed and the caller must be told so. An unrecorded settlement only keeps
    // the account quarantined until reconciliation finds this order in broker history.
    const detail = settled
      ? receipt.detail
      : `${receipt.detail} ${UNRECORDED_RESULT}`
    return { intent, receipt: { ...receipt, detail } }
  })
  if (onAccepted) {
    const followUp = async () => {
      try {
        await onAccepted.run(intent)
      } catch (error) {
        // The order is already at the broker; bookkeeping after it must not read as a refusal.
        console.error('TradeIntentRememberFailed', errorName(toError(error)))
      }
    }
    onAccepted.waitUntil(followUp())
  }
  return receipt
}
