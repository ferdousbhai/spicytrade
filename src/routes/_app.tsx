import { createFileRoute } from '@tanstack/react-router'

import { SpiceApp } from '../components/spice-app'
import { WATCH_SUMMARY_ID } from '../domain/site'

/**
 * The application shell: a pathless layout over Watch, Recommendations and Connect. It owns the
 * market, favorites, viewer and live-feed state, so moving between the views swaps only the
 * outlet and never remounts or refetches what they share.
 *
 * TanStack DB's browser-backed collections intentionally make this app shell client-rendered;
 * API routes and scheduled Workers remain server-rendered. The views inherit that from here.
 */
export const Route = createFileRoute('/_app')({ ssr: false, component: SpiceApp, pendingComponent: WatchSummarySlot })

/**
 * What the server renders in place of the client-only shell. Empty here; on `/watch` the Worker
 * fills it with a plain reading of the public snapshot (`server/watch-summary.ts`) so the
 * document is not blank without JavaScript. The browser keeps that markup through hydration --
 * the HTML string is not diffed -- and the app replaces the slot once it mounts.
 */
function WatchSummarySlot() {
  return <div dangerouslySetInnerHTML={{ __html: '' }} id={WATCH_SUMMARY_ID} suppressHydrationWarning />
}
