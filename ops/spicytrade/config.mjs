import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What every local tool agrees on: where spicytrade is, which keyring entry holds the agent
 * token, which folder is the member's workspace, and how to name the CLI in a message. One module, so
 * the commands cannot drift apart on any of them.
 */

/** The Worker's MCP endpoint; every other Worker path is resolved against its origin. */
export const UPSTREAM = process.env.SPICYTRADE_MCP_URL ?? 'https://spicy.trade/mcp'
export const ORIGIN = new URL(UPSTREAM).origin
export const TASTYTRADE_API_BASE = process.env.TASTYTRADE_API_BASE ?? 'https://api.tastyworks.com'

/**
 * The Worker answers a fault on its own side while checking a computer's token with the same 401
 * as a revoked token -- deliberately, so a fault can never read as access -- and tells them apart
 * only in the challenge's description (`SERVER_FAULT_DESCRIPTION` in `src/server/mcp.ts`). A 401 carrying
 * this is spicytrade's trouble, to be waited out, not a sign-out. Change them together.
 */
const WORKER_FAULT_CHALLENGE = 'spicytrade could not verify this request.'
export function workerFault(response) {
  return response.status === 401 && (response.headers.get('www-authenticate') ?? '').includes(WORKER_FAULT_CHALLENGE)
}

/**
 * The MCP revision this CLI names when it asks the Worker for its instructions; any revision the
 * Worker accepts would do.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** The agent token is spicytrade's credential, so it is filed under spicytrade's service. */
export const AGENT_TOKEN_SERVICE = 'spicytrade'
export const MCP_TOKEN_KEY = 'mcp-token'

/**
 * The member's workspace: the folder this CLI runs in, which is the agent's own folder when the
 * agent runs it, as the connect guide has it do. Trading acts on the member's own account, so the
 * skill that tells an agent about spicytrade is written here, not into every session in every
 * directory. `setup`, `doctor`, `connect` and `uninstall` must all mean this one folder.
 */
export const WORKSPACE_DIR = process.env.SPICYTRADE_WORKSPACE ?? process.cwd()

/**
 * This CLI. In a checkout it is the sibling entry script; in the single-file build that
 * `spicy.trade/install.sh` installs, this module is bundled into that very file, which keeps the
 * same name, so the same URL resolves to it.
 */
export const CLI_PATH = fileURLToPath(new URL('./spicytrade.mjs', import.meta.url))

export function homeRelative(path) {
  const home = homedir()
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}

/** Whether `spicytrade` on PATH is this very CLI, as the installer's link makes it. */
function onPath() {
  for (const directory of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    try {
      if (realpathSync(join(directory, 'spicytrade')) === realpathSync(CLI_PATH)) return true
    } catch {
      // Not in this directory.
    }
  }
  return false
}

/** The link `install.sh` makes, when it leads to this CLI: the name the installer told the member. */
function installedLink() {
  const link = join(homedir(), '.local', 'bin', 'spicytrade')
  try {
    return realpathSync(link) === realpathSync(CLI_PATH) ? link : undefined
  } catch {
    return undefined
  }
}

/**
 * How a message tells the member to run the CLI: `spicytrade` when that name reaches this CLI,
 * otherwise the installer's link or the script, by a path that works from any directory -- an
 * agent runs it from wherever it was started, so a relative path would be wrong exactly where its
 * messages are read.
 */
const CLI_NAME = onPath() ? 'spicytrade' : homeRelative(installedLink() ?? CLI_PATH)

export function cliCommand(subcommand) {
  return `${CLI_NAME} ${subcommand}`
}
