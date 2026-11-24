import { transportCode } from './broker-grants.mjs'
import { CliFailure } from './cli.mjs'
import { cliCommand, ORIGIN, UPSTREAM, workerFault } from './config.mjs'
import { UPSTREAM_TIMEOUT_MS } from './token-refresh.mjs'

/**
 * Whether spicytrade accepts an agent token: the one question `setup`, `doctor` and the
 * credential scripts all have to answer before they can say anything useful.
 *
 * Asked the way an agent would ask it -- a `tools/list` on the MCP endpoint, the cheapest call that
 * requires the token -- so an accepted answer means `spicytrade mcp`'s calls will be accepted too.
 * It is one relayed MCP call, so it gets the budget for one. The token rides in the
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
    return { status: 'unreachable', transport: transportCode(error) ?? 'UnknownError' }
  }
  await response.body?.cancel()
  if (workerFault(response)) return { httpStatus: response.status, status: 'unanswered' }
  if (response.status === 401) return { status: 'rejected' }
  if (!response.ok) return { httpStatus: response.status, status: 'unanswered' }
  return { status: 'accepted' }
}

/** One line describing a token check. */
export function describeTokenCheck(check) {
  switch (check.status) {
    case 'accepted': return 'signed in to spicytrade'
    case 'rejected': return 'this computer was signed out of spicytrade (revoked under Signed-in computers)'
    case 'unanswered': return `spicytrade could not check this computer's sign-in (HTTP ${check.httpStatus})`
    default: return `spicytrade could not be reached (${check.transport})`
  }
}

/**
 * One JSON POST to the Worker, abandoned after `timeoutMs`: its status, and its body as JSON or
 * undefined when it is not JSON. `bearer` is the agent token, for the calls that need one. A call
 * the Worker never answered is the one failure decided here; what a status means is the caller's.
 */
export async function postWorker(path, body, timeoutMs, bearer) {
  const headers = { Accept: 'application/json', 'Content-Type': 'application/json' }
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  let response
  try {
    response = await fetch(new URL(path, ORIGIN), {
      body: JSON.stringify(body),
      headers,
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    // The cause's own word -- ENOTFOUND, ECONNREFUSED, TimeoutError -- not fetch's bare TypeError.
    const cause = transportCode(error)
    throw new CliFailure(`spicytrade could not be reached${cause ? ` (${cause})` : ''}. Check your internet connection, then run: ${cliCommand('connect')}`)
  }
  return { ok: response.ok, payload: await response.json().catch(() => undefined), status: response.status }
}
