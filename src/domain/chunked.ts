/**
 * `items` in consecutive runs of at most `size`, in order. The size is the caller's named limit
 * (a provider's per-request cap, D1's bound parameters); one that is not a positive integer would
 * loop forever or drop everything, so it throws.
 */
export function chunked<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('Chunk size must be a positive integer')
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size))
  return chunks
}
