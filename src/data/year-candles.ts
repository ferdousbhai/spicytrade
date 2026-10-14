import { useEffect, useState } from 'react'

import { marketDate } from '../domain/catalyst'
import { YearCandlesSchema } from '../domain/market'
import { loadPublicJson } from './public-json'
import { useRetryOnFocus } from './retry-on-focus'

/**
 * The year series is fetched once per market date and only where something draws it. It changes
 * once a market day and is large enough that the market snapshot cannot carry it: a reader
 * refetches that on every tab focus, and most screens never render the chart at all.
 *
 * One shared request, outside React, so several views asking are one answer.
 */
type YearCandlesRead = {
  failed: boolean
  loadedDay?: string
  asOf?: string
  series: ReadonlyMap<string, readonly number[]>
}

let request: { day: string; promise: Promise<YearCandlesRead> } | undefined

const NO_SERIES: ReadonlyMap<string, readonly number[]> = new Map()
const NOT_YET_READ: YearCandlesRead = { failed: false, series: NO_SERIES }

function loadYearCandles(day: string): Promise<YearCandlesRead> {
  if (request?.day === day) return request.promise
  const pending = {
    day,
    promise: loadPublicJson('/api/public-year-candles', YearCandlesSchema)
      .then((parsed): YearCandlesRead => ({
        failed: false,
        loadedDay: day,
        asOf: parsed.asOf,
        series: new Map(parsed.series.map((entry) => [entry.symbol, entry.closes])),
      }))
      .catch((): YearCandlesRead => {
        // An old day's failure must not clear a newer day's in-flight request.
        if (request === pending) request = undefined
        return { failed: true, series: NO_SERIES }
      }),
  }
  request = pending
  return pending.promise
}

/**
 * Loads the series only when something is actually going to draw it. A failed read is asked
 * again when the window regains focus, so a mounted list does not keep its failure all session.
 */
export function useYearCandles(enabled: boolean): YearCandlesRead {
  const [read, setRead] = useState<YearCandlesRead>(NOT_YET_READ)
  const [attempt, setAttempt] = useState(0)
  const day = marketDate()

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    void loadYearCandles(day).then((loaded) => {
      if (!cancelled) setRead(loaded)
    })
    return () => { cancelled = true }
  }, [attempt, day, enabled])

  // A successful read also needs renewal after an overnight tab returns to focus.
  useRetryOnFocus(enabled, () => {
    if (read.failed || read.loadedDay !== marketDate()) setAttempt((current) => current + 1)
  })

  // A failure is reported only where the series would be drawn.
  return enabled ? read : NOT_YET_READ
}
