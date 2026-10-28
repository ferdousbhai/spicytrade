import { useEffect, useRef, useState } from 'react'

import { useRetryOnFocus } from './retry-on-focus'

export type SymbolReadState<T> =
  | { status: 'pending' }
  | { status: 'failed' }
  | { status: 'ready'; value: T }

/**
 * One public read about the selected symbol, for the focus card's sections.
 *
 * The answer carries the symbol it answers, so a slow answer for the name a reader just left can
 * never stand under the one they moved to while its own request is in flight. A failed read stays
 * `failed` rather than passing for an empty answer, and is asked again when the window regains
 * focus, as the calendar and year series are. The latest `load` is used without re-reading on
 * every render, so a caller may pass a fresh function each time.
 */
export function useSymbolRead<T>(symbol: string, load: (symbol: string, signal: AbortSignal) => Promise<T>): SymbolReadState<T> {
  const [answer, setAnswer] = useState<{ symbol: string; state: SymbolReadState<T> }>()
  const [attempt, setAttempt] = useState(0)
  const latestLoad = useRef(load)
  useEffect(() => {
    latestLoad.current = load
  })

  useEffect(() => {
    const controller = new AbortController()
    latestLoad.current(symbol, controller.signal)
      .then((value) => { if (!controller.signal.aborted) setAnswer({ symbol, state: { status: 'ready', value } }) })
      .catch(() => { if (!controller.signal.aborted) setAnswer({ symbol, state: { status: 'failed' } }) })
    return () => controller.abort()
  }, [attempt, symbol])

  const state: SymbolReadState<T> = answer?.symbol === symbol ? answer.state : { status: 'pending' }
  useRetryOnFocus(state.status === 'failed', () => setAttempt((count) => count + 1))
  return state
}
