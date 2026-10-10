import { createFileRoute } from '@tanstack/react-router'

import { McpTokenIssueRequestSchema, McpTokenRevokeRequestSchema } from '../domain/mcp-tokens'
import { errorName, toError } from '../domain/failure'
import { issueMcpToken, listMcpTokens, McpTokenLimitError, revokeMcpToken } from '../server/mcp-tokens'
import { authenticateRequest, jsonNoStore } from '../server/http'
import { appEnv } from '../server/worker-env'

/**
 * Any signed-in member manages their own agent tokens; this is not owner-gated. Every handler
 * scopes by `identity.id`, so a token id from someone else's account resolves to nothing.
 */
export const Route = createFileRoute('/api/mcp-tokens')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const authenticated = await authenticateRequest(request, appEnv)
        if ('response' in authenticated) return authenticated.response
        if (!appEnv.DB) return jsonNoStore({ error: 'Agent tokens are unavailable' }, { status: 503 })
        try {
          return jsonNoStore({ tokens: await listMcpTokens(appEnv.DB, authenticated.identity.id) })
        } catch (error) {
          console.error('McpTokenListFailed', errorName(toError(error)))
          return jsonNoStore({ error: 'Agent tokens are temporarily unavailable' }, { status: 503 })
        }
      },
      POST: async ({ request }) => {
        const authenticated = await authenticateRequest(request, appEnv, true)
        if ('response' in authenticated) return authenticated.response
        if (!appEnv.DB) return jsonNoStore({ error: 'Agent tokens are unavailable' }, { status: 503 })
        const parsed = McpTokenIssueRequestSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) return jsonNoStore({ error: 'Invalid token label' }, { status: 400 })
        try {
          // The plaintext token is in this response and nowhere else, ever again.
          const issued = await issueMcpToken(appEnv.DB, authenticated.identity.id, parsed.data.label)
          return jsonNoStore(issued)
        } catch (error) {
          if (error instanceof McpTokenLimitError) {
            return jsonNoStore({ error: error.message }, { status: 409 })
          }
          console.error('McpTokenIssueFailed', errorName(toError(error)))
          return jsonNoStore({ error: 'Agent tokens are temporarily unavailable' }, { status: 503 })
        }
      },
      DELETE: async ({ request }) => {
        const authenticated = await authenticateRequest(request, appEnv, true)
        if ('response' in authenticated) return authenticated.response
        if (!appEnv.DB) return jsonNoStore({ error: 'Agent tokens are unavailable' }, { status: 503 })
        const parsed = McpTokenRevokeRequestSchema.safeParse(await request.json().catch(() => null))
        if (!parsed.success) return jsonNoStore({ error: 'Invalid token' }, { status: 400 })
        try {
          const revoked = await revokeMcpToken(appEnv.DB, authenticated.identity.id, parsed.data.tokenId)
          if (!revoked) return jsonNoStore({ error: 'No such token' }, { status: 404 })
          return jsonNoStore({ tokens: await listMcpTokens(appEnv.DB, authenticated.identity.id) })
        } catch (error) {
          console.error('McpTokenRevokeFailed', errorName(toError(error)))
          return jsonNoStore({ error: 'Agent tokens are temporarily unavailable' }, { status: 503 })
        }
      },
    },
  },
})
