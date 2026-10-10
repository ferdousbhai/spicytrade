import {
  parseOrderPlacement,
  type FreshOrderPlacement,
  type OrderPlacement,
} from './agent-contracts'
import { executeOrderPlacement, type SubmissionReceipt } from './brokerage'
import { type JsonValue } from '../domain/json-payload'
import { type AppEnv } from './env'
import { PortfolioRiskError } from './portfolio-risk'
import { brokerAdapterFor } from './brokers'
import { internalWatchlistWriter } from './internal-watchlist'
import { BrokerCredentialMissingError, type BrokerCredential } from './broker-credential'

async function rememberTradeIntentSymbol(env: AppEnv, action: FreshOrderPlacement): Promise<void> {
  const symbol = action.kind === 'place_equity_order' ? action.symbol : action.underlying
  await internalWatchlistWriter().ensureSymbols(env, [symbol], 'trade-intent')
}

/**
 * Place one order, guards first.
 *
 * There is no draft step any more. The agent runs on the member's own machine and its client
 * prompts before the tool executes, so the second channel a server-held confirmation token used
 * to buy no longer exists to be bought. What decides admissibility is unchanged and still runs
 * here: the contract is resolved from the live chain rather than taken from the model, the
 * portfolio and market guards run against fresh broker state, and the broker's own dry-run must
 * come back clean before anything is submitted.
 *
 * There is deliberately no placement rate limit, and one should not be added. Cadence is not
 * what bounds the damage here: the mutation lease serializes the submit, the limit is the
 * debit, and the broker dry-run is the buying-power check. How many tickets to work at once is
 * agent advice, not a server veto. A rate limit would add a bound with no policy behind it
 * and would refuse a legitimate correction — including a cancel-and-replace — at exactly the
 * moment it is most needed.
 */
export async function placeBrokerageOrder(
  env: AppEnv,
  untrustedAction: JsonValue,
  credential: BrokerCredential | undefined,
  waitUntil: (task: Promise<unknown>) => void,
): Promise<SubmissionReceipt> {
  if (!credential) throw new BrokerCredentialMissingError()
  if (!env.DB) throw new PortfolioRiskError('The brokerage submission store is unavailable.')
  const action: OrderPlacement = parseOrderPlacement(untrustedAction)
  // Placement has not moved behind the adapter -- it still writes tastytrade's own paths -- so
  // refuse another broker by name here. Today such a credential fails closed in the transport
  // anyway, but with a "connect a brokerage" message that would be actively misleading once a
  // second adapter is registered for reads.
  const adapter = brokerAdapterFor(credential)
  if (adapter.id !== 'tastytrade') {
    throw new PortfolioRiskError(`Order placement is not implemented for ${adapter.id}. Account reads work; placing an order does not.`)
  }
  // Account discovery is an account read, so it goes through the adapter like cancellation's.
  const { accountNumber } = await adapter.resolveAccountRef(env, credential)
  // The quarantine check is the write-ahead claim inside `executeOrderPlacement`, under the
  // mutation lease and atomic in D1; a check out here would race a concurrent placement.
  return executeOrderPlacement(
    env,
    action,
    credential,
    accountNumber,
    // An order the broker accepted is the deterministic point where a discussed trade becomes a
    // trusted ticker, including a price-only replacement. A refused order earns no provenance,
    // and a failed write here is logged by `executeOrderPlacement` rather than refusing the order.
    // Scheduled, never awaited: the receipt must not wait on a watchlist write.
    { run: (intent) => rememberTradeIntentSymbol(env, intent.effectiveAction), waitUntil },
  )
}

/**
 * Cancel one working order.
 *
 * There is deliberately no guard to run here: cancelling only ever reduces exposure, and the
 * thing that must not happen — an automatic retry after an ambiguous DELETE — is the adapter's
 * responsibility and it raises rather than retries.
 */
export async function cancelBrokerageOrder(
  env: AppEnv,
  orderId: string,
  credential: BrokerCredential | undefined,
): Promise<{ cancelled: string; detail: string }> {
  const adapter = brokerAdapterFor(credential)
  const ref = await adapter.resolveAccountRef(env, credential)
  await adapter.cancelOrder(env, ref, orderId, credential)
  return { cancelled: orderId, detail: `Order #${orderId} cancelled.` }
}
