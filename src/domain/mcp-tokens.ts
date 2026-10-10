import { z } from 'zod'

/**
 * One token per machine a member connects from. The cap exists so a forgotten laptop cannot
 * accumulate credentials without bound; a member who needs more should revoke a stale one,
 * which is the action the cap is trying to provoke.
 */
export const MAX_MCP_TOKENS_PER_USER = 5

/**
 * A label names a machine in the Connect tab's token list ("Work laptop", "Home desktop"). It is
 * a display name, not free text: the bound keeps one row of that list on one line, and the
 * input that collects it carries the same number so a member cannot type past what is kept.
 */
export const MAX_MCP_TOKEN_LABEL_LENGTH = 60

export const McpTokenLabelSchema = z.string().trim().min(1).max(MAX_MCP_TOKEN_LABEL_LENGTH)

/**
 * A token id is this many lowercase hex characters: 8 random bytes, enough that ids never
 * collide within one member's handful of tokens and short enough to read in a list. The
 * minting side and every request that names an id derive their shape from this one number.
 */
export const TOKEN_ID_HEX_LENGTH = 16
export const TOKEN_ID_PATTERN = `[0-9a-f]{${TOKEN_ID_HEX_LENGTH}}`

const McpTokenMetadataSchema = z.strictObject({
  createdAt: z.string(),
  label: McpTokenLabelSchema,
  lastUsedAt: z.string().optional(),
  tokenId: z.string(),
})

export const McpTokenListResponseSchema = z.strictObject({
  tokens: z.array(McpTokenMetadataSchema),
})

/** The plaintext token appears in exactly this one response and is never readable again. */
export const McpTokenIssuedResponseSchema = z.strictObject({
  token: z.string(),
  tokenMetadata: McpTokenMetadataSchema,
})

export const McpTokenIssueRequestSchema = z.strictObject({
  label: McpTokenLabelSchema,
})

export const McpTokenRevokeRequestSchema = z.strictObject({
  tokenId: z.string().regex(new RegExp(`^${TOKEN_ID_PATTERN}$`)),
})

export type McpTokenMetadata = z.infer<typeof McpTokenMetadataSchema>
