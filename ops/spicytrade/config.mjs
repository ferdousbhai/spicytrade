import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What every local tool agrees on: where spicytrade is, which keyring entry holds the agent
 * token, how agents launch the MCP server, and how to name the CLI in a message. One module, so
 * the commands cannot drift apart on any of them.
 */

/*
 * The local tools were named spicy-trade before they were spicytrade, and ran a background proxy
 * before agents launched `spicytrade mcp` themselves. Each `LEGACY_` name below is what such an
 * install still has -- a keyring entry, a systemd unit, a client entry -- and is read only so
 * `setup` can move it to the current shape. Nothing new is ever written under a legacy name.
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
 * The MCP revision this CLI speaks, both probing the Worker and answering `initialize` locally
 * when the client names none; any revision the Worker accepts would do.
 */
export const MCP_PROTOCOL_VERSION = '2025-06-18'

/** The browser sign-ins' one-shot listeners bind here, never to a routable address. */
export const LISTEN_HOST = '127.0.0.1'

/** The address the retired background proxy listened on, which older client entries still name. */
export const LEGACY_PROXY_URL = 'http://127.0.0.1:8787/mcp'
/** The retired proxy's systemd user units, current name and pre-rename name. */
export const LEGACY_UNIT_NAMES = ['spicytrade-proxy.service', 'spicy-trade-proxy.service']

/** The agent token is spicytrade's credential, so it is filed under spicytrade's service. */
export const AGENT_TOKEN_SERVICE = 'spicytrade'
export const LEGACY_AGENT_TOKEN_SERVICE = 'spicy-trade'
export const MCP_TOKEN_KEY = 'mcp-token'

/** The name agents' MCP configs know the server by. */
export const MCP_SERVER_NAME = 'spicytrade'
export const LEGACY_MCP_SERVER_NAME = 'spicy-trade'

/** Codex keeps the server switched off, so a trading session turns it on for that session alone. */
export const CODEX_START = `codex -c mcp_servers.${MCP_SERVER_NAME}.enabled=true`
/**
 * How a running session picks up a changed credential: each session reads the keyring when it
 * starts `spicytrade mcp`, so Claude Code reconnects the server, and Codex is started again the one
 * way that loads it at all. Keyed by the client ids in `clients.mjs`.
 */
const RECONNECT_STEPS = {
  claude: `in Claude Code, run /mcp, pick ${MCP_SERVER_NAME} and choose Reconnect`,
  // `resume --last` reopens the same conversation, so a fix does not cost the member what they were
  // doing; `resume` takes the same `-c` that turns the server on.
  codex: `in Codex, quit and run codex resume --last -c mcp_servers.${MCP_SERVER_NAME}.enabled=true`,
}

/** The reconnect step for each of `clients`; every client's when which one is in use is unknown. */
export function reconnectHow(clients = Object.keys(RECONNECT_STEPS)) {
  return clients.map((client) => RECONNECT_STEPS[client]).join('; or ')
}

/**
 * The folder whose Claude Code sessions load the server: the one this CLI runs in, which is the
 * agent's own workspace when the agent runs it, as the connect guide has it do. Trading tools act
 * on the member's own account, so they belong to the workspace the member chose for trading, not
 * to every session in every directory; Claude Code cannot add a server switched off everywhere,
 * so it is registered here at local scope. `setup`, `doctor`, `connect` and `start` must all mean
 * this one folder: a fixed folder of our own reported the member's actual workspace as missing,
 * and its "fix" registered the server somewhere the member never starts an agent.
 */
export const WORKSPACE_DIR = process.env.SPICYTRADE_WORKSPACE ?? process.cwd()

/**
 * This CLI. In a checkout it is the sibling entry script; in the single-file build that
 * `spicy.trade/install.sh` installs, this module is bundled into that very file, which keeps the
 * same name, so the same URL resolves to it.
 */
export const CLI_PATH = fileURLToPath(new URL('./spicytrade.mjs', import.meta.url))

/**
 * What an agent client launches: this CLI by absolute path, run through its own
 * `#!/usr/bin/env node` line. Naming the CLI rather than this node keeps the entry working across
 * Node upgrades -- a version manager's per-version path disappears with the version -- and the
 * client starts it with the member's own PATH. `doctor` compares a client's entry against this to
 * notice one left pointing at another install.
 */
export const MCP_COMMAND = [CLI_PATH, 'mcp']

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
 * agent launches `mcp` from wherever it was started, so a relative path would be wrong exactly
 * where its messages are read.
 */
const CLI_NAME = onPath() ? 'spicytrade' : homeRelative(installedLink() ?? CLI_PATH)

export function cliCommand(subcommand) {
  return `${CLI_NAME} ${subcommand}`
}
