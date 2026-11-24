import { spawnSync } from 'node:child_process'
import { z } from 'zod'

import { AppGrantRefusalSchema } from './broker-grants.mjs'
import { CliFailure, pollUntil, unexpectedTail } from './cli.mjs'
import { cliCommand } from './config.mjs'
import { keyringEnvironment } from './keyring-environment.mjs'
import {
  APP_REFRESH_TOKEN_KEY, CLIENT_SECRET_KEY, keyringClear, keyringPrompt, keyringSecret, keyringStore, KeyringUnavailable, REFRESH_TOKEN_KEY, TASTYTRADE,
  tastytradeCredentialKind,
} from './keyring.mjs'
import { login } from './login.mjs'
import { TOKEN_REQUEST_TIMEOUT_MS } from './token-refresh.mjs'
import { postWorker } from './worker.mjs'

/**
 * Connecting tastytrade through spicytrade's OAuth app, once, with the result kept in the OS
 * keyring: what `spicytrade connect` and `spicytrade setup` both run.
 *
 * It rides on the sign-in (`login.mjs`): the one link the member approves signs this computer in
 * and continues to tastytrade's own consent page, in whichever browser they opened it. The
 * browser returns to the Worker, and this process, polling with the agent token that sign-in
 * issued and the same verifier, has the Worker redeem the code and stores the refresh token under
 * `tastytrade/app-refresh-token`, where `spicytrade mcp` finds it. The Worker holds the app's
 * client secret and never keeps the refresh token; this machine keeps the refresh token and
 * never needs a client secret.
 *
 * The agent token and the verifier together bind the connection: only the CLI that printed the
 * link, signed in as the member who approved it, can collect the grant.
 *
 * Output is fixed vocabulary. No token, code, or verifier is printed.
 */

/**
 * How long a started connection stays pending on the Worker (`BROKER_CONSENT_TTL_MS` in
 * `src/domain/broker-consent.ts`), which this package cannot import: once that passes, the
 * Worker answers that it expired, and the pending ones no longer count against the member's limit.
 */
const PENDING_WAIT_MINUTES = 10
const BROKER = TASTYTRADE
const KEY = APP_REFRESH_TOKEN_KEY

const ExchangeResponseSchema = z.object({ refreshToken: z.string().min(1) })
/** The Worker's answer for a consent the member did not give (`BrokerConsentRefusalSchema`). */
const RefusalResponseSchema = z.object({ refusal: z.string().min(1) })

/**
 * One call to the Worker: its answer, undefined while the browser has not returned from
 * tastytrade, `{ refusal }` when the member declined there, or `{ lapsed }` once the connection
 * expired. A failure is reported by status and, for a tastytrade refusal the Worker relays,
 * tastytrade's status; never by body text, which for the exchange could carry credential material.
 */
async function callWorker(path, agentBearer, body) {
  const response = await postWorker(path, body, TOKEN_REQUEST_TIMEOUT_MS, agentBearer)
  const { payload } = response
  if (response.status === 202) return undefined
  const refusal = response.status === 403 ? RefusalResponseSchema.safeParse(payload) : undefined
  if (refusal?.success) return { refusal: refusal.data.refusal }
  // The pending connection lapsed before the browser came back from tastytrade.
  if (response.status === 404) return { lapsed: true }
  if (!response.ok) {
    const tastytradeStatus = AppGrantRefusalSchema.safeParse(payload)
    if (response.status === 401) {
      throw new CliFailure(`this computer was signed out of spicytrade (revoked under Signed-in computers). Sign in again with: ${cliCommand('connect')}`)
    }
    const again = cliCommand('connect')
    if (tastytradeStatus.success) {
      throw new CliFailure(`tastytrade did not accept the connection (HTTP ${tastytradeStatus.data.tastytradeStatus}). To try again, run: ${again}`)
    }
    // The Worker's own refusals (src/server/broker-consents.ts), each in words that say what to do.
    if (response.status === 503) throw new CliFailure(`connecting tastytrade is unavailable right now. Try again later with: ${again}`)
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
    super(`${reason}. Connect any time with: ${cliCommand('connect')}`)
    this.name = 'NotConnected'
    this.reason = reason
  }
}

/**
 * Collect the grant the approval behind `session` started, and store it. Progress goes to `out`.
 * The wait ends when the Worker has the browser's return, or says the connection expired.
 */
export async function collectTastytrade(out, { agentBearer, codeVerifier }) {
  out.write('Waiting for tastytrade. To skip for now, press Ctrl-C.\n')
  const outcome = await pollUntil(
    () => callWorker('/api/brokers/tastytrade/exchange', agentBearer, { codeVerifier }),
    PENDING_WAIT_MINUTES * 60_000,
    { skippable: true },
  )
  if (outcome.skipped) throw new NotConnected('skipped for now, so tastytrade is not connected')
  if (outcome.lapsed) throw new NotConnected('the tastytrade approval expired, so it is not connected')
  if (outcome.refusal === 'access_denied') throw new NotConnected('you declined on tastytrade, so it is not connected')
  if (outcome.refusal) throw new CliFailure(`tastytrade did not grant access (${outcome.refusal}). Try again with: ${cliCommand('connect')}`)

  const exchanged = ExchangeResponseSchema.safeParse(outcome)
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
 * Sign in and connect tastytrade on one link. Signing in again is part of it even on a computer
 * that already is: the approval is what starts the consent, under the member's own session.
 */
export async function connectTastytrade(out = process.stdout) {
  await collectTastytrade(out, await login(out, { tastytrade: true }))
}

/**
 * `spicytrade store-personal-grant`: keep a personal grant from the member's own tastytrade OAuth
 * app (my.tastytrade.com > OAuth Applications > Manage > Create Grant) instead of connecting
 * through spicytrade's. The password-storage helper prompts for each value on the terminal itself, so
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
    const prompt = keyringPrompt(BROKER, key, label)
    out.write(`Paste your ${label} ${prompt.note}:\n`)
    spawnSync(prompt.bin, prompt.args, { stdio: 'inherit', env: await keyringEnvironment() })
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
