import { z } from 'zod'

import { grantMinter, grantRefused, TastytradeAuthError } from './broker-grants.mjs'
import { callTool } from './call.mjs'
import { CliFailure } from './cli.mjs'
import { cliCommand } from './config.mjs'
import { agentToken, keyringHelperInstalled, keyringHelperMissing, keyringWritable, requireSupportedPlatform, tastytradeCredentialKind } from './keyring.mjs'
import { login } from './login.mjs'
import { installedAgents, installSkill, workspaceName } from './skill.mjs'
import { connectTastytrade } from './tastytrade-connect.mjs'
import { checkAgentToken, describeTokenCheck } from './worker.mjs'

const SnapshotSchema = z.object({ asOf: z.iso.datetime(), balances: z.object({ netLiquidatingValue: z.number() }), source: z.literal('tastytrade') })

/**
 * A connection is finished only when a real account snapshot comes back, read the way the agent
 * will read it. Nothing of the account is printed.
 */
async function verifyAccount() {
  const { isError, text } = await callTool('read_account_snapshot')
  let snapshot
  try {
    snapshot = isError ? undefined : SnapshotSchema.safeParse(JSON.parse(text)).data
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error
  }
  if (!snapshot) throw new CliFailure(`the account snapshot could not be verified. Check the connection with: ${cliCommand('doctor')}`)
}

/** Explicit account connection, callable from an existing agent's shell without a terminal questionnaire. */
export async function connect(out = process.stdout) {
  requireSupportedPlatform()
  if (!await keyringHelperInstalled()) throw new CliFailure(`${keyringHelperMissing().name} is missing. ${keyringHelperMissing().install}, then connect again. Your agent can help with that.`)
  out.write('Checking password storage. Approve any desktop unlock dialog.\n')
  if (!await keyringWritable(out)) throw new CliFailure('Password storage is unavailable. Connect from a signed-in desktop session with a working system keyring.')
  let token = await agentToken()
  const checked = token ? await checkAgentToken(token) : undefined
  if (checked?.status === 'unanswered' || checked?.status === 'unreachable') throw new CliFailure(describeTokenCheck(checked))
  const credential = await tastytradeCredentialKind()
  if (credential.kind === 'ambiguous' || credential.kind === 'incomplete') {
    throw new CliFailure(`The saved tastytrade connection needs repair. Run ${cliCommand('setup')} in a terminal to choose whether to replace it.`)
  }
  // Running `connect` explicitly asks for account access. Brokerage authorization is still
  // the user's own decision on tastytrade's consent page; a shell/agent never supplies consent.
  if (credential.kind === 'none') {
    // One link: it signs this computer in and continues to tastytrade.
    await connectTastytrade(out)
  } else {
    if (checked?.status !== 'accepted') {
      await login(out)
      token = await agentToken()
    }
    try {
      await grantMinter(token, credential)()
    } catch (error) {
      if (!(error instanceof TastytradeAuthError) || !grantRefused(error)) throw error
      if (credential.kind === 'personal') throw new CliFailure(`tastytrade refused your personal grant. Store a replacement with ${cliCommand('store-personal-grant')}.`)
      await connectTastytrade(out)
    }
  }
  out.write('Verifying live account access…\n')
  await verifyAccount()
  const ready = await installSkill(out)
  // An agent whose own skill of that name was left alone is installed all the same: only a
  // computer with neither is told there is no agent to hear of it.
  const told = ready.length
    ? ` Agents started in ${workspaceName()} can use it now.`
    : (await installedAgents()).length ? '' : ' No Claude Code or Codex was found on this computer to tell about it.'
  out.write(`Account connected and live snapshot verified.${told} List what it can do with \`${cliCommand('tools')}\`.\n`)
}
