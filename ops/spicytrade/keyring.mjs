import { execFile, spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { access, constants } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { promisify } from 'node:util'

import { AGENT_TOKEN_SERVICE, cliCommand, LEGACY_AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY, ORIGIN } from './config.mjs'
import { CliFailure } from './loopback.mjs'
import { keyringEnvironment } from './keyring-environment.mjs'

/**
 * Keyring access for the local tools, shared so every one of them (`mcp`, setup, doctor, login
 * and the tastytrade connect step) reads the same entries the same way.
 *
 * Everything goes through the platform's own password-storage command (`HELPERS` below), and no
 * secret is ever an argv value: a lookup prints the value to our stdout, a store reads it from our
 * stdin.
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

/**
 * Wraps a constant for a line of `security -i`, which splits its input on spaces and honours
 * double quotes. Only this file's own service names, keys and labels pass through, so a quote or
 * backslash in one is a programming error, refused rather than escaped.
 */
function securityWord(word) {
  if (/["\\\n]/.test(word)) throw new Error('a keychain attribute may not contain a quote, backslash or newline')
  return `"${word}"`
}

/**
 * The password-storage command on each platform this CLI runs on, and how it is spoken to:
 *   linux   `secret-tool`, the libsecret client of the desktop keyring.
 *   darwin  `security`, which ships with macOS, on the login keychain. An entry is a generic
 *           password whose service is ours and whose account is the key. `security` has no way to
 *           read a new password from stdin, so a store is one command on the stdin of its
 *           interactive mode (`-i`): plain when the value is made only of characters that mode
 *           takes literally, as tokens are, and otherwise as hex (`-X`). That mode's exit status is
 *           not relied on -- the read-back in `keyringStore` is what decides -- and a value too long
 *           for one of its input lines fails that read-back rather than being stored cut short.
 * `absent` is how each says "no such entry", which is a different fact from a failure.
 */
const HELPERS = {
  linux: {
    bin: 'secret-tool',
    install: 'Install it (Debian/Ubuntu: sudo apt install libsecret-tools; Arch: sudo pacman -S libsecret; Fedora: sudo dnf install libsecret)',
    fix: 'If you have one, unlock it. If not, install one (Debian/Ubuntu: sudo apt install'
      + ' gnome-keyring; Arch: sudo pacman -S gnome-keyring; Fedora: sudo dnf install gnome-keyring) and log out and back in',
    lookup: (service, key) => ['lookup', 'service', service, 'key', key],
    clear: (service, key) => ['clear', 'service', service, 'key', key],
    // Exit 1 with nothing on stderr; a failure also exits 1 but says why.
    absent: ({ status, stderr }) => status === 1 && !stderr.trim(),
    store: (service, key, label, value) => ({ args: ['store', `--label=${label}`, 'service', service, 'key', key], stdin: value }),
    stored: (status) => status === 0,
    prompt: (service, key, label) => ['store', `--label=${label}`, 'service', service, 'key', key],
    promptNote: 'at the Password prompt (it is not shown as you type)',
  },
  darwin: {
    bin: 'security',
    install: 'It ships with macOS at /usr/bin/security; put /usr/bin back on your PATH',
    fix: 'Unlock your login keychain in Keychain Access. Over SSH, run: security unlock-keychain',
    lookup: (service, key) => ['find-generic-password', '-s', service, '-a', key, '-w'],
    clear: (service, key) => ['delete-generic-password', '-s', service, '-a', key],
    // errSecItemNotFound, which `security` reports as exit 44 with a line on stderr.
    absent: ({ status }) => status === 44,
    store: (service, key, label, value) => ({
      args: ['-i'],
      stdin: `add-generic-password -U -s ${securityWord(service)} -a ${securityWord(key)} -l ${securityWord(label)} `
        + `${/^[\w.~+/=-]+$/.test(value) ? `-w ${value}` : `-X ${Buffer.from(value).toString('hex')}`}\n`,
    }),
    stored: () => true,
    // `-w` last makes `security` ask for the value on the terminal itself, twice.
    prompt: (service, key, label) => ['add-generic-password', '-U', '-s', service, '-a', key, '-l', label, '-w'],
    promptNote: 'when asked, and again to confirm (it is not shown as you type)',
  },
}

/** Where the installer and the connector run, as a sentence says it. */
const SUPPORTED_PLATFORMS = 'Linux and macOS'
/** Windows by its own name: it is the platform most people refused here are on. */
const platformName = () => (process.platform === 'win32' ? 'Windows' : process.platform)

/** This platform's helper; a platform without one is refused here, before anything is attempted. */
function helper() {
  const found = HELPERS[process.platform]
  if (!found) {
    throw new CliFailure(`account access needs the local connector, which runs on ${SUPPORTED_PLATFORMS}, not on ${platformName()}.`
      + ` Your agent can still use market data and research without installing: see "Without installing" at ${ORIGIN}/connect`)
  }
  return found
}

/** Throws on a platform the connector does not run on; the first line of every command that stores. */
export function requireSupportedPlatform() {
  helper()
}

export const keyringHelperInstalled = () => commandInstalled(helper().bin)

/** What to say when the helper is missing: its name, and how to get it. */
export const keyringHelperMissing = () => ({ name: helper().bin, install: helper().install })

/** The command a member runs by hand to remove one entry, for when this CLI could not. */
export const keyringClearCommand = (service, key) => [helper().bin, ...helper().clear(service, key)].join(' ')

/** The terminal prompt that takes one value straight into password storage; see `storePersonalGrant`. */
export const keyringPrompt = (service, key, label) => ({ args: helper().prompt(service, key, label), bin: helper().bin, note: helper().promptNote })

/**
 * The stored value, or undefined when there is none.
 *
 * "Not stored" and "could not read the keyring" are different facts. Each helper has its own way
 * of saying an entry is absent (`absent` in `HELPERS`); anything else -- a missing binary, a locked
 * or unreachable keyring, which it reports on stderr -- is a failure, thrown as `KeyringUnavailable`
 * rather than carried on as though a credential that is in fact stored were absent.
 */
export async function keyringSecret(service, key) {
  const { absent, bin, lookup } = helper()
  try {
    const { stdout } = await execFileAsync(bin, lookup(service, key), {
      timeout: KEYRING_UNLOCK_WAIT_MS, env: await keyringEnvironment(),
    })
    const value = stdout.trim()
    return value || undefined
  } catch (error) {
    if (absent({ status: error?.code, stderr: String(error?.stderr ?? '') })) return undefined
    // The helper's stderr is not echoed: its words are not ours. The caller reports the failure.
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
  // Setup may run in several agent sessions at once. Each check owns its disposable entry.
  const key = `write-check-${randomUUID()}`
  let cleared = false
  // A locked keyring answers with an unlock prompt on the desktop -- on the remote screen, over
  // SSH -- so a check that has not answered soon says why the terminal is waiting, and one that
  // has not answered within the budget is reported as a keyring that cannot save.
  const hint = setTimeout(() => out.write('Checking the system keyring. If a password prompt appears, unlock it.\n'), KEYRING_HINT_MS)
  try {
    if (!await keyringStore(AGENT_TOKEN_SERVICE, key, 'spicytrade keyring check', '1', { timeoutMs: KEYRING_UNLOCK_WAIT_MS })) {
      return false
    }
  } catch (error) {
    if (error instanceof KeyringUnavailable && error.reason !== 'unknown') throw error
    if (error instanceof KeyringUnavailable) return false
    throw error
  } finally {
    clearTimeout(hint)
    // A failed read-back may still have stored the probe. Clean it up on every exit path.
    cleared = await keyringClear(AGENT_TOKEN_SERVICE, key)
  }
  return cleared
}

/** What to do about a keyring that cannot be opened, shared with what the agent is told. */
export const keyringFix = () => helper().fix

/** Inspect only known diagnostics; never expose the helper's output to an agent or log. */
function keyringFailure(error) {
  if (error?.code === 'ENOENT') return 'missing-tool'
  if (error?.killed) return 'timeout'
  // macOS, with the login keychain locked and no desktop to ask on (errSecInteractionNotAllowed).
  if (/User interaction is not allowed/i.test(String(error?.stderr ?? ''))) return 'locked'
  if (/Cannot autolaunch D-Bus|Unable to autolaunch a dbus-daemon|DBUS_SESSION_BUS_ADDRESS|XDG_RUNTIME_DIR/i.test(String(error?.stderr ?? ''))) return 'session-unavailable'
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
          ? `The password-storage helper ${helper().bin} is missing. ${helper().install}`
          : reason === 'session-unavailable'
            ? 'Your desktop session bus could not be reached. Run from a signed-in desktop session; unlocking the keyring alone does not restore this connection'
            : `Your system keyring could not be opened. ${helper().fix}`
    super(`${recovery}. Run: ${cliCommand('setup')}`)
    this.name = 'KeyringUnavailable'
    this.reason = reason
    this.recovery = recovery
  }
}

/**
 * Store a value, passing it on the helper's stdin, then read the entry back. Resolves true only
 * when the helper reports success and the read-back matches, rather than trusting the exit status alone.
 * `label` is only what a keyring UI displays; the service and key attributes are what a lookup
 * finds.
 */
export async function keyringStore(service, key, label, value, { timeoutMs } = {}) {
  const env = await keyringEnvironment()
  const { bin, store, stored: reportsStored } = helper()
  const { args, stdin } = store(service, key, label, value)
  const stored = await new Promise((resolve) => {
    // A store against a locked keyring waits on an unlock prompt; `timeoutMs` bounds that wait.
    const child = spawn(bin, args, {
      stdio: ['pipe', 'ignore', 'pipe'],
      env,
      timeout: timeoutMs ?? KEYRING_UNLOCK_WAIT_MS,
    })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => resolve({ ok: false, reason: keyringFailure(error) }))
    child.on('close', (status, signal) => resolve({ ok: !signal && reportsStored(status), reason: keyringFailure({ stderr, killed: Boolean(signal) }) }))
    // A helper that dies before reading surfaces as its exit status, not as an EPIPE here.
    child.stdin.on('error', () => {})
    child.stdin.end(stdin)
  })
  if (!stored.ok && stored.reason !== 'unknown') throw new KeyringUnavailable(stored.reason)
  return stored.ok && await keyringSecret(service, key) === value
}

/**
 * Remove an entry. Resolves true when it is gone -- including when there was none, which each
 * helper says the way its lookup says "not stored" -- and false when the keyring could not be
 * reached, which it reports on stderr.
 */
export async function keyringClear(service, key) {
  const env = await keyringEnvironment()
  const { absent, bin, clear } = helper()
  return new Promise((resolve) => {
    const child = spawn(bin, clear(service, key), { stdio: ['ignore', 'ignore', 'pipe'], timeout: KEYRING_UNLOCK_WAIT_MS, env })
    let stderr = ''
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', () => resolve(false))
    child.on('close', (status) => resolve(status === 0 || absent({ status, stderr })))
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
