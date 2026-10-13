import { createInterface } from 'node:readline/promises'

import { grantMinter, grantRefused, TastytradeAuthError } from './broker-grants.mjs'
import { CLIENTS, EXPECTED_TARGET, namesSpicytrade } from './clients.mjs'
import {
  AGENT_TOKEN_SERVICE, cliCommand, LEGACY_AGENT_TOKEN_SERVICE, LEGACY_MCP_SERVER_NAME, MCP_SERVER_NAME, MCP_TOKEN_KEY, ORIGIN,
} from './config.mjs'
import { doctor } from './doctor.mjs'
import {
  agentToken, commandInstalled, KEYRING_FIX, keyringClear, keyringSecret, KeyringUnavailable, keyringWritable, secretToolInstalled, storeAgentToken,
  tastytradeCredentialKind,
} from './keyring.mjs'
import { removeLegacyUnits } from './legacy-proxy.mjs'
import { login } from './login.mjs'
import { CliFailure, reconnectNote } from './loopback.mjs'
import { connectTastytrade, NotConnected } from './tastytrade-connect.mjs'
import { checkAgentToken, describeTokenCheck } from './worker.mjs'

/**
 * `spicytrade setup`: everything between a fresh machine and an agent that can reach
 * spicytrade, in one run. Each step looks before it acts and skips what is already done, so
 * running it again is also how a broken setup is repaired; `doctor` closes the run by checking
 * the result end to end.
 *
 * Only the tastytrade connection is asked about rather than done: it hands trading authority to
 * any agent on this machine, which is the member's call to make, and a run without a terminal to
 * ask on leaves it undone and says how to do it later.
 */

function step(out, title) {
  out.write(`\n== ${title}\n`)
}

/**
 * A step's output, its heading written only with its first line: a step with nothing to say --
 * no agent to add, a check with nothing wrong -- leaves no bare heading behind.
 */
function underHeading(out, title) {
  let shown = false
  return {
    write: (text) => {
      if (!shown) step(out, title)
      shown = true
      out.write(text)
    },
  }
}

/** A yes/no question: Enter, y or yes is yes; anything else, Ctrl-C or Ctrl-D is no. */
async function confirm(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    // Only Enter, y or yes is yes: every question here is about connecting a brokerage, so an answer
    // that is not clearly yes -- "nope", a typo -- must never be taken as one.
    return /^(y(es)?)?$/i.test((await prompt.question(question)).trim())
  } catch (error) {
    // Ctrl-C or Ctrl-D at the question is "not now", as it is during the wait that follows a yes:
    // every question asked here is about tastytrade, which setup finishes without.
    if (error instanceof Error && error.name === 'AbortError') {
      process.stdout.write('\n')
      return false
    }
    throw error
  } finally {
    prompt.close()
  }
}

/**
 * Removes an entry setup no longer wants -- the pre-rename name, or one that loads the server in
 * every folder -- once the current entry is in place, and only when it is spicytrade's: an entry
 * of that name pointing anywhere else is someone's own.
 */
function removeStale(out, label, entry, scope, inPlace) {
  const found = scope.configured(entry)
  if (found.state !== 'configured') return
  if (!namesSpicytrade(found.target)) {
    out.write(`! ${label} has a different server named "${entry}"; left as it is\n`)
  } else if (!inPlace) {
    out.write(`· ${label} keeps its old ${entry} entry until ${MCP_SERVER_NAME} is in place\n`)
  } else if (scope.remove(entry).ok) {
    out.write(`✓ ${label}: removed an old ${entry} entry\n`)
  } else {
    out.write(`✗ ${label} did not remove an old ${entry} entry; remove it yourself with:\n    ${scope.removeCommand(entry)}\n`)
  }
}

/** Registers `spicytrade mcp` with one client; true when its entry is in place afterwards. */
function register(out, client, configured) {
  // Each way this can fail is reported once, by the check below, with its fix.
  if (configured.state === 'failed') {
    out.write(`· ${client.name} did not answer; see the check below\n`)
    return false
  }
  if (configured.state === 'configured' && configured.target === EXPECTED_TARGET) {
    out.write(`✓ ${client.name} already starts spicytrade; skipped\n`)
    return true
  }
  if (configured.state === 'configured' && !namesSpicytrade(configured.target)) {
    // Someone chose that entry; replacing it is theirs to decide.
    out.write(`· ${client.name} already has a different server named "${MCP_SERVER_NAME}"; left as it is, see the check below\n`)
    return false
  }
  // Spicytrade's own entry from an older install -- the retired proxy, another copy of this CLI,
  // a node that has moved -- is replaced.
  if (configured.state === 'configured' && !client.remove(MCP_SERVER_NAME).ok) {
    out.write(`· ${client.name}: the old ${MCP_SERVER_NAME} entry was not replaced; see the check below\n`)
    return false
  }
  const added = client.add()
  if (!added.ok) {
    out.write(`· ${client.name}: not added; see the check below\n`)
    return false
  }
  // How to start each agent is said once, in the closing Ready block.
  out.write(added.off === false
    ? `! ${client.name}: added ${MCP_SERVER_NAME}, but ${client.offFailedNote}\n`
    : `✓ ${client.name}: added ${MCP_SERVER_NAME}${client.offNote ?? ''}\n`)
  return true
}

/** Connects tastytrade, reporting a failure without ending setup; true when it connected. */
async function tryConnect(out) {
  try {
    await connectTastytrade(out)
    return true
  } catch (error) {
    if (!(error instanceof CliFailure)) throw error
    out.write(error instanceof NotConnected ? `· ${error.reason}\n` : `✗ ${error.message}\n`)
    return false
  }
}

/** Runs every step, writing progress to `out`; resolves true when the closing doctor passes. */
export async function setup(out = process.stdout) {
  // Whether this run replaced a credential a running agent session may still hold.
  let credentialsChanged = false
  if (process.platform !== 'linux') {
    throw new CliFailure(`the install runs on Linux for now; this is ${process.platform}. Your agent can still use market data and research`
      + ` without installing: see "Without installing" at ${ORIGIN}/connect`)
  }
  if (!await secretToolInstalled()) {
    throw new CliFailure(`secret-tool is not installed. Install it (Debian/Ubuntu: sudo apt install libsecret-tools; Arch: sudo pacman -S libsecret; Fedora: sudo dnf install libsecret), then run: ${cliCommand('setup')}`)
  }
  if (!await keyringWritable(out)) {
    throw new CliFailure(`your system keyring cannot save credentials here. ${KEYRING_FIX}. Over SSH, this computer's`
      + ` desktop session must also be logged in. Then run: ${cliCommand('setup')}`)
  }

  // Said before two browser sign-ins rather than after them: without an agent, nothing uses them.
  const agentInstalled = (await Promise.all(CLIENTS.map((client) => commandInstalled(client.bin)))).some(Boolean)
  if (!agentInstalled) {
    // Only a heads-up: the run's closing line says what to do about it.
    out.write('· No Claude Code or Codex found; signing in anyway.\n')
  }

  step(out, 'Sign in')
  const token = await agentToken()
  const check = token ? await checkAgentToken(token) : undefined
  if (check?.status === 'accepted') {
    if (await keyringSecret(AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY) === token) {
      await keyringClear(LEGACY_AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY)
      out.write('✓ already signed in; skipped\n')
    } else {
      // Signed in before the rename: the token is good, only its keyring entry is old.
      if (!await storeAgentToken(token)) throw new KeyringUnavailable()
      out.write('✓ already signed in; moved the token to its current keyring entry\n')
    }
  } else if (check?.status === 'unanswered' || check?.status === 'unreachable') {
    throw new CliFailure(check.status === 'unreachable'
      ? `${describeTokenCheck(check)}. Check your internet connection, then run: ${cliCommand('setup')}`
      : `${describeTokenCheck(check)}. Try again in a minute: ${cliCommand('setup')}`)
  } else {
    if (check?.status === 'rejected') out.write('This computer was signed out of spicytrade (revoked under Signed-in computers); signing in again.\n')
    await login(out)
    credentialsChanged = true
  }

  // With an agent to add, the heading comes first: looking a client up can take a few seconds,
  // which would otherwise pass with nothing on screen.
  const agents = underHeading(out, 'Agents')
  if (agentInstalled) agents.write('')
  for (const name of await removeLegacyUnits()) agents.write(`✓ removed the old background proxy (${name})\n`)
  const ready = []
  let alreadyInPlace = false
  /** Clients that did not answer here; the check below reports them without asking again. */
  const unanswered = new Set()
  for (const client of CLIENTS) {
    const configured = client.configured()
    if (configured.state === 'uninstalled') continue
    if (configured.state === 'failed') unanswered.add(client.name)
    const inPlace = register(agents, client, configured)
    // A client that did not answer would only make each lookup below wait out its timeout again.
    if (configured.state === 'failed') continue
    if (inPlace) ready.push(client)
    if (configured.state === 'configured' && configured.target === EXPECTED_TARGET) alreadyInPlace = true
    removeStale(agents, client.name, LEGACY_MCP_SERVER_NAME, client, inPlace)
    if (client.everywhere) {
      for (const entry of [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME]) {
        removeStale(agents, `${client.name} (every folder)`, entry, client.everywhere, inPlace)
      }
    }
  }

  step(out, 'tastytrade')
  const credential = await tastytradeCredentialKind()
  const { kind } = credential
  if (kind === 'app' || kind === 'personal') {
    // Present is not the same as working: a connection tastytrade has since revoked or expired is
    // found here, so running setup again is also how it is repaired.
    let refused = false
    try {
      await grantMinter(await agentToken(), credential)()
      out.write('✓ already connected; skipped\n')
    } catch (error) {
      if (!(error instanceof TastytradeAuthError)) throw error
      refused = grantRefused(error)
      if (!refused) out.write('! tastytrade could not be checked just now; the check below says more\n')
    }
    if (refused && kind === 'personal') {
      // The check below reports it once, with its fix.
      out.write('· tastytrade refused your personal grant; see the check below\n')
    } else if (refused && !process.stdin.isTTY) {
      out.write('· tastytrade refused the saved connection; see the check below\n')
    } else if (refused && await confirm('tastytrade refused the saved connection. Reconnect now? [Y/n] ')) {
      credentialsChanged = await tryConnect(out) || credentialsChanged
    } else if (refused) {
      out.write('· not reconnected\n')
    }
  } else if (kind === 'ambiguous' || kind === 'incomplete') {
    // Neither can trade, and a fresh connection replaces either, so that is the one repair.
    const found = kind === 'ambiguous' ? 'Two tastytrade connections are saved' : 'An incomplete tastytrade connection is saved'
    if (!process.stdin.isTTY) {
      out.write(`· ${found}; see the check below\n`)
    } else if (await confirm(`${found}. Replace ${kind === 'ambiguous' ? 'them' : 'it'} with a new connection now? [Y/n] `)) {
      credentialsChanged = await tryConnect(out) || credentialsChanged
    } else {
      out.write('· left as it is\n')
    }
  } else if (!process.stdin.isTTY) {
    // The closing block says how to connect; run from an agent's shell, "in a terminal" is the point.
    out.write('· not connected: there is no terminal to ask on\n')
  } else if (await confirm('Connect tastytrade, so your agent can see your positions and place orders? [Y/n] ')) {
    credentialsChanged = await tryConnect(out) || credentialsChanged
  } else {
    // The check below says what that leaves the agent and how to connect later.
    out.write('· skipped\n')
  }

  const checkStep = underHeading(out, 'Check')
  if (agentInstalled) checkStep.write('Checking that your agent can reach spicytrade…\n')
  const healthy = await doctor(checkStep, { quiet: true, settled: new Set(ready.map((client) => client.name)), skip: unanswered })
  // Whatever else is wrong, the missing agent is the step that matters most here, so it is always said.
  if (!agentInstalled) out.write(`\n${healthy ? 'Signed in. ' : ''}Install Claude Code or Codex, then run: ${cliCommand('setup')}\n`)
  if (ready.length) {
    const starts = ready.map((client) => `  ${client.start}   (${client.name})\n`).join('')
    const { kind } = await tastytradeCredentialKind()
    // An agent that was added can start whatever else failed, so how to start it is always said;
    // "Ready" is kept for a run with nothing left to fix.
    out.write(!healthy
      ? `\nStart your agent with:\n${starts}`
      : kind === 'app' || kind === 'personal'
        ? `\nReady. Start trading with:\n${starts}`
        : `\nReady for market data and research. Start your agent with:\n${starts}`
          + `To see positions and place orders, run this in a terminal and connect tastytrade: ${cliCommand('setup')}\n`)
    // Only an agent that already had the server can be running on the credentials this run replaced.
    if (credentialsChanged && alreadyInPlace) out.write(reconnectNote(ready.map((client) => client.id)))
  }
  return healthy
}
