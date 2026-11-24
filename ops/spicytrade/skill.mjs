import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { homeRelative, WORKSPACE_DIR } from './config.mjs'
import { commandInstalled } from './keyring.mjs'

/**
 * The skill that tells an agent spicytrade is here: one `SKILL.md` in the member's workspace, for
 * each agent installed on this computer. It is the whole of what connects an agent -- the agent
 * reads it when a request is about markets or the account, then runs `spicytrade tools` and
 * `spicytrade call` in its own shell. Nothing is registered with any agent and nothing is started.
 *
 * Trading acts on the member's own account, so the skill belongs to the folder the member chose
 * to connect from, not to every session in every directory: it is written into `WORKSPACE_DIR`,
 * the folder `connect` or `setup` runs in.
 */

const SKILL_NAME = 'spicytrade'

/** Where each agent looks for a folder's skills, relative to that folder. */
export const AGENTS = [
  { bin: 'claude', name: 'Claude Code', skills: join('.claude', 'skills') },
  { bin: 'codex', name: 'Codex', skills: join('.agents', 'skills') },
]

/**
 * How a `SKILL.md` this CLI wrote is told from one a member wrote under the same name, which is
 * theirs and is left alone. Part of the file, so it travels with it.
 */
const OWN_MARK = '<!-- Written by `spicytrade connect`, which rewrites it. -->'

const SKILL = `---
name: ${SKILL_NAME}
description: Market data, options research and the user's tastytrade brokerage account, through the spicytrade command. Use for quotes, price history, option chains and Greeks, catalysts and the daily brief, and for the user's positions, balances and orders, including placing, replacing or cancelling an order.
---

${OWN_MARK}

# spicytrade

Run the \`spicytrade\` command in your shell. If it is not on PATH, use \`~/.local/bin/spicytrade\`.

1. \`spicytrade tools\` prints how to use spicytrade and every tool available to this user. Read
   it before the first call in a conversation. The \`spicytrade://guide\` resource it mentions is
   printed by \`spicytrade guide\`.
2. \`spicytrade tools <name>\` prints one tool's full description and its arguments.
3. \`spicytrade call <name> '<json arguments>'\` calls a tool and prints its answer. Pass \`-\` in
   place of the JSON to read it from stdin. A tool that takes no arguments needs none.

## Orders

- A tool marked \`[changes things]\` acts on the user's real account. Place, replace or cancel an
  order only when the user asked for exactly that, and show them the order before you send it.
- Call such a tool as its own command, never inside a script, a loop or a pipeline.
- If a call says the order may already have gone through, do not send it again. Check working
  orders and positions with \`spicytrade call read_account_snapshot\` first.

## When it is not connected

If a command says this computer is not signed in, or tastytrade is not connected, run
\`spicytrade connect\` and keep it running. It prints one link and a short code. Give the user
both, and tell them to approve only if the page shows that code. Never ask for passwords, tokens
or codes in chat. \`spicytrade doctor\` checks the connection without changing anything.
`

function skillPath(agent) {
  return join(WORKSPACE_DIR, agent.skills, SKILL_NAME, 'SKILL.md')
}

/** The agents installed on this computer. */
export async function installedAgents() {
  const installed = await Promise.all(AGENTS.map((agent) => commandInstalled(agent.bin)))
  return AGENTS.filter((_, index) => installed[index])
}

/**
 * What the workspace holds for one agent: `missing`, `current`, `outdated` (this CLI's own skill
 * from an earlier version), or `foreign` (a skill of that name someone else wrote).
 */
export async function skillState(agent) {
  let found
  try {
    found = await readFile(skillPath(agent), 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing'
    // Something else sits where the skill would go -- a file for the folder, a folder for the
    // file -- and it is not this CLI's to replace.
    if (error.code === 'ENOTDIR' || error.code === 'EISDIR') return 'foreign'
    throw error
  }
  if (found === SKILL) return 'current'
  return found.includes(OWN_MARK) ? 'outdated' : 'foreign'
}

/** The workspace as a message names it. */
export function workspaceName() {
  return homeRelative(WORKSPACE_DIR)
}

/**
 * Write the skill into the workspace for each installed agent, one line each to `out`; resolves
 * the agents that have it afterwards. A skill of the same name that is not this CLI's is left as
 * it is and said so.
 */
export async function installSkill(out) {
  const ready = []
  for (const agent of await installedAgents()) {
    const state = await skillState(agent)
    if (state === 'foreign') {
      out.write(`! ${agent.name} has a different skill named "${SKILL_NAME}" in ${workspaceName()}; left as it is\n`)
      continue
    }
    if (state !== 'current') {
      await mkdir(dirname(skillPath(agent)), { recursive: true })
      await writeFile(skillPath(agent), SKILL)
    }
    out.write(state === 'current'
      ? `✓ ${agent.name} already has the ${SKILL_NAME} skill in ${workspaceName()}; skipped\n`
      : `✓ ${agent.name}: ${state === 'outdated' ? 'updated' : 'added'} the ${SKILL_NAME} skill in ${workspaceName()}\n`)
    ready.push(agent)
  }
  return ready
}

/** Remove this CLI's own skill from the workspace; resolves the agents it was removed for. */
export async function removeSkill() {
  const removed = []
  for (const agent of AGENTS) {
    const state = await skillState(agent)
    if (state !== 'current' && state !== 'outdated') continue
    await rm(dirname(skillPath(agent)), { recursive: true })
    removed.push(agent)
  }
  return removed
}
