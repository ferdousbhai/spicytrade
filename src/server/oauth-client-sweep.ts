import { AUTHORIZATION_REQUEST_LIFETIME_SECONDS } from './auth'
import { type AppEnv } from './env'
import { ConfigurationError } from './secrets'

/**
 * Drop OAuth clients that registered themselves and never earned anything.
 *
 * Registration is open and unauthenticated, so every call leaves a row, and a client that no
 * member ever approved confers nothing: it holds no consent and no token. Deleting one loses
 * nothing a legitimate agent needs, because an MCP client that is told its client id is unknown
 * registers again. Only self-registered clients (no owning user) are considered, and only once
 * they are older than one authorization request, so a client cannot be dropped while its first
 * approval is still on someone's screen. A long-registered, never-approved client whose member is
 * mid-approval during the tick does lose that attempt; the provider then reports the client as
 * unknown and the agent starts over, which is visible rather than silent.
 *
 * Better-auth stores dates in D1 as ISO strings, so the cutoff compares as one.
 */
export async function sweepUnconsentedOAuthClients(env: AppEnv, now = new Date()): Promise<number> {
  // Scheduled only: a missing binding is a misconfiguration to name, not a sweep of zero rows.
  if (!env.DB) throw new ConfigurationError('BindingMissing', 'DB')
  const cutoff = new Date(now.getTime() - AUTHORIZATION_REQUEST_LIFETIME_SECONDS * 1000).toISOString()
  const result = await env.DB.prepare(
    `DELETE FROM "oauthClient"
     WHERE "userId" IS NULL
       AND "createdAt" <= ?
       AND NOT EXISTS (SELECT 1 FROM "oauthConsent" WHERE "oauthConsent"."clientId" = "oauthClient"."clientId")
       AND NOT EXISTS (SELECT 1 FROM "oauthAccessToken" WHERE "oauthAccessToken"."clientId" = "oauthClient"."clientId")
       AND NOT EXISTS (SELECT 1 FROM "oauthRefreshToken" WHERE "oauthRefreshToken"."clientId" = "oauthClient"."clientId")`,
  ).bind(cutoff).run()
  return result.meta.changes ?? 0
}
