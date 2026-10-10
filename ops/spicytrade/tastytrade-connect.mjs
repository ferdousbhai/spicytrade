import { z } from 'zod'

import { AppGrantRefusalSchema } from './broker-grants.mjs'
import { cliCommand, ORIGIN } from './config.mjs'
import {
  agentToken, APP_REFRESH_TOKEN_KEY, CLIENT_SECRET_KEY, keyringStore, REFRESH_TOKEN_KEY, TASTYTRADE,
  tastytradeCredentialKind,
} from './keyring.mjs'
import { awaitReturn, CliFailure, loopbackListener, openBrowser } from './loopback.mjs'
import { restartProxy } from './systemd.mjs'
import { TOKEN_REQUEST_TIMEOUT_MS } from './token-refresh.mjs'

/**
 * `spicytrade connect-tastytrade`: connect tastytrade through spicytrade's OAuth app, once, and
 * keep the result in the OS keyring.
 *
 * The member approves spicytrade on tastytrade's own page; the browser comes back through the Worker
 * to a listener here on the loopback address; this process redeems the code through the Worker
 * and stores the refresh token under `tastytrade/app-refresh-token`, where the local proxy finds
 * it. The Worker holds the app's client secret and never keeps the refresh token; this machine
 * keeps the refresh token and never needs a client secret.
 *
 * Every Worker call carries the member's spicytrade agent token from the keyring, which is what binds
 * the whole connection to that member: a started connection can be redeemed only with the same
 * token, so the consent URL, the code, and the state are each useless to anyone else.
 *
 * Output is fixed vocabulary. No token, code, or state is printed; the consent URL is, because
 * following it is the whole point, and its state grants nothing without the agent token.
 */

const PROGRAM = 'SpicytradeConnectTastytrade'
const BROKER = TASTYTRADE
const KEY = APP_REFRESH_TOKEN_KEY

const AuthorizeResponseSchema = z.object({
  authorizationUrl: z.url({ protocol: /^https$/ }),
  expiresAt: z.iso.datetime(),
  state: z.string().min(1),
})
const ExchangeResponseSchema = z.object({ refreshToken: z.string().min(1) })

/**
 * One call to the Worker. A refusal is reported by status and, for a tastytrade refusal the
 * Worker relays, tastytrade's status; never by body text, which for the exchange could carry
 * credential material.
 */
async function callWorker(path, agentBearer, body) {
  let response
  try {
    response = await fetch(new URL(path, ORIGIN), {
      body: JSON.stringify(body),
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${agentBearer}`,
        'Content-Type': 'application/json',
      },
      method: 'POST',
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    })
  } catch (error) {
    throw new CliFailure(`spicytrade could not be reached (${error instanceof Error ? error.name : 'UnknownError'})`)
  }
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) {
    const tastytradeStatus = AppGrantRefusalSchema.safeParse(payload)
    if (response.status === 401) {
      throw new CliFailure(`spicytrade did not accept the agent token in the keyring. Sign in again with:\n  ${cliCommand('login')}`)
    }
    if (tastytradeStatus.success) throw new CliFailure(`tastytrade refused the grant (HTTP ${tastytradeStatus.data.tastytradeStatus})`)
    throw new CliFailure(`spicytrade refused ${path} (HTTP ${response.status})`)
  }
  return payload
}

/** Connect, store the grant, and restart the proxy so it uses it. Progress goes to `out`. */
export async function connectTastytrade(out = process.stdout) {
  const agentBearer = await agentToken(PROGRAM)
  if (!agentBearer) {
    throw new CliFailure(`no spicytrade token in the keyring. Sign this machine in first:\n  ${cliCommand('login')}`)
  }
  // The proxy refuses a keyring holding both kinds, so connecting over a personal grant would
  // only leave it unable to start. Say so now, before the member goes through tastytrade.
  const { kind } = await tastytradeCredentialKind(PROGRAM)
  if (kind === 'personal' || kind === 'ambiguous') {
    throw new CliFailure('the keyring already holds a tastytrade personal grant, and the proxy refuses to start with both.\n'
      + 'Remove it first:\n'
      + `  secret-tool clear service ${BROKER} key ${CLIENT_SECRET_KEY}\n`
      + `  secret-tool clear service ${BROKER} key ${REFRESH_TOKEN_KEY}`)
  }

  const listener = await loopbackListener(PROGRAM, {
    forbidden: 'This listener only answers the tastytrade return.',
    received: 'spicytrade received the authorization. You can close this tab and return to the terminal.',
    refused: 'tastytrade did not grant access. You can close this tab.',
  })
  let authorization
  try {
    authorization = AuthorizeResponseSchema.safeParse(
      await callWorker('/api/brokers/tastytrade/authorize', agentBearer, { port: listener.port }),
    )
  } catch (error) {
    // An open listener would keep this process alive after the failure is reported.
    listener.close()
    throw error
  }
  if (!authorization.success) {
    listener.close()
    throw new CliFailure('spicytrade answered the authorization request with an unreadable response')
  }
  const { authorizationUrl, expiresAt, state } = authorization.data
  listener.expect(state)

  out.write(`Approve spicytrade on tastytrade to connect your account:\n\n  ${authorizationUrl}\n\n`)
  openBrowser(authorizationUrl)

  // Waits no longer than the Worker keeps the connection redeemable.
  const outcome = await awaitReturn(listener, Date.parse(expiresAt) - Date.now())
  if (outcome.lapsed) throw new CliFailure('the connection expired before tastytrade returned; run this again')
  if (outcome.error) throw new CliFailure(`tastytrade did not grant access (${outcome.error})`)

  const exchanged = ExchangeResponseSchema.safeParse(
    await callWorker('/api/brokers/tastytrade/exchange', agentBearer, { code: outcome.code, state }),
  )
  if (!exchanged.success) throw new CliFailure('spicytrade answered the exchange with an unreadable response')
  const { refreshToken } = exchanged.data

  if (!await keyringStore(PROGRAM, BROKER, KEY, 'tastytrade refresh token (spicytrade app)', refreshToken)) {
    throw new CliFailure(`failed to store ${BROKER}/${KEY}`)
  }
  out.write(`Stored ${BROKER}/${KEY}.\n`)

  restartProxy(out)
}
