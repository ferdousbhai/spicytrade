import { type FreshOrderPlacement } from './agent-contracts'
import { type AppEnv } from './env'
import { CallerVisibleError } from './caller-visible-error'
import { type EquityOptionContract } from './option-contract'
import { type BrokerAccountRef, type BrokerAccountSnapshot, type BrokerPosition } from '../domain/broker'
import { brokerAdapterFor, BrokerSnapshotError, describeSnapshotError } from './brokers'
import { BrokerCredentialMissingError, type BrokerCredential } from './broker-credential'

type RiskPosition = Pick<BrokerPosition, 'direction' | 'instrumentType' | 'quantity' | 'symbol'>

interface RiskAccount {
  positions: RiskPosition[]
}

/** A refusal always carries its reason, so the guard never has to invent one. */
type PortfolioActionAssessment =
  | { allowed: true }
  | { allowed: false; reason: string }

export class PortfolioRiskError extends CallerVisibleError {
  constructor(message: string) {
    super(message)
    this.name = 'PortfolioRiskError'
  }
}

async function loadRiskAccount(
  env: AppEnv,
  ref: BrokerAccountRef,
  credential: BrokerCredential | undefined,
): Promise<RiskAccount> {
  let snapshot: BrokerAccountSnapshot
  try {
    snapshot = await brokerAdapterFor(credential).loadAccountSnapshot(env, ref, credential)
  } catch (error) {
    if (error instanceof BrokerCredentialMissingError) throw error
    // A BrokerSnapshotError means the broker answered something the adapter refuses to
    // believe; anything else means it would not answer at all.
    if (error instanceof BrokerSnapshotError) {
      throw new PortfolioRiskError(describeSnapshotError(error, 'The portfolio guard'))
    }
    throw new PortfolioRiskError('The portfolio guard could not refresh the complete brokerage account.')
  }
  const { netLiquidatingValue, cashBalance } = snapshot.balances
  if (netLiquidatingValue <= 0) {
    throw new PortfolioRiskError('The portfolio guard could not verify net liquidation value.')
  }
  if (cashBalance < 0) throw new PortfolioRiskError('The portfolio guard found a negative cash reserve.')
  return { positions: snapshot.positions }
}

function unsupportedOpeningPosition(position: RiskPosition): boolean {
  return position.direction !== 'Long'
    || (position.instrumentType !== 'Equity' && position.instrumentType !== 'Equity Option')
}

function closingPosition(
  action: FreshOrderPlacement,
  account: RiskAccount,
  optionContract?: EquityOptionContract,
): RiskPosition | undefined {
  if (action.kind === 'place_vertical_spread_order') return undefined
  const symbol = action.kind === 'place_option_order' ? optionContract?.symbol : action.symbol
  const instrumentType = action.kind === 'place_option_order' ? 'Equity Option' : 'Equity'
  const direction = action.action === 'Sell to Close' ? 'Long' : 'Short'
  return account.positions.find((position) => position.symbol === symbol
    && position.instrumentType === instrumentType
    && position.direction === direction
    && position.quantity >= action.quantity)
}

export function assessPortfolioAction(
  action: FreshOrderPlacement,
  account: RiskAccount,
  optionContracts: readonly EquityOptionContract[] = [],
): PortfolioActionAssessment {
  const isClose = action.kind !== 'place_vertical_spread_order'
    && (action.action === 'Sell to Close' || action.action === 'Buy to Close')
  if (isClose) {
    if (!closingPosition(action, account, optionContracts[0])) {
      return { allowed: false, reason: 'The requested close is larger than the verified matching position.' }
    }
    if (action.action === 'Sell to Close' && account.positions.some(unsupportedOpeningPosition)) {
      return { allowed: false, reason: 'This account will not remove long collateral or protection while unsupported short exposure remains.' }
    }
    return { allowed: true }
  }
  if (action.kind !== 'place_vertical_spread_order'
    && (action.action !== 'Buy to Open' || action.priceEffect !== 'Debit')) {
    return { allowed: false, reason: 'This account will not open a naked or unbounded short position.' }
  }
  if (account.positions.some(unsupportedOpeningPosition)) {
    return { allowed: false, reason: 'Existing short, futures, or unsupported exposure prevents bounding the loss of a new position.' }
  }
  // The limit is the debit. Buying power is the broker dry-run, not a second cash floor. The
  // contract multiplier needs no check here: resolution refuses any contract whose
  // shares-per-contract is not a positive integer, and the guard refuses a missing contract.
  return { allowed: true }
}

/**
 * The portfolio guard. Against a fresh, completeness-checked snapshot (positive net liquidation
 * value, non-negative cash, every position and live-order page complete), it admits a close
 * only up to the verified matching position, and an open only as a debit Buy to Open or debit
 * vertical while the account holds nothing short, futures, or otherwise unsupported. It does
 * not size the trade: the limit is the debit and the broker dry-run is the buying-power check.
 */
export async function assertPortfolioActionAllowed(
  env: AppEnv,
  action: FreshOrderPlacement,
  credential: BrokerCredential | undefined,
  resolved: { accountNumber: string; optionContracts: readonly EquityOptionContract[] },
): Promise<void> {
  // Both are resolved once, by placement, before the guard runs: the account inside the caller's
  // credential check and the contracts from the live chain inside the mutation lease. The guard
  // judges exactly those, never a second resolution that could disagree with what is submitted.
  const ref = { accountNumber: resolved.accountNumber, broker: brokerAdapterFor(credential).id }
  const account = await loadRiskAccount(env, ref, credential)
  const { optionContracts } = resolved
  if (action.kind === 'place_option_order' && optionContracts.length !== 1) {
    throw new PortfolioRiskError('The guard could not verify the option contract.')
  }
  if (action.kind === 'place_vertical_spread_order' && optionContracts.length !== 2) {
    throw new PortfolioRiskError('The guard could not verify both spread contracts.')
  }
  const assessment = assessPortfolioAction(action, account, optionContracts)
  if (!assessment.allowed) throw new PortfolioRiskError(assessment.reason)
}
