import { execFile, spawn } from 'node:child_process'
import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

import { AGENT_TOKEN_SERVICE, cliCommand, LEGACY_AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY } from './config.mjs'
import { CliFailure } from './loopback.mjs'

/**
 * Keyring access for the local tools, shared so every one of them (`mcp`, setup, doctor, login
 * and the tastytrade connect step) reads the same entries the same way.
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

/** Whether an executable `name` is on PATH, for tools that should say so before failing on it. */
export async function commandInstalled(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      await access(join(directory, name), constants.X_OK)
      return true
    } catch {
      // Not in this directory.
    }
  }
  return false
}

export const secretToolInstalled = () => commandInstalled('secret-tool')

/**
 * The stored value, or undefined when there is none.
 *
 * "Not stored" and "could not read the keyring" are different facts. `secret-tool lookup` exits 1
 * and prints nothing when the entry is absent; anything else -- a missing binary, a locked or
 * unreachable keyring, which it reports on stderr -- is a failure, thrown as `KeyringUnavailable`
 * rather than carried on as though a credential that is in fact stored were absent.
 */
export async function keyringSecret(service, key) {
  try {
    const { stdout } = await execFileAsync('secret-tool', ['lookup', 'service', service, 'key', key], {
      timeout: KEYRING_UNLOCK_WAIT_MS, env: { ...process.env, LC_ALL: 'C' },
    })
    const value = stdout.trim()
    return value || undefined
  } catch (error) {
    if (error?.code === 1 && !String(error.stderr ?? '').trim()) return undefined
    // secret-tool's stderr is not echoed: its words are not ours. The caller reports the failure.
    throw new KeyringUnavailable(keyringFailure(error))
  }
}

/** How long the write check runs before saying why; an unlocked keyring answers well within it. */
const KEYRING_HINT_MS = 2_000
/** How long a member is given to answer an unlock prompt: a named budget, the owner's judgment. */
const KEYRING_UNLOCK_WAIT_MS = 60_000

/**
 * Whether the keyring can save a credential here, found by storing a throwaway entry and clearing
 * it. A keyring can answer lookups yet refuse writes -- a server reached only over SSH, where no
 * desktop session ever unlocked a collection -- and the first real write comes only after the
 * browser sign-in has issued a token; checking first keeps that from failing late and leaving
 * the issued token signed in with nowhere to keep it.
 */
export async function keyringWritable(out = process.stdout) {
  // A locked keyring answers with an unlock prompt on the desktop -- on the remote screen, over
  // SSH -- so a check that has not answered soon says why the terminal is waiting, and one that
  // has not answered within the budget is reported as a keyring that cannot save.
  const hint = setTimeout(() => out.write('Checking the system keyring. If a password prompt appears, unlock it.\n'), KEYRING_HINT_MS)
  try {
    if (!await keyringStore(AGENT_TOKEN_SERVICE, 'write-check', 'spicytrade keyring check', '1', { timeoutMs: KEYRING_UNLOCK_WAIT_MS })) {
      return false
    }
  } catch (error) {
    if (error instanceof KeyringUnavailable && error.reason !== 'unknown') throw error
    if (error instanceof KeyringUnavailable) return false
    throw error
  } finally {
    clearTimeout(hint)
  }
  await keyringClear(AGENT_TOKEN_SERVICE, 'write-check')
  return true
}

/** What to do about a keyring that cannot be opened, shared with what the agent is told. */
export const KEYRING_FIX = 'If you have one, unlock it. If not, install one (Debian/Ubuntu: sudo apt install'
  + ' gnome-keyring; Arch: sudo pacman -S gnome-keyring; Fedora: sudo dnf install gnome-keyring) and log out and back in'

/** Inspect only known diagnostics; never expose secret-tool output to an agent or log. */
function keyringFailure(error) {
  if (error?.code === 'ENOENT') return 'missing-tool'
  if (error?.killed) return 'timeout'
  return /locked collection|collection is locked|keyring is locked/i.test(String(error?.stderr ?? '')) ? 'locked' : 'unknown'
}

/**
 * The keyring could not be read or written: no keyring service running (a minimal desktop, a
 * headless machine), or one that is locked. One message wherever it happens, with what to do.
 */
export class KeyringUnavailable extends CliFailure {
  constructor(reason = 'unknown') {
    const recovery = reason === 'locked'
      ? 'Your password storage is locked. Unlock it in the desktop password dialog when setup asks'
      : reason === 'timeout'
        ? 'Password storage did not answer. Run setup in a desktop terminal and watch for a password dialog'
        : reason === 'missing-tool'
          ? 'The password-storage helper secret-tool is missing. Install libsecret-tools (Debian/Ubuntu), libsecret (Arch), or libsecret (Fedora)'
          : `Your system keyring could not be opened. ${KEYRING_FIX}`
    super(`${recovery}. Run: ${cliCommand('setup')}`)
    this.name = 'KeyringUnavailable'
    this.reason = reason
    this.recovery = recovery
  }
}

/**
 * Store a value, passing it on secret-tool's stdin, then read the entry back. Resolves true only
 * when secret-tool exits 0 and the read-back matches, rather than trusting the exit status alone.
 * `label` is only what a keyring UI displays; the service and key attributes are what a lookup
 * finds.
 */
export async function keyringStore(service, key, label, value, { timeoutMs } = {}) {
  const stored = await new Promise((resolve) => {
    // A store against a locked keyring waits on an unlock prompt; `timeoutMs` bounds that wait.
    const child = spawn('secret-tool', ['store', `--label=${label}`, 'service', service, 'key', key], {
      stdio: ['pipe', 'ignore', 'pipe'],
      env: { ...process.env, LC_ALL: 'C' },
      timeout: timeoutMs ?? KEYRING_UNLOCK_WAIT_MS,
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ ok: false, reason: keyringFailure(error) }))
    child.on('close', (status, signal) => resolve({ ok: status === 0, reason: keyringFailure({ stderr, killed: Boolean(signal) }) }))
    // A secret-tool that dies before reading surfaces as its exit status, not as an EPIPE here.
    child.stdin.on('error', () => {})
    child.stdin.end(value)
  })
  if (!stored.ok && stored.reason !== 'unknown') throw new KeyringUnavailable(stored.reason)
  return stored.ok && await keyringSecret(service, key) === value
}

/**
 * Remove an entry. Resolves true when it is gone -- including when there was none: secret-tool
 * exits 1 with nothing on stderr when no entry matches, as a lookup does for "not stored" -- and
 * false when the keyring could not be reached, which it reports on stderr.
 */
export function keyringClear(service, key) {
  return new Promise((resolve) => {
    const child = spawn('secret-tool', ['clear', 'service', service, 'key', key], { stdio: ['ignore', 'ignore', 'pipe'], timeout: KEYRING_UNLOCK_WAIT_MS })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', () => resolve(false))
    child.on('close', (status) => resolve(status === 0 || (status === 1 && !stderr.trim())))
  })
}

/**
 * The agent token: from its current entry, else from the one an install from before the rename
 * filed it under (see `config.mjs`), so that install keeps working until `login` moves it.
 */
export async function agentToken() {
  return await keyringSecret(AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY)
    ?? await keyringSecret(LEGACY_AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY)
}

/**
 * Store the agent token under its current entry and read it back, then drop the legacy entry so
 * a later read cannot fall back to a token this one replaced. False when the store did not take;
 * the legacy entry is then left, since it may be the only token this machine has.
 */
export async function storeAgentToken(token) {
  if (!await keyringStore(AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY, 'spicytrade agent token', token)) return false
  await keyringClear(LEGACY_AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY)
  return true
}

/**
 * A tastytrade credential comes in one of two kinds, told apart by which keyring entries are
 * present:
 *   personal grant  `client-secret` + `refresh-token`, from the member's own OAuth app; minted
 *                   directly against tastytrade.
 *   app grant       `app-refresh-token`, from `spicytrade connect-tastytrade` under spicytrade's OAuth app,
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
 * `'none'`; `'personal'` (a client secret and a refresh token); `'app'` (an app-grant refresh
 * token, nothing else); `'ambiguous'` (an app grant alongside any personal-grant key -- which
 * account trades would otherwise turn on an ordering nobody chose); or `'incomplete'` (half a
 * personal grant, which cannot mint). The last two are repaired the same way: clear and connect
 * again. The raw values come back alongside `kind` so a caller that needs them to mint -- the
 * MCP server, and doctor's mint check -- does not read the keyring twice; setup and the connect step
 * only inspect `kind`. Never logs a value.
 */
export async function tastytradeCredentialKind() {
  const [clientSecret, refreshToken, appRefreshToken] = await Promise.all([
    keyringSecret(TASTYTRADE, CLIENT_SECRET_KEY),
    keyringSecret(TASTYTRADE, REFRESH_TOKEN_KEY),
    keyringSecret(TASTYTRADE, APP_REFRESH_TOKEN_KEY),
  ])
  const hasPersonal = Boolean(clientSecret || refreshToken)
  const kind = appRefreshToken && hasPersonal
    ? 'ambiguous'
    : appRefreshToken
      ? 'app'
      : clientSecret && refreshToken
        ? 'personal'
        : hasPersonal
          ? 'incomplete'
          : 'none'
  return { appRefreshToken, clientSecret, kind, refreshToken }
}
