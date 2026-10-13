import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'

import { CODEX_START, LEGACY_PROXY_URL, MCP_COMMAND, MCP_SERVER_NAME, ORIGIN, TRADING_DIR } from './config.mjs'

/**
 * The agent clients `setup` registers `spicytrade mcp` with, through each client's own CLI rather
 * than by editing its config file, whose format is the client's to change.
 *
 * Trading tools are something to turn on when wanted, not a default in every session, so no
 * client loads the server everywhere. Claude Code cannot add a server switched off, so it gets the
 * server only in the trading folder, at local scope; Codex has no local scope, so it gets the
 * server at user scope switched off. Every command runs from a fixed directory -- the trading
 * folder, or home -- never from wherever `setup` was run: a project's own `.mcp.json` or local
 * entry would otherwise answer for the server's name.
 *
 * An entry is compared as its target: the command line a client launches, joined by spaces, or
 * the URL an older entry names. Nothing here carries a credential; the command line is the whole
 * configuration.
 */

/**
 * Both CLIs start the server before `get` prints anything, to report its status, and the server
 * reads the keyring and calls the Worker on the way. A named budget, the owner's judgment of how
 * long a client may take to answer before `setup` reports it as not answering.
 */
const CLIENT_COMMAND_TIMEOUT_MS = 120_000

export const EXPECTED_TARGET = MCP_COMMAND.join(' ')
const shellWord = (word) => (/^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`)
const MCP_COMMAND_LINE = MCP_COMMAND.map(shellWord).join(' ')

const CodexServerSchema = z.object({
  transport: z.object({ args: z.array(z.string()).optional(), command: z.string().optional(), url: z.string().optional() }),
})

function run(command, args, cwd = homedir()) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: CLIENT_COMMAND_TIMEOUT_MS,
  })
  if (result.error?.code === 'ENOENT') return { absent: true }
  // A timeout or a signal is not an answer: neither "configured" nor "not configured".
  if (result.error || result.signal) return { failed: true }
  return { ok: result.status === 0, stdout: result.stdout ?? '' }
}

/**
 * What a client has under one entry name: `uninstalled` (no such CLI), `failed` (the CLI did not
 * answer), `missing`, or `configured` with the target it names -- empty when it cannot be read.
 */
function lookup(got, targetOf) {
  if (got.absent) return { state: 'uninstalled' }
  if (got.failed) return { state: 'failed' }
  if (!got.ok) return { state: 'missing' }
  return { state: 'configured', target: targetOf(got.stdout) }
}

/** `claude mcp get` prints a launched server as `Command:` and `Args:`, a remote one as `URL:`. */
function claudeTarget(stdout) {
  const field = (name) => stdout.match(new RegExp(`^\\s*${name}:[ \\t]*(.*?)\\s*$`, 'm'))?.[1]
  const command = field('Command')
  if (command) return [command, field('Args')].filter(Boolean).join(' ')
  return field('URL') ?? ''
}

/**
 * `claude mcp get` resolves a name across scopes and prints the `Scope:` that answered, so an entry
 * counts only at the scope asked about. A local entry is keyed by the directory the command runs
 * in, so it is read from the trading folder; a user entry is read from home. A trading folder that
 * does not exist yet holds no entry, but whether the CLI is there still has to be asked.
 */
function claudeEntry(entry, scope) {
  let got
  if (scope === 'local' && !existsSync(TRADING_DIR)) {
    const probe = run('claude', ['--version'])
    got = probe.absent || probe.failed ? probe : { ok: false }
  } else {
    got = run('claude', ['mcp', 'get', entry], scope === 'local' ? TRADING_DIR : homedir())
  }
  const found = lookup(got, claudeTarget)
  if (found.state !== 'configured') return found
  return got.stdout.match(/^\s*Scope:\s*(\w+)/m)?.[1]?.toLowerCase() === scope ? found : { state: 'missing' }
}

function addClaudeEntry() {
  try {
    mkdirSync(TRADING_DIR, { recursive: true })
  } catch {
    return { ok: false }
  }
  return run('claude', ['mcp', 'add', '--scope', 'local', MCP_SERVER_NAME, '--', ...MCP_COMMAND], TRADING_DIR)
}

/**
 * Codex has no command to add a server switched off, so the entry `codex mcp add` just wrote gets
 * `enabled = false` in its own table. Resolves false when the table is not where Codex keeps it.
 */
function disableCodexEntry(name) {
  const path = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')
  let lines
  try {
    lines = readFileSync(path, 'utf8').split('\n')
  } catch {
    return false
  }
  const header = lines.findIndex((line) => line.trim() === `[mcp_servers.${name}]`)
  if (header < 0) return false
  let end = header + 1
  while (end < lines.length && !lines[end].trim().startsWith('[')) end += 1
  const enabled = lines.slice(header + 1, end).findIndex((line) => /^\s*enabled\s*=/.test(line))
  if (enabled >= 0) lines[header + 1 + enabled] = 'enabled = false'
  else lines.splice(header + 1, 0, 'enabled = false')
  writeFileSync(path, lines.join('\n'))
  return true
}

/**
 * Whether an entry is spicytrade's, so it is ours to replace: this CLI's `mcp` command from any
 * install, the retired proxy's address, or spicytrade itself.
 */
export function namesSpicytrade(target) {
  return target.endsWith('spicytrade.mjs mcp') || target === LEGACY_PROXY_URL || target.startsWith(`${ORIGIN}/`)
}

/**
 * Each client, with its lookup and removal taking the entry name: `setup` asks about both the
 * current name and the one an install from before the rename added (see `config.mjs`), and
 * replaces the old entry once the current one is in place. Only the current name is ever added.
 *
 * `everywhere` is the entry a client loads in every directory where that is not where the server
 * belongs: Claude Code's user scope, which earlier installs wrote. `setup` removes it once the
 * trading folder's entry is in place.
 */
export const CLIENTS = [
  {
    add: addClaudeEntry,
    bin: 'claude',
    id: 'claude',
    addCommand: `mkdir -p ${TRADING_DIR} && cd ${TRADING_DIR} && claude mcp add --scope local ${MCP_SERVER_NAME} -- ${MCP_COMMAND_LINE}`,
    name: 'Claude Code',
    start: `cd ${TRADING_DIR} && claude`,
    configured: (entry = MCP_SERVER_NAME) => claudeEntry(entry, 'local'),
    remove: (entry) => run('claude', ['mcp', 'remove', entry, '--scope', 'local'], TRADING_DIR),
    removeCommand: (entry = MCP_SERVER_NAME) => `cd ${TRADING_DIR} && claude mcp remove ${entry} --scope local`,
    everywhere: {
      configured: (entry) => claudeEntry(entry, 'user'),
      remove: (entry) => run('claude', ['mcp', 'remove', entry, '--scope', 'user']),
      removeCommand: (entry) => `claude mcp remove ${entry} --scope user`,
    },
  },
  {
    bin: 'codex',
    id: 'codex',
    add: () => {
      const added = run('codex', ['mcp', 'add', MCP_SERVER_NAME, '--', ...MCP_COMMAND])
      return added.ok ? { ...added, off: disableCodexEntry(MCP_SERVER_NAME) } : added
    },
    addCommand: `codex mcp add ${MCP_SERVER_NAME} -- ${MCP_COMMAND_LINE}`,
    // By hand as by setup, the entry is switched off. Codex has no command for that, so it follows
    // the command as words, never inside it, where a pasted line would hand them to Codex.
    afterAdd: `; then set enabled = false under [mcp_servers.${MCP_SERVER_NAME}] in ~/.codex/config.toml`,
    name: 'Codex',
    start: CODEX_START,
    offNote: ' (on only when you start Codex with the command at the end)',
    offFailedNote: `could not switch it off; set enabled = false under [mcp_servers.${MCP_SERVER_NAME}] in ~/.codex/config.toml`,
    configured: (entry = MCP_SERVER_NAME) => lookup(run('codex', ['mcp', 'get', entry, '--json']), (stdout) => {
      try {
        const { transport } = CodexServerSchema.parse(JSON.parse(stdout))
        return transport.command ? [transport.command, ...(transport.args ?? [])].join(' ') : transport.url ?? ''
      } catch {
        return ''
      }
    }),
    remove: (entry) => run('codex', ['mcp', 'remove', entry]),
    removeCommand: (entry = MCP_SERVER_NAME) => `codex mcp remove ${entry}`,
  },
]
