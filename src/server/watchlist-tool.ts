import { type AgentTool } from '../domain/agent-tool'
import { Type } from 'typebox'

import { EQUITY_SYMBOL_PATTERN, EquitySymbolType } from '../domain/instrument'
import { MAX_WATCHLIST_SYMBOLS } from '../domain/watchlist'
import { WatchlistActionParameters, WatchlistActionSchema } from './agent-contracts'
import { executeWatchlistAction } from './watchlist-actions'
import { textResult } from './agent-tool-result'
import { type AppEnv } from './env'
import {
  internalWatchlistWriter,
  readInternalWatchlist,
  readInternalWatchlistSymbolDetails,
  type InternalWatchlistSymbolDetails,
} from './internal-watchlist'
import { loadStoredPublicMarketUniverse } from './public-market-universe'

type WatchlistReadResult =
  | {
    fetchedAt: string
    mode: 'index'
    source: 'spice'
    status: 'ok'
    symbols: string[]
  }
  | {
    fetchedAt: string
    mode: 'detail'
    source: 'spice'
    status: 'not_found'
    symbol: string
  }
  | {
    details: InternalWatchlistSymbolDetails
    fetchedAt: string
    mode: 'detail'
    source: 'spice'
    status: 'ok'
  }

export const WatchlistReadParameters = Type.Object({
  symbol: Type.Optional(Type.String({
    description: 'Omit for the index; provide for retained provenance.',
    pattern: EQUITY_SYMBOL_PATTERN,
  })),
}, { additionalProperties: false })

/** The index alone: no parameter a caller could use to ask for provenance. */
const WatchlistIndexParameters = Type.Object({}, { additionalProperties: false })

// Symbols only, alphabetized, which reveals nothing about which source put a name there or how
// strongly. Provenance and instrument type are the detail mode's.
function indexResult(symbols: string[]): WatchlistReadResult {
  return { fetchedAt: new Date().toISOString(), mode: 'index', source: 'spice', status: 'ok', symbols }
}

/** The owner's index: the maintained list itself, including names held back from readers. */
async function readWatchlistIndex(env: AppEnv): Promise<WatchlistReadResult> {
  return indexResult((await readInternalWatchlist(env)).map((item) => item.symbol))
}

async function readWatchlist(env: AppEnv, symbol?: string): Promise<WatchlistReadResult> {
  if (!symbol) return readWatchlistIndex(env)
  const fetchedAt = new Date().toISOString()
  const details = await readInternalWatchlistSymbolDetails(env, symbol)
  return details
    ? { details, fetchedAt, mode: 'detail', source: 'spice', status: 'ok' }
    : { fetchedAt, mode: 'detail', source: 'spice', status: 'not_found', symbol }
}

/**
 * The owner's read: the index, or one symbol's retained provenance -- its origin and the provider
 * watchlists that seeded it, which are the owner's own account data.
 */
export function createWatchlistReadTool(env: AppEnv): AgentTool<typeof WatchlistReadParameters> {
  return {
    description: 'Private watchlist; optional symbol returns retained provenance.',
    execute: async (params) => textResult(await readWatchlist(env, params.symbol)),
    name: 'read_watchlist',
    parameters: WatchlistReadParameters,
  }
}

/**
 * Everyone else's read, under the same name. Provider watchlist provenance is never public and
 * is not a member's either -- it names the owner's brokerage watchlists -- so this tier is
 * offered no `symbol` parameter at all rather than one that is refused. Its index is the
 * published universe, not the maintained list: a name the broker no longer trades stays on the
 * list but is held back from readers there, and this read is a reader's.
 */
export function createWatchlistIndexTool(env: AppEnv): AgentTool<typeof WatchlistIndexParameters> {
  return {
    description: 'Every symbol spicytrade keeps loaded, alphabetized.',
    execute: async () => textResult(indexResult((await loadStoredPublicMarketUniverse(env)).symbols)),
    name: 'read_watchlist',
    parameters: WatchlistIndexParameters,
  }
}

const RememberSymbolsParameters = Type.Object({
  symbols: Type.Array(EquitySymbolType, { maxItems: MAX_WATCHLIST_SYMBOLS, minItems: 1 }),
}, { additionalProperties: false })

/**
 * Additive only, and available to any member. The internal watchlist is shared — it drives the
 * market surface every reader sees — and this admits a whole list's worth of names per call with
 * no catalog check, which a visitor's one-quoted-name search cannot. What bounds it is the
 * provenance it writes: `agent-discussion` is prunable and ranks below every curated and
 * protected name (internal-watchlist.ts), so a member's flood can displace only searches and
 * uncurated seed rows, never refuse an owner or trade-intent addition. Removing a name is not the
 * same act and is owner-only below.
 */
export function createRememberSymbolsTool(
  env: AppEnv,
): AgentTool<typeof RememberSymbolsParameters> {
  return {
    description: 'Add substantively discussed tickers to the shared watchlist so they stay loaded. '
      + 'Only names a conversation actually developed; an incidental mention does not count.',
    execute: async (params) => {
      const remembered = await internalWatchlistWriter().ensureSymbols(env, params.symbols, 'agent-discussion')
      return textResult({ remembered })
    },
    name: 'remember_symbols',
    parameters: RememberSymbolsParameters,
  }
}

/**
 * Pruning the shared list back to a working set is an owner act: it changes what every reader
 * sees, and a member removing a name would take it from everyone.
 */
export function createWatchlistManageTool(
  env: AppEnv,
): AgentTool<typeof WatchlistActionParameters> {
  return {
    description: 'Add or remove symbols on the shared internal watchlist.',
    execute: async (params) => textResult(
      await executeWatchlistAction(env, WatchlistActionSchema.parse(params)),
    ),
    name: 'manage_watchlist',
    parameters: WatchlistActionParameters,
  }
}
