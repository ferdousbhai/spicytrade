import { useCallback, useMemo, useState } from 'react'
import { useLiveQuery } from '@tanstack/react-db'

import { toError } from '../domain/failure'
import { retainSymbolLookup, type Preference } from './collections'
import { type PublicSymbolLookup } from '../domain/market'
import { seedCatalystSearch } from './catalyst-refresh'
import {
  createFavoriteSync,
  favoriteStageMarkerCollection,
  stagedFavoriteSymbols,
  toggleFavoriteSymbol,
} from './favorites'

export function useWorkspaceFavorites(viewerId: string | undefined, preference: Preference | undefined) {
  const favoriteSync = useMemo(
    () => viewerId ? createFavoriteSync(viewerId) : undefined,
    [viewerId],
  )
  const stageQuery = useLiveQuery(
    (query) => query.from({ favoriteStageMarker: favoriteStageMarkerCollection }),
  )
  const favoriteQuery = useLiveQuery(
    () => favoriteSync,
    [favoriteSync],
  )
  const [mutationError, setMutationError] = useState<string>()
  const stageMarker = (stageQuery.data ?? [])[0]
  const pinnedSymbols = favoriteSync
    ? (favoriteQuery.data ?? []).map((favorite) => favorite.symbol)
    : stagedFavoriteSymbols(preference, stageMarker)
  const error = favoriteSync && favoriteQuery.isError
    ? 'Favorite synchronization failed.'
    : mutationError

  const togglePinned = useCallback((symbol: string, lookup?: PublicSymbolLookup) => {
    setMutationError(undefined)
    // Retain a catalog result before starring it, so clearing search does not hide it.
    const retained = lookup ? retainSymbolLookup(lookup) : Promise.resolve()
    void retained.then(() => toggleFavoriteSymbol(symbol, favoriteSync)).then((favorited) => {
      // Seeding catalyst coverage is a consequence of the favorite, never a condition of it,
      // and goes through the shared search store so a later look joins the same answer.
      if (favorited) seedCatalystSearch(symbol)
    }).catch((cause: unknown) => {
      setMutationError(toError(cause)?.message ?? 'The favorite could not be updated')
    })
  }, [favoriteSync])

  return {
    collectionFailed: stageQuery.isError,
    error,
    pinnedSymbols,
    togglePinned,
  }
}
