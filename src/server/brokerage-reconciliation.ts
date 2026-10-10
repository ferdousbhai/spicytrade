import { type AgentTool } from '../domain/agent-tool'
import { Type } from 'typebox'

import { echoesOrderPayload, type OrderPayload } from './order-payload'
import { BROKER_CLOCK_SKEW_MS } from './order-market'
import { type AppEnv } from './env'
import { BROKER_ORDER_ID, type BrokerAccountRef, type BrokerOrderRecord } from '../domain/broker'
import { type JsonValue } from '../domain/json-payload'
import { resolveStoredOrderFingerprint } from './order-intent'
import { brokerAdapterFor, type BrokerAdapter } from './brokers'
import { brokerApi, TASTYTRADE_REQUEST_TIMEOUT_MS } from './tastytrade'
import { d1InListChunks } from './d1-limits'
import { textResult } from './agent-tool-result'
import { BrokerCredentialMissingError, type BrokerCredential } from './broker-credential'
import { PortfolioRiskError } from './portfolio-risk'
import { CallerVisibleError } from './caller-visible-error'

type StoredUnknownAction = {
  id: string
  payload_json: string
  /** Null only on a row claimed before the resolved order was stored (migration 0047). */
  resolved_payload_json: string | null
  submitted_at: string
}

/** The one unresolved ambiguous submission for this broker account, if there is one. */
export async function unresolvedSubmission(
  env: AppEnv,
  broker: string,
  accountNumber: string,
): Promise<StoredUnknownAction | null> {
  if (!env.DB) throw new CallerVisibleError('TastytradeReconciliation:store-unavailable')
  return env.DB.prepare(
    `SELECT id, payload_json, resolved_payload_json, submitted_at
       FROM broker_submissions
      WHERE broker_id = ? AND account_number = ? AND status = 'unresolved'
      LIMIT 1`,
  ).bind(broker, accountNumber).first<StoredUnknownAction>()
}

/**
 * The write-ahead record of one submission, and with it the quarantine check.
 *
 * It is written inside the mutation lease, after the broker dry-run and before the POST or PUT
 * leaves, as `unresolved`. The partial unique index `broker_submissions_one_unresolved_per_account`
 * makes this insert the atomic "is this account quarantined?" test: a second placement whose
 * insert conflicts is refused, and so is one whose insert fails for any other reason, because an
 * order sent without this row could go ambiguous with nothing to stop the next one. Checking
 * first and writing after the broker answered left a window -- the lease is not held across both
 * -- in which a concurrent placement could slip through before the quarantine landed.
 *
 * Two things are stored. `payload_json` is the server-parsed action -- the tuple a price-only
 * replacement later rebuilds the order's shape from. `resolved_payload_json` is the exact order
 * body built from the contracts resolved inside this lease, which is what the reconciliation
 * fingerprint needs: re-resolving the tuple later would ask a chain that may no longer list the
 * contract (an expired 0DTE, one gone closing-only), and a model-supplied order would let a wrong
 * order clear the quarantine.
 */
export async function claimSubmission(
  env: AppEnv,
  submission: { accountNumber: string; broker: string; resolvedPayload: OrderPayload; storedAction: JsonValue },
): Promise<string> {
  if (!env.DB) throw new PortfolioRiskError('The brokerage submission store is unavailable, so nothing was submitted.')
  const id = crypto.randomUUID()
  try {
    await env.DB.prepare(
      `INSERT INTO broker_submissions
         (id, broker_id, account_number, payload_json, resolved_payload_json, submitted_at, status, error_code)
       VALUES (?, ?, ?, ?, ?, ?, 'unresolved', 'BrokerageSubmissionUnknown')`,
    ).bind(
      id,
      submission.broker,
      submission.accountNumber,
      JSON.stringify(submission.storedAction),
      JSON.stringify(submission.resolvedPayload),
      new Date().toISOString(),
    ).run()
    return id
  } catch {
    // Either refusal is safe; the lookup only chooses which one the caller reads. A lookup that
    // itself fails falls to the store refusal, never to submitting.
    const quarantined = await unresolvedSubmission(env, submission.broker, submission.accountNumber)
      .catch(() => null)
    if (quarantined) {
      throw new PortfolioRiskError(
        'A previous submission for this account could not be verified and is still unresolved. '
        + 'Reconcile it against broker order history before placing another order; do not retry the previous one.',
      )
    }
    // A fixed marker only: D1 detail can carry private account or order context.
    console.error('BrokerageSubmissionClaimFailed')
    throw new PortfolioRiskError('The brokerage submission could not be recorded, so nothing was submitted.')
  }
}

type SubmissionOutcome =
  | { providerOrderId: string; status: 'executed' }
  | { errorCode: 'TastytradeApiError' | 'TastytradeOrderRejected'; status: 'failed' }

/**
 * Settle a claimed submission once the broker's answer is definite. Returns whether the row is
 * now settled as this outcome. A write that fails leaves the row `unresolved`, which is the safe
 * direction: the account stays quarantined until reconciliation settles it from broker order
 * history, rather than being released on a result nothing recorded. An ambiguous answer is never
 * settled here.
 *
 * A conditional update that changed nothing is read back rather than assumed lost: a reconcile
 * that reached the row first (the lease normally prevents that, but it can lapse) may already
 * have recorded this same outcome, and telling the agent the account stays quarantined would
 * then be false.
 */
export async function settleSubmission(env: AppEnv, id: string, outcome: SubmissionOutcome): Promise<boolean> {
  try {
    if (!env.DB) throw new CallerVisibleError('TastytradeReconciliation:store-unavailable')
    const statement = outcome.status === 'executed'
      ? env.DB.prepare(
        "UPDATE broker_submissions SET status = 'executed', error_code = NULL, provider_order_id = ? WHERE id = ? AND status = 'unresolved'",
      ).bind(outcome.providerOrderId, id)
      : env.DB.prepare(
        "UPDATE broker_submissions SET status = 'failed', error_code = ? WHERE id = ? AND status = 'unresolved'",
      ).bind(outcome.errorCode, id)
    const update = await statement.run()
    if (update.meta.changes === 1) return true
    const row = await env.DB.prepare(
      'SELECT status, provider_order_id FROM broker_submissions WHERE id = ?',
    ).bind(id).first<{ provider_order_id: string | null; status: string }>()
    if (row && row.status === outcome.status
      && (outcome.status !== 'executed' || row.provider_order_id === outcome.providerOrderId)) return true
  } catch {
    // Fall through to the fixed marker below.
  }
  console.error('BrokerageSubmissionSettleFailed')
  return false
}

type ReconciliationResult = {
  actionId?: string
  detail: string
  providerOrderId?: string
  status: 'none' | 'executed' | 'failed' | 'unresolved'
}

const ReconcileParameters = Type.Object({}, { additionalProperties: false })
// A recent absence is not proof that an ambiguous broker mutation failed; wait before allowing a
// deterministic absence result. tastytrade documents no order-history propagation window, so this
// is the owner's risk policy rather than a provider figure: a duplicate order is the costly error,
// so an absence is trusted only after a conservative quarter hour.
// `submitted_at` is the write-ahead claim, taken before the request leaves, so the window runs
// from no later than the send. A claimed row whose request never left at all (a transport
// failure before sending is still treated as ambiguous) is covered the same way: it stays
// quarantined until this window passes with a complete history and no match.
const FINAL_ABSENCE_DELAY_MS = 15 * 60_000
/**
 * How far before `submitted_at` a matching order may have been received, for a row the earlier
 * quarantine path wrote. Those rows recorded `submitted_at` after the request had returned -- up
 * to its transport timeout plus the post-lease write -- and must still match, or an absent-looking
 * order would later be settled as never placed. This is a named safety margin over that lag, the
 * owner's choice rather than a derived figure: about six times the request timeout
 * (`TASTYTRADE_REQUEST_TIMEOUT_MS`), so a legacy row written late still matches its order, yet far
 * shorter than the gap between two deliberate identical placements. A claimed row (one carrying `resolved_payload_json`) is written before its
 * request leaves, so for it only clock skew applies: a wider margin would reach back to an
 * identical ticket placed just before it.
 */
const SUBMISSION_RECORD_LAG_MS = 2 * 60_000
/**
 * How long after its claim a submission can still reach the broker. The placement arms this
 * deadline before it writes the claim and hands it to the POST or PUT as its abort signal, so a
 * request queued behind the account's request gate is abandoned at the same instant however long
 * the gate held it. It is the transport's own per-request budget, not a new figure. It bounds a
 * match from above: an identical ticket placed later, from the broker's own app, must not become
 * a second match that keeps the account quarantined forever.
 */
export const SUBMISSION_TRANSPORT_BUDGET_MS = TASTYTRADE_REQUEST_TIMEOUT_MS
/**
 * Order history is asked for by calendar date, which the broker reads in its own zone. Starting
 * one full day before the submission instant puts that instant on or after the start date in
 * any zone, since no zone offset reaches 24 hours.
 */
const ORDER_HISTORY_DATE_MARGIN_MS = 24 * 60 * 60_000

type StoredSubmissionTime = {
  /** True when the row was claimed before its request left (it stores the resolved order). */
  claimed: boolean
  submittedAt: Date
}

/**
 * Exact order fingerprint match; timestamps keep unrelated duplicate orders from clearing quarantine.
 *
 * Only the broker's received-at bounds a match on both sides. The history reader treats it as
 * optional, and the updated-at it would otherwise lean on moves later on every fill or cancel, so
 * an upper bound on updated-at would drop the real order -- and once absence became final, settle
 * a placed order as never placed and lift its quarantine. Without a received-at, updated-at only
 * excludes a row last touched before the submission could have arrived (nothing is updated before
 * it is received); any other row stays a candidate, so an extra one keeps the quarantine rather
 * than letting absence settle it.
 */
export function matchesSubmittedOrder(
  row: BrokerOrderRecord,
  intended: OrderPayload,
  submission: StoredSubmissionTime,
  now: Date,
  replacedOrderId?: string,
): boolean {
  const submittedAt = submission.submittedAt.getTime()
  const earliest = submittedAt - (submission.claimed ? BROKER_CLOCK_SKEW_MS : SUBMISSION_RECORD_LAG_MS)
  const receivedAt = Date.parse(row.receivedAt ?? '')
  if (Number.isFinite(receivedAt)) {
    const latest = Math.min(submittedAt + SUBMISSION_TRANSPORT_BUDGET_MS, now.getTime()) + BROKER_CLOCK_SKEW_MS
    if (receivedAt < earliest || receivedAt > latest) return false
  } else {
    const updatedAt = Date.parse(row.updatedAt ?? '')
    if (Number.isFinite(updatedAt) && updatedAt < earliest) return false
  }
  return (!replacedOrderId || row.replacesOrderId === replacedOrderId)
    && echoesOrderPayload(row, intended)
}

/**
 * Drop candidates another submission already owns. An order some row already recorded as its
 * `provider_order_id` is that row's order: matching it again would give two rows one order id
 * (which a later replacement then refuses as ambiguous), or -- when this submission never reached
 * the broker -- settle it as executed on an identical ticket placed just before it.
 */
async function unclaimedOrders(
  db: D1Database,
  broker: string,
  accountNumber: string,
  candidates: BrokerOrderRecord[],
): Promise<BrokerOrderRecord[]> {
  const ids = [...new Set(candidates.flatMap((row) => row.id ? [row.id] : []))]
  const owned = new Set<string>()
  // The account's broker and number bind two parameters; the rest carry candidate order ids.
  for (const chunk of d1InListChunks(ids, 2)) {
    const result = await db.prepare(
      `SELECT provider_order_id FROM broker_submissions
        WHERE broker_id = ? AND account_number = ? AND provider_order_id IN (${chunk.map(() => '?').join(', ')})`,
    ).bind(broker, accountNumber, ...chunk).all<{ provider_order_id: string }>()
    for (const row of result.results ?? []) owned.add(row.provider_order_id)
  }
  return candidates.filter((row) => !row.id || !owned.has(row.id))
}

/**
 * What a row says after a conditional settle changed nothing. Another request -- a concurrent
 * reconcile, or the placement's own settle landing late -- already moved it, so the answer is
 * whatever it moved it to, read back rather than assumed: reporting `unresolved` would tell the
 * agent an account is still quarantined when it is not.
 */
async function settledElsewhere(db: D1Database, id: string): Promise<ReconciliationResult> {
  const row = await db.prepare(
    'SELECT status, provider_order_id FROM broker_submissions WHERE id = ?',
  ).bind(id).first<{ provider_order_id: string | null; status: string }>()
  const already = 'The action was already reconciled by another request.'
  if (!row) return { detail: already, status: 'none' }
  if (row.status === 'executed') {
    const result: ReconciliationResult = { actionId: id, detail: already, status: 'executed' }
    if (row.provider_order_id) result.providerOrderId = row.provider_order_id
    return result
  }
  if (row.status === 'failed') return { actionId: id, detail: already, status: 'failed' }
  return { actionId: id, detail: 'The action could not be settled; the quarantine remains in place.', status: 'unresolved' }
}

export async function reconcileUnknownBrokerageAction(
  env: AppEnv,
  credential: BrokerCredential | undefined,
): Promise<ReconciliationResult> {
  const now = new Date()
  if (!credential) throw new BrokerCredentialMissingError()
  const db = env.DB
  if (!db) throw new CallerVisibleError('TastytradeReconciliation:store-unavailable')
  // Scoped to the account the presented credential resolves to: a member may only reconcile
  // their own quarantine, and possession of a row id is never authority to touch it.
  const adapter = brokerAdapterFor(credential)
  const ref = await adapter.resolveAccountRef(env, credential)
  // Under the account's mutation lease, the one a placement holds from its dry-run through its
  // settle. Without it a reconcile run beside an in-flight placement could match the order after
  // the broker accepted it and settle the row first, and the placement would then tell its agent
  // the account stays quarantined. The lease waits rather than refuses, so a reconcile queued
  // behind a placement runs once that placement has settled or quarantined its own row.
  return brokerApi().withBrokerMutationLease(env, ref.accountNumber, () => (
    reconcileUnderLease(env, db, credential, adapter, ref, now)
  ))
}

async function reconcileUnderLease(
  env: AppEnv,
  db: D1Database,
  credential: BrokerCredential,
  adapter: BrokerAdapter,
  ref: BrokerAccountRef,
  now: Date,
): Promise<ReconciliationResult> {
  const stored = await unresolvedSubmission(env, credential.broker, ref.accountNumber)
  if (!stored) return { detail: 'No brokerage submission needs reconciliation.', status: 'none' }

  const submittedAt = new Date(stored.submitted_at)
  if (!Number.isFinite(submittedAt.getTime())) {
    return { actionId: stored.id, detail: 'The local submission timestamp is invalid; the quarantine remains in place.', status: 'unresolved' }
  }
  const fingerprint = await resolveStoredOrderFingerprint(
    env,
    JSON.parse(stored.payload_json),
    stored.resolved_payload_json === null ? undefined : JSON.parse(stored.resolved_payload_json),
  )
  const intended = fingerprint.payload
  const replacedOrderId = fingerprint.action.kind === 'replace_order' ? fingerprint.action.orderId : undefined
  const startDate = new Date(submittedAt.getTime() - ORDER_HISTORY_DATE_MARGIN_MS).toISOString().slice(0, 10)
  const history = await adapter.readOrderHistory(env, ref, { startDate }, credential)
  const submission = { claimed: stored.resolved_payload_json !== null, submittedAt }
  const matches = await unclaimedOrders(
    db,
    credential.broker,
    ref.accountNumber,
    history.orders.filter((row) => matchesSubmittedOrder(row, intended, submission, now, replacedOrderId)),
  )
  if (matches.length !== 1) {
    if (matches.length === 0 && history.complete && now.getTime() - submittedAt.getTime() >= FINAL_ABSENCE_DELAY_MS) {
      const update = await db.prepare(
        "UPDATE broker_submissions SET status = 'failed', error_code = 'BrokerageSubmissionNotFound' WHERE id = ? AND status = 'unresolved'",
      ).bind(stored.id).run()
      if (update.meta.changes === 1) {
        return { actionId: stored.id, detail: 'No matching broker order appeared after the reconciliation window.', status: 'failed' }
      }
      return settledElsewhere(db, stored.id)
    }
    // An order the broker refused never reaches its history, so absence is the only way it
    // settles; say when that can be concluded rather than leave the caller polling blind.
    const absenceFinalAt = new Date(submittedAt.getTime() + FINAL_ABSENCE_DELAY_MS).toISOString()
    const reason = matches.length > 1
      ? 'More than one exact broker match was found.'
      : !history.complete
        ? 'The broker\'s order history came back incomplete, so absence cannot be concluded until a complete read.'
        : `No exact broker match is visible yet; if none appears, absence can be concluded from ${absenceFinalAt}.`
    return { actionId: stored.id, detail: `${reason} The quarantine remains in place.`, status: 'unresolved' }
  }

  const match = matches[0]!
  const providerOrderId = match.id
  // History reads bound an id's length only, since they report what the broker wrote. This one
  // is stored as the order's identity and later sent back in a replacement's path, so it must
  // meet the same all-digits shape a direct placement requires of the id it stores.
  if (!providerOrderId || !BROKER_ORDER_ID.test(providerOrderId) || !match.status) {
    throw new CallerVisibleError('TastytradeReconciliation:invalid-match')
  }
  const rejected = match.rejected
  // An executed match stores the broker's order id: this row is the only source a later
  // price-only replacement can resolve the order's shape from, exactly as if the placement had
  // settled it directly.
  const update = await (rejected
    ? db.prepare(
      "UPDATE broker_submissions SET status = 'failed', error_code = 'TastytradeOrderRejected' WHERE id = ? AND status = 'unresolved'",
    ).bind(stored.id)
    : db.prepare(
      "UPDATE broker_submissions SET status = 'executed', error_code = NULL, provider_order_id = ? WHERE id = ? AND status = 'unresolved'",
    ).bind(providerOrderId, stored.id)
  ).run()
  if (update.meta.changes !== 1) return settledElsewhere(db, stored.id)
  return {
    actionId: stored.id,
    detail: rejected ? `Broker order #${providerOrderId} was rejected.` : `Broker order #${providerOrderId} was found and recorded.`,
    providerOrderId,
    status: rejected ? 'failed' : 'executed',
  }
}

export function createBrokerageReconciliationTool(
  env: AppEnv,
  credential: BrokerCredential | undefined,
): AgentTool<typeof ReconcileParameters> {
  return {
    description: 'Resolve one quarantined submission against broker order history. Use this after '
      + 'an ambiguous submission; never automatically retry an ambiguous broker mutation.',
    execute: async () => textResult(await reconcileUnknownBrokerageAction(env, credential)),
    name: 'reconcile_brokerage_action',
    parameters: ReconcileParameters,
  }
}
