import { useEffect, useState } from 'react'

import { YearCandlesSchema } from '../domain/market'
import { loadPublicJson } from './public-json'
import { useRetryOnFocus } from './retry-on-focus'

/**
 * The year series is fetched once per session and only where something draws it. It changes
 * once a market day and is large enough that the market snapshot cannot carry it: a reader
 * refetches that on every tab focus, and most screens never render the chart at all.
 *
 * One shared request, outside React, so several views asking are one answer.
 */
type YearCandlesRead = {
  failed: boolean
  series: ReadonlyMap<string, readonly number[]>
}

let request: Promise<YearCandlesRead> | undefined

const NO_SERIES: ReadonlyMap<string, readonly number[]> = new Map()
const NOT_YET_READ: YearCandlesRead = { failed: false, series: NO_SERIES }

function loadYearCandles(): Promise<YearCandlesRead> {
  request ??= loadPublicJson('/api/public-year-candles', YearCandlesSchema)
    .then((parsed): YearCandlesRead => ({
      failed: false,
      series: new Map(parsed.series.map((entry) => [entry.symbol, entry.closes])),
    }))
    .catch((): YearCandlesRead => {
      // A missing year chart is a column that stays empty, not a market a reader cannot read,
      // but it is reported as missing rather than as a year with nothing in it. Clearing the
      // promise lets a later ask try again rather than caching the failure.
      request = undefined
      return { failed: true, series: NO_SERIES }
    })
  return request
}

/**
 * Loads the series only when something is actually going to draw it. A failed read is asked
 * again when the window regains focus, so a mounted list does not keep its failure all session.
 */
export function useYearCandles(enabled: boolean): YearCandlesRead {
  const [read, setRead] = useState<YearCandlesRead>(NOT_YET_READ)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void loadYearCandles().then((loaded) => {
      if (!cancelled) setRead(loaded)
    })
    return () => { cancelled = true }
  }, [attempt, enabled])

  useRetryOnFocus(enabled && read.failed, () => setAttempt((current) => current + 1))

  // A failure is reported only where the series would be drawn.
  return enabled ? read : NOT_YET_READ
}
