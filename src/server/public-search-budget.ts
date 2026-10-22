import { type AppEnv } from './env'

// Abuse budget: at most one fresh public search per second on average, shared by HTTP and MCP.
// Cached answers cost no provider work and do not consume this allowance.
export const PUBLIC_SEARCH_LOOKUPS_PER_MINUTE = 60
const WINDOW_MS = 60_000

export async function claimPublicSearchBudget(env: AppEnv, now = Date.now()): Promise<boolean> {
  if (!env.DB) throw new Error('PublicSearchBudgetUnavailable')
  const windowStart = Math.floor(now / WINDOW_MS) * WINDOW_MS
  const claimed = await env.DB.prepare(`
    INSERT INTO public_search_budget (id, window_start, requests) VALUES (1, ?, 1)
    ON CONFLICT(id) DO UPDATE SET
      requests = CASE WHEN window_start = excluded.window_start THEN requests + 1 ELSE 1 END,
      window_start = excluded.window_start
    WHERE window_start < excluded.window_start
      OR (window_start = excluded.window_start AND requests < ?)
    RETURNING requests
  `).bind(windowStart, PUBLIC_SEARCH_LOOKUPS_PER_MINUTE).first<{ requests: number }>()
  return claimed !== null
}
