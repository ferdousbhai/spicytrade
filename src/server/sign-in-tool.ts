import { Type } from 'typebox'
import { z } from 'zod'

import { type AgentTool } from '../domain/agent-tool'
import { CONNECT_GUIDE_URL } from '../domain/site'

/**
 * How an agent on the public tier asks its client to sign in.
 *
 * A caller presenting nothing is served the public tier, never challenged, so an MCP client
 * connects, works, and has no reason to offer the user a sign-in: OAuth starts only from a 401.
 * This tool is that 401 on request. A call to it is answered at the HTTP layer
 * (`handleMcpRequest`) with the same bearer challenge, naming the discovery document, that a bad
 * token gets -- which a client treats as "authorization required" and starts, or offers, the
 * sign-in. The public tier stays open to everyone who never calls it.
 *
 * Listed only to a caller who presented nothing. Once signed in there is nothing left to sign
 * into, and a tool that could only report that is a per-turn cost on every member's tool list.
 */
export const SIGN_IN_TOOL_NAME = 'sign_in'

/**
 * Second choice by design. Signing in over this connection reaches live market data but never an
 * account, because the broker credential exists only on the user's computer; an agent with a
 * shell there gets both from the connector in one approval, so the description says so first.
 */
export const SIGN_IN_TOOL_DESCRIPTION = 'Sign the user in to spicytrade over this connection, for live broker '
  + 'quotes, option chains and Greeks, remembered symbols, and research writes. It never reaches '
  + 'balances, positions or orders. If you can run commands on the user\'s Linux or macOS computer, '
  + `set up the local connector from ${CONNECT_GUIDE_URL} instead: one approval covers sign-in and `
  + 'the brokerage. The call returns an authorization challenge rather than a result; the client then '
  + 'opens the sign-in or marks this server as needing authentication. If nothing opens, tell the user '
  + 'to authenticate the spicytrade server from their client\'s MCP settings.'

/** The challenge's description, which a client may show the user. */
export const SIGN_IN_CHALLENGE_DESCRIPTION = 'Sign in to spicytrade to continue.'

const SignInCallSchema = z.object({
  method: z.literal('tools/call'),
  params: z.object({ name: z.literal(SIGN_IN_TOOL_NAME) }),
})

/**
 * Whether a JSON-RPC body calls `sign_in`, alone or within a batch. Read from a clone, so the
 * request itself still reaches the MCP handler unread when the answer is no. A body that is not
 * JSON is not a sign-in call; the MCP handler reports it as whatever it is.
 */
export async function callsSignIn(request: Request): Promise<boolean> {
  if (request.method !== 'POST') return false
  let body: unknown
  try {
    body = JSON.parse(await request.clone().text())
  } catch {
    return false
  }
  const batch = z.array(z.unknown()).safeParse(body)
  const frames = batch.success ? batch.data : [body]
  return frames.some((frame) => SignInCallSchema.safeParse(frame).success)
}

/**
 * The registered tool. Its `execute` runs only if a call reached the MCP server without passing
 * through `handleMcpRequest`'s check, which no route does; it then says how to sign in rather
 * than pretending a sign-in happened.
 */
export function createSignInTool(): AgentTool {
  return {
    description: SIGN_IN_TOOL_DESCRIPTION,
    execute: () => Promise.resolve({
      content: [{
        text: 'Sign-in could not be started from here. Ask the user to authenticate the spicytrade server from their MCP client\'s settings.',
        type: 'text' as const,
      }],
    }),
    name: SIGN_IN_TOOL_NAME,
    parameters: Type.Object({}, { additionalProperties: false }),
  }
}
