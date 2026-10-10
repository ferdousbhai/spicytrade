/**
 * D1 accepts at most 100 bound parameters in one query. Keep the platform number
 * in one place so every multi-row statement derives its batch size from its own
 * column count instead of carrying an unexplained hand-tuned row cap.
 */
export const D1_MAX_BOUND_PARAMETERS = 100

export function rowsPerD1Statement(boundParametersPerRow: number): number {
  if (!Number.isSafeInteger(boundParametersPerRow)
    || boundParametersPerRow < 1
    || boundParametersPerRow > D1_MAX_BOUND_PARAMETERS) {
    throw new Error('D1 bound-parameter count must fit one statement')
  }
  return Math.floor(D1_MAX_BOUND_PARAMETERS / boundParametersPerRow)
}

/** One row's `(?, ...)` group, sized from the same per-row count its batch size derives from. */
export function d1RowPlaceholders(boundParametersPerRow: number): string {
  return `(${Array.from({ length: boundParametersPerRow }, () => '?').join(', ')})`
}

/**
 * A `col IN (?, ...)` list split into statement-sized chunks: one bound parameter per item, less
 * the parameters the rest of the statement binds.
 */
export function d1InListChunks<T>(items: readonly T[], otherBoundParameters = 0): T[][] {
  const size = D1_MAX_BOUND_PARAMETERS - otherBoundParameters
  if (!Number.isSafeInteger(size) || size < 1) throw new Error('D1 bound-parameter count must fit one statement')
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += size) chunks.push(items.slice(start, start + size))
  return chunks
}
