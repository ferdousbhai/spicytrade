import { useEffect, useState, useSyncExternalStore } from 'react'
import { z } from 'zod'

import { CatalystSchema, type Catalyst } from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { loadPublicJson } from './public-json'
import { useCatalystRevalidation, CATALYST_BROWSER_REVALIDATE_MS } from './catalyst-revalidation'

const PublicCatalystsResponseSchema = z.object({ catalysts: z.array(CatalystSchema) })

const NO_CATALYSTS: readonly Catalyst[] = []
const inflight = new Map<string, Promise<PublicCatalystsRead>>()
const cache = new Map<string, { catalysts: readonly Catalyst[]; readAt: number }>()
const listeners = new Set<() => void>()
/** Moves whenever a symbol's rows are dropped, so a card already on screen goes and asks again. */
let revision = 0

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Drop what this browser holds for a symbol, because a search just changed what the server
 * reports for it. Invalidation also unregisters an older in-flight read so it cannot restore
 * rows from before the search when it eventually answers.
 */
export function forgetPublicCatalysts(symbol: string): void {
  const parsed = EquitySymbolSchema.safeParse(symbol)
  if (!parsed.success) return
  cache.delete(parsed.data)
  inflight.delete(parsed.data)
  revision += 1
  for (const listener of listeners) listener()
}

/**
 * What one read answered. `failed` is not an empty calendar: a read that never arrived, or
 * arrived in a shape this bundle cannot parse, leaves the symbol's calendar unknown, and a
 * reader is told so rather than shown nothing as though nothing were on it.
 */
type PublicCatalystsRead = {
  catalysts: readonly Catalyst[]
  failed: boolean
}

const FAILED_READ: PublicCatalystsRead = { catalysts: NO_CATALYSTS, failed: true }

/**
 * Full catalyst rows for the focused symbol. The snapshot's calendar is enough for stories;
 * description and source are only drawn on the runway, so they ride this fetch.
 */
export function loadPublicCatalysts(symbol: string): Promise<PublicCatalystsRead> {
  const parsed = EquitySymbolSchema.safeParse(symbol)
  // A name that is not a symbol was never asked about, so its calendar is unknown, not empty.
  if (!parsed.success) return Promise.resolve(FAILED_READ)
  const cached = cache.get(parsed.data)
  if (cached && Date.now() - cached.readAt < CATALYST_BROWSER_REVALIDATE_MS) {
    return Promise.resolve({ catalysts: cached.catalysts, failed: false })
  }
  const pending = inflight.get(parsed.data)
  if (pending) return pending
  // Only the request still registered for the symbol may settle it. `forgetPublicCatalysts`
  // unregisters one that started before a search moved the rows; that older request must not
  // cache the pre-search rows, nor clear the newer request's registration when it finishes.
  const current = () => inflight.get(parsed.data) === request
  const request: Promise<PublicCatalystsRead> = loadPublicJson(
    `/api/public-catalysts?symbol=${encodeURIComponent(parsed.data)}`,
    PublicCatalystsResponseSchema,
  )
    .then(({ catalysts: body }): PublicCatalystsRead => {
      // Parsed before caching: a malformed response must remain retryable, not become
      // a cached successful empty calendar.
      if (current()) cache.set(parsed.data, { catalysts: body, readAt: Date.now() })
      return { catalysts: body, failed: false }
    })
    // Nothing is cached for a failure, so the next ask -- a new revision, the window regaining
    // focus, or another look at the symbol -- reads again.
    .catch(() => FAILED_READ)
    .finally(() => {
      if (current()) inflight.delete(parsed.data)
    })
  inflight.set(parsed.data, request)
  return request
}

type HeldRead = PublicCatalystsRead & { symbol: string }

/**
 * The focused symbol's rows and read status. Visible views revalidate periodically and on
 * focus, so successful copies expire too and edits made by another reader can reach this tab.
 */
export function usePublicCatalysts(symbol: string): PublicCatalystsRead & { symbol?: string } {
  const [held, setHeld] = useState<HeldRead>(() => ({
    catalysts: cache.get(symbol)?.catalysts ?? NO_CATALYSTS,
    failed: false,
    symbol,
  }))
  const dropped = useSyncExternalStore(subscribe, () => revision, () => 0)
  const [attempt, setAttempt] = useState(0)
  const failed = held.symbol === symbol && held.failed

  useEffect(() => {
    let cancelled = false
    void loadPublicCatalysts(symbol).then((loaded) => {
      if (!cancelled) setHeld({ ...loaded, symbol })
    })
    return () => { cancelled = true }
  }, [attempt, dropped, symbol])

  useCatalystRevalidation(() => {
    const cached = cache.get(symbol)
    if (inflight.has(symbol) || (cached && Date.now() - cached.readAt < CATALYST_BROWSER_REVALIDATE_MS)) return
    setAttempt((current) => current + 1)
  })

  // Rows held for the previous symbol are still valid rows -- the runway filters by symbol --
  // but a failure belongs to the symbol it was for.
  // Only a registered successful copy is a complete calendar. Invalidation unregisters it
  // immediately, so an older read cannot hide a search result while its replacement loads.
  const completeSymbol = !failed && cache.get(held.symbol)?.catalysts === held.catalysts
    ? held.symbol : undefined
  return { catalysts: held.catalysts, failed, symbol: completeSymbol }
}
