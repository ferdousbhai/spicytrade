import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { z } from 'zod'

import { grantMinter, grantRefused, mintUnavailable, TastytradeAuthError, tastytradeUnavailable } from './broker-grants.mjs'
import { CLIENTS, EXPECTED_TARGET, namesSpicytrade } from './clients.mjs'
import {
  AGENT_TOKEN_SERVICE, cliCommand, LEGACY_MCP_SERVER_NAME, MCP_COMMAND, MCP_SERVER_NAME, MCP_TOKEN_KEY,
} from './config.mjs'
import {
  agentToken, keyringSecret, secretToolInstalled, tastytradeCredentialKind,
} from './keyring.mjs'
import { legacyUnits } from './legacy-proxy.mjs'
import { unexpectedTail } from './loopback.mjs'
import { NOT_READY } from './mcp.mjs'
import { TOKEN_REQUEST_TIMEOUT_MS, UPSTREAM_TIMEOUT_MS } from './token-refresh.mjs'
import { checkAgentToken, describeTokenCheck } from './worker.mjs'

/**
 * `spicytrade doctor`: every link between an agent and spicytrade, checked in the order a
 * request crosses them, each failure with the one command that fixes it.
 *
 * Output is fixed vocabulary, as everywhere in these tools: a status, a transport code, a path of
 * this install, or a message the MCP server itself wrote from its own vocabulary. No credential
 * is printed, and the server's answer is read only for its JSON-RPC error message.
 */

/**
 * The server's worst case for one call that also mints a broker token: a mint's budget, then the
 * relayed call's.
 */
const SERVER_CHECK_TIMEOUT_MS = UPSTREAM_TIMEOUT_MS + TOKEN_REQUEST_TIMEOUT_MS

/** The MCP revision this probe speaks; any revision the Worker accepts would do for a liveness check. */
const MCP_PROTOCOL_VERSION = '2025-06-18'

const ReplySchema = z.object({
  error: z.object({ message: z.string() }).optional(),
  result: z.object({ instructions: z.string().optional() }).optional(),
})

/**
 * `quiet` is for `setup`, which has just reported each step itself: only failures, and the one
 * check setup cannot see -- the agent's server reaching spicytrade -- are written.
 */
function report(out, quiet) {
  let failed = 0
  let noted = 0
  return {
    fail: (label, fix) => {
      failed += 1
      out.write(`✗ ${label}\n    ${fix}\n`)
    },
    get failed() { return failed },
    get noted() { return noted },
    note: (label, hint) => {
      noted += 1
      if (!quiet) out.write(`· ${label}\n    ${hint}\n`)
    },
    pass: (label, { always = false } = {}) => { if (!quiet || always) out.write(`✓ ${label}\n`) },
  }
}

function brokerFailure(error, kind) {
  if (!(error instanceof TastytradeAuthError)) return 'the tastytrade connection could not be checked'
  if (error.code === 'spicytrade-401') return 'this computer was signed out of spicytrade (revoked under Signed-in computers)'
  if (error.code === 'unreachable') return `${error.party} could not be reached${error.transport ? ` (${error.transport})` : ''}`
  if (tastytradeUnavailable(error)) return `tastytrade is not answering right now (HTTP ${error.code})`
  if (Number.isInteger(error.code)) return `tastytrade refused ${kind === 'app' ? 'the saved connection' : 'your personal grant'} (HTTP ${error.code})`
  if (String(error.code).startsWith('spicytrade-')) return 'spicytrade could not check the tastytrade connection just now'
  return 'tastytrade answered with something unexpected'
}

/**
 * The fix for a connection that could not mint. Only a refusal by tastytrade is fixed by a new
 * connection; tastytrade not answering is waited out; anything else -- unreachable, an unreadable
 * answer -- is tried again once the network answers. A refused sign-in fails the mint too.
 */
function brokerFix(error, kind, setup) {
  if (error instanceof TastytradeAuthError && error.code === 'spicytrade-401') return `Sign in again with: ${setup}`
  if (tastytradeUnavailable(error) || mintUnavailable(error)) return `Try again in a few minutes: ${setup}`
  if (!grantRefused(error)) return `Check the network, then run: ${setup}`
  return kind === 'app'
    ? `Reconnect with: ${setup}`
    : `Store a new grant from my.tastytrade.com with: ${cliCommand('store-personal-grant')}`
}

/**
 * Starts the MCP server exactly as an agent does -- the same command line -- and sends it
 * `initialize`, which it relays to the Worker with this machine's credentials.
 */
async function checkServer() {
  const child = spawn(MCP_COMMAND[0], MCP_COMMAND.slice(1), { stdio: ['pipe', 'pipe', 'ignore'] })
  const lines = createInterface({ input: child.stdout })
  // Each reason ends in what to do, as every other check's fix line does.
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill()
  }, SERVER_CHECK_TIMEOUT_MS)
  try {
    const started = new Promise((resolve) => {
      child.once('error', (error) => resolve({ reason: `it could not start (${error.code ?? error.name}). ${unexpectedTail()}` }))
      // The timer's kill also ends the process, which is a wait, not the server stopping by itself.
      child.once('exit', () => resolve({
        reason: timedOut
          ? `it did not answer within ${SERVER_CHECK_TIMEOUT_MS / 1_000} seconds. Check your internet connection, then run: ${cliCommand('setup')}`
          : `it stopped before answering. ${unexpectedTail()}`,
      }))
      lines.once('line', (line) => {
        try {
          const reply = ReplySchema.parse(JSON.parse(line))
          const instructions = reply.result?.instructions ?? ''
          // A session that needs setup still answers, so the agent can relay the fix; here it is a failure.
          resolve(reply.error
            ? { reason: reply.error.message }
            : instructions.startsWith(NOT_READY) ? { reason: instructions.slice(NOT_READY.length).trim() } : { ok: true })
        } catch {
          resolve({ reason: `it answered with something other than MCP. ${unexpectedTail()}` })
        }
      })
    })
    child.stdin.on('error', () => {})
    child.stdin.write(`${JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'initialize',
      params: { capabilities: {}, clientInfo: { name: 'spicytrade-doctor', version: '1' }, protocolVersion: MCP_PROTOCOL_VERSION },
    })}\n`)
    return await started
  } finally {
    clearTimeout(timer)
    lines.close()
    child.kill()
  }
}

/** Runs every check, writing one line each to `out`; resolves true when none failed. */
/**
 * `skip` names clients `setup` already found not answering, so they are reported without waiting
 * out their timeout again; `settled`, clients whose entries `setup` has just put in place and
 * reported on itself, so their lookups -- each one starting the server -- are not made twice.
 */
export async function doctor(out = process.stdout, { quiet = false, settled = new Set(), skip = new Set() } = {}) {
  const checks = report(out, quiet)
  const setup = cliCommand('setup')

  if (!await secretToolInstalled()) {
    checks.fail('secret-tool is not installed', `Install it (Debian/Ubuntu: sudo apt install libsecret-tools; Arch: sudo pacman -S libsecret; Fedora: sudo dnf install libsecret), then run: ${setup}`)
    return false
  }

  const token = await agentToken()
  // The checks that go through spicytrade run only once it accepts this computer: otherwise each
  // would fail for that same one reason, and list it as several problems.
  let signedIn = false
  if (!token) {
    checks.fail('this computer is not signed in to spicytrade', `Sign in with: ${setup}`)
  } else {
    const check = await checkAgentToken(token)
    signedIn = check.status === 'accepted'
    if (signedIn) checks.pass('signed in to spicytrade')
    else if (check.status === 'rejected') checks.fail(describeTokenCheck(check), `Sign in again with: ${setup}`)
    else {
      // spicytrade answering with an error is not the member's network; not reaching it may be.
      checks.fail(describeTokenCheck(check), check.status === 'unanswered'
        ? `Try again in a minute: ${setup}`
        : `Check your internet connection, then run: ${setup}`)
    }
    if (await keyringSecret(AGENT_TOKEN_SERVICE, MCP_TOKEN_KEY) !== token) {
      checks.fail('the sign-in is still under its old keyring entry', `Move it with: ${setup}`)
    }
  }

  const credential = await tastytradeCredentialKind()
  if (credential.kind === 'none') {
    checks.note('tastytrade is not connected: your agent gets market and research tools only',
      `To see positions and trade, run: ${setup}`)
  } else if (credential.kind === 'ambiguous' || credential.kind === 'incomplete') {
    checks.fail(credential.kind === 'ambiguous'
      ? 'two tastytrade connections are saved, so spicytrade will not guess which account trades'
      : 'an incomplete tastytrade connection is saved', `Replace ${credential.kind === 'ambiguous' ? 'them' : 'it'} with: ${setup}`)
  } else if (credential.kind === 'app' && !signedIn) {
    // Its mint goes through spicytrade, so the sign-in failure above already covers it.
  } else {
    const described = credential.kind === 'app' ? 'tastytrade' : 'tastytrade (your personal grant)'
    try {
      await grantMinter(token, credential)()
      checks.pass(`${described} is connected`)
    } catch (error) {
      // A refused agent token fails the app-grant mint too; signing in again fixes both.
      checks.fail(brokerFailure(error, credential.kind), brokerFix(error, credential.kind, setup))
    }
  }

  for (const name of await legacyUnits()) {
    checks.fail(`the old background proxy is still installed (${name})`, `Remove it with: ${setup}`)
  }


  let agentsFound = 0
  for (const client of CLIENTS) {
    if (settled.has(client.name)) {
      agentsFound += 1
      continue
    }
    const configured = skip.has(client.name) ? { state: 'failed' } : client.configured()
    if (configured.state === 'uninstalled') continue
    agentsFound += 1
    // Run from setup, which has just tried to fix these itself, the fix given is the manual one;
    // run alone, it is setup, which would fix them.
    if (configured.state === 'failed') {
      checks.fail(`${client.name} did not answer when asked for its ${MCP_SERVER_NAME} server`, `Once ${client.name} responds, run: ${setup}`)
      // Every lookup below would wait out the same timeout.
      continue
    } else if (configured.state === 'missing') {
      checks.fail(`${client.name} has no ${MCP_SERVER_NAME} server`, quiet ? `Add it yourself with: ${client.addCommand}${client.afterAdd ?? ''}` : `Add it with: ${setup}`)
    } else if (configured.target !== EXPECTED_TARGET) {
      // The configured target is not printed: a client entry may carry a credential in a URL.
      checks.fail(namesSpicytrade(configured.target)
        ? `${client.name} starts spicytrade from an older install`
        : `${client.name} has a different server named "${MCP_SERVER_NAME}"`,
      namesSpicytrade(configured.target) && !quiet ? `Update it with: ${setup}` : `Replace it: ${client.removeCommand()} && ${client.addCommand}${client.afterAdd ?? ''}`)
    } else {
      checks.pass(`${client.name} starts spicytrade`)
    }
    const legacy = client.configured(LEGACY_MCP_SERVER_NAME)
    if (legacy.state === 'configured' && namesSpicytrade(legacy.target)) {
      checks.fail(`${client.name} still has the old ${LEGACY_MCP_SERVER_NAME} entry`, `Remove it with: ${setup}`)
    }
    for (const entry of [MCP_SERVER_NAME, LEGACY_MCP_SERVER_NAME]) {
      const wide = client.everywhere?.configured(entry)
      if (wide?.state === 'configured' && namesSpicytrade(wide.target)) {
        checks.fail(`${client.name} loads ${entry} in every folder, not only the trading folder`, `Move it with: ${setup}`)
      }
    }
  }

  // A saved connection that cannot trade was reported above; the server would only answer with it again.
  // And with no agent to start it, there is no server to speak of.
  if (agentsFound && signedIn && credential.kind !== 'ambiguous' && credential.kind !== 'incomplete') {
    const server = await checkServer()
    // The server's own answer already ends in the command that fixes it.
    if (server.ok) checks.pass('your agent can reach spicytrade', { always: true })
    else checks.fail('your agent could not reach spicytrade', server.reason)
  }
  // Everything else may check out, but with no agent to use it nothing is connected yet.
  // Quiet, from setup, which said so at its start and closes on it: not a second, contradicting failure.
  if (!agentsFound && !quiet) checks.fail('no agent found (Claude Code or Codex)', `Install one, then run: ${setup}`)

  // A note -- tastytrade not connected -- is not a failure, but "everything is connected" would
  // say otherwise. Quiet, a clean run says nothing: setup's Ready block follows.
  if (checks.failed) out.write(`\n${checks.failed} problem${checks.failed === 1 ? '' : 's'} found.\n`)
  else if (!quiet) out.write(checks.noted ? '\nEverything else is working.\n' : '\nEverything is connected.\n')
  return checks.failed === 0
}
