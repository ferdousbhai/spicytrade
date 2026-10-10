import { errorName, toError } from '../domain/failure'
import {
  MarketSnapshotSchema,
  PublicMarketSnapshotSchema,
  type MarketSnapshot,
  type PublicMarketSnapshot,
  type Watchlist,
  publicTickerFromTicker,
  type PublicSymbolLookup,
} from '../domain/market'
import {
  createTastytradeClient,
  memoryTokenStore,
  TastytradeApiError,
  TastytradeAuthError,
  TastytradeOutcomeUnknownError,
  TastytradeTransportError,
  type RequestOptions,
} from 'tasty-agent/tastytrade'
import { type AppEnv } from './env'
import {
  catalystsFromMarketMetrics,
  persistAndLoadCatalysts,
  readUpcomingCatalysts,
  readUpcomingCatalystsForSymbol,
} from './catalysts'
import {
  ensureInternalWatchlistSymbols,
  readInternalWatchlistCatalogCandidates,
  readInternalWatchlistFocus,
} from './internal-watchlist'
import {
  envelopeRows,
  jsonObject,
  jsonObjectOrEmpty,
  jsonText,
  type JsonObject,
  type JsonValue,
} from '../domain/json-payload'
import { readStoredSecret } from './secrets'
import {
  missingInstrumentCatalogSymbols,
  loadInstrumentCatalog,
  persistInstrumentCatalog,
  readInstrumentCatalog,
  type InstrumentCatalogRefresh,
  unresolvedInstrumentCatalogItem,
} from './instrument-catalog'
import {
  catalogTickerInstrument,
  marketClosesAtFromTastytradeSession,
  marketOpensAtFromTastytradeSession,
  marketStateFromTastytradeSession,
  tickerFromStoredRecords,
  normalizeTastytradeMarketTicker,
  strictTastytradeRows,
  tastytradeRowsByRequestedSymbol,
} from './tastytrade-market-normalization'
import { defineSeam, type SeamValue } from './seam'
import { searchInstrumentCatalog, symbolCandidate } from './symbol-search'
import { loadStoredPublicMarketUniverse, publishInternalWatchlistUniverse } from './public-market-universe'
import { readYearAgoCloses } from './year-candle-store'
import { readLatestDailyBrief } from './daily-brief-store'
import {
  BrokerCredentialMissingError,
  type BrokerCredential,
} from './broker-credential'
import {
  claimMarketRefresh,
  persistMarketSession,
  readStoredMarketRecords,
  readStoredMarketSession,
  persistTastytradeMarketSnapshot,
  releaseMarketRefresh,
  type TastytradeMarketQuoteRecord,
} from './tastytrade-market-store'
import { CallerVisibleError } from './caller-visible-error'

export const USER_AGENT = 'Spice/0.1'
/**
 * The symbols one tastytrade request names. tastytrade's market-data endpoint documents a
 * combined limit of 100 symbols per request, and every symbol-listing read here — metrics,
 * quotes, the equity instruments catalog — pages by this one figure. It is deliberately
 * independent of how long the watchlist grows: the list is paged into requests, never sent as
 * one URL. D1 persistence does not borrow it; storage chunks by `d1-limits`.
 */
export const BROKER_SYMBOL_CHUNK_SIZE = 100
/**
 * How long one tastytrade request may take before it is abandoned. A named budget, the owner's
 * judgment rather than a provider figure: long enough for tastytrade's slowest ordinary read, and
 * short enough that one hung request ends well inside the public refresh claim
 * (`REFRESH_LEASE_MS`, 30 s), which assumes a slow provider answers within its lease.
 */
export const TASTYTRADE_REQUEST_TIMEOUT_MS = 20_000
// This store holds only the Worker's market-data token, as a settled value: the shared client
// keeps a pending refresh to itself. A per-request account token is never stored, because this
// module state is shared by every isolate user.
const marketTokens = memoryTokenStore()

export function apiBase(env: AppEnv) {
  return env.TASTYTRADE_API_BASE || 'https://api.tastyworks.com'
}

function safeEndpoint(path: string): string {
  return path.split('?')[0]!.replace(/\/accounts\/[^/]+/g, '/accounts/[redacted]')
}

type BrokerRequestGate = ReturnType<NonNullable<AppEnv['BROKER_GATE']>['getByName']>

type BrokerMutationLease = {
  renew(): Promise<void>
}

/** The account's mutation lease lapsed before the next broker step, so nothing further was sent. */
class BrokerMutationLeaseExpiredError extends CallerVisibleError {
  constructor() {
    super('BrokerMutationLeaseExpired')
    this.name = 'BrokerMutationLeaseExpiredError'
  }
}

function requestGate(env: AppEnv, accountNumber?: string): BrokerRequestGate {
  // Broker coordination is part of the provider safety boundary. Validate the
  // binding before reading credentials so a misbound deployment cannot silently
  // bypass request throttling.
  const namespace = env.BROKER_GATE
  if (!namespace) throw new CallerVisibleError('TastytradeCoordinatorUnavailable')
  // A rate budget belongs to one broker account, so two members' account work must not
  // share a gate. Market requests and initial account discovery have no account number.
  return namespace.getByName(accountNumber ? `tastytrade:${accountNumber}` : 'tastytrade:market')
}

/**
 * Serialize one broker read-modify-write sequence across Worker isolates. Renewals
 * are explicit so callers can prove the durable lease is still theirs immediately
 * before each broker mutation. A failed cleanup must not obscure an accepted or
 * ambiguous broker result; the persisted lease expires on its own as a backstop.
 */
export async function withBrokerMutationLease<T>(
  env: AppEnv,
  accountNumber: string,
  operation: (lease: BrokerMutationLease) => Promise<T>,
): Promise<T> {
  if (!accountNumber) throw new CallerVisibleError('TastytradeAccount:invalid-account-number')
  const gate = requestGate(env, accountNumber)
  const token = await gate.acquireMutation()
  try {
    return await operation({
      renew: async () => {
        if (!await gate.renewMutation(token)) throw new BrokerMutationLeaseExpiredError()
      },
    })
  } finally {
    try {
      await gate.releaseMutation(token)
    } catch {
      console.error('BrokerMutationLeaseReleaseFailed')
    }
  }
}

function isAccountPath(path: string): boolean {
  return path.startsWith('/accounts/') || path.startsWith('/customers/')
}

function accountNumberFromPath(path: string): string | undefined {
  if (!path.startsWith('/accounts/')) return undefined
  const encoded = path.slice('/accounts/'.length).split(/[/?]/, 1)[0]
  if (!encoded) throw new CallerVisibleError('TastytradeAccount:invalid-path-account')
  try {
    const accountNumber = decodeURIComponent(encoded)
    if (!accountNumber) throw new CallerVisibleError('TastytradeAccount:invalid-path-account')
    return accountNumber
  } catch {
    throw new CallerVisibleError('TastytradeAccount:invalid-path-account')
  }
}

/**
 * A client for one request's lane. An account path spends the caller's credential and nothing
 * else: the shared client neither refreshes nor retries a caller-minted token. Every other path
 * spends the Worker's own grant, whose secrets are read only when a token has to be minted.
 */
function laneClient(env: AppEnv, memberToken: string | undefined, gate: BrokerRequestGate) {
  const common = {
    apiBase: apiBase(env),
    gate: { acquire: () => gate.acquire() },
    timeoutMs: TASTYTRADE_REQUEST_TIMEOUT_MS,
    userAgent: USER_AGENT,
  }
  if (memberToken !== undefined) return createTastytradeClient({ ...common, accessToken: memberToken })
  return createTastytradeClient({
    ...common,
    clientSecret: () => readStoredSecret(env.TASTYTRADE_CLIENT_SECRET, 'TASTYTRADE_CLIENT_SECRET'),
    refreshToken: () => readStoredSecret(env.TASTYTRADE_REFRESH_TOKEN, 'TASTYTRADE_REFRESH_TOKEN'),
    tokenStore: marketTokens,
  })
}

function accountToken(credential: BrokerCredential | undefined): string {
  if (credential?.broker !== 'tastytrade' || !credential.accessToken.trim()) throw new BrokerCredentialMissingError()
  return credential.accessToken
}

/**
 * Restates a shared-client failure in this repository's vocabulary. No provider text crosses:
 * an API refusal keeps only its status and the redacted endpoint, and anything the broker may
 * still have acted on (a 5xx, a timeout, no response) is named ambiguous, which is what makes
 * mutation callers quarantine rather than retry.
 */
function restated(error: Error | undefined, path: string): Error {
  const endpoint = safeEndpoint(path)
  const named = (message: string, name: string) => Object.assign(new Error(message), { name })
  // An unanswered mutation arrives wrapped; its status, when the broker sent one, is kept.
  const apiError = error instanceof TastytradeOutcomeUnknownError ? error.cause : error
  if (apiError instanceof TastytradeApiError) {
    const ambiguous = apiError.ambiguous || error instanceof TastytradeOutcomeUnknownError
    return named(`TastytradeApi:${apiError.status}:${endpoint}`, ambiguous ? 'TastytradeApiAmbiguousError' : 'TastytradeApiError')
  }
  if (error instanceof TastytradeAuthError) {
    if (error.reason === 'missing-token') return new CallerVisibleError('TastytradeAuth:missing-token')
    if (error.reason === 'invalid-lifetime') return new CallerVisibleError('TastytradeAuth:invalid-token-lifetime')
    return new Error(`TastytradeAuth:${error.status ?? 'no-response'}`)
  }
  // No response, a body that could not be read, or anything else: the broker may have acted, so
  // a mutation caller must quarantine rather than read this as a refusal.
  const reason = error instanceof TastytradeOutcomeUnknownError || error instanceof TastytradeTransportError
    ? 'no-response'
    : 'unreadable-response'
  return named(`TastytradeApi:${reason}:${endpoint}`, 'TastytradeApiAmbiguousError')
}

type TastyRequestInit = Pick<RequestOptions, 'body' | 'method' | 'signal'>

export async function tastyRequest(
  env: AppEnv,
  path: string,
  init: TastyRequestInit = {},
  credential?: BrokerCredential,
): Promise<JsonValue> {
  // Account credentials are checked before any platform or network I/O. Market requests
  // retain the coordinator-first failure order before stored secrets are read.
  const memberToken = isAccountPath(path) ? accountToken(credential) : undefined
  const gate = requestGate(env, accountNumberFromPath(path))
  try {
    return await laneClient(env, memberToken, gate).request(path, { ...init, raw: true })
  } catch (cause) {
    throw restated(toError(cause), path)
  }
}

async function resolveAccountNumber(
  env: AppEnv,
  credential: BrokerCredential | undefined,
): Promise<string> {
  const payload = await tastyRequest(env, '/customers/me/accounts', {}, credential)
  const accounts = envelopeRows(payload)
  if (!accounts) throw new CallerVisibleError('TastytradeAccount:invalid-accounts')
  if (accounts.length !== 1) throw new CallerVisibleError('TastytradeAccount:explicit-account-required')
  const row = jsonObject(accounts[0])
  if (!row) throw new CallerVisibleError('TastytradeAccount:invalid-account')
  const account = jsonObject(row.account ?? row)
  if (!account) throw new CallerVisibleError('TastytradeAccount:invalid-account')
  const accountNumber = jsonText(account['account-number'])
  if (!accountNumber) throw new CallerVisibleError('TastytradeAccount:not-found')
  return accountNumber
}

async function loadQuoteToken(env: AppEnv): Promise<{ token: string; url: string }> {
  const data = jsonObjectOrEmpty(jsonObjectOrEmpty(await tastyRequest(env, '/api-quote-tokens')).data)
  const token = jsonText(data.token)
  const url = jsonText(data['dxlink-url'])
  if (!token || !url || !url.startsWith('wss://')) throw new CallerVisibleError('TastytradeQuoteToken:invalid')
  return { token, url }
}

/** Both audiences read the same brief; a missing store is a fault, never an empty brief. */
async function loadStoredBrief(env: AppEnv): Promise<MarketSnapshot['brief']> {
  if (!env.DB) throw new CallerVisibleError('DailyBrief:store-unavailable')
  return readLatestDailyBrief(env.DB)
}

/** Both market reads name every symbol in the query string, so a long watchlist is
 *  fetched in request-sized chunks rather than in one URL the provider would reject. */
async function loadMarketRows(
  env: AppEnv,
  symbols: readonly string[],
): Promise<{ metrics: JsonObject[]; quotes: JsonObject[] }> {
  const metrics: JsonObject[] = []
  const quotes: JsonObject[] = []
  for (let start = 0; start < symbols.length; start += BROKER_SYMBOL_CHUNK_SIZE) {
    const chunk = symbols.slice(start, start + BROKER_SYMBOL_CHUNK_SIZE)
    const metricQuery = chunk.map(encodeURIComponent).join(',')
    const marketDataQuery = chunk.map((symbol) => `equity=${encodeURIComponent(symbol)}`).join('&')
    const [metricsPayload, marketDataPayload] = await Promise.all([
      tastyRequest(env, `/market-metrics?symbols=${metricQuery}`),
      tastyRequest(env, `/market-data/by-type?${marketDataQuery}`),
    ])
    metrics.push(...strictTastytradeRows(metricsPayload, 'TastytradeMetrics'))
    quotes.push(...strictTastytradeRows(marketDataPayload, 'TastytradeMarketData'))
  }
  return { metrics, quotes }
}

async function readOptionalYearCandles(
  env: AppEnv,
  symbols: readonly string[],
): Promise<Map<string, number>> {
  if (!env.DB) return new Map()
  try {
    return await readYearAgoCloses(env.DB, symbols)
  } catch (cause) {
    // The missing chart is visible in the response; keep the live price path available while
    // recording only the failure class, never a provider or database body.
    console.error('YearCandleCacheReadFailed', errorName(toError(cause)))
    return new Map()
  }
}

type MarketFacts = Pick<MarketSnapshot, 'catalysts' | 'tickers'>

/** A snapshot build with no symbol answered has nothing to serve, so it fails visibly. */
async function loadMarketFacts(env: AppEnv, symbols: readonly string[]): Promise<MarketFacts> {
  const facts = await loadAnsweredMarketFacts(env, symbols)
  if (!facts) throw new CallerVisibleError('TastytradeSnapshot:empty')
  return facts
}

/**
 * The market facts for `symbols`, or undefined when the provider and catalog answered for none of
 * them. Nothing is persisted in that case. A snapshot treats it as a failure; a single-symbol
 * lookup treats it as "no quote", which is a different answer from "unavailable".
 */
async function loadAnsweredMarketFacts(
  env: AppEnv,
  symbols: readonly string[],
): Promise<MarketFacts | undefined> {
  const [{ metrics, quotes }, instrumentCatalog] = await Promise.all([
    loadMarketRows(env, symbols),
    readInstrumentCatalog(env, symbols),
  ])
  const metricBySymbol = tastytradeRowsByRequestedSymbol(metrics, symbols, 'TastytradeMetrics')
  const quoteBySymbol = tastytradeRowsByRequestedSymbol(quotes, symbols, 'TastytradeMarketData')
  const normalized = symbols.flatMap((symbol) => {
    const metricsRow = metricBySymbol.get(symbol)
    const quoteRow = quoteBySymbol.get(symbol)
    const instrument = instrumentCatalog.get(symbol)
    if (!metricsRow || !quoteRow || !instrument) return []
    return [normalizeTastytradeMarketTicker(symbol, metricsRow, quoteRow, catalogTickerInstrument(instrument))]
  })
  // A symbol the provider or catalog could not answer for is left out of this build and keeps
  // its previous stored row. That is the product's best-effort contract, so the drop is counted
  // rather than hidden: a name that never normalizes shows up here long before a reader notices.
  if (normalized.length < symbols.length) {
    console.warn('MarketSymbolsDropped', symbols.length - normalized.length)
  }
  if (!normalized.length) return undefined
  // Read-only: the year series is refreshed on the schedule, so a symbol the refresh has not
  // reached yet simply carries no year chart rather than delaying the whole market read.
  const yearCandles = await readOptionalYearCandles(env, symbols)
  for (const item of normalized) {
    const cached = yearCandles.get(item.ticker.symbol)
    if (cached !== undefined) item.ticker.yearAgoClose = cached
  }
  // Only a symbol whose metrics row arrived can retire its stored earnings date; the rest keep
  // their previous row, the same as their ticker does.
  const catalysts = await persistAndLoadCatalysts(
    env,
    catalystsFromMarketMetrics(metrics),
    { answered: symbols.filter((symbol) => metricBySymbol.has(symbol)), requested: symbols },
  )
  await persistTastytradeMarketSnapshot(env, {
    metrics: normalized.map((item) => item.metricRecord),
    quotes: normalized.map((item) => item.quoteRecord),
  })
  return {
    tickers: normalized.map((item) => item.ticker),
    catalysts,
  }
}

function equityInstrumentPath(symbols: readonly string[]): string {
  const query = symbols.map((symbol) => `symbol[]=${encodeURIComponent(symbol)}`).join('&')
  return `/instruments/equities?per-page=${symbols.length}&${query}`
}

async function loadTastytradeInstrumentCatalog(
  env: AppEnv,
  symbols: readonly string[],
  now: Date,
) {
  return loadInstrumentCatalog(
    symbols,
    (chunk) => tastyRequest(env, equityInstrumentPath(chunk)),
    BROKER_SYMBOL_CHUNK_SIZE,
    now,
  )
}

/** A catalog load's resolved rows, and an unresolved placeholder for every symbol it missed. */
async function persistLoadedCatalog(
  env: AppEnv,
  loaded: Awaited<ReturnType<typeof loadTastytradeInstrumentCatalog>>,
  now: Date,
): Promise<void> {
  await persistInstrumentCatalog(env, [
    ...loaded.items,
    ...loaded.missingSymbols.map((symbol) => unresolvedInstrumentCatalogItem(symbol, now)),
  ])
}

/** The one list a public snapshot carries, and the one the owner's own snapshot carries. */
function publicOptionsWatch(symbols: string[]): Watchlist {
  return { id: 'public-options-watch', kind: 'public', name: 'Options Watch', symbols }
}

function ownerWatchlist(symbols: string[]): Watchlist {
  return { id: 'watchlist', kind: 'private', name: 'Watchlist', symbols }
}

export async function refreshTastytradeInstrumentCatalog(
  env: AppEnv,
  symbols: readonly string[],
  now = new Date(),
): Promise<InstrumentCatalogRefresh> {
  const result = await loadTastytradeInstrumentCatalog(env, symbols, now)
  await persistLoadedCatalog(env, result, now)
  return {
    missingSymbols: result.missingSymbols,
    receivedCount: result.items.length,
    requestedCount: result.requestedCount,
  }
}

type InternalInstrumentCatalogChunkRefresh = InstrumentCatalogRefresh & {
  complete: boolean
  nextOffset: number
  totalCount: number
}

async function internalInstrumentCatalogChunk(
  env: AppEnv,
  offset: number,
  now: Date,
  persist: boolean,
): Promise<InternalInstrumentCatalogChunkRefresh> {
  if (!Number.isSafeInteger(offset) || offset < 0) throw new CallerVisibleError('InstrumentCatalog:invalid-offset')
  const symbols = await readInternalWatchlistCatalogCandidates(env)
  if (offset > symbols.length) throw new CallerVisibleError('InstrumentCatalog:invalid-offset')
  const chunk = symbols.slice(offset, offset + BROKER_SYMBOL_CHUNK_SIZE)
  const loaded = await loadTastytradeInstrumentCatalog(env, chunk, now)
  if (persist) await persistLoadedCatalog(env, loaded, now)
  const nextOffset = Math.min(symbols.length, offset + chunk.length)
  return {
    complete: nextOffset >= symbols.length,
    missingSymbols: loaded.missingSymbols,
    nextOffset,
    receivedCount: loaded.items.length,
    requestedCount: loaded.requestedCount,
    totalCount: symbols.length,
  }
}

export async function previewInternalInstrumentCatalogChunkFromTastytrade(
  env: AppEnv,
  offset: number,
  now = new Date(),
): Promise<InternalInstrumentCatalogChunkRefresh> {
  return internalInstrumentCatalogChunk(env, offset, now, false)
}

/** One bounded ops chunk stays below D1's per-invocation query limit. */
export async function refreshInternalInstrumentCatalogChunkFromTastytrade(
  env: AppEnv,
  offset: number,
  now = new Date(),
): Promise<InternalInstrumentCatalogChunkRefresh> {
  return internalInstrumentCatalogChunk(env, offset, now, true)
}

async function refreshMissingTastytradeInstruments(env: AppEnv, symbols: readonly string[]): Promise<void> {
  const now = new Date()
  const missing = await missingInstrumentCatalogSymbols(env, symbols, now)
  if (missing.length) await refreshTastytradeInstrumentCatalog(env, missing, now)
}

async function loadMarketSnapshot(env: AppEnv): Promise<MarketSnapshot> {
  const sessionPayload = await tastyRequest(env, '/market-time/equities/sessions/current')
  // Held names reach the watchlist through the trade-intent write at placement; snapshots no
  // longer read positions. Every write to the list already holds it to its cap in the same
  // batch, so this path only reads the focus. The one publish of the public universe is below,
  // after the build succeeds.
  const symbols = await readInternalWatchlistFocus(env)
  const watchlists = [ownerWatchlist(symbols)]
  // New owner and agent symbols get an authoritative name immediately; an unresolved row is put
  // to the broker again by the first snapshot after `UNRESOLVED_INSTRUMENT_RETRY_MS` lapses.
  await refreshMissingTastytradeInstruments(env, symbols)
  const { catalysts, tickers } = await loadMarketFacts(env, symbols)
  const session = await cacheProviderSession(env, sessionPayload)

  const syncedAt = new Date().toISOString()
  const snapshot = MarketSnapshotSchema.parse({
    source: 'tastytrade',
    syncedAt,
    ...session,
    watchlists,
    tickers,
    catalysts,
    brief: await loadStoredBrief(env),
  })
  await publishInternalWatchlistUniverse(env, new Date(syncedAt))
  return snapshot
}

/**
 * Resolve a symbol the loaded watchlist does not carry yet: the instrument catalog
 * answers first, an unknown ticker is put to the broker once, and whatever resolves and
 * quotes is admitted to the maintained list so the row keeps arriving with every later
 * snapshot. Account-free like the public snapshot around it.
 *
 * The quote is read before the admission. A resolved instrument the provider will not quote
 * is answered as not found -- the honest answer for "no quote" -- and is not added, since a
 * list entry nothing can price would only be dropped from every later build.
 */
async function lookupPublicMarketSymbol(
  env: AppEnv,
  query: string,
): Promise<PublicSymbolLookup | undefined> {
  const symbol = await resolveSearchedSymbol(env, query)
  if (!symbol) return undefined
  const facts = await loadAnsweredMarketFacts(env, [symbol])
  const ticker = facts?.tickers[0]
  if (!facts || !ticker) return undefined
  const retained = await ensureInternalWatchlistSymbols(env, [symbol], 'visitor-search')
  return {
    catalysts: facts.catalysts,
    ticker: publicTickerFromTicker(ticker),
    watchlisted: retained.includes(symbol),
  }
}

/**
 * The catalog's answer to a search. A ticker-shaped query is answered only by that exact ticker;
 * a name query takes the catalog's best match.
 */
async function catalogSymbolForQuery(
  env: AppEnv,
  query: string,
): Promise<{ candidate: string | undefined; symbol: string | undefined }> {
  const candidate = symbolCandidate(query)
  const [match] = await searchInstrumentCatalog(env, candidate ?? query, 1)
  // A stored fuzzy match cannot establish that an unchecked exact ticker is absent.
  if (candidate && match?.symbol !== candidate) return { candidate, symbol: undefined }
  return { candidate, symbol: match?.symbol }
}

/**
 * The same lookup, answered from the store. Every successful live lookup persists its symbol
 * through `loadAnsweredMarketFacts`, so a symbol anyone has already searched can be served again
 * without a provider call.
 */
async function lookupStoredMarketSymbol(
  env: AppEnv,
  query: string,
): Promise<PublicSymbolLookup | undefined> {
  if (!env.DB) return undefined
  const { symbol } = await catalogSymbolForQuery(env, query)
  if (!symbol) return undefined
  const [records, catalog, yearCandles, catalysts] = await Promise.all([
    readStoredMarketRecords(env, [symbol]),
    readInstrumentCatalog(env, [symbol]),
    readYearAgoCloses(env.DB, [symbol]),
    readUpcomingCatalystsForSymbol(env, symbol),
  ])
  const quote = records.quotes.get(symbol)
  if (!quote) return undefined
  const ticker = tickerFromStoredRecords(
    symbol,
    records.metrics.get(symbol),
    quote,
    catalogTickerInstrument(catalog.get(symbol)),
    yearCandles.get(symbol),
  )
  return {
    catalysts,
    ticker: publicTickerFromTicker(ticker),
    // A stored answer says nothing about maintained-list membership, which only the live
    // lookup decides; claiming otherwise would tell the reader their search was retained.
    watchlisted: false,
  }
}

async function resolveSearchedSymbol(env: AppEnv, query: string): Promise<string | undefined> {
  const { candidate, symbol } = await catalogSymbolForQuery(env, query)
  if (symbol || !candidate) return symbol
  // A ticker-shaped query the catalog does not hold exactly is resolved against the broker, then
  // re-read under the same exact-match rule: a prefix or name match never stands in for it.
  await refreshMissingTastytradeInstruments(env, [candidate])
  const { symbol: resolved } = await catalogSymbolForQuery(env, candidate)
  return resolved
}

/**
 * Account-free public surface. Its read-only watchlist universe is published by owner/server sync;
 * this path never calls account, position, or private-watchlist endpoints.
 */
export async function loadPublicMarketSnapshot(
  env: AppEnv,
): Promise<PublicMarketSnapshot> {
  const storedUniverse = await loadStoredPublicMarketUniverse(env)
  const publicSymbols = [...new Set(storedUniverse.symbols)]
  const [sessionResult, marketFacts] = await Promise.all([
    tastyRequest(env, '/market-time/equities/sessions/current'),
    loadMarketFacts(env, publicSymbols),
  ])
  const syncedAt = new Date().toISOString()
  const session = await cacheProviderSession(env, sessionResult)
  const watchlists = [publicOptionsWatch(storedUniverse.symbols)]
  return PublicMarketSnapshotSchema.parse({
    source: 'tastytrade',
    syncedAt,
    ...session,
    watchlists,
    tickers: marketFacts.tickers.map(publicTickerFromTicker),
    catalysts: marketFacts.catalysts,
    brief: await loadStoredBrief(env),
  })
}

/** Session only: overnight `after` becomes `pre` without rebuilding quotes. */
async function refreshPublicMarketSession(
  env: AppEnv,
  snapshot: PublicMarketSnapshot,
): Promise<PublicMarketSnapshot> {
  const payload = await tastyRequest(env, '/market-time/equities/sessions/current')
  return { ...snapshot, ...await cacheProviderSession(env, payload) }
}

/**
 * Caching the session is best-effort: it is a read optimization for later visitors, never a
 * reason to fail the live build that already has the answer in hand.
 */
async function cacheProviderSession(env: AppEnv, payload: JsonValue) {
  const now = new Date()
  const session = {
    marketClosesAt: marketClosesAtFromTastytradeSession(payload, now),
    marketOpensAt: marketOpensAtFromTastytradeSession(payload, now),
    marketState: marketStateFromTastytradeSession(payload),
  }
  try {
    await persistMarketSession(env, session.marketState, session.marketOpensAt, session.marketClosesAt)
  } catch (error) {
    console.error('MarketSessionCacheWriteFailed', errorName(toError(error)))
  }
  return session
}

/**
 * Everything a stored snapshot is assembled from, for one symbol list. Both audiences read the
 * same tables and build the same rows; only the symbol list, the watchlist descriptor and the
 * schema that parses the result differ, so the stored read model is derived in one place and a
 * fix to it cannot land on one audience and miss the other.
 */
async function storedSnapshotParts(env: AppEnv, symbols: readonly string[]) {
  if (!env.DB || !symbols.length) return undefined
  const [records, catalog, yearCandles, catalysts, session, brief] = await Promise.all([
    readStoredMarketRecords(env, symbols),
    readInstrumentCatalog(env, symbols),
    readYearAgoCloses(env.DB, symbols),
    readUpcomingCatalysts(env, symbols),
    readStoredMarketSession(env),
    loadStoredBrief(env),
  ])
  // A quote is what makes a row renderable; a symbol the store has never seen is left out
  // rather than shown at a price of zero.
  const tickers = symbols
    .map((symbol) => ({ quote: records.quotes.get(symbol), symbol }))
    .filter((entry): entry is { quote: TastytradeMarketQuoteRecord; symbol: string } => Boolean(entry.quote))
    .map(({ quote, symbol }) => tickerFromStoredRecords(
      symbol,
      records.metrics.get(symbol),
      quote,
      catalogTickerInstrument(catalog.get(symbol)),
      yearCandles.get(symbol),
    ))
  if (!tickers.length || !records.observedAt || !records.latestObservedAt) return undefined
  return {
    brief,
    catalysts,
    latestObservedAt: records.latestObservedAt,
    observedAt: records.observedAt,
    sessionFields: {
      marketState: session?.state ?? 'unknown',
      marketOpensAt: session?.opensAt,
      marketClosesAt: session?.closesAt,
    },
    tickers,
  }
}

/**
 * A public snapshot read from the store, with the instant the store was last written for it.
 * The snapshot's own `syncedAt` is the oldest reading, the honest staleness bound a reader sees;
 * `lastWrittenAt` is the newest, which is what says whether the provider was asked lately. It
 * stays beside the snapshot rather than in it, because the snapshot is the public wire contract.
 */
export type StoredPublicMarketSnapshot = {
  lastWrittenAt: string
  snapshot: PublicMarketSnapshot
}

/**
 * Build the public snapshot entirely from the store, so an ordinary visitor never causes a
 * provider request. Absence is returned rather than thrown: a cold store has nothing to serve
 * and the caller falls back to one guarded live build.
 */
async function loadStoredPublicMarketSnapshot(env: AppEnv): Promise<StoredPublicMarketSnapshot | undefined> {
  if (!env.DB) return undefined
  const storedUniverse = await loadStoredPublicMarketUniverse(env)
  const parts = await storedSnapshotParts(env, [...new Set(storedUniverse.symbols)])
  if (!parts) return undefined
  const snapshot = PublicMarketSnapshotSchema.parse({
    source: 'tastytrade',
    syncedAt: parts.observedAt,
    ...parts.sessionFields,
    watchlists: [publicOptionsWatch(storedUniverse.symbols)],
    tickers: parts.tickers.map(publicTickerFromTicker),
    catalysts: parts.catalysts,
    brief: parts.brief,
  })
  return { lastWrittenAt: parts.latestObservedAt, snapshot }
}

/** The owner's default view, served entirely from the market store. */
async function loadStoredMarketSnapshot(env: AppEnv): Promise<MarketSnapshot | undefined> {
  if (!env.DB) return undefined
  const focusSymbols = await readInternalWatchlistFocus(env)
  const parts = await storedSnapshotParts(env, focusSymbols)
  if (!parts) return undefined
  return MarketSnapshotSchema.parse({
    source: 'tastytrade',
    syncedAt: parts.observedAt,
    ...parts.sessionFields,
    watchlists: [ownerWatchlist(focusSymbols)],
    tickers: parts.tickers,
    catalysts: parts.catalysts,
    brief: parts.brief,
  })
}

/**
 * The slice of the Tastytrade API that the rest of the server reaches for. Production
 * code calls it through `brokerApi()` so a test can install a faithful in-memory broker
 * with `setBrokerApi` instead of replacing this module. Each entry is the
 * implementation above, so the contract type cannot drift from the real signatures.
 */
const brokerApiSeam = defineSeam(() => ({
  loadMarketSnapshot,
  loadPublicMarketSnapshot,
  claimMarketRefresh,
  loadStoredMarketSnapshot,
  loadStoredPublicMarketSnapshot,
  lookupPublicMarketSymbol,
  lookupStoredMarketSymbol,
  loadQuoteToken,
  refreshPublicMarketSession,
  releaseMarketRefresh,
  resolveAccountNumber,
  tastyRequest,
  withBrokerMutationLease,
}))

export type BrokerApi = SeamValue<typeof brokerApiSeam>

export const brokerApi = brokerApiSeam.current

export const setBrokerApi = brokerApiSeam.set

export const resetBrokerApi = brokerApiSeam.reset
