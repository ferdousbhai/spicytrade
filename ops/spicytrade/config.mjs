import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * What every local tool agrees on: where spicytrade is, where the proxy listens, which keyring
 * entry holds the agent token, and how to name the CLI in a message. One module, so the proxy,
 * `spicytrade`, and `tastytrade-connect.mjs` cannot drift apart on any of them.
 *
 * Importing this starts nothing, unlike `proxy.mjs`.
 */

/*
 * The local tools were named spicy-trade before they were spicytrade. Each `LEGACY_` name below
 * is what an install from then still has -- a keyring entry, a unit, a client entry -- and is
 * read only so that install keeps working until `setup` moves it to the current name. Nothing new
 * is ever written under a legacy name.
 */

/** The Worker's MCP endpoint; every other Worker path is resolved against its origin. */
export const UPSTREAM = process.env.SPICYTRADE_MCP_URL ?? 'https://spicy.trade/mcp'
export const ORIGIN = new URL(UPSTREAM).origin
export const TASTYTRADE_API_BASE = process.env.TASTYTRADE_API_BASE ?? 'https://api.tastyworks.com'

/**
 * Loopback only, and a fixed default port because every agent's MCP config names it: an
 * ephemeral port would have to be rewritten into each client on every start.
 */
export const LISTEN_HOST = '127.0.0.1'
const DEFAULT_PORT = 8787
export const PROXY_PORT = Number(process.env.SPICYTRADE_PROXY_PORT ?? DEFAULT_PORT)
export const PROXY_URL = `http://${LISTEN_HOST}:${PROXY_PORT}/mcp`

/** The agent token is spicytrade's credential, so it is filed under spicytrade's service. */
export const AGENT_TOKEN_SERVICE = 'spicytrade'
export const LEGACY_AGENT_TOKEN_SERVICE = 'spicy-trade'
export const MCP_TOKEN_KEY = 'mcp-token'

/** The name agents' MCP configs know the server by. */
export const MCP_SERVER_NAME = 'spicytrade'
export const LEGACY_MCP_SERVER_NAME = 'spicy-trade'

/**
 * The one folder where Claude Code loads the server. Trading tools act on the member's own
 * account, so they belong to sessions started for trading, not to every session in every
 * directory -- least of all a checkout of this code, where an agent edits the server it would be
 * trading through. Claude Code cannot add a server switched off everywhere, so the server is
 * registered here at local scope instead.
 */
export const TRADING_DIR = process.env.SPICYTRADE_TRADING_DIR ?? join(homedir(), 'trading')
export const UNIT_NAME = 'spicytrade-proxy.service'
export const LEGACY_UNIT_NAME = 'spicy-trade-proxy.service'

export const PROXY_PATH = fileURLToPath(new URL('./proxy.mjs', import.meta.url))
const CLI_PATH = fileURLToPath(new URL('./spicytrade.mjs', import.meta.url))
const STORE_CREDENTIALS_PATH = fileURLToPath(new URL('./store-credentials.sh', import.meta.url))

/**
 * How a message tells the member to run the CLI. An npm install puts `spicytrade` on PATH; a
 * checkout does not, so there the message names the script itself, by a path that works from
 * any directory -- the proxy's own working directory under systemd is `/`, so a
 * checkout-relative path would be wrong exactly where these messages are read.
 */
function homeRelative(path) {
  const home = homedir()
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
const CLI_NAME = CLI_PATH.includes('/node_modules/') ? 'spicytrade' : homeRelative(CLI_PATH)

export function cliCommand(subcommand) {
  return `${CLI_NAME} ${subcommand}`
}

export function storeCredentialsCommand(argument) {
  return `${homeRelative(STORE_CREDENTIALS_PATH)} ${argument}`
}
