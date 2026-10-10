import { execFile, spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

import { AGENT_TOKEN_SERVICE, LEGACY_AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY } from './config.mjs'

/**
 * Keyring access for the local tools, shared so every one of them (the proxy, setup, doctor,
 * login and the tastytrade connect step) reads the same entries the same way. It is its own module because importing `proxy.mjs` starts the proxy.
 *
 * Everything goes through the secret-tool binary, and no secret is ever an argv value: a lookup
 * prints the value to our stdout, a store reads it from our stdin.
 *
 * Credentials are filed under the service that issued them, not the app that spends them: the
 * agent token is spicytrade's, while a client secret and refresh token are tastytrade's and would be
 * Schwab's for a Schwab adapter. That keeps the keyring laid out the way the Worker's adapter
 * registry (`brokerAdaptersSeam` in `src/server/brokers/index.ts`) is, so adding a broker adds a
 * service rather than more keys under this one.
 */

const execFileAsync = promisify(execFile)

/** Whether a `secret-tool` is on PATH, for tools that should say so before failing on it. */
export async function secretToolInstalled() {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      await access(join(directory, 'secret-tool'), constants.X_OK)
      return true
    } catch {
      // Not in this directory.
    }
  }
  return false
}

/**
 * The stored value, or undefined when there is none.
 *
 * "Not stored" and "could not read the keyring" are different facts. `secret-tool lookup` exits 1
 * and prints nothing when the entry is absent; anything else -- a missing binary, a locked or
 * unreachable keyring, which it reports on stderr -- is a failure, and the calling tool exits
 * rather than carry on as though a credential that is in fact stored were absent. `program` is
 * the caller's log prefix.
 */
export async function keyringSecret(program, service, key) {
  try {
    const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', service, 'key', key])
    const value = stdout.trim()
    return value || undefined
  } catch (error) {
    if (error?.code === 1 && !String(error.stderr ?? '').trim()) return undefined
    // Fixed vocabulary only: secret-tool's stderr is not echoed.
    process.stderr.write(`${program}: the keyring could not be read (${service}/${key})\n`)
    process.exit(1)
  }
}

/**
 * Store a value, passing it on secret-tool's stdin, then read the entry back. Resolves true only
 * when secret-tool exits 0 and the read-back matches, rather than trusting the exit status alone.
 * `label` is only what a keyring UI displays; the service and key attributes are what a lookup
 * finds.
 */
export async function keyringStore(program, service, key, label, value) {
  const stored = await new Promise((resolve) => {
    const child = spawn('secret-tool', ['store', `--label=${label}`, 'service', service, 'key', key], {
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    child.on('error', () => resolve(false))
    child.on('close', (status) => resolve(status === 0))
    // A secret-tool that dies before reading surfaces as its exit status, not as an EPIPE here.
    child.stdin.on('error', () => {})
    child.stdin.end(value)
  })
  return stored && await keyringSecret(program, service, key) === value
}

/**
 * Remove an entry. Resolves true when secret-tool exits 0, which it also does when there was
 * nothing to remove.
 */
export function keyringClear(service, key) {
  return new Promise((resolve) => {
    const child = spawn('secret-tool', ['clear', 'service', service, 'key', key], { stdio: 'ignore' })
    child.on('error', () => resolve(false))
    child.on('close', (status) => resolve(status === 0))
  })
}

/**
 * The agent token: from its current entry, else from the one an install from before the rename
 * filed it under (see `config.mjs`), so that install keeps working until `login` moves it.
 */
export async function agentToken(program) {
  return await keyringSecret(program, AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY)
    ?? await keyringSecret(program, LEGACY_AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY)
}

/**
 * Store the agent token under its current entry and read it back, then drop the legacy entry so
 * a later read cannot fall back to a token this one replaced. False when the store did not take;
 * the legacy entry is then left, since it may be the only token this machine has.
 */
export async function storeAgentToken(program, token) {
  if (!await keyringStore(program, AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY, 'spicytrade agent token', token)) return false
  await keyringClear(LEGACY_AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY)
  return true
}

/**
 * A tastytrade credential comes in one of two kinds, told apart by which keyring entries are
 * present:
 *   personal grant  `client-secret` + `refresh-token`, from the member's own OAuth app; minted
 *                   directly against tastytrade.
 *   app grant       `app-refresh-token`, from `connect-tastytrade.mjs` under spicytrade's OAuth app,
 *                   whose client secret only the Worker holds; minted through the Worker.
 * Every tool that looks at the grant needs to tell these apart the same way, so the key names and
 * the read live here rather than duplicated in each.
 */
export const TASTYTRADE = 'tastytrade'
export const APP_REFRESH_TOKEN_KEY = 'app-refresh-token'
export const CLIENT_SECRET_KEY = 'client-secret'
export const REFRESH_TOKEN_KEY = 'refresh-token'

/**
 * Reads every tastytrade keyring entry in parallel and classifies what is there. `kind` is
 * `'none'`; `'personal'` (a client secret and/or refresh token present -- even half a personal
 * grant counts, since it is still ambiguous beside an app grant and still not usable alone);
 * `'app'` (an app-grant refresh token, nothing else); or `'ambiguous'` (an app grant alongside
 * any personal-grant key -- which account trades would otherwise turn on an ordering nobody
 * chose). The raw values come back alongside `kind` so a caller that needs them to mint -- the
 * proxy, and doctor's mint check -- does not read the keyring twice; setup and the connect step
 * only inspect `kind`. Never logs a value.
 */
export async function tastytradeCredentialKind(program) {
  const [clientSecret, refreshToken, appRefreshToken] = await Promise.all([
    keyringSecret(program, TASTYTRADE, CLIENT_SECRET_KEY),
    keyringSecret(program, TASTYTRADE, REFRESH_TOKEN_KEY),
    keyringSecret(program, TASTYTRADE, APP_REFRESH_TOKEN_KEY),
  ])
  const hasPersonal = Boolean(clientSecret || refreshToken)
  const kind = appRefreshToken && hasPersonal
    ? 'ambiguous'
    : appRefreshToken
      ? 'app'
      : hasPersonal
        ? 'personal'
        : 'none'
  return { appRefreshToken, clientSecret, kind, refreshToken }
}
