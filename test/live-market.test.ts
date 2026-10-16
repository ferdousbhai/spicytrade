// @vitest-environment jsdom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useLiveFeedIndicator, useLiveMarket } from '../src/data/live-market'

/**
 * Just enough of a browser WebSocket to drive the hook: nothing is sent anywhere, `close()`
 * only records the request, and the test decides when a close or a frame actually arrives --
 * which is the point, since a real close lands asynchronously, after the replacement opened.
 */
class FakeWebSocket extends EventTarget {
  static readonly OPEN = 1
  static opened: FakeWebSocket[] = []
  readyState = 0
  closeRequested = false

  constructor(readonly url: URL) {
    super()
    FakeWebSocket.opened.push(this)
  }

  send(): void {}

  close(): void {
    this.closeRequested = true
  }

  status(state: 'live' | 'reconnecting'): void {
    const data = JSON.stringify({ asOf: new Date().toISOString(), state, type: 'feed-status' })
    this.dispatchEvent(new MessageEvent('message', { data }))
  }

  closed(): void {
    this.readyState = 3
    this.dispatchEvent(new Event('close'))
  }
}

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state })
  document.dispatchEvent(new Event('visibilitychange'))
}

beforeEach(() => {
  FakeWebSocket.opened = []
  vi.stubGlobal('WebSocket', FakeWebSocket)
  setVisibility('visible')
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function renderLiveMarket(symbols: string[]) {
  return renderHook(({ list }) => {
    useLiveMarket(list, 'public')
    return useLiveFeedIndicator()
  }, { initialProps: { list: symbols } })
}

describe('a replaced market socket', () => {
  it('cannot speak for the socket that replaced it after the subscription changes', () => {
    const view = renderLiveMarket(['SPY'])
    const first = FakeWebSocket.opened[0]!
    act(() => first.status('live'))
    expect(view.result.current).toBe('live')

    view.rerender({ list: ['QQQ'] })
    expect(first.closeRequested).toBe(true)
    const second = FakeWebSocket.opened[1]!
    act(() => second.status('live'))
    expect(view.result.current).toBe('live')

    // The old socket's queued frame and its late close both arrive after the new one is live.
    act(() => first.status('reconnecting'))
    act(() => first.closed())
    expect(view.result.current).toBe('live')
    expect(FakeWebSocket.opened).toHaveLength(2)
  })

  it('cannot speak for the socket a returning tab opened after going idle', () => {
    vi.useFakeTimers()
    const view = renderLiveMarket(['SPY'])
    const first = FakeWebSocket.opened[0]!
    act(() => first.status('live'))

    act(() => setVisibility('hidden'))
    act(() => { vi.runOnlyPendingTimers() })
    expect(first.closeRequested).toBe(true)
    expect(view.result.current).toBe('snapshot')

    act(() => setVisibility('visible'))
    const second = FakeWebSocket.opened[1]!
    act(() => second.status('live'))

    // The idle socket's close lands only now; it must neither dim the live feed nor schedule
    // a reconnect that would open a third socket beside the second.
    act(() => first.closed())
    act(() => { vi.runOnlyPendingTimers() })
    expect(view.result.current).toBe('live')
    expect(FakeWebSocket.opened).toHaveLength(2)
  })

  it('still reconnects when the socket it holds closes', () => {
    vi.useFakeTimers()
    const view = renderLiveMarket(['SPY'])
    const first = FakeWebSocket.opened[0]!
    act(() => first.status('live'))

    act(() => first.closed())
    expect(view.result.current).toBe('snapshot')
    act(() => { vi.advanceTimersByTime(1_000) })
    expect(FakeWebSocket.opened).toHaveLength(2)
  })
})
