#!/usr/bin/env node
import { call, guide, tools } from './call.mjs'
import { CliFailure } from './cli.mjs'
import { cliCommand } from './config.mjs'
import { connect } from './connect.mjs'
import { doctor } from './doctor.mjs'
import { setup } from './setup.mjs'
import { disconnectTastytrade, storePersonalGrant } from './tastytrade-connect.mjs'
import { uninstall } from './uninstall.mjs'

/**
 * `spicytrade`: the one command on a member's own machine, installed by
 * `curl -fsSL https://spicy.trade/install.sh | bash`. `connect` signs this computer in and connects
 * tastytrade, and is run again to redo either; `tools` and `call` are what an agent runs in its
 * own shell to use spicytrade, as the skill `connect` leaves in the workspace tells it.
 */

/** The site's support address (`SUPPORT_EMAIL` in `src/domain/site.ts`), which this package cannot import. */
const SUPPORT_EMAIL = 'support@spicy.trade'

const USAGE = `Usage: spicytrade <command>

  connect  Connect this computer and your tastytrade account.
           Prints one link; approve it in any browser, on any device.

For your agent:
  tools [name]            List what spicytrade can do, or one tool's arguments.
  call <tool> [json]      Call a tool and print its answer.
  guide                   What spicytrade can answer that an agent would not guess.

Advanced:
  setup                   Step-by-step setup and repair in a terminal.
  doctor                  Check everything without changing anything.
  disconnect-tastytrade   Remove tastytrade from this computer.
  store-personal-grant    Use your own tastytrade OAuth app instead.
  uninstall               Remove spicytrade and its credentials from this computer.
`

/** Each command takes the arguments after its name; only `tools` and `call` have any. */
const COMMANDS = {
  call,
  connect: () => connect(),
  'disconnect-tastytrade': async () => { await disconnectTastytrade() },
  guide,
  doctor: async () => { if (!await doctor()) process.exitCode = 1 },
  setup: async () => { if (!await setup()) process.exitCode = 1 },
  'store-personal-grant': () => storePersonalGrant(),
  tools,
  uninstall: () => uninstall(),
}
const TAKES_ARGUMENTS = new Set(['call', 'tools'])

const [command, ...rest] = process.argv.slice(2)
if (command === undefined || command === '-h' || command === '--help' || command === 'help') {
  process.stdout.write(USAGE)
} else if (!Object.hasOwn(COMMANDS, command) || (rest.length && !TAKES_ARGUMENTS.has(command))) {
  process.stderr.write(`${Object.hasOwn(COMMANDS, command)
    ? `spicytrade ${command}: takes no arguments`
    : `spicytrade: unknown command "${command}"`}\n\n${USAGE}`)
  process.exitCode = 2
} else {
  try {
    await COMMANDS[command](rest)
  } catch (error) {
    // Anything else is a bug, not something the member did; a stack trace tells them nothing.
    // Its name says which, and SPICYTRADE_DEBUG brings the trace back for whoever fixes it.
    if (!(error instanceof CliFailure) && process.env.SPICYTRADE_DEBUG) throw error
    process.stderr.write(error instanceof CliFailure
      ? `spicytrade ${command}: ${error.message}\n`
      : `spicytrade ${command} stopped unexpectedly (${error instanceof Error ? error.name : 'UnknownError'}).`
        + ` Check this computer with: ${cliCommand('doctor')} -- if it happens again, write to ${SUPPORT_EMAIL}\n`)
    process.exitCode = 1
  }
}
