import { describe, expect, it } from 'vitest'
import { claimPublicSearchBudget, PUBLIC_SEARCH_LOOKUPS_PER_MINUTE } from '../src/server/public-search-budget'
import { migrationStore } from './sqlite-d1'

describe('public search abuse budget', () => {
  it('shares one atomic allowance across concurrent callers and resets in the next window', async () => {
    const store = await migrationStore()
    try {
      const env = { DB: store.database }
      const now = 120_000
      const claims = await Promise.all(Array.from({ length: PUBLIC_SEARCH_LOOKUPS_PER_MINUTE + 20 }, () => claimPublicSearchBudget(env, now)))
      expect(claims.filter(Boolean)).toHaveLength(PUBLIC_SEARCH_LOOKUPS_PER_MINUTE)
      expect(await claimPublicSearchBudget(env, now)).toBe(false)
      expect(await claimPublicSearchBudget(env, now + 60_000)).toBe(true)
      expect(await claimPublicSearchBudget(env, now)).toBe(false)
    } finally { store.close() }
  })
  it('fails closed when its database is unavailable', async () => {
    await expect(claimPublicSearchBudget({})).rejects.toThrow('PublicSearchBudgetUnavailable')
  })
})
