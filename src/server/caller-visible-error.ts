/**
 * An error whose message this repository wrote for whoever made the call. It reaches every
 * caller who can reach the throwing path -- through an MCP tool result that is any member's
 * agent, not only the owner -- so its message is this repository's own vocabulary and never
 * carries a value from a provider payload, a frame, or a secret.
 *
 * The MCP boundary (`toolErrorResult`) passes this message verbatim. Every other error reaches
 * the caller as its name alone, so a failure that should be actionable must be one of these.
 */
export class CallerVisibleError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CallerVisibleError'
  }
}

/** A tool's integer argument, defaulted when omitted and refused by name when out of range. */
export function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new CallerVisibleError(`${label} is invalid.`)
  }
  return result
}

/** The checks a broker-sourced refusal can name, in this repository's vocabulary. */
type BrokerRefusalCheck =
  | 'broker-rejected'
  | 'broker-warning'
  | 'limit-off-tick'
  | 'limit-outside-quote'

/**
 * Values the broker supplied that explain a refusal: its own message text (already bounded by
 * `messagePacket` in `brokerage.ts`) or the market figures a limit was checked against. They are
 * useful to the caller and are not ours, so they never enter the message; the boundary renders
 * them in a field whose name says they are untrusted.
 */
type UntrustedBrokerData =
  | { messages: readonly string[] }
  | { ask: number; bid: number }
  | { tickSize: number }

/**
 * A refusal whose reason is partly the broker's. The message names the check in our words;
 * what the broker said stays in `untrustedBrokerData`.
 */
export class BrokerRefusalError extends CallerVisibleError {
  constructor(
    readonly check: BrokerRefusalCheck,
    message: string,
    readonly untrustedBrokerData: UntrustedBrokerData,
  ) {
    super(message)
    this.name = 'BrokerRefusalError'
  }
}
