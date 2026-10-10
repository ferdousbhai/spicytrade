import { UPSTREAM } from './config.mjs'
import { UPSTREAM_TIMEOUT_MS } from './token-refresh.mjs'

/**
 * Whether spicytrade accepts an agent token: the one question `setup`, `doctor` and the
 * credential scripts all have to answer before they can say anything useful.
 *
 * Asked the way an agent would ask it -- a `tools/list` on the MCP endpoint, the cheapest call that
 * requires the token -- so an accepted answer means the proxy's calls will be accepted too. It is
 * one forwarded MCP call, so it gets the proxy's budget for one. The token rides in the
 * Authorization header of this request and nowhere else; no answer body is read.
 *
 * `accepted`, `rejected` (a 401), `unanswered` with the status for any other refusal, or
 * `unreachable` with the fixed-vocabulary transport code.
 */
export async function checkAgentToken(token) {
  let response
  try {
    response = await fetch(UPSTREAM, {
      body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }),
      headers: {
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
  } catch (error) {
    const cause = error instanceof Error && error.cause instanceof Error && 'code' in error.cause
      ? String(error.cause.code)
      : error instanceof Error ? error.name : 'UnknownError'
    return { status: 'unreachable', transport: /^[A-Za-z0-9_]+$/.test(cause) ? cause : 'UnknownError' }
  }
  await response.body?.cancel()
  if (response.status === 401) return { status: 'rejected' }
  if (!response.ok) return { httpStatus: response.status, status: 'unanswered' }
  return { status: 'accepted' }
}

/** One line describing a token check. */
export function describeTokenCheck(check) {
  switch (check.status) {
    case 'accepted': return 'spicytrade accepts the agent token'
    case 'rejected': return 'spicytrade rejected the agent token'
    case 'unanswered': return `spicytrade could not check the agent token (HTTP ${check.httpStatus})`
    default: return `spicytrade could not be reached (${check.transport})`
  }
}
