import { grantMinter, grantRefused, mintUnavailable, TastytradeAuthError, tastytradeUnavailable } from './broker-grants.mjs'
import { cliCommand } from './config.mjs'
import {
  agentToken, keyringHelperInstalled, keyringHelperMissing, tastytradeCredentialKind,
} from './keyring.mjs'
import { installedAgents, skillState, workspaceName } from './skill.mjs'
import { checkAgentToken, describeTokenCheck } from './worker.mjs'

/**
 * `spicytrade doctor`: every link between an agent and spicytrade, checked in the order a call
 * crosses them, each failure with the one command that fixes it.
 *
 * Output is fixed vocabulary, as everywhere in these tools: a status, a transport code, a path of
 * this install. No credential is printed.
 */

/**
 * `quiet` is for `setup`, which has just reported each step itself: only failures are written.
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
    pass: (label) => { if (!quiet) out.write(`✓ ${label}\n`) },
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
 * Runs every check, writing one line each to `out`; resolves true when none failed. */
export async function doctor(out = process.stdout, { quiet = false } = {}) {
  const checks = report(out, quiet)
  const setup = cliCommand('setup')

  if (!await keyringHelperInstalled()) {
    const { install, name } = keyringHelperMissing()
    checks.fail(`${name} is not installed`, `${install}, then run: ${setup}`)
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
  }

  const credential = await tastytradeCredentialKind()
  if (credential.kind === 'none') {
    checks.note('tastytrade is not connected: market and research tools only',
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

  // Run from setup, which has just written the skill itself, there is nothing more to say of it.
  const agents = quiet ? [] : await installedAgents()
  for (const agent of agents) {
    const state = await skillState(agent)
    if (state === 'current') {
      checks.pass(`${agent.name} has the spicytrade skill in ${workspaceName()}`)
    } else if (state === 'foreign') {
      checks.note(`${agent.name} has a different skill named "spicytrade" in ${workspaceName()}`,
        'Rename or remove it if agents started in this folder should learn about spicytrade.')
    } else {
      // The command works from any folder; the skill is only how an agent started here hears of it.
      checks.note(state === 'outdated'
        ? `${agent.name} has an older spicytrade skill in ${workspaceName()}`
        : `${agent.name} has no spicytrade skill in ${workspaceName()}, so an agent started here is not told about it`,
      `${state === 'outdated' ? 'Update' : 'Add'} it by running this in that folder: ${cliCommand('connect')}`)
    }
  }
  // Everything else may check out, but with no agent to use it nothing is connected yet.
  // Quiet, from setup, which said so at its start and closes on it: not a second, contradicting failure.
  if (!quiet && !agents.length) checks.fail('no agent found (Claude Code or Codex)', `Install one, then run: ${setup}`)

  // A note -- tastytrade not connected -- is not a failure, but "everything is connected" would
  // say otherwise. Quiet, a clean run says nothing: setup's Ready block follows.
  if (checks.failed) out.write(`\n${checks.failed} problem${checks.failed === 1 ? '' : 's'} found.\n`)
  else if (!quiet) out.write(checks.noted ? '\nEverything else is working.\n' : '\nEverything is connected.\n')
  return checks.failed === 0
}
