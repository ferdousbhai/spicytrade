#!/usr/bin/env node
import { connect } from './connect.mjs'
import { cliCommand, MCP_COMMAND } from './config.mjs'
import { doctor } from './doctor.mjs'
import { login } from './login.mjs'
import { CliFailure, reconnectNote } from './loopback.mjs'
import { serveMcp } from './mcp.mjs'
import { setup } from './setup.mjs'
import { start } from './start.mjs'
import { connectTastytrade, disconnectTastytrade, storePersonalGrant } from './tastytrade-connect.mjs'
import { uninstall } from './uninstall.mjs'

/**
 * `spicytrade`: the one command a member runs on their own machine, installed by
 * `curl -fsSL https://spicy.trade/install.sh | bash`. `setup` is the whole path from nothing to
 * a working agent; the others are its steps, for when only one needs redoing, and `mcp` is what
 * the agent itself runs.
 */

// `mcp` is left out: the agent runs it, and a member never needs to.
/** The site's support address (`SUPPORT_EMAIL` in `src/domain/site.ts`), which this package cannot import. */
const SUPPORT_EMAIL = 'support@spicy.trade'

const USAGE = `Usage: spicytrade <command>

  connect  Connect your account from the agent you already have open.
           Your agent handles MCP registration; approve sign-in in your browser.

Advanced:
  setup                   Manual setup and repair for installed agent clients.
  integration             Print the credential-free local MCP configuration.
  start                   Optional: open a trading agent.
  doctor                  Check everything without changing anything.
  login                   Sign this computer in again.
  connect-tastytrade      Reconnect tastytrade.
  disconnect-tastytrade   Remove tastytrade from this computer.
  store-personal-grant    Use your own tastytrade OAuth app instead.
  uninstall               Remove spicytrade and its credentials from this computer.
`

// The local MCP server can reload credentials with setup_required; older clients may reconnect.
const COMMANDS = {
  integration: async () => { process.stdout.write(`${JSON.stringify({ command: MCP_COMMAND[0], args: MCP_COMMAND.slice(1) })}\n`) },
  connect,
  start,
  'connect-tastytrade': async () => { await connectTastytrade(); process.stdout.write(reconnectNote()) },
  'disconnect-tastytrade': async () => { if (await disconnectTastytrade()) process.stdout.write(reconnectNote()) },
  doctor: async () => { if (!await doctor()) process.exitCode = 1 },
  login: async () => { await login(); process.stdout.write(reconnectNote()) },
  mcp: async () => {
    // Run by hand, it would sit waiting for an agent's messages on the terminal with no word why.
    if (process.stdin.isTTY) {
      process.stderr.write(`spicytrade mcp is started by your agent, not run by hand. To check or repair this computer, run: ${cliCommand('setup')}\n`)
      return
    }
    await serveMcp()
  },
  setup: async () => { if (!await setup()) process.exitCode = 1 },
  'store-personal-grant': async () => { await storePersonalGrant(); process.stdout.write(reconnectNote()) },
  uninstall: async () => { await uninstall() },
}

const [command, ...rest] = process.argv.slice(2)
if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
  process.stdout.write(USAGE)
} else if (!Object.hasOwn(COMMANDS, command) || rest.length) {
  process.stderr.write(`${Object.hasOwn(COMMANDS, command)
    ? `spicytrade ${command}: takes no arguments`
    : `spicytrade: unknown command "${command}"`}\n\n${USAGE}`)
  process.exitCode = 2
} else {
  try {
    await COMMANDS[command]()
  } catch (error) {
    // Anything else is a bug, not something the member did; a stack trace tells them nothing.
    // Its name says which, and SPICYTRADE_DEBUG brings the trace back for whoever fixes it.
    if (!(error instanceof CliFailure) && process.env.SPICYTRADE_DEBUG) throw error
    process.stderr.write(error instanceof CliFailure
      ? `spicytrade ${command}: ${error.message}\n`
      : `spicytrade ${command} stopped unexpectedly (${error instanceof Error ? error.name : 'UnknownError'}).`
        + ` Run: ${cliCommand('setup')} -- if it happens again, write to ${SUPPORT_EMAIL}\n`)
    process.exitCode = 1
  }
}
