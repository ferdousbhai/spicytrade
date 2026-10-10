import { type AgentTool } from '../domain/agent-tool'
import { BROKER_SYMBOL_MAX_LENGTH } from '../domain/broker'
import { EQUITY_SYMBOL_REGEX, MAX_EQUITY_SYMBOL_LENGTH } from '../domain/instrument'

import { type AppEnv } from './env'
import {
  ACCOUNT_SNAPSHOT_PARTS,
  AccountHistoryReadParameters,
  AccountSnapshotReadParameters,
  DEFAULT_HISTORY_ITEMS,
  DEFAULT_ORDER_HISTORY_DAYS,
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_TRANSACTION_HISTORY_DAYS,
  InstrumentQuoteReadParameters,
  MAX_CHAIN_ROWS,
  MAX_HISTORY_ITEMS,
  MAX_MARKET_SYMBOLS,
  MAX_OPTION_CONTRACTS,
  MAX_OPTION_EXPIRATIONS,
  MAX_QUOTE_INSTRUMENTS,
  MAX_SEARCH_RESULTS,
  MAX_SEARCH_ROWS,
  MarketMetricsReadParameters,
  OptionContractFindParameters,
  isSymbolSearchQuery,
  SymbolSearchParameters,
  SymbolSearchQueryError,
  UNDERLYING_SYMBOL,
  type AccountHistoryReadResult,
  type AccountHistoryReadInput,
  type AccountSnapshotPart,
  type AccountSnapshotReadInput,
  type AccountSnapshotReadResult,
  type CompactMarketMetric,
  type CompactOptionContract,
  type InstrumentQuoteReadResult,
  type InstrumentQuoteReadInput,
  type MarketMetricsReadResult,
  type OptionContractFindResult,
  type OptionContractFindInput,
  type SymbolSearchItem,
  type SymbolSearchResult,
} from './brokerage-read-contracts'
import { jsonObject, type JsonObject } from '../domain/json-payload'
import { isValidIsoDate } from '../domain/iso-date'
import { distinctTuples } from '../domain/equity-option'
import {
  invalidResponse,
  itemEnvelope,
  optionalBoolean,
  optionalDate,
  optionalNumber,
  optionalPercentPoints,
  optionalRatioPercent,
  optionalText,
  optionalTimestamp,
  requiredText,
  requiredTimestamp,
} from './brokerage-read-normalization'
import { resolveEquityOptionTuples } from './option-contract'
import { textResult } from './agent-tool-result'
import { BROKER_SYMBOL_CHUNK_SIZE, brokerApi } from './tastytrade'
import {
  brokerAdapterFor,
  BrokerSnapshotError,
  describeSnapshotError,
  type BrokerHistoryQuery,
} from './brokers'
import { loadBrokerageContext } from './brokerage-context'
import { type BrokerCredential } from './broker-credential'
import { boundedInteger, CallerVisibleError } from './caller-visible-error'
import { FIND_OPTION_CONTRACTS_MODES } from './doctrine'
import { tickerSymbolArgument, tickerSymbolsArgument } from './ticker-arguments'

function dateDaysAgo(now: Date, days: number): string {
  const result = new Date(now)
  result.setUTCDate(result.getUTCDate() - days)
  if (!Number.isFinite(result.getTime())) throw new CallerVisibleError('Account history days is invalid.')
  return result.toISOString().slice(0, 10)
}

function requestedSnapshotParts(include: AccountSnapshotReadInput['include']): readonly AccountSnapshotPart[] {
  if (include === undefined) return ACCOUNT_SNAPSHOT_PARTS
  const unique = new Set(include)
  if (unique.size !== include.length
    || include.length < 1
    || include.length > ACCOUNT_SNAPSHOT_PARTS.length
    || include.some((part) => !ACCOUNT_SNAPSHOT_PARTS.includes(part))) {
    throw new CallerVisibleError('Account snapshot include is invalid.')
  }
  return include
}

/**
 * The current account as the agent used to receive it automatically: balances, positions, and
 * working orders, with no account identity. The broker read is always the complete snapshot —
 * a subset in `include` only changes what is returned, because a partial broker page is not
 * the same fact as a completeness-checked account.
 */
export async function readAccountSnapshot(
  env: AppEnv,
  input: AccountSnapshotReadInput,
  credential: BrokerCredential | undefined,
): Promise<AccountSnapshotReadResult> {
  const parts = requestedSnapshotParts(input.include)
  let context
  try {
    context = await loadBrokerageContext(env, credential)
  } catch (error) {
    // Account resolution and the adapter already speak to the caller in this repository's words
    // (a missing credential, an unknown broker, more than one account); those pass as they are,
    // exactly as they do through `readAccountHistory`, rather than collapsing into "could not load".
    if (error instanceof CallerVisibleError) throw error
    if (error instanceof BrokerSnapshotError) throw new CallerVisibleError(describeSnapshotError(error, 'The account snapshot'))
    throw new CallerVisibleError('The account snapshot could not be loaded.')
  }
  const result: AccountSnapshotReadResult = { asOf: context.asOf, source: context.source }
  if (parts.includes('balances')) result.balances = context.balances
  if (parts.includes('positions')) result.positions = context.positions
  if (parts.includes('orders')) result.orders = context.orders
  return result
}

/** Read one bounded broker page and strip account identifiers before returning it to the model. */
export async function readAccountHistory(
  env: AppEnv,
  input: AccountHistoryReadInput,
  credential: BrokerCredential | undefined,
  now = new Date(),
): Promise<AccountHistoryReadResult> {
  if (input.type !== 'orders' && input.type !== 'transactions') throw new CallerVisibleError('Account history type is invalid.')
  if (input.type === 'orders' && input.transactionType !== undefined) {
    throw new CallerVisibleError('transactionType is valid only for transaction history.')
  }
  const defaultDays = input.type === 'transactions' ? DEFAULT_TRANSACTION_HISTORY_DAYS : DEFAULT_ORDER_HISTORY_DAYS
  const days = boundedInteger(input.days, defaultDays, 0, Number.MAX_SAFE_INTEGER, 'Account history days')
  const limit = boundedInteger(input.limit, DEFAULT_HISTORY_ITEMS, 1, MAX_HISTORY_ITEMS, 'Account history limit')
  const pageOffset = boundedInteger(input.pageOffset, 0, 0, Number.MAX_SAFE_INTEGER, 'Account history page offset')
  const underlyingSymbol = input.underlyingSymbol?.trim().toUpperCase()
  if (underlyingSymbol && !UNDERLYING_SYMBOL.test(underlyingSymbol)) throw new CallerVisibleError('Account history underlying symbol is invalid.')
  if (input.transactionType !== undefined && input.transactionType !== 'Trade' && input.transactionType !== 'Money Movement') {
    throw new CallerVisibleError('Account history transaction type is invalid.')
  }

  const adapter = brokerAdapterFor(credential)
  const ref = await adapter.resolveAccountRef(env, credential)
  const query: BrokerHistoryQuery = {
    limit,
    pageOffset,
    startDate: dateDaysAgo(now, days),
    type: input.type,
  }
  if (input.transactionType) query.transactionType = input.transactionType
  if (underlyingSymbol) query.underlyingSymbol = underlyingSymbol
  const page = await adapter.readAccountHistory(env, ref, query, credential)
  const items = page.items.slice(0, limit)
  const consumed = pageOffset * limit + items.length
  // Truncation stays observable: a page the broker filled exactly, or one whose reported
  // total is still ahead of what the reader has consumed, is short rather than complete.
  const truncated = page.rowCount > limit
    || (page.totalItemCount === undefined ? page.rowCount === limit : consumed < page.totalItemCount)
  const result: AccountHistoryReadResult = {
    asOf: now.toISOString(),
    items,
    pageOffset,
    truncated,
    source: ref.broker,
  }
  if (page.totalItemCount !== undefined) result.totalItemCount = page.totalItemCount
  return result
}

// tastytrade writes a zero capitalization for instruments it publishes none for (ETFs,
// indices), so a zero is an unreported reading rather than a zero-dollar issuer.
function optionalCapitalization(row: JsonObject, label: string): number | undefined {
  const reported = optionalNumber(row, ['market-cap'], label)
  return reported === 0 ? undefined : reported
}

function compactMetric(row: JsonObject): CompactMarketMetric {
  const label = 'Tastytrade market metrics'
  const symbol = requiredText(row, ['symbol'], label, MAX_EQUITY_SYMBOL_LENGTH).toUpperCase()
  if (!EQUITY_SYMBOL_REGEX.test(symbol)) return invalidResponse(label)
  const rawEarnings = row.earnings
  let earnings: JsonObject | undefined
  if (rawEarnings !== undefined && rawEarnings !== null) earnings = jsonObject(rawEarnings) ?? invalidResponse(label)
  return {
    beta: optionalNumber(row, ['beta'], label),
    earningsDate: earnings ? optionalDate(earnings, ['expected-report-date'], label) : undefined,
    earningsEstimated: earnings ? optionalBoolean(earnings, ['estimated'], label) : undefined,
    earningsPerShare: optionalNumber(row, ['earnings-per-share'], label),
    earningsTimeOfDay: earnings ? optionalText(earnings, ['time-of-day'], label, 32) : undefined,
    historicalVolatility30Day: optionalPercentPoints(row, ['historical-volatility-30-day'], label),
    impliedHistoricalVolatility30DayDifference: optionalPercentPoints(row, ['iv-hv-30-day-difference'], label),
    // tastytrade sends these two as the same number in different units: the index as a ratio
    // (0.2459) and the 30-day as percentage points (24.59). Converting both as ratios inflated
    // the 30-day by 100x, so a reader saw NVDA at 3468 under a `percentage_points` label.
    // `iv-hv-30-day-difference` settles which is which: it equals the 30-day minus
    // `historical-volatility-30-day` only when the 30-day is read as points.
    impliedVolatility30Day: optionalPercentPoints(row, ['implied-volatility-30-day'], label),
    impliedVolatilityIndex: optionalRatioPercent(row, ['implied-volatility-index'], label),
    impliedVolatilityPercentile: optionalRatioPercent(row, ['implied-volatility-percentile'], label),
    impliedVolatilityRank: optionalRatioPercent(row, ['implied-volatility-index-rank', 'implied-volatility-rank'], label),
    liquidityRank: optionalNumber(row, ['liquidity-rank'], label),
    liquidityRating: optionalNumber(row, ['liquidity-rating'], label),
    liquidityValue: optionalNumber(row, ['liquidity-value', 'liquidity'], label),
    marketCap: optionalCapitalization(row, label),
    priceEarningsRatio: optionalNumber(row, ['price-earnings-ratio'], label),
    symbol,
    updatedAt: optionalTimestamp(row, ['updated-at'], label),
  }
}

export async function readMarketMetrics(
  env: AppEnv,
  requestedSymbols: readonly string[],
  now = new Date(),
): Promise<MarketMetricsReadResult> {
  const symbols = [...new Set(requestedSymbols.map((symbol) => symbol.trim().toUpperCase()))]
  if (symbols.length < 1 || symbols.length > MAX_MARKET_SYMBOLS || symbols.some((symbol) => !EQUITY_SYMBOL_REGEX.test(symbol))) {
    throw new CallerVisibleError('Market metric symbols are invalid.')
  }
  const query = symbols.map(encodeURIComponent).join(',')
  const envelope = itemEnvelope(
    await brokerApi().tastyRequest(env, `/market-metrics?symbols=${query}`),
    'Tastytrade market metrics',
    MAX_MARKET_SYMBOLS,
  )
  const rows = envelope.rows.map(compactMetric)
  const bySymbol = new Map<string, CompactMarketMetric>()
  for (const metric of rows) {
    if (!symbols.includes(metric.symbol) || bySymbol.has(metric.symbol)) return invalidResponse('Tastytrade market metrics')
    bySymbol.set(metric.symbol, metric)
  }
  return {
    asOf: now.toISOString(),
    metrics: symbols.flatMap((symbol) => bySymbol.get(symbol) ?? []),
    missingSymbols: symbols.filter((symbol) => !bySymbol.has(symbol)),
    source: 'tastytrade',
    volatilityUnit: 'percentage_points',
  }
}

function compactSearchItem(row: JsonObject): SymbolSearchItem {
  const label = 'Tastytrade symbol search'
  return {
    description: requiredText(row, ['description'], label, 200),
    hasOptions: optionalBoolean(row, ['options'], label),
    instrumentType: optionalText(row, ['instrument-type'], label, 64),
    listedMarket: optionalText(row, ['listed-market'], label, 32),
    symbol: requiredText(row, ['symbol'], label, 64),
  }
}

function quoteFromRecord(
  row: JsonObject,
  expectedSymbol: string,
  instrumentType: 'Equity' | 'Equity Option',
  underlying?: string,
) {
  const label = 'Tastytrade market quote'
  const symbol = requiredText(row, ['symbol'], label, BROKER_SYMBOL_MAX_LENGTH)
  const responseType = requiredText(row, ['instrumentType', 'instrument-type'], label, 64)
  if (symbol !== expectedSymbol || responseType !== instrumentType) return invalidResponse(label)
  const bid = optionalNumber(row, ['bid'], label)
  const ask = optionalNumber(row, ['ask'], label)
  const bidSize = optionalNumber(row, ['bidSize', 'bid-size'], label)
  const askSize = optionalNumber(row, ['askSize', 'ask-size'], label)
  const observedAt = requiredTimestamp(row, ['updatedAt', 'updated-at'], label)
  if (bid === undefined || ask === undefined || bid < 0 || ask <= 0 || bid > ask) return invalidResponse(label)
  const quote: InstrumentQuoteReadResult['quotes'][number] = {
    ask,
    bid,
    instrumentType,
    mid: Math.round(((bid + ask) / 2) * 1e6) / 1e6,
    observedAt,
    symbol,
  }
  if (askSize !== undefined) quote.askSize = askSize
  if (bidSize !== undefined) quote.bidSize = bidSize
  if (underlying) quote.underlying = underlying
  return quote
}

/** Resolve human option tuples server-side, then fetch exact bid/ask without accepting arbitrary broker symbols. */
export async function readInstrumentQuotes(
  env: AppEnv,
  input: InstrumentQuoteReadInput,
  now = new Date(),
): Promise<InstrumentQuoteReadResult> {
  const symbols = [...new Set((input.symbols ?? []).map((symbol) => symbol.trim().toUpperCase()))]
  // Two identical tuples resolve to one OCC symbol and one quote row; counted twice they read
  // as a broker that answered short.
  const contracts = distinctTuples(input.contracts ?? [])
  if ((!symbols.length && !contracts.length)
    || symbols.length + contracts.length > MAX_QUOTE_INSTRUMENTS
    || symbols.some((symbol) => !EQUITY_SYMBOL_REGEX.test(symbol))
    || contracts.some((contract) => !EQUITY_SYMBOL_REGEX.test(contract.underlying)
      || !isValidIsoDate(contract.expiry)
      || (contract.optionType !== 'C' && contract.optionType !== 'P')
      || !Number.isFinite(contract.strike)
      || contract.strike <= 0)) {
    throw new CallerVisibleError('Quote instruments are invalid.')
  }
  const resolvedContracts = await resolveEquityOptionTuples(env, contracts)
  const query = [
    ...symbols.map((symbol) => `equity=${encodeURIComponent(symbol)}`),
    ...resolvedContracts.map((contract) => `equity-option=${encodeURIComponent(contract.symbol)}`),
  ].join('&')
  const envelope = itemEnvelope(
    await brokerApi().tastyRequest(env, `/market-data/by-type?${query}`),
    'Tastytrade market quote',
    MAX_QUOTE_INSTRUMENTS,
  )
  const bySymbol = new Map(envelope.rows.map((row) => [requiredText(row, ['symbol'], 'Tastytrade market quote', BROKER_SYMBOL_MAX_LENGTH), row]))
  const requested = [
    ...symbols.map((symbol) => ({ instrumentType: 'Equity' as const, symbol })),
    ...resolvedContracts.map((contract) => ({
      instrumentType: 'Equity Option' as const, symbol: contract.symbol, underlying: contract.underlying,
    })),
  ]
  const quotes = requested.map((instrument) => {
    const row = bySymbol.get(instrument.symbol)
    if (!row) return invalidResponse('Tastytrade market quote')
    return quoteFromRecord(
      row,
      instrument.symbol,
      instrument.instrumentType,
      'underlying' in instrument ? instrument.underlying : undefined,
    )
  })
  if (bySymbol.size !== quotes.length) return invalidResponse('Tastytrade market quote')
  return { asOf: now.toISOString(), quotes, source: 'tastytrade-rest-market-data' }
}

export async function searchSymbols(
  env: AppEnv,
  requestedQuery: string,
  requestedLimit?: number,
  now = new Date(),
): Promise<SymbolSearchResult> {
  const query = requestedQuery.trim()
  if (!isSymbolSearchQuery(query)) throw new SymbolSearchQueryError()
  const limit = boundedInteger(requestedLimit, DEFAULT_SEARCH_RESULTS, 1, MAX_SEARCH_RESULTS, 'Symbol search limit')
  const envelope = itemEnvelope(
    await brokerApi().tastyRequest(env, `/symbols/search/${encodeURIComponent(query)}`),
    'Tastytrade symbol search',
    MAX_SEARCH_ROWS,
  )
  const rows = envelope.rows.map(compactSearchItem)
  const results = rows.slice(0, limit)
  return {
    asOf: now.toISOString(),
    results,
    totalResultCount: rows.length,
    truncated: rows.length > results.length,
    source: 'tastytrade',
  }
}

type ParsedOption = {
  brokerSymbol: string
  expirationDate: string
  isClosingOnly?: boolean
  optionType: 'C' | 'P'
  sharesPerContract: number
  strikePrice: number
}

type OptionActivity = {
  openInterest?: number
  volume?: number
}

function parseActiveStandardOption(row: JsonObject, underlying: string): ParsedOption | undefined {
  const label = 'Tastytrade option chain'
  const instrumentType = requiredText(row, ['instrument-type'], label, 64)
  const rowUnderlying = requiredText(row, ['underlying-symbol'], label, 64).toUpperCase()
  const chainType = requiredText(row, ['option-chain-type'], label, 64)
  const active = optionalBoolean(row, ['active'], label)
  if (active === undefined) return invalidResponse(label)
  if (instrumentType !== 'Equity Option'
    || rowUnderlying !== underlying
    || chainType !== 'Standard'
    || !active) {
    return undefined
  }
  const optionType = requiredText(row, ['option-type'], label, 1)
  if (optionType !== 'C' && optionType !== 'P') return invalidResponse(label)
  const expirationDate = optionalDate(row, ['expiration-date'], label) ?? invalidResponse(label)
  const strikePrice = optionalNumber(row, ['strike-price'], label)
  const sharesPerContract = optionalNumber(row, ['shares-per-contract'], label)
  if (strikePrice === undefined || strikePrice <= 0
    || sharesPerContract === undefined || !Number.isSafeInteger(sharesPerContract) || sharesPerContract <= 0) {
    return invalidResponse(label)
  }
  return {
    brokerSymbol: requiredText(row, ['symbol'], label, BROKER_SYMBOL_MAX_LENGTH),
    expirationDate,
    isClosingOnly: optionalBoolean(row, ['is-closing-only'], label),
    optionType,
    sharesPerContract,
    strikePrice,
  }
}

function optionalCount(row: JsonObject, keys: readonly string[], label: string): number | undefined {
  const value = optionalNumber(row, keys, label)
  if (value === undefined) return undefined
  if (!Number.isSafeInteger(value) || value < 0) return invalidResponse(label)
  return value
}

/** Higher counts first; a missing reading sorts after a present one, including zero. */
function compareCountDesc(left?: number, right?: number): number {
  if (left === undefined && right === undefined) return 0
  if (left === undefined) return 1
  if (right === undefined) return -1
  return right - left
}

function publishedContract(contract: ParsedOption, activity: OptionActivity | undefined): CompactOptionContract {
  const published: CompactOptionContract = {
    expirationDate: contract.expirationDate,
    optionType: contract.optionType,
    sharesPerContract: contract.sharesPerContract,
    strikePrice: contract.strikePrice,
  }
  if (contract.isClosingOnly !== undefined) published.isClosingOnly = contract.isClosingOnly
  if (activity?.openInterest !== undefined) published.openInterest = activity.openInterest
  if (activity?.volume !== undefined) published.volume = activity.volume
  return published
}

async function readOptionActivity(
  env: AppEnv,
  symbols: readonly string[],
): Promise<Map<string, OptionActivity>> {
  const activity = new Map<string, OptionActivity>()
  const label = 'Tastytrade option activity'
  for (let start = 0; start < symbols.length; start += BROKER_SYMBOL_CHUNK_SIZE) {
    const chunk = symbols.slice(start, start + BROKER_SYMBOL_CHUNK_SIZE)
    const query = chunk.map((symbol) => `equity-option=${encodeURIComponent(symbol)}`).join('&')
    const envelope = itemEnvelope(
      await brokerApi().tastyRequest(env, `/market-data/by-type?${query}`),
      label,
      chunk.length,
    )
    const requested = new Set(chunk)
    const seen = new Set<string>()
    for (const row of envelope.rows) {
      const symbol = requiredText(row, ['symbol'], label, BROKER_SYMBOL_MAX_LENGTH)
      if (!requested.has(symbol)) continue
      if (seen.has(symbol) || activity.has(symbol)) return invalidResponse(label)
      seen.add(symbol)
      const openInterest = optionalCount(row, ['open-interest', 'openInterest'], label)
      const volume = optionalCount(row, ['volume', 'day-volume'], label)
      if (openInterest === undefined && volume === undefined) continue
      const stats: OptionActivity = {}
      if (openInterest !== undefined) stats.openInterest = openInterest
      if (volume !== undefined) stats.volume = volume
      activity.set(symbol, stats)
    }
  }
  return activity
}

export async function findOptionContracts(
  env: AppEnv,
  input: OptionContractFindInput,
  now = new Date(),
): Promise<OptionContractFindResult> {
  const underlying = input.underlying.trim().toUpperCase()
  if (!EQUITY_SYMBOL_REGEX.test(underlying)) throw new CallerVisibleError('Option underlying is invalid.')
  if (input.expiry !== undefined && !isValidIsoDate(input.expiry)) throw new CallerVisibleError('Option expiry is invalid.')
  if (input.optionType !== undefined && input.optionType !== 'C' && input.optionType !== 'P') {
    throw new CallerVisibleError('Option type is invalid.')
  }
  if ([input.nearStrike, input.strike].some((strike) => (
    strike !== undefined && (!Number.isFinite(strike) || strike <= 0)
  ))) {
    throw new CallerVisibleError('Option strike is invalid.')
  }
  const envelope = itemEnvelope(
    await brokerApi().tastyRequest(env, `/option-chains/${encodeURIComponent(underlying)}`),
    'Tastytrade option chain',
    MAX_CHAIN_ROWS,
  )
  const activeStandard = envelope.rows.flatMap((row) => {
    const option = parseActiveStandardOption(row, underlying)
    return option ? [option] : []
  })
  const discoverable = activeStandard.filter((contract) => (
    (input.optionType === undefined || contract.optionType === input.optionType)
    && (input.strike === undefined || contract.strikePrice === input.strike)
  ))
  const allExpirationDates = [...new Set(discoverable.map((contract) => contract.expirationDate))].sort()
  const matching = discoverable.filter((contract) => (
    input.expiry === undefined || contract.expirationDate === input.expiry
  ))
  const expirationDates = allExpirationDates.slice(0, MAX_OPTION_EXPIRATIONS)
  const mode = input.expiry === undefined && input.nearStrike === undefined && input.strike === undefined
    ? 'expirations'
    : 'contracts'
  const base = { asOf: now.toISOString(), source: 'tastytrade' as const }
  if (mode === 'expirations') {
    return {
      ...base,
      expirationDates,
      mode,
      truncated: expirationDates.length < allExpirationDates.length,
    }
  }
  const rankedByStrike = [...matching].sort((left, right) => left.expirationDate.localeCompare(right.expirationDate)
    || (input.nearStrike === undefined
      ? 0
      : Math.abs(left.strikePrice - input.nearStrike) - Math.abs(right.strikePrice - input.nearStrike))
    || left.strikePrice - right.strikePrice
    || left.optionType.localeCompare(right.optionType))
  // nearStrike already picked the window; activity is attached to those rows, not used to
  // replace the window with far-away open-interest magnets. An untargeted expiry ranks the
  // whole listed set, then truncates.
  const candidates = input.nearStrike === undefined
    ? rankedByStrike
    : rankedByStrike.slice(0, MAX_OPTION_CONTRACTS)
  const activity = await readOptionActivity(env, candidates.map((contract) => contract.brokerSymbol))
  const contracts = candidates
    .map((contract) => publishedContract(contract, activity.get(contract.brokerSymbol)))
    .sort((left, right) => left.expirationDate.localeCompare(right.expirationDate)
      || (input.nearStrike === undefined
        ? 0
        : Math.abs(left.strikePrice - input.nearStrike) - Math.abs(right.strikePrice - input.nearStrike))
      || compareCountDesc(left.openInterest, right.openInterest)
      || compareCountDesc(left.volume, right.volume)
      || left.strikePrice - right.strikePrice
      || left.optionType.localeCompare(right.optionType))
    .slice(0, MAX_OPTION_CONTRACTS)
  return { ...base, contracts, mode, truncated: contracts.length < matching.length }
}

function createAccountSnapshotReadTool(
  env: AppEnv,
  credential: BrokerCredential | undefined,
): AgentTool<typeof AccountSnapshotReadParameters> {
  return {
    description: 'Current balances, positions, and working orders. Omit include for all three.',
    execute: async (params) => textResult(await readAccountSnapshot(env, params, credential)),
    name: 'read_account_snapshot',
    parameters: AccountSnapshotReadParameters,
  }
}

function createAccountHistoryReadTool(
  env: AppEnv,
  credential: BrokerCredential | undefined,
): AgentTool<typeof AccountHistoryReadParameters> {
  return {
    description: 'Broker trades, cash movements, or orders.',
    execute: async (params) => textResult(await readAccountHistory(env, params, credential)),
    name: 'read_account_history',
    parameters: AccountHistoryReadParameters,
  }
}

export function createMarketMetricsReadTool(
  env: AppEnv,
): AgentTool<typeof MarketMetricsReadParameters> {
  return {
    description: 'IV, liquidity, beta, valuation, and earnings metrics; IV is percentage points.',
    execute: async (params) => textResult(await readMarketMetrics(env, tickerSymbolsArgument(params.symbols))),
    name: 'read_market_metrics',
    parameters: MarketMetricsReadParameters,
  }
}

export function createSymbolSearchTool(
  env: AppEnv,
): AgentTool<typeof SymbolSearchParameters> {
  return {
    description: 'Broker ticker or company-name lookup.',
    execute: async (params) => textResult(await searchSymbols(env, params.query, params.limit)),
    name: 'search_symbols',
    parameters: SymbolSearchParameters,
  }
}

export function createOptionContractFindTool(
  env: AppEnv,
): AgentTool<typeof OptionContractFindParameters> {
  return {
    description: `${FIND_OPTION_CONTRACTS_MODES} Contracts carry open interest and volume. `
      + 'Within an expiration, default order is open interest then volume; nearStrike is nearest '
      + 'listed, strike is exact. Only contracts this tool returns exist; never name one it did '
      + 'not list.',
    execute: async (params) => {
      const underlying = tickerSymbolArgument(params.underlying, 'underlying')
      return textResult(await findOptionContracts(env, { ...params, underlying }))
    },
    name: 'find_option_contracts',
    parameters: OptionContractFindParameters,
  }
}

export function createInstrumentQuoteReadTool(
  env: AppEnv,
): AgentTool<typeof InstrumentQuoteReadParameters> {
  return {
    description: 'Current broker bid/ask/mid for equities or option tuples.',
    execute: async (params) => {
      if (params.symbols === undefined) return textResult(await readInstrumentQuotes(env, params))
      return textResult(await readInstrumentQuotes(env, { ...params, symbols: tickerSymbolsArgument(params.symbols) }))
    },
    name: 'read_instrument_quotes',
    parameters: InstrumentQuoteReadParameters,
  }
}

export function createBrokerageReadTools(env: AppEnv, credential: BrokerCredential | undefined) {
  return [
    createAccountSnapshotReadTool(env, credential),
    createAccountHistoryReadTool(env, credential),
    createSymbolSearchTool(env),
    createMarketMetricsReadTool(env),
    createOptionContractFindTool(env),
    createInstrumentQuoteReadTool(env),
  ]
}
