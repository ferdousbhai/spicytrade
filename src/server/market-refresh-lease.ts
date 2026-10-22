import { errorName, toError } from '../domain/failure'
import { type AppEnv } from './env'
import { brokerApi } from './tastytrade'

// A crashed public market read frees its claim within thirty seconds. A live read renews
// halfway through: both a full snapshot and a missing-symbol lookup need sequential REST calls.
export const MARKET_REFRESH_LEASE_MS = 30_000

/**
 * Keep the claim alive for the whole rebuild, including queued requests and D1 writes. Renewals
 * compare the holder's expiry so a delayed callback never extends a newer caller's claim.
 * Sequential timers avoid overlapping renewals; cleanup waits for one already in flight.
 */
export async function withMarketRefreshLease<T>(
  env: AppEnv,
  claimedAt: Date,
  id: string,
  operation: (release: () => Promise<void>) => Promise<T>,
): Promise<T> {
  let holderAt = claimedAt
  let stopped = false
  let pending: Promise<void> = Promise.resolve()
  let timer: ReturnType<typeof setTimeout>
  const schedule = () => {
    timer = setTimeout(() => {
      pending = renew()
    }, MARKET_REFRESH_LEASE_MS / 2)
  }
  const renew = async () => {
    const now = new Date()
    try {
      if (!await brokerApi().renewMarketRefresh(env, MARKET_REFRESH_LEASE_MS, holderAt, now, id)) {
        console.error('MarketRefreshLeaseLost', 'Error')
        return
      }
      holderAt = now
      if (!stopped) schedule()
    } catch (error) {
      // The lease remains an optimization, like claimMarketRefresh: failed coordination is
      // observable, and the ongoing public read may still finish rather than denying the page.
      console.error('MarketRefreshLeaseRenewalFailed', errorName(toError(error)))
    }
  }
  const stop = async () => {
    stopped = true
    clearTimeout(timer!)
    await pending
  }
  const release = async () => {
    // Stop and join a renewal before releasing, otherwise its newer expiry could survive
    // cleanup. The expiry we last renewed is the claim identity used by the store's CAS.
    await stop()
    await brokerApi().releaseMarketRefresh(env, MARKET_REFRESH_LEASE_MS, holderAt, id)
  }
  schedule()
  try {
    return await operation(release)
  } finally {
    await stop()
  }
}
