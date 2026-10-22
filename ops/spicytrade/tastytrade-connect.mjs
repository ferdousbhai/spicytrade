import { spawnSync } from 'node:child_process'
import { z } from 'zod'

import { AppGrantRefusalSchema, transportCode } from './broker-grants.mjs'
import { cliCommand, ORIGIN } from './config.mjs'
import { keyringEnvironment } from './keyring-environment.mjs'
import {
  agentToken, APP_REFRESH_TOKEN_KEY, CLIENT_SECRET_KEY, keyringClear, keyringSecret, keyringStore, KeyringUnavailable, REFRESH_TOKEN_KEY, TASTYTRADE,
  tastytradeCredentialKind,
} from './keyring.mjs'
import { awaitReturn, CliFailure, loopbackListener, openBrowser, remoteNote, unexpectedTail } from './loopback.mjs'
import { TOKEN_REQUEST_TIMEOUT_MS } from './token-refresh.mjs'

/**
 * `spicytrade connect-tastytrade`: connect tastytrade through spicytrade's OAuth app, once, and
 * keep the result in the OS keyring.
 *
 * The member approves spicytrade on tastytrade's own page; the browser comes back through the Worker
 * to a listener here on the loopback address; this process redeems the code through the Worker
 * and stores the refresh token under `tastytrade/app-refresh-token`, where `spicytrade mcp` finds
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
/**
 * How long a started connection stays pending on the Worker (`BROKER_AUTHORIZATION_TTL_MS` in
 * `src/domain/broker-authorization.ts`), which this package cannot import: once that passes, the
 * pending ones no longer count against the member's limit.
 */
const PENDING_WAIT_MINUTES = 10
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
    // The cause's own word -- ENOTFOUND, ECONNREFUSED, TimeoutError -- not fetch's bare TypeError.
    const cause = transportCode(error)
    throw new CliFailure(`spicytrade could not be reached${cause ? ` (${cause})` : ''}. Check your internet connection, then run: ${cliCommand('setup')}`)
  }
  const payload = await response.json().catch(() => undefined)
  if (!response.ok) {
    const tastytradeStatus = AppGrantRefusalSchema.safeParse(payload)
    if (response.status === 401) {
      throw new CliFailure(`this computer was signed out of spicytrade (revoked under Signed-in computers). Sign in again with: ${cliCommand('setup')}`)
    }
    const again = cliCommand('setup')
    if (tastytradeStatus.success) {
      throw new CliFailure(`tastytrade did not accept the connection (HTTP ${tastytradeStatus.data.tastytradeStatus}). To try again, run: ${again}`)
    }
    // The Worker's own refusals (src/server/broker-authorizations.ts), each in words that say what to do.
    if (response.status === 503) throw new CliFailure(`connecting tastytrade is unavailable right now. Try again later with: ${again}`)
    if (response.status === 409) {
      throw new CliFailure(`too many tastytrade connections were started and not finished. Wait ${PENDING_WAIT_MINUTES} minutes, then run: ${again}`)
    }
    if (response.status === 404) throw new CliFailure(`this tastytrade connection expired. Run: ${again}`)
    throw new CliFailure(`spicytrade could not connect tastytrade (HTTP ${response.status}). To try again, run: ${again}`)
  }
  return payload
}

/**
 * The member chose not to finish connecting -- declined on tastytrade's page, or let the approval
 * lapse. Not a failure of anything: `setup` reports the reason quietly and says once, at its end,
 * how to connect later; run alone, the message carries that itself.
 */
export class NotConnected extends CliFailure {
  constructor(reason) {
    super(`${reason}. Connect any time with: ${cliCommand('setup')}`)
    this.name = 'NotConnected'
    this.reason = reason
  }
}

/** Connect and store the grant. Progress goes to `out`. */
export async function connectTastytrade(out = process.stdout) {
  const agentBearer = await agentToken()
  if (!agentBearer) {
    throw new CliFailure(`this computer is not signed in to spicytrade. Run: ${cliCommand('setup')}`)
  }
  // A working personal grant is the member's choice, so connecting over it is refused rather than
  // replacing it. Two connections, or half a personal grant, cannot trade at all: the new
  // connection replaces them once it is in hand.
  const { kind } = await tastytradeCredentialKind()
  if (kind === 'personal') {
    throw new CliFailure('tastytrade is already connected with your personal grant. To switch, run:\n'
      + `  ${cliCommand('disconnect-tastytrade')}\nthen run this again.`)
  }

  const listener = await loopbackListener(PROGRAM, {
    forbidden: 'This listener only answers the tastytrade return.',
    received: 'tastytrade approved. Return to your agent conversation or terminal while the connection finishes.',
    refused: 'Not connected. You can close this tab.',
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
    throw new CliFailure(`spicytrade answered the authorization request with an unreadable response. ${unexpectedTail()}`)
  }
  const { authorizationUrl, expiresAt, state } = authorization.data
  listener.expect(state)

  out.write(`Approve spicytrade on tastytrade to connect your account:\n${remoteNote(listener.port)}\n  ${authorizationUrl}\n\n`)
  openBrowser(authorizationUrl)

  // Waits no longer than the Worker keeps the connection redeemable.
  out.write('Waiting for tastytrade. To skip for now, press Ctrl-C.\n')
  const outcome = await awaitReturn(listener, Date.parse(expiresAt) - Date.now(), { skippable: true })
  if (outcome.skipped) throw new NotConnected('skipped for now, so tastytrade is not connected')
  if (outcome.lapsed) throw new NotConnected('the tastytrade approval expired, so it is not connected')
  if (outcome.error === 'access_denied') throw new NotConnected('you declined on tastytrade, so it is not connected')
  if (outcome.error) throw new CliFailure(`tastytrade did not grant access (${outcome.error}). Try again with: ${cliCommand('setup')}`)

  const exchanged = ExchangeResponseSchema.safeParse(
    await callWorker('/api/brokers/tastytrade/exchange', agentBearer, { code: outcome.code, state }),
  )
  if (!exchanged.success) throw new CliFailure(`spicytrade answered the exchange with an unreadable response. ${unexpectedTail()}`)
  const { refreshToken } = exchanged.data

  for (const key of [CLIENT_SECRET_KEY, REFRESH_TOKEN_KEY]) {
    if (!await keyringClear(BROKER, key)) throw new KeyringUnavailable()
  }
  if (!await keyringStore(BROKER, KEY, 'tastytrade refresh token (spicytrade app)', refreshToken)) {
    throw new KeyringUnavailable()
  }
  out.write('✓ tastytrade connected.\n')
}

/**
 * `spicytrade store-personal-grant`: keep a personal grant from the member's own tastytrade OAuth
 * app (my.tastytrade.com > OAuth Applications > Manage > Create Grant) instead of connecting
 * through spicytrade's. `secret-tool store` prompts for each value on the terminal itself, so
 * neither reaches this process, the shell history, or any argument list.
 */
export async function storePersonalGrant(out = process.stdout) {
  if (!process.stdin.isTTY) throw new CliFailure('this prompts for the grant, so it needs a terminal')
  const { kind } = await tastytradeCredentialKind()
  if (kind === 'app' || kind === 'ambiguous') {
    throw new CliFailure('tastytrade is already connected. To switch to a personal grant, run:\n'
      + `  ${cliCommand('disconnect-tastytrade')}\nthen run this again.`)
  }
  for (const [key, label] of [[CLIENT_SECRET_KEY, 'tastytrade OAuth client secret'], [REFRESH_TOKEN_KEY, 'tastytrade refresh token']]) {
    out.write(`Paste your ${label} at the Password prompt (it is not shown as you type):\n`)
    spawnSync('secret-tool', ['store', `--label=${label}`, 'service', BROKER, 'key', key], { stdio: 'inherit', env: await keyringEnvironment() })
    if (!await keyringSecret(BROKER, key)) {
      // Cancelled at the prompt. Half a grant cannot trade, so none is kept.
      for (const partial of [CLIENT_SECRET_KEY, REFRESH_TOKEN_KEY]) await keyringClear(BROKER, partial)
      throw new CliFailure(`nothing was saved for the ${label}. To try again, run: ${cliCommand('store-personal-grant')}`)
    }
  }
  out.write('✓ tastytrade connected with your personal grant.\n')
}

/**
 * `spicytrade disconnect-tastytrade`: remove every tastytrade credential from the keyring, of
 * either kind. It is the one way out of a connection the member no longer wants, and the one fix
 * for a keyring holding both kinds.
 */
export async function disconnectTastytrade(out = process.stdout) {
  // Read first: where the grant itself is ended depends on whose app issued it. Resolves whether
  // anything was removed, so a run with nothing connected says so and nothing more.
  const { kind } = await tastytradeCredentialKind()
  if (kind === 'none') {
    out.write('· tastytrade was not connected on this computer; nothing to remove.\n')
    return false
  }
  for (const key of [APP_REFRESH_TOKEN_KEY, CLIENT_SECRET_KEY, REFRESH_TOKEN_KEY]) {
    if (!await keyringClear(BROKER, key)) throw new KeyringUnavailable()
  }
  out.write('✓ tastytrade removed from this computer. Your agent keeps market and research tools.'
    + (kind === 'personal'
      ? ' To end the grant itself, delete it under OAuth Applications on my.tastytrade.com.\n'
      // The app grant lived only in this keyring -- the Worker never keeps it -- so nothing can use it now.
      : ' spicytrade kept no copy, so nothing can use that connection now; tastytrade may still list it in your'
        + ' account settings, where you can remove it.\n'))
  return true
}
