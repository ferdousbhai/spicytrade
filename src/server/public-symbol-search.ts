import { type PublicSymbolLookup } from '../domain/market'
import { errorName, toError } from '../domain/failure'
import { type AppEnv } from './env'
import { jsonNoStore, jsonPublic } from './http'
import { COLD_STORE_RETRY_DELAYS_MS, storeEdgeCopy, type PublicSnapshotCache } from './public-snapshot-cache'
import { searchableQuery } from './symbol-search'
import { SYMBOL_REFRESH_LEASE_PREFIX } from './tastytrade-market-store'
import { brokerApi } from './tastytrade'

/**
 * A lookup costs a broker read and a maintained-list write, so an answer is kept and
 * replayed: the same search repeated by any number of readers resolves once a minute.
 * A search that matched nothing is kept longer — a typo does not become a symbol.
 */
const FOUND_RETENTION_SECONDS = 60
const MISSING_RETENTION_SECONDS = 300
// One lookup per symbol may reach the provider at a time. The edge copy only dedupes readers
// that land in the same location, so the claim is what stops the same search in twenty places
// from becoming twenty provider calls. The lease bounds a holder that dies mid-lookup. A holder
// whose lookup found a symbol keeps its claim until it expires, because the answer is in the
// shared store; one that missed or failed gives it back, because a miss is kept only in the
// holder's own location, and a reader elsewhere must be able to ask rather than be told "busy".
const LOOKUP_LEASE_MS = 30 * 1_000

function cacheKeyFor(request: Request, query: string): Request {
  const cacheUrl = new URL(request.url)
  cacheUrl.search = ''
  cacheUrl.searchParams.set('schema', '1')
  cacheUrl.searchParams.set('q', query)
  return new Request(cacheUrl, { method: 'GET' })
}

function store(edgeCache: PublicSnapshotCache, cacheKey: Request, response: Response, retentionSeconds: number): Promise<Response> {
  return storeEdgeCopy(edgeCache, cacheKey, response, retentionSeconds, 'PublicSymbolSearchCacheWriteFailed')
}

async function readStored(env: AppEnv, query: string): Promise<PublicSymbolLookup | undefined> {
  try {
    return await brokerApi().lookupStoredMarketSymbol(env, query)
  } catch (error) {
    console.error('PublicSymbolSearchStoreReadFailed', errorName(toError(error)))
    return undefined
  }
}

/** Claim the one provider lookup for this query, answering the claim's instant when it is ours. */
async function claimLookup(env: AppEnv, leaseId: string): Promise<Date | undefined> {
  const claimedAt = new Date()
  return await brokerApi().claimMarketRefresh(env, LOOKUP_LEASE_MS, claimedAt, leaseId) ? claimedAt : undefined
}

/**
 * The provider lookup, made only while holding the claim. A found answer is in the shared store,
 * so the claim is kept until it expires: every other location reads that answer rather than
 * buying its own lookup within the lease. A miss or a failure reaches no shared store, so the
 * claim is released at once and a waiting location can answer for itself instead of "busy".
 */
async function lookupHoldingClaim(
  env: AppEnv,
  edgeCache: PublicSnapshotCache,
  cacheKey: Request,
  query: string,
  leaseId: string,
  claimedAt: Date,
): Promise<Response> {
  const release = () => brokerApi().releaseMarketRefresh(env, LOOKUP_LEASE_MS, claimedAt, leaseId)
  let lookup
  try {
    lookup = await brokerApi().lookupPublicMarketSymbol(env, query)
  } catch (error) {
    await release()
    throw error
  }
  if (!lookup) {
    // Released after the edge copy lands, so a waiter in this location reads it rather than
    // claiming a second lookup in between.
    const missed = await store(
      edgeCache,
      cacheKey,
      jsonPublic({ error: 'No tradable symbol matches that search' }, { status: 404 }),
      MISSING_RETENTION_SECONDS,
    )
    await release()
    return missed
  }
  return await store(edgeCache, cacheKey, jsonPublic(lookup), FOUND_RETENTION_SECONDS)
}

/** The edge copy, if any; a cache that fails to answer is logged and treated as a miss. */
async function readEdgeCopy(edgeCache: PublicSnapshotCache, cacheKey: Request): Promise<Response | undefined> {
  try {
    return await edgeCache.match(cacheKey)
  } catch (error) {
    console.error('PublicSymbolSearchCacheReadFailed', errorName(toError(error)))
    return undefined
  }
}

/**
 * Give the one caller that won the claim time to land its answer, then read it: the edge copy
 * first, which also carries a search that matched nothing, then the store, which a winner in
 * another location writes. A winner whose answer reached neither -- a search that matched
 * nothing, answered in another location -- has released its claim by then, so claiming again
 * takes over the lookup rather than reporting busy; the claim still admits one lookup at a time.
 */
async function awaitClaimWinner(
  env: AppEnv,
  edgeCache: PublicSnapshotCache,
  cacheKey: Request,
  query: string,
  leaseId: string,
): Promise<Response | undefined> {
  for (const delay of COLD_STORE_RETRY_DELAYS_MS) {
    await new Promise((resolve) => setTimeout(resolve, delay))
    const cached = await readEdgeCopy(edgeCache, cacheKey)
    if (cached) return cached
    const stored = await readStored(env, query)
    if (stored) return await store(edgeCache, cacheKey, jsonPublic(stored), FOUND_RETENTION_SECONDS)
    const claimedAt = await claimLookup(env, leaseId)
    if (claimedAt) return await lookupHoldingClaim(env, edgeCache, cacheKey, query, leaseId, claimedAt)
  }
  return undefined
}

export async function servePublicSymbolSearch(
  request: Request,
  env: AppEnv,
  edgeCache: PublicSnapshotCache,
): Promise<Response> {
  const query = searchableQuery(new URL(request.url).searchParams.get('q') ?? '')
  if (!query) return jsonNoStore({ error: 'Search for a symbol or a company name' }, { status: 400 })
  const cacheKey = cacheKeyFor(request, query)
  const cached = await readEdgeCopy(edgeCache, cacheKey)
  if (cached) return cached

  // A symbol anyone has already searched is in the store, so losing the claim still answers, and
  // so does a live lookup that fails. Read once: the failure path reuses this answer.
  const stored = await readStored(env, query)
  const leaseId = `${SYMBOL_REFRESH_LEASE_PREFIX}${query}`
  try {
    const claimedAt = await claimLookup(env, leaseId)
    if (claimedAt) return await lookupHoldingClaim(env, edgeCache, cacheKey, query, leaseId, claimedAt)
    if (stored) return await store(edgeCache, cacheKey, jsonPublic(stored), FOUND_RETENTION_SECONDS)
    // A first-time search whose claim another caller holds waits for that caller's answer
    // rather than making its own provider call, which is the fan-out the claim exists to stop.
    const awaited = await awaitClaimWinner(env, edgeCache, cacheKey, query, leaseId)
    if (awaited) return awaited
    return jsonNoStore({ error: 'Symbol search is busy; try again' }, { status: 503 })
  } catch (error) {
    console.error('PublicSymbolSearchUnavailable', errorName(toError(error)))
    if (stored) return jsonPublic(stored)
    return jsonNoStore({ error: 'Symbol search is temporarily unavailable' }, { status: 503 })
  }
}
