#!/usr/bin/env node
import { cliCommand } from './config.mjs'
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

  start    Open your trading agent.
  setup    Sign in, connect tastytrade, and add spicytrade to your agents.
           Run it again any time to repair. To update, run the install again:
           curl -fsSL https://spicy.trade/install.sh | bash

Advanced:
  doctor                  Check everything without changing anything.
  login                   Sign this computer in again.
  connect-tastytrade      Reconnect tastytrade.
  disconnect-tastytrade   Remove tastytrade from this computer.
  store-personal-grant    Use your own tastytrade OAuth app instead.
  uninstall               Remove spicytrade and its credentials from this computer.
`

// A credential changed on its own reaches a session already running only once it reconnects;
// `setup` says so itself, at its end, once.
const COMMANDS = {
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
