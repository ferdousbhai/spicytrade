import { useEffect, useSyncExternalStore } from 'react'
import { z } from 'zod'

import { type JsonValue } from '../domain/json-payload'
import { applyLiveMarketEvent, type SnapshotAudience } from './collections'
import { CLIENT_HEARTBEAT_MS, MarketFeedStatusSchema } from '../server/market-feed-contracts'

type LiveFeedIndicator = 'live' | 'snapshot'

let indicator: LiveFeedIndicator = 'snapshot'
const listeners = new Set<() => void>()

function publishLiveFeedIndicator(next: LiveFeedIndicator): void {
  if (indicator === next) return
  indicator = next
  for (const listener of listeners) listener()
}

function readLiveFeedIndicator(): LiveFeedIndicator {
  return indicator
}

/** Isolated from the market tree: a status frame must not re-render every quote row. */
export function useLiveFeedIndicator(): LiveFeedIndicator {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    readLiveFeedIndicator,
    readLiveFeedIndicator,
  )
}

/** The relay delivers text frames; binary frames are not part of the market protocol. */
const RelayFrameSchema = z.string()
const RECONNECT_BASE_DELAY_MS = 1_000
const RECONNECT_MAX_DELAY_MS = 30_000
/**
 * A hidden tab is nobody looking. The relay holds one upstream connection for as long as any
 * same-origin client socket exists. An abandoned overnight tab would otherwise keep dxLink
 * up for a market nobody is reading. The grace period keeps a brief alt-tab from cycling it.
 */
const HIDDEN_DISCONNECT_MS = 90 * 1_000
/**
 * The relay drops readers that stop announcing themselves, so a crashed or suspended browser
 * cannot hold its upstream connection open. This must stay well inside the relay's own idle
 * timeout, which allows several missed beats before closing.
 */
const HEARTBEAT_MS = CLIENT_HEARTBEAT_MS

/**
 * Opens the subscription and writes what it receives into the market collections.
 * Live vs snapshot is published to a store the top bar reads; reconnects must not
 * re-render the quote rows.
 *
 * `audience` is the audience whose snapshot is on screen, or undefined while none is. A change
 * of audience closes the socket and opens another, and each socket's frames carry the audience
 * it was opened for, so a frame queued before the change cannot land in the other audience.
 */
export function useLiveMarket(symbols: readonly string[], audience: SnapshotAudience | undefined): void {
  const key = [...new Set(symbols)].sort().join(',')

  useEffect(() => {
    if (!audience || !key) {
      publishLiveFeedIndicator('snapshot')
      return
    }
    let socket: WebSocket | undefined
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let stopped = false
    let idle = false
    let attempts = 0

    const connect = () => {
      if (stopped || idle) return
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
      const url = new URL('/api/stream', `${protocol}//${window.location.host}`)
      url.searchParams.set('symbols', key)
      // Each listener answers only for the socket this call opened. A socket that was replaced
      // -- by cleanup, by going idle, or by a reconnect after idling -- can still deliver a queued
      // frame or a late close, and neither may speak for the socket that replaced it: a late
      // close used to flip a live indicator back to Snapshot and schedule a second socket.
      const current = new WebSocket(url)
      socket = current
      current.addEventListener('message', (event) => {
        if (stopped || socket !== current) return
        try {
          const frame = RelayFrameSchema.parse(event.data)
          const payload: JsonValue = JSON.parse(frame)
          // A status frame is not a market event: it only tells the backoff that the upstream
          // feed is live again.
          const status = MarketFeedStatusSchema.safeParse(payload)
          if (status.success) {
            if (status.data.state === 'live') attempts = 0
            publishLiveFeedIndicator(status.data.state === 'live' ? 'live' : 'snapshot')
            return
          }
          applyLiveMarketEvent(payload, audience)
        } catch {
          // A frame this bundle cannot read is dropped; the data on screen keeps its own age.
        }
      })
      current.addEventListener('open', () => {
        if (stopped || socket !== current) return
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = setInterval(() => {
          if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'heartbeat' }))
        }, HEARTBEAT_MS)
      })
      current.addEventListener('close', () => {
        // Cleanup and goIdle already cleared the heartbeat and published Snapshot themselves.
        if (stopped || idle || socket !== current) return
        if (heartbeat) clearInterval(heartbeat)
        heartbeat = undefined
        publishLiveFeedIndicator('snapshot')
        // Cap browser reconnect backoff so a recovered live feed resumes without user action.
        const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * 2 ** attempts++)
        reconnectTimer = setTimeout(connect, delay)
      })
    }

    const goIdle = () => {
      if (idle) return
      idle = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      reconnectTimer = undefined
      if (heartbeat) clearInterval(heartbeat)
      heartbeat = undefined
      // Closing the last client socket is what lets the relay drop its upstream connection.
      socket?.close(1000, 'Viewer idle')
      socket = undefined
      publishLiveFeedIndicator('snapshot')
    }

    const onVisibilityChange = () => {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = undefined
      if (document.visibilityState === 'hidden') {
        idleTimer = setTimeout(goIdle, HIDDEN_DISCONNECT_MS)
        return
      }
      if (!idle) return
      idle = false
      attempts = 0
      connect()
    }

    document.addEventListener('visibilitychange', onVisibilityChange)
    if (document.visibilityState === 'hidden') idleTimer = setTimeout(goIdle, HIDDEN_DISCONNECT_MS)
    connect()
    return () => {
      stopped = true
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (reconnectTimer) clearTimeout(reconnectTimer)
      if (idleTimer) clearTimeout(idleTimer)
      if (heartbeat) clearInterval(heartbeat)
      socket?.close(1000, 'Subscription changed')
      publishLiveFeedIndicator('snapshot')
    }
  }, [audience, key])
}
