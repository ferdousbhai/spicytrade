// Production seams replace banned module mocking. Factory resets rebuild the live
// implementation rather than restoring a stale test stand-in.
type Seam<T> = {
  current: () => T
  reset: () => void
  set: (next: T) => void
}

export type SeamValue<S> = S extends Seam<infer T> ? T : never

export function defineSeam<T>(createProduction: () => T): Seam<T> {
  let installed: T = createProduction()
  return {
    current: () => installed,
    reset: () => {
      installed = createProduction()
    },
    set: (next: T) => {
      installed = next
    },
  }
}
