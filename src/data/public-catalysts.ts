import { useEffect, useState, useSyncExternalStore } from 'react'
import { z } from 'zod'

import { CatalystSchema, type Catalyst } from '../domain/catalyst'
import { EquitySymbolSchema } from '../domain/instrument'
import { loadPublicJson } from './public-json'
import { useRetryOnFocus } from './retry-on-focus'

const PublicCatalystsResponseSchema = z.object({ catalysts: z.array(CatalystSchema) })

const NO_CATALYSTS: readonly Catalyst[] = []
const inflight = new Map<string, Promise<PublicCatalystsRead>>()
const cache = new Map<string, readonly Catalyst[]>()
const listeners = new Set<() => void>()
/** Moves whenever a symbol's rows are dropped, so a card already on screen goes and asks again. */
let revision = 0

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * Drop what this browser holds for a symbol, because a search just changed what the server
 * reports for it. The cache has no expiry -- a symbol's rows are read once per session -- so a
 * date the producer has since moved would otherwise sit on the runway beside the date it moved
 * to for as long as the reader stayed on the page, which is the duplicate a reader clicked the
 * button to resolve. The server decides which sighting is current; this only stops the browser
 * from answering from a copy taken before it did.
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
  if (cached) return Promise.resolve({ catalysts: cached, failed: false })
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
      // a successful empty calendar for the rest of this browser session.
      if (current()) cache.set(parsed.data, body)
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
 * The focused symbol's rows, and whether the last read of them failed. A failed read is asked
 * again whenever the window regains focus, as well as on the next revision; a mounted view
 * otherwise kept its failure until the reader happened to pick another symbol.
 */
export function usePublicCatalysts(symbol: string): PublicCatalystsRead {
  const [held, setHeld] = useState<HeldRead>(() => ({
    catalysts: cache.get(symbol) ?? NO_CATALYSTS,
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

  useRetryOnFocus(failed, () => setAttempt((current) => current + 1))

  // Rows held for the previous symbol are still valid rows -- the runway filters by symbol --
  // but a failure belongs to the symbol it was for.
  return { catalysts: held.catalysts, failed }
}
