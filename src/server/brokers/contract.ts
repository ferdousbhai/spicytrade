import {
  type BrokerAccountHistoryPage,
  type BrokerAccountRef,
  type BrokerAccountSnapshot,
  type BrokerId,
  type BrokerOrderHistoryPage,
  type BrokerOrderRecord,
} from '../../domain/broker'
import { type BrokerCredential } from '../broker-credential'
import { CallerVisibleError } from '../caller-visible-error'
import { type AppEnv } from '../env'

/**
 * Which of the four account reads a snapshot failed on, and whether it failed reading the
 * page itself or one record inside it. The portfolio guard and the account snapshot tool turn
 * this into caller-visible wording through `describeSnapshotError`, so the distinction has to
 * survive the adapter boundary rather than collapsing into one opaque "the account could not
 * be read".
 */
export type BrokerSnapshotPart = 'balances' | 'complex-orders' | 'orders' | 'positions'
type BrokerSnapshotStage = 'page' | 'record'

/**
 * A broker account snapshot that could not be normalized. `message` is the adapter's own
 * failure name, which is what reaches a caller-visible message, so it must stay specific.
 * A transport failure is deliberately NOT wrapped in this: callers distinguish "the broker
 * would not answer" from "the broker answered something we refuse to believe".
 */
export class BrokerSnapshotError extends Error {
  constructor(
    readonly part: BrokerSnapshotPart,
    readonly stage: BrokerSnapshotStage,
    detail: string,
  ) {
    super(detail)
    this.name = 'BrokerSnapshotError'
  }
}

/**
 * How a caller names a snapshot it refuses to believe, in its own voice (`subject`). These
 * messages reach a member's agent and are how an incomplete account read is told apart from a
 * rejected trade, so each stays as specific as the part and stage allow.
 */
export function describeSnapshotError(error: BrokerSnapshotError, subject: string): string {
  if (error.part === 'positions') {
    return error.stage === 'record'
      ? `${subject} found an unsupported position record.`
      : `${subject} could not verify every open position: ${error.message}.`
  }
  if (error.part === 'balances') return `${subject} could not verify balances: ${error.message}.`
  const label = error.part === 'orders' ? 'every ordinary live order' : 'every complex live order'
  return `${subject} could not verify ${label}: ${error.message}.`
}

/**
 * A cancellation whose outcome the broker did not make knowable. The caller turns this into
 * its own caller-visible warning; what matters here is that an adapter must raise it rather
 * than retrying, because the broker may already have accepted the cancellation.
 */
export class BrokerCancellationAmbiguousError extends CallerVisibleError {
  constructor() {
    super('The broker may have received this cancellation, but the result could not be verified.')
    this.name = 'BrokerCancellationAmbiguousError'
  }
}

/** An unknown broker id. Never defaulted to a broker; account access fails closed. */
export class UnknownBrokerError extends CallerVisibleError {
  constructor(broker: string) {
    // The id is caller-supplied but already parsed against `BrokerIdSchema`, so it is one of
    // this repository's own ids, never a secret; naming it makes a misconfigured agent diagnosable.
    super(`No broker adapter is registered for '${broker}'.`)
    this.name = 'UnknownBrokerError'
  }
}

/** A bounded account-history request, in neutral terms; the adapter owns the query shape. */
export interface BrokerHistoryQuery {
  limit: number
  pageOffset: number
  /** Inclusive ISO date the history starts at. */
  startDate: string
  transactionType?: 'Money Movement' | 'Trade'
  type: 'orders' | 'transactions'
  underlyingSymbol?: string
}

/**
 * Every account read and cancellation spicytrade performs against a brokerage. Order placement is
 * deliberately absent: it still lives in `brokerage.ts` behind its own guards.
 *
 * Each method takes the request-scoped credential explicitly. No adapter may hold, cache,
 * or persist one, and an adapter that cannot work without a stored long-lived credential
 * does not belong here at all.
 */
export interface BrokerAdapter {
  readonly id: BrokerId

  /** Cancel one order. Ambiguity must surface as ambiguity; never retry internally. */
  cancelOrder(
    env: AppEnv,
    ref: BrokerAccountRef,
    orderId: string,
    credential: BrokerCredential | undefined,
  ): Promise<void>

  /** Positions, balances, and live orders as one consistent, completeness-checked read. */
  loadAccountSnapshot(
    env: AppEnv,
    ref: BrokerAccountRef,
    credential: BrokerCredential | undefined,
  ): Promise<BrokerAccountSnapshot>

  /** One bounded page of order or transaction history for the agent read tool. */
  readAccountHistory(
    env: AppEnv,
    ref: BrokerAccountRef,
    query: BrokerHistoryQuery,
    credential: BrokerCredential | undefined,
  ): Promise<BrokerAccountHistoryPage>

  /** One order, read back for a replacement echo check. */
  readOrder(
    env: AppEnv,
    ref: BrokerAccountRef,
    orderId: string,
    credential: BrokerCredential | undefined,
  ): Promise<BrokerOrderRecord>

  /** Recent order history for reconciling an ambiguous submission. */
  readOrderHistory(
    env: AppEnv,
    ref: BrokerAccountRef,
    options: { startDate: string },
    credential: BrokerCredential | undefined,
  ): Promise<BrokerOrderHistoryPage>

  /** The single account the credential grants; more than one is refused, never guessed. */
  resolveAccountRef(
    env: AppEnv,
    credential: BrokerCredential | undefined,
  ): Promise<BrokerAccountRef>
}
