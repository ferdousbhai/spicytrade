import { type BrokerAccountSnapshot, type BrokerId } from '../domain/broker'
import { brokerAdapterFor } from './brokers'
import { type BrokerCredential } from './broker-credential'
import { type AppEnv } from './env'

/**
 * One broker account as the rest of the server sees it: the provider-neutral snapshot and the
 * broker that answered. The account number stays behind the adapter: nothing above this line
 * reads it, and a field no reader needs is one more place it could leak from.
 */
type BrokerageContext = BrokerAccountSnapshot & {
  source: BrokerId
}

export async function loadBrokerageContext(
  env: AppEnv,
  credential: BrokerCredential | undefined,
): Promise<BrokerageContext> {
  const adapter = brokerAdapterFor(credential)
  const ref = await adapter.resolveAccountRef(env, credential)
  const snapshot = await adapter.loadAccountSnapshot(env, ref, credential)
  return { ...snapshot, source: ref.broker }
}
