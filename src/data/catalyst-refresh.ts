import { useEffect, useSyncExternalStore } from 'react'

import {
  CatalystRefreshSchema,
  type Catalyst,
  type CatalystRefresh,
} from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { forgetPublicCatalysts } from './public-catalysts'
import { useCatalystRevalidation, CATALYST_BROWSER_REVALIDATE_MS } from './catalyst-revalidation'

/**
 * Catalyst coverage is seeded by attention: favoriting a symbol or looking at its calendar
 * asks for a search. The server owns the window that decides
 * whether a search is actually bought, so asking is cheap and asking twice costs nothing.
 */
async function requestCatalystRefresh(symbol: string): Promise<CatalystRefresh> {
  const response = await fetch('/api/public-catalyst-refresh', {
    body: JSON.stringify({ symbol: EquitySymbolSchema.parse(symbol) }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) throw new Error(`Catalyst refresh failed (${response.status})`)
  return CatalystRefreshSchema.parse(await response.json())
}

// Successful checks expire on the public-read cadence, not the research cooldown: another
// reader may have changed the calendar, and only the server knows when research is due.
const searches = new Set<string>()
const checkedAt = new Map<string, number>()
/** Symbols whose last search never answered, which a reader is told rather than shown empty. */
const failed = new Set<string>()
const answers = new Map<string, Catalyst[]>()
const listeners = new Set<() => void>()
let revision = 0
/** One shared empty list, so a caller can memoize on what a search bound rather than on a
    new array every render for the symbols no search has answered. */
const NO_CATALYSTS: readonly Catalyst[] = []
const FAILED_REFRESH: CatalystRefresh = { catalysts: [], ran: false, reason: 'failed' }

function notify(): void {
  revision += 1
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function record(symbol: string, refresh: CatalystRefresh): void {
  // A failed search bound nothing, so it neither answers the symbol nor erases what an earlier
  // search bound; leaving the answer unset also lets a retry in flight read as searching.
  searches.delete(symbol)
  if (refresh.reason !== 'failed') checkedAt.set(symbol, Date.now())
  // A cooldown refusal bound nothing new. Preserve the last actual answer, including the
  // distinction between a completed empty search and a symbol nobody has searched.
  if (refresh.ran) {
    answers.set(symbol, refresh.catalysts)
    forgetPublicCatalysts(symbol)
  }
  if (refresh.reason === 'failed') failed.add(symbol)
  else failed.delete(symbol)
  notify()
}

/**
 * Ask for a symbol's calendar, sharing in-flight and recently answered requests, so
 * a favorite's search and a later look at the symbol are one request and one answer.
 */
export function seedCatalystSearch(symbol: string): void {
  if (searches.has(symbol) || Date.now() - (checkedAt.get(symbol) ?? -Infinity) < CATALYST_BROWSER_REVALIDATE_MS) return
  searches.add(symbol)
  // A request that never answered is a failed search, not an empty calendar: telling a reader
  // nothing is scheduled on the strength of an outage is the one wrong answer here.
  void requestCatalystRefresh(symbol)
    .catch((): CatalystRefresh => FAILED_REFRESH)
    .then((refresh) => record(symbol, refresh))
  notify()
}

type CatalystSearchState = {
  catalysts: readonly Catalyst[]
  /** True once a search has run and bound nothing, which is not the same as never having looked. */
  confirmedEmpty: boolean
  /** True when the last search for this symbol never answered, so its calendar is unknown. */
  failed: boolean
  searching: boolean
}

/** A visible symbol is attention even when an earlier search already found an event. */
export function useCatalystSearch(symbol: string): CatalystSearchState {
  useSyncExternalStore(subscribe, () => revision, () => 0)
  useEffect(() => { seedCatalystSearch(symbol) }, [symbol])
  useCatalystRevalidation(() => seedCatalystSearch(symbol))
  const isFailed = failed.has(symbol)

  const answer = answers.get(symbol)
  return {
    catalysts: answer ?? NO_CATALYSTS,
    confirmedEmpty: answer?.length === 0,
    failed: isFailed,
    searching: searches.has(symbol),
  }
}
