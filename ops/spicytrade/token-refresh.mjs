/**
 * When the proxy stops handing out a cached broker access token.
 *
 * Refreshed on a margin rather than on a 401, so a placement is never attempted with a token that
 * dies mid-flight. A token is handed to one forwarded request, which the proxy abandons after
 * `UPSTREAM_TIMEOUT_MS`; retiring it that long before expiry means every request it rides on
 * finishes, or is abandoned, while it is still live. A tenth of the lifetime caps the margin for a
 * token too short-lived to spare a whole timeout and still be worth caching. This is the rule the
 * Worker applies to its own market credential, with this process's timeout in place of its own.
 */
const REFRESH_SKEW_FRACTION = 0.1

// The proxy's budget for one forwarded MCP call, headers through the last streamed byte. Nothing
// on the Worker bounds a request's wall time (Workers limit CPU, not wall-clock, and each broker
// call there carries its own timeout), so this is not a mirror of a Worker bound: it is meant to
// cover a single call's worst case, a placement's sequential broker round trips being the longest,
// and it is a named budget, the owner's judgment of that case rather than a figure derived from
// one: an agent left waiting longer than a minute on one tool call is better told it failed. It is also how long a
// broker token must outlive the moment it is attached; see tokenRetiresAt below.
export const UPSTREAM_TIMEOUT_MS = 60_000

// Minting a broker token is one tastytrade request, so it gets the budget the Worker gives one
// (TASTYTRADE_REQUEST_TIMEOUT_MS). Every local call whose answer waits on exactly one such
// request uses it too: the Worker's `/api/brokers/tastytrade/*` endpoints each make at most one,
// and abandon it at this same budget, so waiting longer would only hear the Worker's own
// timeout. It lives here, beside UPSTREAM_TIMEOUT_MS, because importing the proxy starts it.
export const TOKEN_REQUEST_TIMEOUT_MS = 20_000

export function tokenRetiresAt(issuedAtMs, lifetimeMs) {
  const skewMs = Math.min(UPSTREAM_TIMEOUT_MS, lifetimeMs * REFRESH_SKEW_FRACTION)
  return issuedAtMs + lifetimeMs - skewMs
}
