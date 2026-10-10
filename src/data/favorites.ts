import { QueryClient } from '@tanstack/query-core'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { createCollection, localStorageCollectionOptions } from '@tanstack/react-db'
import { z } from 'zod'

import {
  FavoriteMutationSchema,
  FavoriteSymbolsResponseSchema,
  MAX_FAVORITE_SYMBOLS,
  type FavoriteMutation,
} from '../domain/favorites'
import { EquitySymbolSchema, MAX_EQUITY_SYMBOL_LENGTH } from '../domain/instrument'
import { browserStorage } from './browser-storage'
import { preferenceCollection, type Preference } from './collections'

const FavoriteRowSchema = z.strictObject({ symbol: EquitySymbolSchema })
// The longest marker is the legacy JSON array of every valid favorite symbol.
const MAX_FAVORITE_STAGE_ID_LENGTH = 'legacy:'.length
  + 2
  + MAX_FAVORITE_SYMBOLS * (MAX_EQUITY_SYMBOL_LENGTH + 3)
const FavoriteStageMarkerSchema = z.strictObject({
  consumedStageId: z.string().max(MAX_FAVORITE_STAGE_ID_LENGTH),
  id: z.literal('primary'),
})

type FavoriteStageMarker = z.infer<typeof FavoriteStageMarkerSchema>

// Consumption lives under its own storage key. An authenticated response can
// therefore mark only the stage it sent without overwriting a newer preference
// row written by another tab while that request was in flight.
export const favoriteStageMarkerCollection = createCollection(
  localStorageCollectionOptions({
    id: 'spice-favorite-stage-markers',
    storageKey: 'spice.favorite-stage.v1',
    storage: browserStorage,
    schema: FavoriteStageMarkerSchema,
    getKey: (marker) => marker.id,
    startSync: true,
  }),
)

type AnonymousFavoriteStage = {
  id: string
  symbols: string[]
}

function anonymousFavoriteStage(preference: Preference | undefined): AnonymousFavoriteStage | undefined {
  if (!preference) return
  const symbols = [...preference.pinnedSymbols]
  if (preference.favoriteStageVersion) {
    return { id: `version:${preference.favoriteStageVersion}`, symbols }
  }
  if (preference.favoriteUserId) return
  return { id: `legacy:${JSON.stringify([...symbols].sort())}`, symbols }
}

/** The anonymous stage still waiting to merge: none once the marker records it consumed. */
function pendingFavoriteStage(preference: Preference | undefined, marker: FavoriteStageMarker | undefined) {
  const stage = anonymousFavoriteStage(preference)
  return stage && stage.id !== marker?.consumedStageId ? stage : undefined
}

export function stagedFavoriteSymbols(
  preference: Preference | undefined,
  marker?: FavoriteStageMarker,
): string[] {
  return pendingFavoriteStage(preference, marker)?.symbols ?? []
}

async function requestFavoriteSymbols(
  mutation?: FavoriteMutation,
  signal?: AbortSignal,
): Promise<string[]> {
  const response = await fetch('/api/favorites', {
    method: mutation ? 'POST' : 'GET',
    credentials: 'same-origin',
    headers: mutation
      ? { Accept: 'application/json', 'Content-Type': 'application/json' }
      : { Accept: 'application/json' },
    body: mutation ? JSON.stringify(FavoriteMutationSchema.parse(mutation)) : undefined,
    signal,
  })
  if (!response.ok) throw new Error(`Favorite sync failed (${response.status})`)
  return FavoriteSymbolsResponseSchema.parse(await response.json()).symbols
}

async function markAnonymousStageConsumed(stageId: string): Promise<void> {
  const current = favoriteStageMarkerCollection.get('primary')
  if (current?.consumedStageId === stageId) return
  const mutation = current
    ? favoriteStageMarkerCollection.update('primary', (draft) => {
        draft.consumedStageId = stageId
      })
    : favoriteStageMarkerCollection.insert({ consumedStageId: stageId, id: 'primary' })
  await mutation.isPersisted.promise
}

async function toggleAnonymousFavorite(symbol: string): Promise<boolean> {
  await Promise.all([
    preferenceCollection.preload(),
    favoriteStageMarkerCollection.preload(),
  ])
  const current = preferenceCollection.get('primary')
  if (!current) throw new Error('Favorite preferences are unavailable')
  const marker = favoriteStageMarkerCollection.get('primary')
  const pinnedSymbols = stagedFavoriteSymbols(current, marker)
  if (!pinnedSymbols.includes(symbol) && pinnedSymbols.length === MAX_FAVORITE_SYMBOLS) {
    throw new Error(`Favorites are limited to ${MAX_FAVORITE_SYMBOLS} symbols`)
  }
  const nextSymbols = pinnedSymbols.includes(symbol)
    ? pinnedSymbols.filter((candidate) => candidate !== symbol)
    : [...pinnedSymbols, symbol]
  const mutation = preferenceCollection.update('primary', (draft) => {
    draft.favoriteStageVersion = crypto.randomUUID()
    // An update merges changes over the stored row, so a delete never reaches it; undefined does.
    draft.favoriteUserId = undefined
    draft.pinnedSymbols = nextSymbols
  })
  await mutation.isPersisted.promise
  return nextSymbols.includes(symbol)
}

function favoriteRows(symbols: readonly string[]) {
  return symbols.map((symbol) => FavoriteRowSchema.parse({ symbol }))
}

/**
 * One browser workspace owns one QueryClient. Keeping it out of module scope prevents
 * authenticated rows from ever being shared by Cloudflare SSR isolates.
 */
export function createFavoriteSync(userId: string) {
  const queryClient = new QueryClient()
  const queryKey = ['spice-favorites', userId] as const
  let mutationTail: Promise<void> = Promise.resolve()

  const enqueueMutation = <T,>(task: () => Promise<T>): Promise<T> => {
    const execution = mutationTail.then(task)
    mutationTail = execution.then(() => undefined, () => undefined)
    return execution
  }

  const collection = createCollection(
    queryCollectionOptions({
      id: `spice-favorites-${userId}`,
      queryKey,
      queryClient,
      schema: FavoriteRowSchema,
      getKey: (favorite) => favorite.symbol,
      refetchOnMount: 'always',
      refetchOnReconnect: 'always',
      refetchOnWindowFocus: 'always',
      retry: false,
      queryFn: async ({ signal }) => {
        await Promise.all([
          preferenceCollection.preload(),
          favoriteStageMarkerCollection.preload(),
        ])
        const pendingStage = pendingFavoriteStage(
          preferenceCollection.get('primary'),
          favoriteStageMarkerCollection.get('primary'),
        )
        const symbols = pendingStage?.symbols.length
          ? await requestFavoriteSymbols({ kind: 'merge', symbols: pendingStage.symbols }, signal)
          : await requestFavoriteSymbols(undefined, signal)
        if (pendingStage && pendingStage.symbols.some((symbol) => !symbols.includes(symbol))) {
          throw new Error('Favorite merge returned an incomplete result')
        }
        if (signal.aborted) throw new DOMException('Favorite sync was superseded', 'AbortError')
        if (pendingStage) await markAnonymousStageConsumed(pendingStage.id)
        return favoriteRows(symbols)
      },
      onInsert: async ({ transaction }) => {
        const symbols = transaction.mutations.map((mutation) => mutation.modified.symbol)
        await enqueueMutation(async () => {
          const merged = await requestFavoriteSymbols({ kind: 'merge', symbols })
          if (symbols.some((symbol) => !merged.includes(symbol))) {
            throw new Error('Favorite merge returned an incomplete result')
          }
        })
      },
      onDelete: async ({ transaction }) => {
        const symbols = transaction.mutations.map((mutation) => mutation.original.symbol)
        await enqueueMutation(async () => {
          const retained = await requestFavoriteSymbols({ kind: 'remove', symbols })
          if (symbols.some((symbol) => retained.includes(symbol))) {
            throw new Error('Favorite removal returned an incomplete result')
          }
        })
      },
    }),
  )

  return collection
}

type FavoriteSync = ReturnType<typeof createFavoriteSync>

/** Reports whether the symbol is favorited now, which is what a caller acts on. */
export async function toggleFavoriteSymbol(
  symbol: string,
  favoriteSync: FavoriteSync | undefined,
): Promise<boolean> {
  const parsed = EquitySymbolSchema.parse(symbol)
  if (!favoriteSync) return toggleAnonymousFavorite(parsed)

  await favoriteSync.preload()
  const favorited = !favoriteSync.get(parsed)
  const transaction = favorited
    ? favoriteSync.insert({ symbol: parsed })
    : favoriteSync.delete(parsed)
  await transaction.isPersisted.promise
  return favorited
}
