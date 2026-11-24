import { spawn } from 'node:child_process'

import { cliCommand } from './config.mjs'

/**
 * What the commands share in how they talk to the member: the failure they print, the wait for an approval made in a browser, and opening that browser.
 */

/**
 * The end of a failure this CLI cannot explain -- an answer it could not read -- so the member
 * still has a next step. The site's support address is `SUPPORT_EMAIL` in `src/domain/site.ts`.
 */
export function unexpectedTail() {
  return `Try again with: ${cliCommand('connect')} -- if it happens again, write to support@spicy.trade`
}

/** A command-line failure: its message is printed after the program's name, and the run exits 1. */
export class CliFailure extends Error {
  constructor(message) {
    super(message)
    this.name = 'CliFailure'
  }
}

/**
 * How often a pending approval is asked about. The member is looking at a browser, then back at
 * the terminal: two seconds is sooner than they can switch windows, and a wait at its longest
 * stays a few hundred requests. The owner's judgment of that trade.
 */
const POLL_INTERVAL_MS = 2_000

/**
 * Ask `attempt` until it resolves with something other than undefined, but no longer than
 * `waitMs`; resolves `{ lapsed: true }` then. With `skippable`, Ctrl-C ends the wait, not the
 * program, and resolves `{ skipped: true }`: a wait the member may walk away from.
 */
export async function pollUntil(attempt, waitMs, { skippable = false } = {}) {
  const deadline = Date.now() + waitMs
  let interrupted = false
  let wake
  const onInterrupt = () => {
    interrupted = true
    wake?.()
  }
  if (skippable) process.once('SIGINT', onInterrupt)
  try {
    for (;;) {
      const answer = await attempt()
      // An answer that arrived as the member pressed Ctrl-C is still theirs: collecting spends it.
      if (answer !== undefined) return answer
      if (interrupted) return { skipped: true }
      if (Date.now() + POLL_INTERVAL_MS > deadline) return { lapsed: true }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, POLL_INTERVAL_MS)
        wake = () => {
          clearTimeout(timer)
          resolve()
        }
      })
      if (interrupted) return { skipped: true }
    }
  } finally {
    process.off('SIGINT', onInterrupt)
  }
}

/**
 * Best effort: the printed URL is the path, so failing to open a browser is not a failure. Over
 * SSH nothing is opened: a browser started here would appear on this computer's screen, not in
 * front of the member, who opens the link wherever they are.
 */
export function openBrowser(url) {
  if (process.env.SSH_CONNECTION) return
  const opener = process.platform === 'darwin' ? 'open' : 'xdg-open'
  try {
    const child = spawn(opener, [url], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The URL is already on screen.
  }
}
