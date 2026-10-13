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
      // The local relay recognizes this prefix and offers its in-conversation connection tool.
      'No brokerage is connected. Connect Spicytrade in your current agent conversation using '
        + `${CONNECT_GUIDE_URL}. Account access needs the local Linux connector; research can use the remote MCP server.`,
    )
    this.name = 'BrokerCredentialMissingError'
  }
}

/**
 * The broker headers, under their current names and the pre-rename `X-Spice-*` ones. A member's
 * local `spicytrade` updates on its own schedule, so this Worker accepts both; it moves to the
 * current names once this is live, and the old names go once installs have moved. A header sent under both
 * names with different values is refused, not resolved: which one wins would be a guess.
 */
const BROKER_HEADER = { current: 'X-Spicy-Trade-Broker', legacy: 'X-Spice-Broker' } as const
const BROKER_TOKEN_HEADER = { current: 'X-Spicy-Trade-Broker-Token', legacy: 'X-Spice-Broker-Token' } as const

/** The trimmed value under either name; `conflict` when the two names carry different values. */
function brokerHeader(headers: Headers, names: { current: string; legacy: string }): string | undefined | 'conflict' {
  const current = headers.get(names.current)?.trim()
  const legacy = headers.get(names.legacy)?.trim()
  if (current !== undefined && legacy !== undefined && current !== legacy) return 'conflict'
  return current ?? legacy
}

export function brokerCredentialFromHeaders(headers: Headers): BrokerCredential | undefined {
  const accessToken = brokerHeader(headers, BROKER_TOKEN_HEADER)
  const brokerId = brokerHeader(headers, BROKER_HEADER)
  if (accessToken === 'conflict' || brokerId === 'conflict') return undefined
  // Parsed against the broker list rather than compared to a literal, so adding a broker is
  // its adapter plus its id and nothing here. This token is request-scoped and is never
  // written to D1 or logged; an unknown id is refused rather than defaulted, so it can never
  // select the Worker's own market-data credential.
  const broker = BrokerIdSchema.safeParse(brokerId).data
  if (!broker || !accessToken) return undefined
  return { accessToken, broker }
}
