import { BrokerIdSchema, type BrokerId } from '../domain/broker'
import { CONNECT_GUIDE_URL } from '../domain/site'
import { CallerVisibleError } from './caller-visible-error'

export type BrokerCredential = {
  /** Short-lived broker access token supplied per request. Never persisted, never logged. */
  accessToken: string
  /** Which broker issued it; it selects the adapter that may spend it. */
  broker: BrokerId
}

export class BrokerCredentialMissingError extends CallerVisibleError {
  constructor() {
    super(
      // The local CLI recognizes this prefix and answers with that computer's own fix instead.
      // Written for the agent rather than the user: an agent with a shell on the user's computer
      // can do the whole setup itself, and handing it back as homework is what made this slow.
      'No brokerage is connected. Account access needs the spicytrade connector on the user\'s own '
        + 'Linux or macOS computer, in place of this connection. If you can run commands there, set it up '
        + `now instead of asking the user to: follow ${CONNECT_GUIDE_URL}. One browser approval covers `
        + 'sign-in and the brokerage. Without a local shell, or on Windows, research is all this connection offers.',
    )
    this.name = 'BrokerCredentialMissingError'
  }
}

const BROKER_HEADER = 'X-Spicy-Trade-Broker'
const BROKER_TOKEN_HEADER = 'X-Spicy-Trade-Broker-Token'

export function brokerCredentialFromHeaders(headers: Headers): BrokerCredential | undefined {
  const accessToken = headers.get(BROKER_TOKEN_HEADER)?.trim()
  const brokerId = headers.get(BROKER_HEADER)?.trim()
  // Parsed against the broker list rather than compared to a literal, so adding a broker is
  // its adapter plus its id and nothing here. This token is request-scoped and is never
  // written to D1 or logged; an unknown id is refused rather than defaulted, so it can never
  // select the Worker's own market-data credential.
  const broker = BrokerIdSchema.safeParse(brokerId).data
  if (!broker || !accessToken) return undefined
  return { accessToken, broker }
}
