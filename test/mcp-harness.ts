import { type JsonValue } from '../src/domain/json-payload'
import { OWNER_EMAIL } from '../src/server/auth'
import { type McpExecutionContext } from '../src/server/mcp'
import { issueMcpToken } from '../src/server/mcp-tokens'
import { migrationStore, seedMember } from './sqlite-d1'

export const executionContext: McpExecutionContext = { props: undefined, waitUntil: () => undefined }

export type JsonRpcFrame = { id: number; jsonrpc: '2.0'; method: string; params?: Record<string, JsonValue> }

export const TOOLS_LIST: JsonRpcFrame = { id: 1, jsonrpc: '2.0', method: 'tools/list', params: {} }

/** A POST to `/mcp`; `scheme` lets a test send the bearer scheme in another case. */
export function mcpRequest(body: JsonRpcFrame | Record<string, never>, token?: string, scheme = 'Bearer'): Request {
  const headers = new Headers({
    Accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  })
  if (token !== undefined) headers.set('Authorization', `${scheme} ${token}`)
  return new Request('https://spicy.trade/mcp', {
    body: JSON.stringify(body),
    headers,
    method: 'POST',
  })
}

/** Responses come back as an SSE frame; the JSON body starts at the first brace. */
export async function mcpPayload(response: Response) {
  const body = await response.text()
  return JSON.parse(body.slice(body.indexOf('{')))
}

/**
 * Every caller is a row in `user_mcp_tokens`, so a test that reaches `/mcp` needs a real
 * store and a real issued token. `ownerHarness` seeds the owner; `harness('member@example.com')`
 * seeds someone else, which is what separates the two tool tiers.
 */
export async function harness(email: string) {
  const store = await migrationStore()
  seedMember(store, 'member-1', email)
  const issued = await issueMcpToken(store.database, 'member-1', 'laptop')
  return { env: { DB: store.database }, store, token: issued.token }
}

export function ownerHarness() {
  return harness(OWNER_EMAIL)
}
