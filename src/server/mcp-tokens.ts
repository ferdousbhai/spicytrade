import {
  MAX_MCP_TOKENS_PER_USER,
  McpTokenLabelSchema,
  TOKEN_ID_HEX_LENGTH,
  TOKEN_ID_PATTERN,
  type McpTokenMetadata,
} from '../domain/mcp-tokens'
import { randomBase64Url, sha256Base64Url } from './digest'

/**
 * `spice_<token_id>_<secret>`.
 *
 * The id travels inside the token on purpose. Verification cannot scan every row in constant
 * time, so the id selects exactly one row and only the digest comparison has to be constant
 * time. The id is not a secret and grants nothing on its own.
 */
const TOKEN_PREFIX = 'spice_'
/**
 * `heston_` is the retired prefix, on tokens issued before the rebrand to Spice (now spicytrade). They keep
 * authenticating so no member's agent is cut off by a rename, and accepting them is not a bypass:
 * the stored digest covers the whole string, prefix included, so a token only ever matches under
 * the exact prefix it was minted with. Nothing mints this prefix any more.
 */
const LEGACY_TOKEN_PREFIX = 'heston_'
const TOKEN_PATTERN = new RegExp(`^(?:${TOKEN_PREFIX}|${LEGACY_TOKEN_PREFIX})(${TOKEN_ID_PATTERN})_([A-Za-z0-9_-]{16,})$`)
/**
 * `last_used_at` exists so a member can recognise a stale token in the Connect tab. Writing it
 * on every call would cost a D1 write per tool call for a display detail, so it is refreshed at
 * most hourly and is therefore approximate by design.
 */
const LAST_USED_REFRESH_MS = 60 * 60_000

/**
 * Whether a presented bearer has the shape of a token this server mints. Such a string is only
 * ever authenticated against `user_mcp_tokens`: it is not a JWT, so handing a revoked or mistyped
 * one to the OAuth verifier would only log a misleading verification failure.
 */
export function isMintedMcpToken(presented: string): boolean {
  return TOKEN_PATTERN.test(presented)
}

/**
 * The credential in an `Authorization: Bearer` header, parsed once for every way in. The scheme
 * is case-insensitive (RFC 9110 §11.1), so `bearer` is the same claim as `Bearer`. Undefined for
 * a header that is absent, carries another scheme, or carries nothing after it.
 */
export function presentedBearer(request: Request): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') ?? '')
  return match?.[1]?.trim() || undefined
}

type McpTokenIdentity = { tokenId: string; userId: string }

export class McpTokenLimitError extends Error {
  constructor() {
    super(`A member may hold at most ${MAX_MCP_TOKENS_PER_USER} agent tokens. Revoke one before issuing another.`)
    this.name = 'McpTokenLimitError'
  }
}

/**
 * Compare two values by their digests, full width, every time.
 *
 * Hashing first makes both operands a fixed 32 bytes, so length leaks nothing and the loop
 * below runs the same number of iterations regardless of where the first difference falls.
 * This uses only standard WebCrypto rather than the Workers `timingSafeEqual` extension, so the
 * production path and the tested path are the same code.
 */
export async function constantTimeDigestMatch(provided: string, expected: string): Promise<boolean> {
  const encoder = new TextEncoder()
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(provided)),
    crypto.subtle.digest('SHA-256', encoder.encode(expected)),
  ])
  const left = new Uint8Array(a)
  const right = new Uint8Array(b)
  let difference = left.length ^ right.length
  for (let index = 0; index < left.length; index += 1) difference |= left[index]! ^ right[index]!
  return difference === 0
}

function randomTokenId(): string {
  const bytes = new Uint8Array(TOKEN_ID_HEX_LENGTH / 2)
  crypto.getRandomValues(bytes)
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}


function metadataFromRow(row: {
  created_at: string
  label: string
  last_used_at: string | null
  token_id: string
}): McpTokenMetadata {
  const metadata: McpTokenMetadata = {
    createdAt: row.created_at,
    label: row.label,
    tokenId: row.token_id,
  }
  // Absent rather than empty: a token that has never been used is a real fact about it.
  if (row.last_used_at) metadata.lastUsedAt = row.last_used_at
  return metadata
}

export async function listMcpTokens(database: D1Database, userId: string): Promise<McpTokenMetadata[]> {
  const result = await database.prepare(
    `SELECT token_id, label, created_at, last_used_at
       FROM user_mcp_tokens
      WHERE user_id = ?
      ORDER BY created_at`,
  ).bind(userId).all<{ created_at: string; label: string; last_used_at: string | null; token_id: string }>()
  // The digest is deliberately not selected: no read path should be able to return it.
  return result.results.map(metadataFromRow)
}

export async function issueMcpToken(
  database: D1Database,
  userId: string,
  label: string,
  now = new Date(),
): Promise<{ token: string; tokenMetadata: McpTokenMetadata }> {
  const parsedLabel = McpTokenLabelSchema.parse(label)
  const tokenId = randomTokenId()
  const token = `${TOKEN_PREFIX}${tokenId}_${randomBase64Url(32)}`
  const createdAt = now.toISOString()
  // The cap is checked inside the insert rather than read first: two concurrent issues that
  // each counted below the cap would otherwise both insert and leave the member over it.
  const inserted = await database.prepare(
    `INSERT INTO user_mcp_tokens (token_id, user_id, token_digest, label, created_at)
     SELECT ?, ?, ?, ?, ?
     WHERE (SELECT COUNT(*) FROM user_mcp_tokens WHERE user_id = ?) < ?`,
  ).bind(
    tokenId,
    userId,
    await sha256Base64Url(token),
    parsedLabel,
    createdAt,
    userId,
    MAX_MCP_TOKENS_PER_USER,
  ).run()
  if (inserted.meta.changes === 0) throw new McpTokenLimitError()
  return { token, tokenMetadata: { createdAt, label: parsedLabel, tokenId } }
}

/** Scoped by user id: possession of a token id is never authority over someone else's token. */
export async function revokeMcpToken(
  database: D1Database,
  userId: string,
  tokenId: string,
): Promise<boolean> {
  const result = await database.prepare(
    'DELETE FROM user_mcp_tokens WHERE user_id = ? AND token_id = ?',
  ).bind(userId, tokenId).run()
  return result.meta.changes === 1
}

export async function authenticateMcpToken(
  database: D1Database,
  presented: string,
  now = new Date(),
): Promise<McpTokenIdentity | undefined> {
  const match = TOKEN_PATTERN.exec(presented)
  if (!match) return undefined
  const tokenId = match[1]!
  const row = await database.prepare(
    'SELECT user_id, token_digest, last_used_at FROM user_mcp_tokens WHERE token_id = ?',
  ).bind(tokenId).first<{ last_used_at: string | null; token_digest: string; user_id: string }>()
  if (!row) return undefined
  if (!await constantTimeDigestMatch(await sha256Base64Url(presented), row.token_digest)) return undefined

  const lastUsedAt = row.last_used_at ? Date.parse(row.last_used_at) : undefined
  if (lastUsedAt === undefined || !Number.isFinite(lastUsedAt) || now.getTime() - lastUsedAt >= LAST_USED_REFRESH_MS) {
    try {
      await database.prepare(
        'UPDATE user_mcp_tokens SET last_used_at = ? WHERE token_id = ?',
      ).bind(now.toISOString(), tokenId).run()
    } catch {
      // A display detail must never cost an otherwise valid caller their request.
      console.error('McpTokenLastUsedWriteFailed')
    }
  }
  return { tokenId, userId: row.user_id }
}
