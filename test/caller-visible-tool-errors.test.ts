import { afterEach, describe, expect, it, vi } from 'vitest'
import { type AppEnv } from '../src/server/env'
import { type FreshOrderPlacement } from '../src/server/agent-contracts'
import { type PriceHistoryProvider } from '../src/server/market-research-contracts'
import { stubBrokerGate } from './broker-stub'

afterEach(() => {
  vi.resetModules()
})

const noStore: AppEnv = {}

const equityOrder: FreshOrderPlacement = {
  action: 'Buy to Open',
  kind: 'place_equity_order',
  limitPrice: 1,
  priceEffect: 'Debit',
  quantity: 1,
  symbol: 'AAPL',
}

const unreachedProvider: PriceHistoryProvider = {
  readDaily: () => Promise.reject(new Error('The provider must not be reached.')),
}

async function thrown(run: () => Promise<void> | void): Promise<Error | undefined> {
  try {
    await run()
  } catch (error) {
    return error instanceof Error ? error : undefined
  }
  throw new Error('expected a throw')
}

/**
 * One representative failure per module whose repo-worded errors were plain `Error`s and so
 * reached a member's agent as a bare name. Each must now reach it with its own message.
 */
const cases: [string, string, () => Promise<void> | void][] = [
  ['order-intent', 'OrderReplacement:order-changed-or-not-editable', async () => {
    const { assertReplaceableOrder } = await import('../src/server/order-intent')
    const { buildOrderPayload } = await import('../src/server/order-payload')
    assertReplaceableOrder({ editable: false, id: '1', rejected: false, terminal: false }, '1', buildOrderPayload(equityOrder, ['AAPL']))
  }],
  ['option-greeks-tool', 'Option expiry is invalid.', async () => {
    const { readExactOptionGreeks } = await import('../src/server/option-greeks-tool')
    await readExactOptionGreeks(noStore, {
      contracts: [{ expiry: '2026-02-30', optionType: 'C', strike: 100, underlying: 'AAPL' }],
    })
  }],
  ['technical-studies', 'Duplicate price studies are not allowed.', async () => {
    const { normalizeStudies } = await import('../src/server/technical-studies')
    normalizeStudies([{ kind: 'SMA', period: 5 }, { kind: 'SMA', period: 5 }])
  }],
  ['brokerage-reconciliation', 'TastytradeReconciliation:store-unavailable', async () => {
    const { unresolvedSubmission } = await import('../src/server/brokerage-reconciliation')
    await unresolvedSubmission(noStore, 'tastytrade', 'ACCOUNT-1')
  }],
  ['tastytrade (mutation lease)', 'BrokerMutationLeaseExpired', async () => {
    const { withBrokerMutationLease } = await import('../src/server/tastytrade')
    const brokerGate = stubBrokerGate()
    brokerGate.gate.renewMutation.mockResolvedValue(false)
    await withBrokerMutationLease({ BROKER_GATE: brokerGate.namespace }, 'ACCOUNT-1', (lease) => lease.renew())
  }],
  ['brokers/tastytrade', 'OrderReplacement:invalid-order', async () => {
    const { tastytradeOrderFromPayload } = await import('../src/server/brokers/tastytrade')
    tastytradeOrderFromPayload({ data: { items: [] } })
  }],
  ['brokers/contract', 'The broker may have received this cancellation, but the result could not be verified.', async () => {
    const { BrokerCancellationAmbiguousError } = await import('../src/server/brokers/contract')
    throw new BrokerCancellationAmbiguousError()
  }],
  ['research-read-tools', 'Catalyst data is unavailable.', async () => {
    const { readCatalysts } = await import('../src/server/research-read-tools')
    await readCatalysts(noStore, ['AAPL'])
  }],
  ['market-research-tools', 'Price history range is invalid.', async () => {
    const { readPriceHistory } = await import('../src/server/market-research-tools')
    await readPriceHistory({ endDate: '2026-01-01', startDate: '2026-02-01', symbol: 'AAPL' }, unreachedProvider)
  }],
  ['research-provider', 'ResearchProvider:yahoo:unavailable', async () => {
    const { ResearchProviderError } = await import('../src/server/research-provider')
    throw new ResearchProviderError('unavailable', 'yahoo')
  }],
  ['brokerage-read-tools', 'transactionType is valid only for transaction history.', async () => {
    const { readAccountHistory } = await import('../src/server/brokerage-read-tools')
    await readAccountHistory(noStore, { transactionType: 'Trade', type: 'orders' }, undefined)
  }],
  ['brokerage-read-normalization', 'Tastytrade market quote returned an invalid response.', async () => {
    const { invalidResponse } = await import('../src/server/brokerage-read-normalization')
    invalidResponse('Tastytrade market quote')
  }],
  ['symbol-evidence-tool', 'SymbolEvidence:page-reading-unavailable', async () => {
    const { recordSymbolEvidence } = await import('../src/server/symbol-evidence-tool')
    await recordSymbolEvidence(noStore, 'user', {})
  }],
  ['catalyst-record-tool', 'CatalystRecord:page-reading-unavailable', async () => {
    const { recordResearchCatalysts } = await import('../src/server/catalyst-record-tool')
    await recordResearchCatalysts(noStore, {})
  }],
  ['catalysts', 'CatalystStoreUnavailable', async () => {
    const { readUpcomingCatalysts } = await import('../src/server/catalysts')
    await readUpcomingCatalysts(noStore, ['NVDA'])
  }],
  ['catalyst-refresh', 'CatalystRunStoreUnavailable', async () => {
    const { refreshCatalystsForSymbol } = await import('../src/server/catalyst-refresh')
    await refreshCatalystsForSymbol(noStore, 'AAPL')
  }],
  ['public-market-universe', 'PublicMarketUniverse:store-unavailable', async () => {
    const { loadStoredPublicMarketUniverse } = await import('../src/server/public-market-universe')
    await loadStoredPublicMarketUniverse(noStore)
  }],
  ['public-market-tools', 'Symbol search is unavailable (HTTP 503).', async () => {
    const { PublicSymbolSearchError } = await import('../src/server/public-market-tools')
    throw new PublicSymbolSearchError(503)
  }],
  ['symbol-search', 'SymbolSearch:store-unavailable', async () => {
    const { searchInstrumentCatalog } = await import('../src/server/symbol-search')
    await searchInstrumentCatalog(noStore, 'apple')
  }],
  ['instrument-catalog', 'InstrumentCatalog:store-unavailable', async () => {
    const { readInstrumentCatalog } = await import('../src/server/instrument-catalog')
    await readInstrumentCatalog(noStore, ['AAPL'])
  }],
  ['internal-watchlist', 'InternalWatchlist:store-unavailable', async () => {
    const { readInternalWatchlist } = await import('../src/server/internal-watchlist')
    await readInternalWatchlist(noStore)
  }],
  ['tastytrade-market-store', 'TastytradeMarketStore:unavailable', async () => {
    const { persistTastytradeMarketSnapshot } = await import('../src/server/tastytrade-market-store')
    await persistTastytradeMarketSnapshot(noStore, { metrics: [], quotes: [] })
  }],
  ['tastytrade-market-normalization', 'TastytradeMarketMetrics:invalid-response', async () => {
    const { strictTastytradeRows } = await import('../src/server/tastytrade-market-normalization')
    strictTastytradeRows({}, 'TastytradeMarketMetrics')
  }],
  ['order-payload', 'OrderPayload:missing-resolved-symbol', async () => {
    const { buildOrderPayload } = await import('../src/server/order-payload')
    buildOrderPayload(equityOrder, [''])
  }],
]

describe('repo-worded tool failures reach the caller', () => {
  it.each(cases)('%s passes its message through toolErrorResult', async (_module, message, run) => {
    const { toolErrorResult } = await import('../src/server/agent-tool-result')
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const error = await thrown(run)
    expect(error?.message).toBe(message)
    expect(toolErrorResult('any_tool', error).content[0]!.text).toBe(message)
    // A caller-visible failure is an answer, not a fault to log.
    expect(logged).not.toHaveBeenCalledWith('McpToolFailed', expect.anything(), expect.anything())
  })
})
