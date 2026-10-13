import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { z } from 'zod'

import { grantMinter, grantRefused, TastytradeAuthError } from './broker-grants.mjs'
import { CLI_PATH, cliCommand } from './config.mjs'
import { agentToken, keyringWritable, secretToolInstalled, tastytradeCredentialKind } from './keyring.mjs'
import { login } from './login.mjs'
import { CliFailure } from './loopback.mjs'
import { connectTastytrade } from './tastytrade-connect.mjs'
import { TOKEN_REQUEST_TIMEOUT_MS, UPSTREAM_TIMEOUT_MS } from './token-refresh.mjs'
import { checkAgentToken, describeTokenCheck } from './worker.mjs'

/** A verification uses the same stdio transport as the user's harness, and never prints account data. */
export async function verifyAccount() {
  const child = spawn(process.execPath, [CLI_PATH, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'] })
  const lines = createInterface({ input: child.stdout })
  const pending = new Map()
  let sequence = 0
  // Initialization, a broker mint and a snapshot each get their existing request budget.
  const timer = setTimeout(() => child.kill(), 2 * UPSTREAM_TIMEOUT_MS + TOKEN_REQUEST_TIMEOUT_MS)
  const failure = () => {
    for (const reject of pending.values()) reject({ failed: true })
    pending.clear()
  }
  child.once('error', failure)
  child.once('exit', failure)
  child.stdin.on('error', failure)
  lines.on('line', (line) => {
    try {
      const reply = JSON.parse(line)
      pending.get(reply.id)?.(reply)
      pending.delete(reply.id)
    } catch {
      failure()
    }
  })
  const request = (method, params) => new Promise((resolve) => {
    const id = ++sequence
    pending.set(id, resolve)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  try {
    const initialized = await request('initialize', {
      protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'spicytrade-connect', version: '1' },
    })
    if (!initialized.result?.protocolVersion || initialized.error) throw new CliFailure('The MCP connection could not be verified.')
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    const reply = await request('tools/call', { name: 'read_account_snapshot', arguments: {} })
    const content = reply.result?.content?.find((item) => item.type === 'text')?.text
    const snapshot = z.object({ asOf: z.iso.datetime(), source: z.literal('tastytrade'), balances: z.object({ netLiquidatingValue: z.number() }) })
    // A successful transport is insufficient: only a real account snapshot completes onboarding.
    if (reply.error || reply.result?.isError || !content
      || !snapshot.safeParse(JSON.parse(content)).success) throw new CliFailure('The account snapshot could not be verified. Ask your agent to check the connection; no order was submitted.')
  } catch (error) {
    if (error instanceof CliFailure) throw error
    throw new CliFailure('The account connection did not finish answering. Try connecting again.')
  } finally {
    clearTimeout(timer)
    lines.close()
    child.kill()
  }
}

/** Explicit account connection, callable from an existing agent's shell without a terminal questionnaire. */
export async function connect(out = process.stdout) {
  if (process.platform !== 'linux') throw new CliFailure('Local account access currently needs Linux. Use https://spicy.trade/mcp for research on other platforms.')
  if (!await secretToolInstalled()) throw new CliFailure('Install secret-tool for your system, then connect again. Your agent can help install the missing dependency.')
  out.write('Checking password storage. Approve any desktop unlock dialog.\n')
  if (!await keyringWritable(out)) throw new CliFailure('Password storage is unavailable. Connect from a signed-in desktop session with a working system keyring.')
  let token = await agentToken()
  const checked = token ? await checkAgentToken(token) : undefined
  if (checked?.status === 'unanswered' || checked?.status === 'unreachable') throw new CliFailure(describeTokenCheck(checked))
  if (checked?.status !== 'accepted') {
    await login(out)
    token = await agentToken()
  }
  const credential = await tastytradeCredentialKind()
  if (credential.kind === 'ambiguous' || credential.kind === 'incomplete') {
    throw new CliFailure(`The saved tastytrade connection needs repair. Run ${cliCommand('setup')} in a terminal to choose whether to replace it.`)
  }
  let needsConnection = credential.kind === 'none'
  if (!needsConnection) {
    try {
      await grantMinter(token, credential)()
    } catch (error) {
      if (!(error instanceof TastytradeAuthError) || !grantRefused(error)) throw error
      if (credential.kind === 'personal') throw new CliFailure(`tastytrade refused your personal grant. Store a replacement with ${cliCommand('store-personal-grant')}.`)
      needsConnection = true
    }
  }
  // Running `connect` explicitly asks for account access. Brokerage authorization is still
  // the user's own decision on tastytrade's consent page; a shell/agent never supplies consent.
  if (needsConnection) await connectTastytrade(out)
  out.write('Verifying live account access…\n')
  await verifyAccount()
  out.write('Account connected and live snapshot verified. Continue in your existing agent conversation.\n')
}
