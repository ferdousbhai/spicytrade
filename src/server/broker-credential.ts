import { BrokerIdSchema, type BrokerId } from '../domain/broker'
import { INSTALL_SCRIPT_URL } from '../domain/site'
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
      // Its first sentence is matched by `ops/spicytrade/mcp.mjs` (NO_BROKERAGE_PREFIX), which swaps in
      // an installed computer's own fix; change them together. So the rest is read only by agents
      // connected without the install, for whom reconnecting can never bring a brokerage: the
      // install (which also repairs an existing one) can, and it ends by naming how to start each
      // agent it set up, which differs between them. The command comes last, with nothing after
      // it, so copying it takes no trailing punctuation.
      'No brokerage is connected. Positions and orders need spicytrade installed on the computer your agent runs'
        + ' on (Linux, with Claude Code or Codex). Run this in a terminal there, then start your agent the way it says at the end:'
        + ` curl -fsSL ${INSTALL_SCRIPT_URL} | bash`,
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
