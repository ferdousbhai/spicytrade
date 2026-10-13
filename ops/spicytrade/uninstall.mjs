import { lstat, readlink, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { CLIENTS, namesSpicytrade } from './clients.mjs'
import {
  AGENT_TOKEN_SERVICE, CLI_PATH, LEGACY_AGENT_TOKEN_SERVICE, LEGACY_MCP_SERVER_NAME, MCP_SERVER_NAME, MCP_TOKEN_KEY, ORIGIN,
} from './config.mjs'
import {
  agentToken, APP_REFRESH_TOKEN_KEY, CLIENT_SECRET_KEY, keyringClear, REFRESH_TOKEN_KEY, secretToolInstalled, TASTYTRADE,
  tastytradeCredentialKind,
} from './keyring.mjs'
import { removeLegacyUnits } from './legacy-proxy.mjs'
import { UPSTREAM_TIMEOUT_MS } from './token-refresh.mjs'

/**
 * `spicytrade uninstall`: take spicytrade off this computer -- its agent entries, its credentials,
 * and, for the copy `install.sh` put here, the program itself. Revoking a computer on the web
 * leaves all of that behind, and every later agent session would then advise signing in again.
 *
 * Only spicytrade's own entries are removed: an entry of the same name that names something else
 * is someone's own. A checkout of this code is never deleted, only an installed copy.
 */

/** Where `install.sh` puts the program and its link; anything else is a checkout, left alone. */
function installedPaths() {
  const share = join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'spicytrade')
  return { link: join(homedir(), '.local', 'bin', 'spicytrade'), share }
}

/** Resolves once the program files are gone; false when this is not an installed copy. */
async function removeProgram() {
  const { link, share } = installedPaths()
  if (dirname(resolve(CLI_PATH)) !== resolve(share)) return false
  // The link goes only if it is the installer's, pointing at this copy.
  const linked = await lstat(link).then((stat) => stat.isSymbolicLink(), () => false)
  if (linked && resolve(dirname(link), await readlink(link)) === resolve(CLI_PATH)) await rm(link)
  await rm(share, { force: true, recursive: true })
  return true
}

/**
 * Sign this computer out of the member's account with its own token, so uninstalling does not
 * leave a step on the website. True when it is signed out -- including when it never was signed
 * in, or the website already revoked it (a 401) -- and false only when that cannot be known: the
 * keyring could not be read, or spicytrade did not answer. The closing line then says where to do it.
 */
async function signOut() {
  let token
  try {
    token = await agentToken()
  } catch {
    return false
  }
  if (!token) return true
  try {
    const response = await fetch(new URL('/api/agent-logins', ORIGIN), {
      headers: { Authorization: `Bearer ${token}` },
      method: 'DELETE',
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    })
    await response.body?.cancel()
    return response.ok || response.status === 401
  } catch {
    return false
  }
}

/** Runs every step, writing one line each to `out`. */
export async function uninstall(out = process.stdout) {
  // First, while the token is still in the keyring to sign out with.
  const signedOut = await signOut()

  for (const client of CLIENTS) {
    const scopes = [[client.name, client], ...(client.everywhere ? [[`${client.name} (every folder)`, client.everywhere]] : [])]
    for (const [label, scope] of scopes) {
      for (const entry of [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME]) {
        const found = scope.configured(entry)
        if (found.state !== 'configured' || !namesSpicytrade(found.target)) continue
        out.write(scope.remove(entry).ok
          ? `✓ ${label}: removed ${entry}\n`
          : `✗ ${label} did not remove ${entry}; remove it yourself with: ${scope.removeCommand(entry)}\n`)
      }
    }
  }
  for (const name of await removeLegacyUnits()) out.write(`✓ removed the old background proxy (${name})\n`)

  const entries = [
    [TASTYTRADE, APP_REFRESH_TOKEN_KEY], [TASTYTRADE, CLIENT_SECRET_KEY], [TASTYTRADE, REFRESH_TOKEN_KEY],
    [AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY], [LEGACY_AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY],
  ]
  // With no secret-tool there is nothing saved to clear. A keyring that will not clear -- locked --
  // does not stop the rest: the commands that finish it are named, since they need no spicytrade.
  if (await secretToolInstalled()) {
    // Name only what was there: a member who never connected tastytrade is not told it was removed.
    // A keyring that cannot be read says nothing either way, so both are named.
    const tastytradeSaved = await tastytradeCredentialKind().then(({ kind }) => kind !== 'none', () => true)
    const saved = tastytradeSaved ? 'spicytrade sign-in and tastytrade connection' : 'spicytrade sign-in'
    const left = []
    for (const [service, key] of entries) {
      if (!await keyringClear(service, key)) left.push(`secret-tool clear service ${service} key ${key}`)
    }
    out.write(left.length
      ? `✗ the keyring is locked, so this computer's ${saved} ${tastytradeSaved ? 'are' : 'is'} still saved in it.\n`
        + `    Unlock it, then run:\n${left.map((command) => `      ${command}\n`).join('')}`
      : `✓ removed this computer's ${saved} from the keyring\n`)
  }

  if (await removeProgram()) out.write('✓ removed the spicytrade program\n')
  out.write(signedOut
    ? '\nspicytrade is removed from this computer and signed out of your account.\n'
    : `\nspicytrade is removed from this computer. To sign it out of your account too, revoke it under`
      + ` Signed-in computers at ${ORIGIN}/connect.\n`)
}
