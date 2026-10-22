import { type BrokerId } from '../../domain/broker'
import { type BrokerCredential, BrokerCredentialMissingError } from '../broker-credential'
import { defineSeam } from '../seam'
import { UnknownBrokerError, type BrokerAdapter } from './contract'
import { tastytradeAdapter } from './tastytrade'

/**
 * Every brokerage spicytrade can read an account from. Adding one is this entry plus the
 * adapter file it names — no account reader above this layer learns a second provider.
 *
 * It is a seam so a test can register a stub broker and drive the account readers end to
 * end without any provider code in the path; production always rebuilds this map.
 */
const brokerAdaptersSeam = defineSeam<Readonly<Record<string, BrokerAdapter>>>(() => ({
  tastytrade: tastytradeAdapter,
  // Checked against `BrokerIdSchema`: an id added there without an adapter here, or an adapter
  // registered under an id the header parser would refuse, fails to compile. The seam's own type
  // stays a string record only so a test can register a stub broker outside the union.
} satisfies Record<BrokerId, BrokerAdapter>))

const brokerAdapters = brokerAdaptersSeam.current

export const setBrokerAdapters = brokerAdaptersSeam.set

export const resetBrokerAdapters = brokerAdaptersSeam.reset

/**
 * The adapter for a presented credential. An absent credential and an unregistered broker
 * id are both refused: account access fails closed rather than falling back to a default
 * broker, which is what keeps the Worker's own market-data credential unreachable here.
 */
export function brokerAdapterFor(credential: BrokerCredential | undefined): BrokerAdapter {
  if (!credential?.broker) throw new BrokerCredentialMissingError()
  const registered = brokerAdapters()
  // Registry membership is explicit: inherited object properties are never broker adapters.
  const adapter = Object.hasOwn(registered, credential.broker) ? registered[credential.broker] : undefined
  if (!adapter) throw new UnknownBrokerError(credential.broker)
  return adapter
}

export {
  BrokerCancellationAmbiguousError,
  BrokerSnapshotError,
  describeSnapshotError,
  UnknownBrokerError,
  type BrokerAdapter,
  type BrokerHistoryQuery,
} from './contract'
