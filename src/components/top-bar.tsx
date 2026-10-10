import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { LogOut } from 'lucide-react'

import { authClient } from '../data/auth-client'

import { useLiveFeedIndicator } from '../data/live-market'
import { type MarketState } from '../domain/market'

import { Avatar, AvatarFallback, AvatarImage } from '#/components/ui/avatar'
import { Button } from '#/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '#/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '#/components/ui/tooltip'
import { GoogleSignInButton } from './auth-gate'
import { SUPPORT_EMAIL } from '../domain/site'
import { BrandMark, HOME_LINK_LABEL } from './wordmark'

// Fine enough that "just now" becomes "1 min ago" while a reader is still looking at it.
const ELAPSED_TICK_MS = 15_000

/** Whole seconds since `at`, or undefined when it is not a readable instant. */
function elapsedSeconds(at: string, now: number): number | undefined {
  const updated = Date.parse(at)
  if (!Number.isFinite(updated)) return undefined
  // A provider clock a little ahead of the browser's must not read as the future.
  return Math.max(0, Math.round((now - updated) / 1_000))
}

/**
 * How old the data on screen is, in the terms a reader thinks in. This replaced a banner that
 * alarmed on every reconnect: what a reader needs is the age of what they are reading, not an
 * interruption each time a socket drops and heals itself.
 */
export function elapsedLabel(at: string, now: number): string | undefined {
  const seconds = elapsedSeconds(at, now)
  if (seconds === undefined) return undefined
  if (seconds < 45) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.floor(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}

/**
 * The same age at table-cell width: "3m", "5h", "2d". Under a minute reads as "now", since a
 * cell has no room to say "just" and a reader glancing at a column wants one glyph per row.
 */
export function compactElapsedLabel(at: string, now: number): string | undefined {
  const seconds = elapsedSeconds(at, now)
  if (seconds === undefined) return undefined
  if (seconds < 60) return 'now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}

/**
 * Elapsed time only stays true if it keeps counting, so the clock is read on a timer and held
 * in state. Rendering may not read it directly, so a label can trail the real instant by up to
 * one tick — immaterial at the minute granularity a reader is being told about.
 */
function useTick(enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!enabled) return
    const timer = setInterval(() => setNow(Date.now()), ELAPSED_TICK_MS)
    return () => clearInterval(timer)
  }, [enabled])
  return now
}

export function useElapsedLabel(at: string | undefined): string | undefined {
  const now = useTick(Boolean(at))
  return at ? elapsedLabel(at, now) : undefined
}

/**
 * The session as a traffic light: green open, yellow waiting, red closed. What the color
 * means, the New York clock, and the wait to the next bell live on hover — the bar itself
 * has no room for that sentence. A session the provider could not name is neither: it reads
 * as unknown in a muted tone and counts down to nothing, since a bell it cannot place is not
 * one to count toward.
 */
type MarketStatus = { detail: string; tone: 'open' | 'waiting' | 'closed' | 'unknown' }

const SESSION_NAMES = {
  after: 'After hours',
  closed: 'Closed',
  open: 'Open',
  pre: 'Pre-market',
  unknown: 'Session unknown',
} satisfies Record<MarketState, string>

export function marketClockLabel(now: number): string {
  return new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/New_York',
    timeZoneName: 'short',
    weekday: 'short',
  }).format(new Date(now))
}

function waitLabel(target: number, now: number): string | undefined {
  const minutes = Math.ceil((target - now) / 60_000)
  if (!Number.isFinite(minutes) || minutes <= 0) return undefined
  const hours = Math.floor(minutes / 60)
  const remainder = minutes % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const rest = hours % 24
    return rest ? `${days}d ${rest}h` : `${days}d`
  }
  if (hours) return remainder ? `${hours}h ${remainder}m` : `${hours}h`
  return `${remainder}m`
}

export function marketStatusLabel(
  state: MarketState,
  opensAt: string | undefined,
  now: number,
  closesAt?: string,
): MarketStatus {
  const name = SESSION_NAMES[state]
  const tone = state === 'open' ? 'open' : state === 'pre' ? 'waiting' : state === 'unknown' ? 'unknown' : 'closed'
  const lines = [name, marketClockLabel(now)]
  if (state === 'unknown') return { detail: lines.join('\n'), tone }
  if (state === 'open') {
    const wait = closesAt ? waitLabel(Date.parse(closesAt), now) : undefined
    if (wait) lines.push(`Closes in ${wait}`)
  } else {
    const wait = opensAt ? waitLabel(Date.parse(opensAt), now) : undefined
    if (wait) lines.push(`Opens in ${wait}`)
  }
  return { detail: lines.join('\n'), tone }
}

type LiveFeedSourceCopy = {
  label: 'Live' | 'Snapshot'
  title: string
}

export function liveFeedSourceLabel(source: 'live' | 'snapshot'): LiveFeedSourceCopy {
  if (source === 'live') {
    return { label: 'Live', title: 'Live quotes from the dxLink feed' }
  }
  return { label: 'Snapshot', title: 'Last stored print; live feed is off' }
}

/**
 * A full document load after sign-out, not a state reset: signed-in rows (favorites, agent
 * tokens, owner surfaces) live in per-viewer clients and component state, and a fresh load is
 * the one path that provably drops all of them. A failed sign-out stays in the menu and says
 * so, since leaving the reader believing they are signed out is the worse outcome.
 */
function ViewerMenu({ viewerImage, viewerName }: { viewerImage?: string; viewerName: string }) {
  const [phase, setPhase] = useState<'idle' | 'signing-out' | 'failed'>('idle')
  const signOut = async () => {
    setPhase('signing-out')
    try {
      const result = await authClient.signOut()
      if (result.error) throw new Error('sign-out refused')
      window.location.assign('/watch')
    } catch {
      setPhase('failed')
    }
  }
  return (
    <DropdownMenu onOpenChange={(open) => { if (open && phase === 'failed') setPhase('idle') }}>
      <DropdownMenuTrigger aria-label={`Account menu for ${viewerName}`} className="viewer-menu-trigger" title={viewerName}>
        <Avatar className="viewer-avatar">
          {/* alt="" because the trigger already carries the account name as its aria-label; a
              second label here would read it twice to a screen reader. no-referrer keeps
              Google from seeing which spicytrade page requested the image. */}
          {viewerImage && <AvatarImage alt="" referrerPolicy="no-referrer" src={viewerImage} />}
          <AvatarFallback>{viewerName.trim().charAt(0).toUpperCase()}</AvatarFallback>
        </Avatar>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        <DropdownMenuGroup>
          <DropdownMenuLabel>Signed in as <strong className="viewer-menu-name">{viewerName}</strong></DropdownMenuLabel>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuItem closeOnClick={false} disabled={phase === 'signing-out'} onClick={() => void signOut()}>
          <LogOut aria-hidden="true" size={14} />
          {phase === 'signing-out' ? 'Signing out…' : phase === 'failed' ? 'Sign-out failed — try again' : 'Sign out'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export function TopBar({
  lastUpdatedAt,
  marketClosesAt,
  marketOpensAt,
  marketState,
  viewerImage,
  viewerName,
}: {
  lastUpdatedAt?: string
  marketClosesAt?: string
  marketOpensAt?: string
  marketState?: MarketState
  viewerImage?: string
  viewerName?: string
}) {
  // One clock for both readings, on one timer. It also keeps ticking while another tab is
  // open — the age used to stop with it, and resumed from the instant the reader left, so a
  // return to the market showed forty-minute-old quotes as "Updated just now".
  const now = useTick(Boolean(lastUpdatedAt) || Boolean(marketState))
  const updated = lastUpdatedAt ? elapsedLabel(lastUpdatedAt, now) : undefined
  const source = useLiveFeedIndicator()
  const feed = liveFeedSourceLabel(source)
  const status = marketState
    ? marketStatusLabel(marketState, marketOpensAt, now, marketClosesAt)
    : undefined
  const [statusOpen, setStatusOpen] = useState(false)
  const statusPinned = useRef(false)
  return (
    <header className="top-bar">
      <Link aria-label={HOME_LINK_LABEL} className="brand" to="/watch">
        <BrandMark />
      </Link>
      <div className="top-actions">
        {status && (
          <>
            {/* A tooltip opens on hover and focus, which a touch screen has neither of, so a tap
                toggles it too: this is the only place the session, clock and countdown appear. */}
            <Tooltip
              onOpenChange={(next, details) => {
                // A tap on a touch screen is followed by a synthetic hover-leave; while the tap
                // is what opened it, only another tap, an outside press or Escape closes it.
                if (!next && statusPinned.current && details.reason === 'trigger-hover') return
                if (!next) statusPinned.current = false
                setStatusOpen(next)
              }}
              open={statusOpen}
            >
              <TooltipTrigger
                aria-label={status.detail.replaceAll('\n', '. ')}
                className="market-status"
                closeOnClick={false}
                data-tone={status.tone}
                onClick={() => {
                  statusPinned.current = !statusOpen
                  setStatusOpen(!statusOpen)
                }}
                type="button"
              />
              <TooltipContent className="market-status-tip" side="bottom">
                {status.detail}
              </TooltipContent>
            </Tooltip>
            <span
              className="quote-source"
              data-live={source === 'live' ? 'true' : undefined}
              title={feed.title}
            >
              {feed.label}
            </span>
          </>
        )}
        {/* The age matters while quotes move; outside the session each reading's own age is stated on the card that shows it. */}
        {updated && marketState === 'open' && (
          <span className="last-updated" title={`Quotes last updated ${lastUpdatedAt}`}>
            <span className="last-updated-word">Updated </span>{updated}
          </span>
        )}
        <Button nativeButton={false} render={<a className="top-link" href={`mailto:${SUPPORT_EMAIL}`} />} size="sm" variant="link">Support</Button>
        {viewerName && <ViewerMenu viewerImage={viewerImage} viewerName={viewerName} />}
        {!viewerName && <GoogleSignInButton compact />}
      </div>
    </header>
  )
}
