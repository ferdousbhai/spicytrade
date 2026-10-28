import { SymbolRecommendationResponseSchema, type DatedRecommendation } from '../domain/brief'
import { loadPublicJson } from './public-json'

export async function loadSymbolRecommendation(symbol: string, signal?: AbortSignal): Promise<DatedRecommendation | null> {
  const query = new URLSearchParams({ symbol })
  return (await loadPublicJson(`/api/public-symbol-recommendation?${query}`, SymbolRecommendationResponseSchema, signal)).recommendation
}
