import { createInterface } from 'node:readline/promises'

import { CLIENTS, namesSpicytrade } from './clients.mjs'
import {
  AGENT_TOKEN_SERVICE, cliCommand, LEGACY_AGENT_TOKEN_SERVICE, LEGACY_MCP_SERVER_NAME, LEGACY_UNIT_NAME, MCP_SERVER_NAME,
  MCP_TOKEN_KEY, PROXY_URL,
} from './config.mjs'
import { doctor } from './doctor.mjs'
import {
  agentToken, keyringClear, keyringSecret, secretToolInstalled, storeAgentToken, tastytradeCredentialKind,
} from './keyring.mjs'
import { login } from './login.mjs'
import { CliFailure } from './loopback.mjs'
import { installUnit, removeLegacyUnit, restartProxy, systemctl } from './systemd.mjs'
import { connectTastytrade } from './tastytrade-connect.mjs'
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

const PROGRAM = 'SpicytradeSetup'

function step(out, title) {
  out.write(`\n== ${title}\n`)
}

async function confirm(question) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await prompt.question(question)).trim())
  } finally {
    prompt.close()
  }
}

/**
 * The entry an install from before the rename added, under the old name. It is removed only once
 * the current entry is in place, so a client is never left with neither, and only when it names
 * the proxy or spicytrade: an entry of that name pointing anywhere else is someone's own.
 */
function replaceLegacyEntry(out, client, inPlace) {
  const legacy = client.configured(LEGACY_MCP_SERVER_NAME)
  if (legacy.state !== 'configured') return
  if (!namesSpicytrade(legacy.url)) {
    out.write(`! ${client.name} has a ${LEGACY_MCP_SERVER_NAME} server that is not spicytrade's; left as it is\n`)
  } else if (!inPlace) {
    out.write(`· ${client.name} keeps its old ${LEGACY_MCP_SERVER_NAME} entry until ${MCP_SERVER_NAME} is in place\n`)
  } else if (client.remove(LEGACY_MCP_SERVER_NAME).ok) {
    out.write(`✓ ${client.name}: removed the old ${LEGACY_MCP_SERVER_NAME} entry; the server is ${MCP_SERVER_NAME} now\n`)
  } else {
    out.write(`✗ ${client.name} did not remove the old ${LEGACY_MCP_SERVER_NAME} entry; remove it yourself with:\n`
      + `    ${client.removeCommand(LEGACY_MCP_SERVER_NAME)}\n`)
  }
}

/**
 * An entry that loads the server in every directory, which earlier installs wrote, under either
 * name. Like the old name, it is removed only once the trading folder's entry is in place and only
 * when it names the proxy or spicytrade.
 */
function removeEverywhereEntries(out, client, inPlace) {
  if (!client.everywhere) return
  for (const entry of [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME]) {
    const wide = client.everywhere.configured(entry)
    if (wide.state !== 'configured') continue
    if (!namesSpicytrade(wide.url)) {
      out.write(`! ${client.name} has a ${entry} server in every folder that is not spicytrade's; left as it is\n`)
    } else if (!inPlace) {
      out.write(`· ${client.name} keeps its ${entry} entry in every folder until the trading folder's is in place\n`)
    } else if (client.everywhere.remove(entry).ok) {
      out.write(`✓ ${client.name}: removed the ${entry} entry that loaded it in every folder\n`)
    } else {
      out.write(`✗ ${client.name} did not remove the ${entry} entry that loads it in every folder; remove it yourself with:\n`
        + `    ${client.everywhere.removeCommand(entry)}\n`)
    }
  }
}

/** Runs every step, writing progress to `out`; resolves true when the closing doctor passes. */
export async function setup(out = process.stdout) {
  if (process.platform !== 'linux') {
    throw new CliFailure(`setup needs Linux, with a systemd user session and secret-tool; this is ${process.platform}`)
  }
  if (!await secretToolInstalled()) {
    throw new CliFailure('secret-tool is not installed. Install libsecret (it provides secret-tool), then run this again.')
  }
  if (!systemctl('show-environment')) {
    throw new CliFailure('no systemd user session answered (systemctl --user). Run this from your own login session.')
  }

  // A proxy that was already running keeps whatever credentials it read when it started.
  let credentialsChanged = false

  step(out, 'spicytrade sign-in')
  const token = await agentToken(PROGRAM)
  const check = token ? await checkAgentToken(token) : undefined
  if (check?.status === 'accepted') {
    if (await keyringSecret(PROGRAM, AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY) === token) {
      await keyringClear(LEGACY_AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY)
      out.write('✓ already signed in; skipped\n')
    } else {
      // Signed in before the rename: the token is good, only its keyring entry is old.
      if (!await storeAgentToken(PROGRAM, token)) {
        throw new CliFailure(`failed to move the agent token to ${AGENT_TOKEN_SERVICE}/${MCP_TOKEN_KEY}`)
      }
      out.write(`✓ already signed in; moved the token from ${LEGACY_AGENT_TOKEN_SERVICE}/${MCP_TOKEN_KEY} to ${AGENT_TOKEN_SERVICE}/${MCP_TOKEN_KEY}\n`)
    }
  } else if (check?.status === 'unanswered' || check?.status === 'unreachable') {
    throw new CliFailure(`${describeTokenCheck(check)}. Run this again once spicytrade answers.`)
  } else {
    if (check?.status === 'rejected') out.write('The stored agent token was rejected; signing in again.\n')
    await login(out, { restartProxy: false })
    credentialsChanged = true
  }

  step(out, 'proxy service')
  if (await removeLegacyUnit()) out.write(`✓ removed the old ${LEGACY_UNIT_NAME}\n`)
  const installed = await installUnit()
  if (installed === 'unchanged') {
    out.write('✓ already installed and running; skipped\n')
    if (credentialsChanged) restartProxy(out)
  } else {
    out.write(installed === 'installed' ? `✓ installed and started at ${PROXY_URL}\n` : `✓ updated and restarted at ${PROXY_URL}\n`)
  }

  step(out, 'tastytrade')
  const { kind } = await tastytradeCredentialKind(PROGRAM)
  if (kind === 'app' || kind === 'personal') {
    out.write('✓ already connected; skipped\n')
  } else if (kind === 'ambiguous') {
    out.write('✗ both an app grant and a personal grant are stored; the check below says which to remove\n')
  } else if (!process.stdin.isTTY) {
    out.write(`· not connected, and there is no terminal to ask on. Connect later with:\n    ${cliCommand('connect-tastytrade')}\n`)
  } else if (await confirm('Connect tastytrade now, so agents on this machine can trade your account? [y/N] ')) {
    try {
      await connectTastytrade(out)
    } catch (error) {
      if (!(error instanceof CliFailure)) throw error
      out.write(`✗ ${error.message}\n    Try again later with: ${cliCommand('connect-tastytrade')}\n`)
    }
  } else {
    out.write(`· skipped; agents get market and research tools only. Connect later with:\n    ${cliCommand('connect-tastytrade')}\n`)
  }

  step(out, 'agent clients')
  let clientsFound = 0
  for (const client of CLIENTS) {
    const configured = client.configured()
    if (configured.state === 'uninstalled') continue
    clientsFound += 1
    let inPlace = false
    let added
    if (configured.state === 'failed') {
      out.write(`✗ ${client.name} did not answer; add it yourself with:\n    ${client.addCommand}\n`)
    } else if (configured.state === 'configured' && configured.url === PROXY_URL) {
      out.write(`✓ ${client.name} already points at the proxy; skipped\n`)
      inPlace = true
    } else if (configured.state === 'configured') {
      // Someone chose that entry; replacing it is theirs to decide.
      out.write(`! ${client.name} already has a ${MCP_SERVER_NAME} server pointing elsewhere; left as it is. To replace it:\n`
        + `    ${client.removeCommand()} && ${client.addCommand}\n`)
    } else if ((added = client.add()).ok) {
      out.write(added.off === false
        ? `! ${client.name}: added ${MCP_SERVER_NAME} at ${PROXY_URL}, but ${client.offFailedNote}\n`
        : `✓ ${client.name}: added ${MCP_SERVER_NAME} at ${PROXY_URL}; ${client.offNote}\n`)
      inPlace = true
    } else {
      out.write(`✗ ${client.name} refused to add the server; add it yourself with:\n    ${client.addCommand}\n`)
    }
    replaceLegacyEntry(out, client, inPlace)
    removeEverywhereEntries(out, client, inPlace)
  }
  if (!clientsFound) {
    out.write(`· no Claude Code or Codex found. Point any MCP client at ${PROXY_URL} (streamable HTTP, no credentials).\n`)
  }

  step(out, 'check')
  const healthy = await doctor(out)
  if (healthy) out.write('\nAn agent that was already running needs to reconnect: in Claude Code, /mcp.\n')
  return healthy
}
