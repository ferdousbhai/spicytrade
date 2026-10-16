import { createContext, lazy, Suspense, useCallback, useContext, type ComponentProps, type ReactNode } from 'react'
import { Link, Outlet, useMatchRoute, useRouter } from '@tanstack/react-router'
import { Gauge, Newspaper, Plug } from 'lucide-react'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Button } from '#/components/ui/button'
import { Empty, EmptyDescription, EmptyHeader } from '#/components/ui/empty'
import { Skeleton } from '#/components/ui/skeleton'
import { selectLiveMarketSymbols, type SnapshotAudience } from '../data/collections'
import { type DailyBrief } from '../domain/brief'
import { mostActiveSymbol, type PublicSymbolLookup } from '../domain/market'
import { useLiveMarket } from '../data/live-market'
import { useAudienceMarket } from '../data/use-audience-market'
import { useWorkspaceFavorites } from '../data/use-workspace-favorites'
import { type Viewer, useViewer } from './auth-gate'
import { MarketScreen } from './market-screen'
import { TopBar } from './top-bar'
import { useWebMcpTools } from './webmcp-tools'
import { SUPPORT_EMAIL } from '../domain/site'

const ConnectScreen = lazy(async () => {
  const { ConnectScreen: Screen } = await import('./connect-screen')
  return { default: Screen }
})
const BriefScreen = lazy(async () => {
  const { BriefScreen: Screen } = await import('./brief-screen')
  return { default: Screen }
})

/** Where the application itself lives: `/` redirects here, and a symbol chosen anywhere lands here. */
const WATCH_PATH = '/watch'

type MarketScreenProps = ComponentProps<typeof MarketScreen>
/**
 * Everything the three views share, computed once by the layout route and handed down. The
 * views are sibling routes under one layout, so moving between them never remounts this state
 * or re-runs the market, favorites or live-feed hooks — each of those owns a subscription or a
 * browser store, and running them per route would reconnect the feed and re-read storage on
 * every tab change.
 */
type Workspace = {
  activeWatchlist?: MarketScreenProps['activeWatchlist']
  authError?: string
  bootstrapComplete: boolean
  brief?: DailyBrief
  catalysts: MarketScreenProps['catalysts']
  chooseSymbol: (symbol: string, lookup?: PublicSymbolLookup) => void
  favorites: ReturnType<typeof useWorkspaceFavorites>
  owner: boolean
  selected?: MarketScreenProps['selected']
  selectionError?: string
  snapshotReady: boolean
  tickers: MarketScreenProps['tickers']
  viewer: Viewer | null
}

const WorkspaceContext = createContext<Workspace | undefined>(undefined)

function useWorkspace(): Workspace {
  const workspace = useContext(WorkspaceContext)
  // A view rendered outside the layout has no market to read; saying so beats rendering an
  // empty market as if it were real.
  if (!workspace) throw new Error('A spicytrade view rendered outside the application layout.')
  return workspace
}

export function SpiceApp() {
  const auth = useViewer()
  const viewer: Viewer | null = auth.phase === 'ready' ? auth.user : null
  const owner = viewer?.role === 'owner'
  // The audience stays unknown until the session check answers. Booting the public surface on
  // a guess discarded the owner's stored snapshot on every refresh — the record belongs to one
  // audience, and restoring for the other throws it away — so a page that already had the
  // market on disk went blank and fetched it again, twice.
  const audience: SnapshotAudience | undefined = auth.phase === 'ready' ? (owner ? 'owner' : 'public') : undefined
  const authError = auth.phase === 'error' ? auth.message : undefined
  const router = useRouter()
  const matchRoute = useMatchRoute()
  const market = useAudienceMarket(audience)
  const { chooseSymbol: saveSelectedSymbol, preference, snapshot, tickers } = market
  const favorites = useWorkspaceFavorites(viewer?.id, preference)
  const snapshotReady = Boolean(snapshot)
  const activeWatchlist = snapshot?.watchlists[0]
  const fallbackSymbol = mostActiveSymbol(tickers, activeWatchlist?.symbols)
  const selected = tickers.find((ticker) => ticker.symbol === preference?.selectedSymbol)
    ?? tickers.find((ticker) => ticker.symbol === fallbackSymbol)
  const loadedSymbols = new Set(tickers.map((ticker) => ticker.symbol))
  // Favorites stream in the table's default order (volume, busiest first), so when there are more
  // of them than one socket carries, the ones that stream are the ones on top of the list.
  const volumeOf = new Map(tickers.map((ticker) => [ticker.symbol, ticker.volume ?? 0]))
  const pinnedByVolume = [...favorites.pinnedSymbols]
    .sort((left, right) => (volumeOf.get(right) ?? 0) - (volumeOf.get(left) ?? 0) || left.localeCompare(right))
  const streamSymbols = selectLiveMarketSymbols(
    selected?.symbol,
    pinnedByVolume,
    activeWatchlist?.symbols ?? [],
    loadedSymbols,
  )
  useLiveMarket(streamSymbols, snapshotReady ? audience : undefined)
  const collectionFailed = market.collectionFailed || favorites.collectionFailed
  // Reconnect is the feed healing itself. The top bar says Live or Snapshot; a banner
  // for the in-between states would flash on every tab wake.
  const visibleSnapshotWarning = [
    collectionFailed ? 'Browser market storage failed. Reload to inspect the current state.' : undefined,
    market.warning,
  ].filter((warning): warning is string => Boolean(warning)).join(' ') || undefined
  // Live ticks move a ticker's own instant past the snapshot's, so the freshest reading in
  // hand is what the reader is actually looking at.
  const lastUpdatedAt = [snapshot?.syncedAt, ...tickers.map((ticker) => ticker.updatedAt)]
    .filter((at): at is string => Boolean(at))
    .sort().at(-1)

  // Stable row callbacks keep the memoized market rows from re-rendering on every
  // workspace render. The selection itself stays in the market preference, not the URL; this
  // only brings the reader to the view that shows it. A row tap on Watch is already there, and
  // navigating to the same location would re-run the route's load for nothing.
  const chooseSymbol = useCallback((symbol: string, lookup?: PublicSymbolLookup) => {
    void saveSelectedSymbol(symbol, lookup)
    if (!router.matchRoute({ to: WATCH_PATH })) void router.navigate({ to: WATCH_PATH })
  }, [router, saveSelectedSymbol])

  const workspace: Workspace = {
    activeWatchlist,
    authError,
    bootstrapComplete: market.bootstrapComplete,
    brief: snapshot?.brief,
    catalysts: snapshot?.catalysts ?? [],
    chooseSymbol,
    favorites,
    owner,
    selected,
    selectionError: market.selectionError,
    snapshotReady,
    tickers,
    viewer,
  }
  // The same workspace, offered to an agent driving this tab; see `webmcp-tools.ts`.
  useWebMcpTools({
    brief: snapshot?.brief,
    catalysts: workspace.catalysts,
    chooseSymbol,
    marketState: snapshot?.marketState,
    openView: (to) => void router.navigate({ to }),
    pinnedSymbols: favorites.pinnedSymbols,
    selectedSymbol: selected?.symbol,
    signedIn: Boolean(viewer),
    syncedAt: snapshot?.syncedAt,
    tickers,
    togglePinned: favorites.togglePinned,
  })

  return (
    <div className="app-viewport">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <div className="app-shell">
        {/* The age belongs to the market data, so it is stated where that data is read and
            nowhere else: on the recommendations or connect view it would describe something the
            reader is not looking at. */}
        <TopBar
          lastUpdatedAt={matchRoute({ to: WATCH_PATH }) ? lastUpdatedAt : undefined}
          marketClosesAt={snapshot?.marketClosesAt}
          marketOpensAt={snapshot?.marketOpensAt}
          marketState={snapshot?.marketState}
          viewerImage={viewer?.image}
          viewerName={viewer?.name}
        />
        <div className="text-sm">
          <main id="main-content" className="main-content">
            {visibleSnapshotWarning && (
              <Alert>
                <AlertTitle>Market data may be stale</AlertTitle>
                <AlertDescription>{visibleSnapshotWarning}</AlertDescription>
              </Alert>
            )}
            <WorkspaceContext.Provider value={workspace}>
              <Outlet />
            </WorkspaceContext.Provider>
          </main>
        </div>
        <nav aria-label="Primary navigation" className="bottom-nav items-center text-muted-foreground">
          <PrimaryLink icon={<Gauge />} label="Watch" to="/watch" />
          <PrimaryLink icon={<Newspaper />} label="Recommendations" to="/recommendations" />
          <PrimaryLink icon={<Plug />} label="Connect" to="/connect" />
        </nav>
      </div>
    </div>
  )
}

/** The router marks the current view `aria-current="page"`, which is also what the nav styles key on. */
function PrimaryLink({ icon, label, to }: { icon: ReactNode; label: string; to: '/watch' | '/recommendations' | '/connect' }) {
  return (
    <Link
      className="primary-link inline-flex flex-1 rounded-md items-center justify-center whitespace-nowrap transition-all focus-visible:outline-1 focus-visible:outline-ring [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4"
      to={to}
    >
      {icon}
      <span>{label}</span>
    </Link>
  )
}

/**
 * A failed session check never names an audience, so nothing bootstraps and no sync is ever
 * attempted. Saying so — on every market-reading view, not only on Connect — is what keeps the
 * reader off a spinner that cannot end. The audience is still not guessed: restoring for the
 * wrong one would discard the stored snapshot.
 */
function SnapshotPending({ view }: { view: 'brief' | 'watch' }) {
  const { authError, bootstrapComplete, snapshotReady } = useWorkspace()
  return (
    <>
      {authError && (
        <Alert variant="destructive">
          <AlertTitle>Session check failed</AlertTitle>
          <AlertDescription>{authError}</AlertDescription>
          <Button onClick={() => window.location.reload()} size="sm" type="button" variant="outline">Try again</Button>
        </Alert>
      )}
      {!snapshotReady && !authError && (bootstrapComplete
        ? <SnapshotUnavailable />
        : <PageSkeleton view={view} />)}
    </>
  )
}

export function WatchView() {
  const {
    activeWatchlist,
    brief,
    catalysts,
    chooseSymbol,
    favorites,
    selected,
    selectionError,
    snapshotReady,
    tickers,
  } = useWorkspace()
  return (
    <>
      {selectionError && (
        <Alert variant="destructive">
          <AlertTitle>Selection failed</AlertTitle>
          <AlertDescription>{selectionError}</AlertDescription>
        </Alert>
      )}
      {favorites.error && (
        <Alert variant="destructive">
          <AlertTitle>Favorite update failed</AlertTitle>
          <AlertDescription>{favorites.error}</AlertDescription>
        </Alert>
      )}
      <SnapshotPending view="watch" />
      {snapshotReady && selected && activeWatchlist && (
        <MarketScreen
          activeWatchlist={activeWatchlist}
          catalysts={catalysts}
          onSelectTicker={chooseSymbol}
          onTogglePinned={favorites.togglePinned}
          pinnedSymbols={favorites.pinnedSymbols}
          brief={brief}
          selected={selected}
          tickers={tickers}
        />
      )}
      {snapshotReady && (!selected || !activeWatchlist) && (
        <MarketState message="No market symbols are available." />
      )}
    </>
  )
}

export function RecommendationsView() {
  const { brief, chooseSymbol, snapshotReady } = useWorkspace()
  return (
    <>
      <SnapshotPending view="brief" />
      {snapshotReady && (
        <Suspense fallback={<MarketState loading message="Loading…" />}>
          <BriefScreen
            // The screen holds the issue history it has walked; a newly published brief
            // starts that history over rather than leaving the open view on the old issue.
            key={brief ? `${brief.id}:${brief.publishedAt}` : 'none'}
            latest={brief}
            onSymbol={chooseSymbol}
          />
        </Suspense>
      )}
    </>
  )
}

export function ConnectView() {
  const { authError, owner, viewer } = useWorkspace()
  return (
    <>
      <Suspense fallback={<MarketState loading message="Loading…" />}>
        <ConnectScreen authError={authError} owner={owner} signedIn={Boolean(viewer)} />
      </Suspense>
      {/* The top bar has no room for these on a phone, so the view about the reader's own
          account carries them for every width. */}
      <nav aria-label="Legal and support" className="connect-footer">
        <a href={`mailto:${SUPPORT_EMAIL}`}>Support</a>
        <Link to="/terms">Terms</Link>
        <Link to="/privacy">Privacy</Link>
        <Link to="/disclosures">Disclosures</Link>
      </nav>
    </>
  )
}

/**
 * The first load draws the outline of the view it is loading -- the focus card and the list's
 * rows, or a brief's cover and trades -- so the page settles into place instead of jumping from a
 * lone spinner to a full screen. The words stay for assistive technology, which cannot see shapes.
 */
function PageSkeleton({ view }: { view: 'brief' | 'watch' }) {
  return (
    <section aria-busy="true" aria-live="polite" className={`page-skeleton page-skeleton-${view}`}>
      <p className="sr-only" role="status">Loading market data…</p>
      {view === 'watch'
        ? (
            <>
              <div className="skeleton-focus" aria-hidden="true">
                <div className="skeleton-rail">
                  <Skeleton className="skeleton-symbol" />
                  <Skeleton className="skeleton-name" />
                  <Skeleton className="skeleton-price" />
                  <Skeleton className="skeleton-gauge" />
                </div>
                <div className="skeleton-main">
                  {[0, 1, 2, 3].map((line) => <Skeleton className="skeleton-line" key={line} />)}
                </div>
              </div>
              <div className="skeleton-rows" aria-hidden="true">
                {[0, 1, 2, 3, 4, 5].map((row) => <Skeleton className="skeleton-row" key={row} />)}
              </div>
            </>
          )
        : (
            <div className="skeleton-brief" aria-hidden="true">
              <Skeleton className="skeleton-name" />
              {[0, 1].map((trade) => (
                <div className="skeleton-trade" key={trade}>
                  <Skeleton className="skeleton-price" />
                  {[0, 1, 2, 3].map((line) => <Skeleton className="skeleton-line" key={line} />)}
                </div>
              ))}
            </div>
          )}
    </section>
  )
}

/**
 * The snapshot never arrived. Said plainly, with the one thing a reader can do about it: a
 * reload asks again from the start, the same answer a failed session check gives.
 */
function SnapshotUnavailable() {
  return (
    <section aria-live="polite" className="market-state">
      <Empty>
        <EmptyHeader>
          <h2 className="market-state-title">Market data is unavailable</h2>
          <EmptyDescription>spicytrade couldn&apos;t load the market snapshot.</EmptyDescription>
        </EmptyHeader>
        <Button onClick={() => window.location.reload()} size="sm" type="button" variant="outline">Try again</Button>
      </Empty>
    </section>
  )
}

function MarketState({ loading = false, message }: { loading?: boolean; message: string }) {
  if (loading) {
    return (
      <section aria-busy="true" aria-live="polite" className="market-state">
        <div className="market-state-loading" role="status">
          <Skeleton />
          <Skeleton />
          <p>{message}</p>
        </div>
      </section>
    )
  }
  return (
    <section aria-live="polite" className="market-state">
      <Empty><EmptyHeader><EmptyDescription>{message}</EmptyDescription></EmptyHeader></Empty>
    </section>
  )
}
