import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import { createInterface } from 'node:readline/promises'

import { CLIENTS, EXPECTED_TARGET } from './clients.mjs'
import { TRADING_DIR, cliCommand } from './config.mjs'
import { commandInstalled } from './keyring.mjs'
import { CliFailure } from './loopback.mjs'

/** Keep trading opt-in while hiding each client's configuration syntax from the member. */
export async function start() {
  const available = []
  for (const client of CLIENTS) {
    if (await commandInstalled(client.bin)) available.push(client)
  }
  if (!available.length) throw new CliFailure('Install Claude Code or Codex, then run spicytrade setup.')
  const preferenceDir = join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'spicytrade')
  const preferencePath = join(preferenceDir, 'agent.json')
  let preferred
  try {
    preferred = z.enum(['claude', 'codex']).parse(JSON.parse(await readFile(preferencePath, 'utf8')))
  } catch (error) {
    if (error.code !== 'ENOENT') throw new CliFailure(`Could not read your agent choice at ${preferencePath}. Remove that file to choose again.`)
  }
  let client = available.find((item) => item.id === preferred)
  if (!client && available.length === 1) client = available[0]
  if (!client) {
    if (!process.stdin.isTTY) throw new CliFailure('Run spicytrade start in a terminal to choose your agent.')
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    try {
      process.stdout.write(available.map((item, index) => `${index + 1}. ${item.name}\n`).join(''))
      const answer = (await prompt.question('Choose your agent [1]: ')).trim() || '1'
      client = available.find((_, index) => String(index + 1) === answer)
      if (!client) throw new CliFailure('Choose one of the listed agents by number.')
    } finally {
      prompt.close()
    }
  }
  const configured = client.configured()
  if (configured.state !== 'configured' || configured.target !== EXPECTED_TARGET) throw new CliFailure(`Connect ${client.name} first: ${cliCommand('setup')}`)
  await mkdir(TRADING_DIR, { recursive: true })
  await mkdir(preferenceDir, { recursive: true })
  await writeFile(preferencePath, `${JSON.stringify(client.id)}\n`)
  // argv, never a shell: the client inherits the terminal without interpreting paths as code.
  const args = client.id === 'codex' ? ['-c', 'mcp_servers.spicytrade.enabled=true'] : []
  const child = spawn(client.bin, args, { cwd: TRADING_DIR, stdio: 'inherit' })
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (status) => resolve(status ?? 1))
  })
  process.exitCode = code
}
