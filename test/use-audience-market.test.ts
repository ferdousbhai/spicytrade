// @vitest-environment jsdom

import { QueryClient, QueryObserver } from '@tanstack/query-core'
import { describe, expect, it, vi } from 'vitest'

import { DEPLOYMENT_RELOAD_STORAGE_KEY, DeploymentMismatchError } from '../src/data/deployment'
import {
  applySnapshotQueryResult,
  audienceMarketView,
  latestSelectionReporter,
  SNAPSHOT_REFETCH_MS,
  snapshotSyncQueryOptions,
} from '../src/data/use-audience-market'
import { marketSnapshotFixture } from './fixtures/market'

const OWNER_SNAPSHOT = marketSnapshotFixture()
const PRIVATE_TICKER = OWNER_SNAPSHOT.tickers[0]
if (!PRIVATE_TICKER) throw new Error('Fixture requires at least one ticker')
const PUBLIC_SNAPSHOT = marketSnapshotFixture()
const PUBLIC_TICKER = PUBLIC_SNAPSHOT.tickers[0]
if (!PUBLIC_TICKER) throw new Error('Fixture requires a public ticker')

describe('audience market projection', () => {

  it('keeps the old audience hidden across a transition and reveals only the matching replacement', () => {
    const owner = audienceMarketView(
      'owner',
      [{ audience: 'owner', id: 'snapshot', snapshot: OWNER_SNAPSHOT }],
      [PRIVATE_TICKER],
    )
    expect(owner.tickers).toEqual([PRIVATE_TICKER])

    const transitioning = audienceMarketView(
      'public',
      [{ audience: 'owner', id: 'snapshot', snapshot: OWNER_SNAPSHOT }],
      [PRIVATE_TICKER],
    )
    expect(transitioning.snapshot).toBeUndefined()
    expect(transitioning.tickers).toEqual([])

    const replaced = audienceMarketView(
      'public',
      [{ audience: 'public', id: 'snapshot', snapshot: PUBLIC_SNAPSHOT }],
      [PUBLIC_TICKER],
    )
    expect(replaced.tickers).toEqual([PUBLIC_TICKER])
  })
})

describe('snapshot sync while a tab stays open', () => {
  it('refetches a visible tab on the public cache lifetime without a focus event', async () => {
    vi.useFakeTimers()
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    const queryFn = vi.fn(async () => ({ ok: true }))
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const observer = new QueryObserver(queryClient, {
      ...snapshotSyncQueryOptions('public'),
      queryFn,
    })
    const unsubscribe = observer.subscribe(() => undefined)
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(queryFn).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(SNAPSHOT_REFETCH_MS - 1)
      expect(queryFn).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(1)
      expect(queryFn).toHaveBeenCalledTimes(2)
    } finally {
      unsubscribe()
      observer.destroy()
      queryClient.clear()
      visibility.mockRestore()
      vi.useRealTimers()
    }
  })
})

describe('the newer-version notice', () => {
  it('clears once a newer build\'s snapshot hydrates, even while the reload is cooling down', () => {
    // A reload attempted moments ago holds the next one back.
    sessionStorage.setItem(DEPLOYMENT_RELOAD_STORAGE_KEY, String(Date.now()))
    const setWarning = vi.fn()
    try {
      applySnapshotQueryResult({ error: new DeploymentMismatchError('next', false), isFetched: true }, setWarning)
      expect(setWarning).toHaveBeenLastCalledWith(expect.stringContaining('needs a newer version'))

      // The next poll read the newer payload and put it on screen; the notice has nothing left
      // to apologize for.
      applySnapshotQueryResult({ error: new DeploymentMismatchError('next', true), isFetched: true }, setWarning)
      expect(setWarning).toHaveBeenLastCalledWith(undefined)
    } finally {
      sessionStorage.removeItem(DEPLOYMENT_RELOAD_STORAGE_KEY)
    }
  })
})

describe('a symbol selection that cannot be saved', () => {
  it('reports the failure and clears it once a later selection saves', async () => {
    const errors: Array<string | undefined> = []
    const report = latestSelectionReporter((message) => errors.push(message))

    await report(async () => { throw new Error('Selected market symbol is unavailable') })
    expect(errors.at(-1)).toBe('Selected market symbol is unavailable')

    await report(async () => undefined)
    expect(errors.at(-1)).toBeUndefined()
  })

  it('never lets an earlier selection that fails late outlive a later one that saved', async () => {
    const errors: Array<string | undefined> = []
    const report = latestSelectionReporter((message) => errors.push(message))
    let failEarlier: (error: Error) => void = () => undefined
    const earlier = report(() => new Promise<void>((_resolve, reject) => { failEarlier = reject }))

    await report(async () => undefined)
    failEarlier(new Error('Selected market symbol is unavailable'))
    await earlier

    expect(errors).toEqual([undefined])
  })
})
