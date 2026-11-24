import { createInterface } from 'node:readline/promises'

import { grantMinter, grantRefused, TastytradeAuthError } from './broker-grants.mjs'
import { CliFailure } from './cli.mjs'
import { cliCommand } from './config.mjs'
import { doctor } from './doctor.mjs'
import {
  agentToken, keyringFix, keyringHelperInstalled, keyringHelperMissing, keyringWritable,
  requireSupportedPlatform,
  tastytradeCredentialKind,
} from './keyring.mjs'
import { login } from './login.mjs'
import { installedAgents, installSkill } from './skill.mjs'
import { collectTastytrade, connectTastytrade, NotConnected } from './tastytrade-connect.mjs'
import { checkAgentToken, describeTokenCheck } from './worker.mjs'

/**
 * `spicytrade setup`: everything between a fresh machine and an agent that can use spicytrade,
 * in one run. Each step looks before it acts and skips what is already done, so
 * running it again is also how a broken setup is repaired; `doctor` closes the run by checking
 * the result end to end.
 *
 * A computer with nothing saved signs in and connects tastytrade on one link: the member makes
 * that call on the page they approve, which says where it continues, and again on tastytrade's
 * own consent. A computer already signed in is asked before a brokerage is added to it or a saved
 * connection replaced, and a run without a terminal to ask on leaves that undone and says how to
 * do it later.
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
 * Connects tastytrade -- collecting the grant `session`'s approval already started, or on a link
 * of its own -- reporting a failure without ending setup; true when it connected.
 */
async function tryConnect(out, session) {
  try {
    await (session ? collectTastytrade(out, session) : connectTastytrade(out))
    return true
  } catch (error) {
    if (!(error instanceof CliFailure)) throw error
    out.write(error instanceof NotConnected ? `· ${error.reason}\n` : `✗ ${error.message}\n`)
    return false
  }
}

/** Runs every step, writing progress to `out`; resolves true when the closing doctor passes. */
export async function setup(out = process.stdout) {
  requireSupportedPlatform()
  if (!await keyringHelperInstalled()) {
    const { install, name } = keyringHelperMissing()
    throw new CliFailure(`${name} is not installed. ${install}, then run: ${cliCommand('setup')}`)
  }
  if (!await keyringWritable(out)) {
    throw new CliFailure(`your system keyring cannot save credentials here. ${keyringFix()}. Over SSH, this computer's`
      + ` desktop session must also be logged in. Then run: ${cliCommand('setup')}`)
  }

  // Said before the browser sign-in rather than after it: without an agent, nothing uses it.
  const agentInstalled = (await installedAgents()).length > 0
  if (!agentInstalled) {
    // Only a heads-up: the run's closing line says what to do about it.
    out.write('· No Claude Code or Codex found; signing in anyway.\n')
  }

  step(out, 'Sign in')
  /** The approval that signed this computer in, when it also started a tastytrade consent. */
  let session
  const token = await agentToken()
  const check = token ? await checkAgentToken(token) : undefined
  if (check?.status === 'accepted') {
    out.write('✓ already signed in; skipped\n')
  } else if (check?.status === 'unanswered' || check?.status === 'unreachable') {
    throw new CliFailure(check.status === 'unreachable'
      ? `${describeTokenCheck(check)}. Check your internet connection, then run: ${cliCommand('setup')}`
      : `${describeTokenCheck(check)}. Try again in a minute: ${cliCommand('setup')}`)
  } else {
    if (check?.status === 'rejected') out.write('This computer was signed out of spicytrade (revoked under Signed-in computers); signing in again.\n')
    // Nothing saved here: the one link signs in and goes on to tastytrade, collected below.
    const fresh = (await tastytradeCredentialKind()).kind === 'none'
    const signedIn = await login(out, { tastytrade: fresh })
    if (fresh) session = signedIn
  }

  // The skill is how an agent started in this folder learns spicytrade is here.
  await installSkill(underHeading(out, 'Agents'))

  step(out, 'tastytrade')
  const credential = await tastytradeCredentialKind()
  const { kind } = credential
  if (session) {
    await tryConnect(out, session)
  } else if (kind === 'app' || kind === 'personal') {
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
      await tryConnect(out)
    } else if (refused) {
      out.write('· not reconnected\n')
    }
  } else if (kind === 'ambiguous' || kind === 'incomplete') {
    // Neither can trade, and a fresh connection replaces either, so that is the one repair.
    const found = kind === 'ambiguous' ? 'Two tastytrade connections are saved' : 'An incomplete tastytrade connection is saved'
    if (!process.stdin.isTTY) {
      out.write(`· ${found}; see the check below\n`)
    } else if (await confirm(`${found}. Replace ${kind === 'ambiguous' ? 'them' : 'it'} with a new connection now? [Y/n] `)) {
      await tryConnect(out)
    } else {
      out.write('· left as it is\n')
    }
  } else if (!process.stdin.isTTY) {
    // The closing block says how to connect.
    out.write('· not connected: there is no terminal to ask on\n')
  } else if (await confirm('Connect tastytrade, so your agent can see your positions and place orders? [Y/n] ')) {
    await tryConnect(out)
  } else {
    // The check below says what that leaves the agent and how to connect later.
    out.write('· skipped\n')
  }

  const checkStep = underHeading(out, 'Check')
  const healthy = await doctor(checkStep, { quiet: true })
  // Whatever else is wrong, the missing agent is the step that matters most here, so it is always said.
  if (!agentInstalled) out.write(`\n${healthy ? 'Signed in. ' : ''}Install Claude Code or Codex, then run: ${cliCommand('setup')}\n`)
  // Said for any installed agent: one whose own skill of that name was left alone can still run the command.
  if (agentInstalled) {
    const starts = `  Ask your agent about a quote or your positions; it runs \`${cliCommand('tools')}\` to see what it can do.\n`
    const { kind } = await tastytradeCredentialKind()
    // An agent can start whatever else failed, so how to go on is always said;
    // "Ready" is kept for a run with nothing left to fix.
    out.write(!healthy
      ? `\nContinue in your agent:\n${starts}`
      : kind === 'app' || kind === 'personal'
        ? `\nAccount connected. Continue in your agent:\n${starts}`
        : `\nReady for market data and research. Continue in your agent:\n${starts}`
          + `To see positions and place orders, connect tastytrade: ${cliCommand('connect')}\n`)
  }
  return healthy
}
