import { expect, test, type Page } from '@playwright/test'
import { z } from 'zod'

import { SPICE_DEPLOYMENT_ID_HEADER } from '../src/domain/deployment'
import { marketSnapshotFixture } from './fixtures/market'

/** `postDataJSON()` hands back an unparsed body; decode it before the route acts on it. */
const FavoriteMutationRequestSchema = z.object({
  kind: z.enum(['merge', 'remove']),
  symbols: z.array(z.string()),
})

/** On a phone the focus card is a sheet: opened to read it, closed to reach the list again. */
async function openDetail(page: Page, symbol: string): Promise<void> {
  await page.getByRole('button', { name: `Open ${symbol} detail` }).click()
  await expect(page.locator('.instrument-focus')).toBeVisible()
}

async function closeDetail(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Close detail' }).click()
  await expect(page.locator('.instrument-focus')).toHaveCount(0)
}

/** The bottom nav: router links, one per view, the current one marked as the page. */
function primaryLink(page: Page, name: 'Watch' | 'Recommendations' | 'Connect') {
  return page.getByRole('navigation', { name: 'Primary navigation' }).getByRole('link', { exact: true, name })
}

/** Moves to a view through the nav, and proves the address followed. */
async function navigateTo(page: Page, name: 'Watch' | 'Recommendations' | 'Connect'): Promise<void> {
  await primaryLink(page, name).click()
  await expect(page).toHaveURL(new RegExp(`/${name.toLowerCase()}$`))
  await expect(primaryLink(page, name)).toHaveAttribute('aria-current', 'page')
}

function isoDateAfter(days: number): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/**
 * The fixture under the one public watchlist a signed-out reader sees. Given symbols, the list
 * narrows to them and each sparkline keeps its last two points.
 */
function publicWatchSnapshot(symbols?: string[]) {
  const snapshot = marketSnapshotFixture()
  snapshot.watchlists = [{
    id: 'public-options-watch',
    kind: 'public',
    name: 'Options Watch',
    symbols: symbols ?? snapshot.watchlists[0]!.symbols,
  }]
  if (symbols) {
    snapshot.tickers = snapshot.tickers
      .filter((ticker) => symbols.includes(ticker.symbol))
      .map((ticker) => ({ ...ticker, sparkline: ticker.sparkline.slice(-2) }))
  }
  return snapshot
}

test('a newer deployment reloads once before restoring the local snapshot', async ({ page }) => {
  const snapshot = publicWatchSnapshot()
  let documentRequests = 0
  let snapshotRequests = 0
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests += 1
  })
  await page.route('**/api/viewer', (route) => route.fulfill({
    json: { user: null },
  }))
  await page.route('**/api/public-snapshot*', (route) => {
    snapshotRequests += 1
    return route.fulfill({
      headers: { [SPICE_DEPLOYMENT_ID_HEADER]: documentRequests === 1 ? 'next-deployment' : 'development' },
      json: snapshot,
    })
  })

  await page.goto('/')

  await expect.poll(() => documentRequests).toBeGreaterThanOrEqual(2)
  await expect.poll(() => snapshotRequests).toBeGreaterThanOrEqual(2)
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('spice.deployment-reload.v1'))).toBeNull()
})

test('a signed-in member can sign out through the account menu', async ({ page }) => {
  const snapshot = marketSnapshotFixture()
  let signedIn = true
  let signOutRequests = 0
  await page.route('**/api/viewer', (route) => route.fulfill({
    json: { user: signedIn ? { id: 'member-1', name: 'Dana Member', role: 'member' } : null },
  }))
  await page.route('**/api/favorites', (route) => route.fulfill({
    json: { symbols: [] },
  }))
  await page.route('**/api/public-snapshot*', (route) => route.fulfill({
    json: snapshot,
  }))
  await page.route('**/api/auth/sign-out', (route) => {
    signOutRequests += 1
    signedIn = false
    return route.fulfill({ json: { success: true } })
  })

  await page.goto('/')
  const trigger = page.getByRole('button', { name: 'Account menu for Dana Member' })
  await expect(trigger).toBeVisible()
  await trigger.click()
  await expect(page.getByRole('menu')).toContainText('Dana Member')
  await page.getByRole('menuitem', { name: 'Sign out' }).click()

  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  expect(signOutRequests).toBe(1)
})

test('a newer deployment reloads a tab whose unchanged data only ever answers 304', async ({ page }) => {
  // The ETag names the data, not the build, so a quiet market answers an old bundle with 304s
  // for as long as nothing changes. The deployment header on that 304 must still reload the tab.
  const snapshot = publicWatchSnapshot()
  const etag = '"unchanged-market"'
  let documentRequests = 0
  let notModifiedResponses = 0
  page.on('request', (request) => {
    if (request.resourceType() === 'document') documentRequests += 1
  })
  await page.route('**/api/viewer', (route) => route.fulfill({
    json: { user: null },
  }))
  await page.route('**/api/public-snapshot*', (route) => {
    if (route.request().headers()['if-none-match'] === etag) {
      notModifiedResponses += 1
      return route.fulfill({
        status: 304,
        // The reloaded document is the newer build, so from then on the ids agree.
        headers: { ETag: etag, [SPICE_DEPLOYMENT_ID_HEADER]: documentRequests === 1 ? 'next-deployment' : 'development' },
      })
    }
    return route.fulfill({
      headers: { ETag: etag, [SPICE_DEPLOYMENT_ID_HEADER]: 'development' },
      json: snapshot,
    })
  })

  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(page.getByRole('region', { name: 'Options Watch' })).toBeVisible()
  expect(documentRequests).toBe(1)

  // A returning tab refetches on visibility; the 304 it gets back names the newer build.
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect.poll(() => notModifiedResponses).toBeGreaterThanOrEqual(1)
  await expect.poll(() => documentRequests).toBe(2)
  await page.waitForLoadState()
  await expect(page.getByRole('region', { name: 'Options Watch' })).toBeVisible()
  expect(documentRequests).toBe(2)
})

test('each view is an address: a direct load renders it, and moving between them keeps the market', async ({ page }) => {
  const snapshot = publicWatchSnapshot()
  await page.route('**/api/viewer', (route) => route.fulfill({
    json: { user: null },
  }))
  let snapshotRequests = 0
  await page.route('**/api/public-snapshot*', (route) => {
    snapshotRequests += 1
    return route.fulfill({ json: snapshot })
  })

  await page.goto('/recommendations')
  await expect(page).toHaveTitle('Recommendations | spicytrade')
  await expect(page.getByRole('region', { name: 'Trades' })).toBeVisible()
  await expect(primaryLink(page, 'Recommendations')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.last-updated')).toHaveCount(0)

  await page.goto('/connect')
  await expect(page).toHaveTitle('Connect | spicytrade')
  await expect(page.getByRole('heading', { name: 'Connect your agent' })).toBeVisible()
  await expect(primaryLink(page, 'Connect')).toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('navigation', { name: 'Legal and support' })).toBeVisible()

  await page.goto('/watch')
  await expect(page).toHaveTitle('Watch | spicytrade')
  await expect(page.getByRole('region', { name: 'Options Watch' })).toBeVisible()
  await expect(primaryLink(page, 'Watch')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.last-updated')).toContainText('Updated')
  await expect(page.getByRole('navigation', { name: 'Legal and support' })).toHaveCount(0)

  // The old address of the whole application forwards to Watch, keeping what it carried, and
  // leaves no entry behind that would bounce Back straight to Watch again.
  await page.goto('/?from=bookmark#main-content')
  await expect(page).toHaveURL(/\/watch\?from=bookmark#main-content$/)
  await expect(page.getByRole('region', { name: 'Options Watch' })).toBeVisible()
  await page.goBack()
  await expect(page).toHaveURL(/\/watch$/)

  // The views share one layout, so moving between them neither remounts nor refetches the market.
  const settledRequests = snapshotRequests
  await navigateTo(page, 'Recommendations')
  await expect(page.getByRole('region', { name: 'Trades' })).toBeVisible()
  await navigateTo(page, 'Connect')
  await expect(page.getByRole('heading', { name: 'Connect your agent' })).toBeVisible()
  await navigateTo(page, 'Watch')
  await expect(page.getByRole('region', { name: 'Options Watch' })).toBeVisible()
  expect(snapshotRequests).toBe(settledRequests)
})

test('unauthenticated visitors can read market data and the install, and sign in only for tokens', async ({ page }) => {
  const publicSnapshot = publicWatchSnapshot(['SPCX', 'META', 'BE', 'INTC', 'NVDA'])
  publicSnapshot.catalysts = publicSnapshot.catalysts.map((catalyst) => (
    catalyst.symbol === 'NVDA' ? { ...catalyst, date: isoDateAfter(10) } : catalyst
  ))
  publicSnapshot.marketClosesAt = new Date(Date.now() + 6 * 60 * 60 * 1_000).toISOString()
  await page.route('**/api/viewer', (route) => route.fulfill({
    json: { user: null },
  }))
  await page.route('**/api/public-snapshot*', (route) => route.fulfill({
    json: publicSnapshot,
  }))
  await page.addInitScript(() => {
    localStorage.setItem('spice.tickers.v6', 'stale owner ticker rows')
    localStorage.setItem('spice.watchlists.v6', 'stale owner watchlist rows')
    localStorage.setItem('spice.snapshot.v9.previous-deployment', 'incompatible snapshot')
  })
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'Sign in' })).toBeVisible()
  await expect(page.locator('.market-status')).toHaveAttribute('aria-label', /Open/)
  await expect(page.locator('.market-status')).toHaveAttribute('aria-label', /Closes in/)
  // A phone has no hover: a tap is how a reader sees the session, the clock and the countdown.
  await page.locator('.market-status').tap()
  await expect(page.locator('.market-status-tip')).toContainText('Closes in')
  await page.locator('.market-status').tap()
  await expect(page.locator('.market-status-tip')).toHaveCount(0)
  await expect(page.getByText('Premium looks')).toHaveCount(0)
  await expect(page.locator('.intent-label')).toHaveCount(0)
  await expect(page.locator('.watch-list [data-slot="badge"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /NVDA, NVIDIA, Expensive option premium/ })).toBeVisible()
  expect(await page.evaluate(() => Object.keys(localStorage).filter((key) => (
    key.startsWith('spice.snapshot.v')
      || /^spice\.(?:tickers|watchlists|research|recommendations|catalysts|sync-state)\.v/.test(key)
  )))).toEqual(['spice.snapshot.v9'])
  await expect(page.getByRole('button', { name: 'Manage Options Watch' })).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Watchlist' })).toHaveCount(0)
  await expect(page.locator('.watchlist-title')).toHaveText('Watchlist')
  await expect(page.getByRole('region', { name: 'Options Watch' })).toBeVisible()
  // A phone spends no row on an empty rail; it appears once something is pinned.
  await expect(page.getByRole('region', { name: 'Upcoming catalysts' })).toHaveCount(0)
  // The list is the screen; the selected name keeps a two-line strip and the card is a sheet.
  await expect(page.locator('.focus-strip-symbol')).toHaveText('NVDA')
  await expect(page.locator('.focus-strip-read')).toContainText('Expensive 72')
  await expect(page.locator('.instrument-focus')).toHaveCount(0)
  await openDetail(page, 'NVDA')
  await expect(page.locator('.selected-instrument')).toContainText('NVIDIA')
  await expect(page.locator('.focus-tape')).toContainText('Front +6.6 pts')
  await expect(page.locator('.selected-price')).toContainText('$191.68')
  await expect(page.locator('.focus-freshness')).toContainText('Quote')
  await closeDetail(page)
  // A phone gets the list, not the table: the sort is one control, and no row scrolls sideways.
  await expect(page.locator('.premium-data-table')).toHaveCount(0)
  await expect(page.getByRole('combobox', { name: 'Sort by' })).toHaveValue('volume')
  await expect(page.locator('.watch-list .session-sparkline')).toHaveCount(0)
  const nvdaRow = page.locator('.watch-list .watch-row', { hasText: 'NVDA' })
  expect(await nvdaRow.evaluate((row) => row.scrollWidth <= row.clientWidth)).toBe(true)
  await expect(nvdaRow.locator('.watch-pill')).toHaveText('128.4M')
  // Liquidity and lendability read from the focus tape for the selected name.
  await openDetail(page, 'NVDA')
  await expect(page.locator('.focus-tape')).toContainText('5/5')
  await expect(page.locator('.focus-tape')).toContainText('Easy To Borrow')
  await expect(page.locator('.focus-tape')).not.toContainText('borrow')
  await closeDetail(page)
  await page.getByRole('button', { name: 'Pin META' }).click()
  await expect(page.locator('.watch-list .watch-row').first()).toContainText('META')
  await expect(page.getByRole('region', { name: 'Upcoming catalysts' })).toBeVisible()
  await expect(page.getByText('No pinned catalysts are scheduled.')).toBeVisible()
  await page.getByRole('button', { name: 'Pin NVDA' }).click()
  await expect(page.locator('.story')).toHaveCount(1)
  await expect(page.locator('.story').first()).toContainText('NVDA')
  await page.reload()
  await expect(page.getByRole('button', { name: 'Unpin META' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByRole('button', { name: 'Unpin NVDA' })).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.story').first()).toContainText('NVDA')
  await expect(page.getByText('Long vol')).toHaveCount(0)

  await navigateTo(page, 'Connect')
  // Installing needs no web session: the CLI's own sign-in opens the browser.
  await expect(page.getByText('Message to your agent', { exact: true })).toBeVisible()
  await page.getByRole('heading', { name: 'Manual installation' }).click()
  await expect(page.getByText('curl -fsSL https://spicy.trade/install.sh | bash')).toBeVisible()
  await page.getByRole('heading', { name: 'Signed-in computers' }).click()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible()

  await expect(page.getByRole('link', { name: 'Support' }).first()).toHaveAttribute('href', 'mailto:support@spicy.trade')

  await page.goto('/privacy')
  await expect(page.getByRole('heading', { name: 'Privacy policy' })).toBeVisible()
  await expect(page.getByRole('link', { name: 'privacy@spicy.trade' }).first()).toHaveAttribute('href', 'mailto:privacy@spicy.trade')
})

test('mobile market, recommendations, search, sorting, and connect flows remain coherent', async ({ page, context }) => {
  const snapshot = marketSnapshotFixture()
  let rejectSnapshots = false
  snapshot.catalysts.forEach((catalyst, index) => {
    catalyst.date = isoDateAfter(10 + index * 7)
  })
  await page.route('**/api/viewer', (route) => route.fulfill({
    json: { user: { id: 'owner-1', name: 'Owner', role: 'owner' } },
  }))
  await page.route('**/api/mcp-tokens', (route) => route.fulfill({
    json: { tokens: [] },
  }))
  await page.route('**/api/snapshot*', (route) => {
    if (rejectSnapshots) {
      return route.fulfill({ status: 503, body: '{}' })
    }
    return route.fulfill({
      json: snapshot,
    })
  })
  // The loaded list is a slice of the market: a search it cannot answer reaches the
  // server, which resolves the symbol and admits it to the maintained list.
  const symbolSearches: string[] = []
  await page.route('**/api/public-symbol-search*', (route) => {
    const query = new URL(route.request().url()).searchParams.get('q') ?? ''
    symbolSearches.push(query)
    if (!query.toUpperCase().startsWith('TQQQ')) {
      return route.fulfill({ status: 404, json: { error: 'none' } })
    }
    return route.fulfill({
      json: {
        catalysts: [],
        watchlisted: true,
        ticker: {
          symbol: 'TQQQ', name: 'ProShares UltraPro QQQ', assetType: 'etf',
          price: 92.4, change: 1.2, changePercent: 1.32, sparkline: [],
          ivRank: 41, ivPercentile: 47, ivIndex: 52.6,
          earningsDate: null, updatedAt: '2026-09-01T13:31:00.000Z',
        },
      },
    })
  })
  await page.route('**/api/public-catalysts*', (route) => route.fulfill({
    json: { catalysts: [] },
  }))
  await page.route('**/api/public-year-candles', (route) => route.fulfill({
    json: { series: [] },
  }))
  const catalystRefreshes: string[] = []
  await page.route('**/api/public-catalyst-refresh', async (route) => {
    catalystRefreshes.push(String(route.request().postDataJSON().symbol))
    // The route's real answer. One it cannot parse reads as a failed search, which is asked
    // again on the next look -- a different flow from the one this test follows.
    await route.fulfill({ json: { catalysts: [], ran: true } })
  })
  const ownerFavorites = new Set<string>()
  await page.route('**/api/favorites', async (route) => {
    if (route.request().method() === 'POST') {
      const action = FavoriteMutationRequestSchema.parse(route.request().postDataJSON())
      if (action.kind === 'merge') action.symbols.forEach((symbol) => ownerFavorites.add(symbol))
      else action.symbols.forEach((symbol) => ownerFavorites.delete(symbol))
    }
    await route.fulfill({
      json: { symbols: [...ownerFavorites].sort() },
    })
  })
  await page.goto('/')
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest')
  await expect(page.locator('.brand')).toHaveAccessibleName('spicytrade home')
  await expect(page.locator('.brand')).toHaveText('spicytrade')
  await expect(page.getByText('tastytrade live')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sync|refresh market data/i })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /sign out/i })).toHaveCount(0)
  await expect(page.getByText('Premium looks')).toHaveCount(0)
  await expect(page.locator('.intent-label')).toHaveCount(0)
  await expect(page.locator('.watch-list [data-slot="badge"]')).toHaveCount(0)
  await expect(page.getByRole('button', { name: /NVDA, NVIDIA, Expensive option premium/ })).toBeVisible()
  // `/` is the old address of the whole application; it lands on Watch.
  await expect(page).toHaveURL(/\/watch$/)
  await expect(primaryLink(page, 'Watch')).toHaveAttribute('aria-current', 'page')
  await expect(page.locator('.focus-strip .strip-verdict')).toHaveText('Expensive')
  // The rail appears with the first pin; a phone spends no row on it empty.
  await expect(page.getByRole('region', { name: 'Upcoming catalysts' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Pin NVDA' }).click()
  await expect(page.getByRole('region', { name: 'Upcoming catalysts' })).toBeVisible()
  await expect(page.locator('.story')).toHaveCount(1)
  await page.getByRole('button', { name: 'Pin TSLA' }).click()
  await expect(page.locator('.story')).toHaveCount(2)
  await expect(page.locator('.story').first()).toContainText('NVDA')
  await expect(page.locator('.story').first()).toContainText('EARN')
  // A story tap selects and opens the sheet, as a row tap does.
  await page.getByRole('button', { name: /TSLA: TSLA earnings/ }).click()
  await expect(page.locator('.selected-symbol')).toHaveText('TSLA')
  await closeDetail(page)
  await page.getByRole('button', { name: /NVDA: NVDA earnings/ }).click()
  await expect(page.locator('.selected-symbol')).toHaveText('NVDA')
  await expect(page.locator('.focus-runway')).toContainText('NVDA earnings')
  await expect(page.locator('.runway-kind').first()).toContainText('earnings \u00b7 After hours')
  await expect(page.locator('.runway-kind').first()).toContainText('estimated \u00b7 as of')
  await closeDetail(page)
  await expect(page.locator('.watchlist-title')).toHaveText('Watchlist')
  await expect(page.getByRole('combobox', { name: 'Watchlist' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /SPCX, SpaceX Corporation, Cheap/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /BE, Bloom Energy, Fair/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /INTC, Intel, Cheap/ })).toBeVisible()

  const selectedSymbol = page.locator('.selected-symbol')
  const search = page.getByLabel('Search all symbols')
  await search.fill('intel')
  await expect(page.locator('.watch-list .watch-row')).toHaveCount(1)
  await page.getByRole('button', { name: /INTC, Intel, Cheap/ }).click()
  await expect(selectedSymbol).toHaveText('INTC')
  await page.reload()
  // The selection survives the reload; the sheet does not, so the strip is what says so.
  await expect(page.locator('.focus-strip-symbol')).toHaveText('INTC')
  await search.fill('zzzz')
  await expect(page.getByText('No listed symbol matches your search.')).toBeVisible()

  // A symbol outside the loaded list arrives as an ordinary row, and favoriting it is
  // what asks the server to seed its catalysts.
  await search.fill('TQQQ')
  const searchedRow = page.getByRole('button', { name: /TQQQ, ProShares UltraPro QQQ/ })
  await expect(searchedRow).toBeVisible()
  await page.getByRole('button', { name: 'Pin TQQQ' }).click()
  // Attention is what asks: the two favorites pinned earlier, then INTC — selected above
  // with nothing on its calendar, and asked for again after the reload that restored it —
  // and finally the searched symbol as it is favorited. The server's own window decides
  // which of these actually buys a search.
  await expect.poll(() => catalystRefreshes).toEqual(['NVDA', 'TSLA', 'INTC', 'INTC', 'TQQQ'])
  expect(symbolSearches).toEqual(expect.arrayContaining(['ZZZZ', 'TQQQ']))
  expect(symbolSearches.filter((query) => query === 'TQQQ')).toHaveLength(1)
  await search.fill('')

  const rows = page.locator('.watch-list .watch-row')
  const sortBy = page.getByRole('combobox', { name: 'Sort by' })
  await sortBy.selectOption('premium')
  await expect(rows.nth(0)).toContainText('TSLA')
  await expect(rows.nth(1)).toContainText('NVDA')
  await expect(rows.nth(1).locator('.watch-pill')).toHaveText('Expensive 72')
  await page.getByRole('button', { name: 'Sort ascending' }).click()
  // Favorites stay on top in either direction; the metric orders each group.
  await expect(rows.nth(0)).toContainText('TQQQ')
  await expect(rows.nth(1)).toContainText('NVDA')
  await expect(rows.nth(2)).toContainText('TSLA')
  await expect(rows.nth(3)).toContainText('SPY')
  await expect(page.locator('.watch-list .session-sparkline')).toHaveCount(11)
  // The discovered favorite survives clearing search, and opens its own details.
  await searchedRow.click()
  await expect(selectedSymbol).toHaveText('TQQQ')
  await closeDetail(page)

  await navigateTo(page, 'Recommendations')
  await expect(primaryLink(page, 'Watch')).not.toHaveAttribute('aria-current', 'page')
  await expect(page.getByRole('region', { name: 'Trades' })).toBeVisible()
  // The age describes the market, so it is shown only where the market is.
  await expect(page.locator('.last-updated')).toHaveCount(0)
  // A trade line in the brief is a way into the market: it selects the name and moves to Watch.
  await page.locator('.brief-card').getByRole('button', { name: /NVDA/ }).first().click()
  await expect(page).toHaveURL(/\/watch$/)
  await expect(page.locator('.focus-strip-symbol')).toHaveText('NVDA')
  await page.goBack()
  await expect(page).toHaveURL(/\/recommendations$/)
  await expect(page.getByRole('region', { name: 'Trades' })).toBeVisible()
  await page.goForward()
  await expect(page).toHaveURL(/\/watch$/)
  await page.getByRole('button', { name: /INTC, Intel, Cheap/ }).click()
  await expect(selectedSymbol).toHaveText('INTC')
  await closeDetail(page)

  await navigateTo(page, 'Connect')
  // A signed-in member is first class here: the setup surface is theirs, not the owner's.
  await expect(page.getByRole('heading', { name: 'Connect your agent' })).toBeVisible()
  // The optional steps are folded; token issuance is one tap away, under its own heading.
  await expect(page.getByRole('button', { name: 'Create token' })).toBeHidden()
  await page.getByRole('heading', { name: 'Without installing' }).click()
  await page.getByRole('heading', { name: 'Signed-in computers' }).click()
  await expect(page.getByRole('button', { name: 'Create token' })).toBeVisible()
  // Tokens and shell commands are long unbreakable strings; with every step open they must wrap
  // inside their own block rather than push the page sideways. A screenshot caught this when
  // tests did not.
  expect(await page.evaluate(() => document.documentElement.scrollWidth))
    .toBeLessThanOrEqual(await page.evaluate(() => document.documentElement.clientWidth))

  await context.setOffline(true)
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
  await navigateTo(page, 'Watch')
  // Going offline is not an alarm. The saved data stays on screen with the reader's selection
  // intact, and the top bar's age line is what says how current it is — a reconnecting feed
  // and a failed sync used to flash a stale-data banner on and off over nothing.
  await expect(page.getByRole('alert')).toHaveCount(0)
  await expect(page.locator('.last-updated')).toContainText('Updated')
  await expect(page.locator('.focus-strip-symbol')).toHaveText('INTC')

  rejectSnapshots = true
  await context.setOffline(false)
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(page.locator('.focus-strip-symbol')).toHaveText('INTC')
  await expect(page.getByRole('alert')).toHaveCount(0)
})

test('authenticated favorites consume only unchanged anonymous staging across tabs', async ({ context, page }) => {
  test.setTimeout(60_000)
  const snapshot = publicWatchSnapshot(['NVDA', 'META', 'INTC'])
  const serverFavorites = new Set<string>()
  const anonymousMerges: string[][] = []
  let signedIn = false
  let delayFirstMerge = true
  let releaseFirstMerge: () => void = () => undefined
  let signalFirstMerge: () => void = () => undefined
  const firstMergeReleased = new Promise<void>((resolve) => {
    releaseFirstMerge = resolve
  })
  const firstMergeStarted = new Promise<void>((resolve) => {
    signalFirstMerge = resolve
  })

  await page.route('**/api/viewer', (route) => route.fulfill({
    json: {
      user: signedIn ? { id: 'member-1', name: 'Member', role: 'member' } : null,
    },
  }))
  await page.route('**/api/public-snapshot*', (route) => route.fulfill({
    json: snapshot,
  }))
  await page.route('**/api/favorites', async (route) => {
    if (route.request().method() === 'POST') {
      const action = FavoriteMutationRequestSchema.parse(route.request().postDataJSON())
      if (action.kind === 'merge') {
        anonymousMerges.push(action.symbols)
        if (delayFirstMerge) {
          delayFirstMerge = false
          signalFirstMerge()
          await firstMergeReleased
        }
        action.symbols.forEach((symbol) => serverFavorites.add(symbol))
      } else {
        action.symbols.forEach((symbol) => serverFavorites.delete(symbol))
      }
    }
    await route.fulfill({
      json: { symbols: [...serverFavorites].sort() },
    })
  })
  await page.addInitScript(() => {
    window.sessionStorage.setItem('spice.test.block-preference-storage', 'true')
    window.addEventListener('storage', (event) => {
      if (
        event.key !== 'spice.preferences.v2'
        || window.sessionStorage.getItem('spice.test.block-preference-storage') !== 'true'
      ) return
      event.stopImmediatePropagation()
      window.sessionStorage.setItem('spice.test.blocked-preference-value', event.newValue ?? '')
    }, { capture: true })
  })

  await page.goto('/')
  await page.getByRole('button', { name: 'Pin NVDA' }).click()

  const staleAnonymous = await context.newPage()
  await staleAnonymous.route('**/api/viewer', (route) => route.fulfill({
    json: { user: null },
  }))
  await staleAnonymous.route('**/api/public-snapshot*', (route) => route.fulfill({
    json: snapshot,
  }))
  await staleAnonymous.goto('/')
  await expect(staleAnonymous.getByRole('button', { name: 'Unpin NVDA' })).toBeVisible()

  signedIn = true
  const signedInReload = page.reload()
  await firstMergeStarted
  await staleAnonymous.getByRole('button', { name: 'Pin META' }).click()
  await expect(staleAnonymous.getByRole('button', { name: 'Unpin META' })).toBeVisible()
  releaseFirstMerge()
  await signedInReload
  await expect(page.getByRole('button', { name: 'Unpin NVDA' })).toBeVisible()

  expect(await page.evaluate(() => {
    const newValue = window.sessionStorage.getItem('spice.test.blocked-preference-value')
    if (!newValue) return false
    window.sessionStorage.removeItem('spice.test.block-preference-storage')
    window.dispatchEvent(new StorageEvent('storage', {
      key: 'spice.preferences.v2',
      newValue,
      storageArea: window.localStorage,
      url: window.location.href,
    }))
    return true
  })).toBe(true)
  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByRole('button', { name: 'Unpin META' })).toBeVisible()
  expect(anonymousMerges.some((symbols) => symbols.includes('NVDA') && symbols.includes('META'))).toBe(true)

  await staleAnonymous.bringToFront()
  await expect(staleAnonymous.getByRole('button', { name: 'Pin NVDA' })).toBeVisible()
  const authenticatedTabObservedStage = page.evaluate(() => new Promise<boolean>((resolve) => {
    const observePreference = (event: StorageEvent) => {
      if (event.key !== 'spice.preferences.v2') return
      window.removeEventListener('storage', observePreference)
      resolve(event.storageArea === window.localStorage)
    }
    window.addEventListener('storage', observePreference)
  }))
  await staleAnonymous.getByRole('button', { name: 'Pin INTC' }).click()
  expect(await authenticatedTabObservedStage).toBe(true)
  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByRole('button', { name: 'Unpin INTC' })).toBeVisible()
  expect(serverFavorites).toEqual(new Set(['INTC', 'META', 'NVDA']))
  await staleAnonymous.close()
})

test('two signed-out devices converge on the account union without granting owner access', async ({ browser, page }) => {
  test.setTimeout(60_000)
  const snapshot = publicWatchSnapshot(['NVDA', 'SPCX', 'META', 'BE', 'INTC'])
  let laptopSignedIn = false
  let mobileSignedIn = false
  let ownerSnapshotRequests = 0
  let rejectNextFavoriteMutation = false
  let rejectedFavoriteMutations = 0
  const serverFavorites = new Set(['BE'])
  const anonymousMerges: string[][] = []

  // Both devices share the one server state below, so they must be stubbed identically:
  // a difference between the two route sets would make them diverge for reasons unrelated
  // to the convergence under test.
  const stubDevice = async (target: Page, signedIn: () => boolean) => {
    await target.route('**/api/viewer', (route) => route.fulfill({
      json: {
        user: signedIn() ? { id: 'member-1', name: 'Member', role: 'member' } : null,
      },
    }))
    await target.route('**/api/mcp-tokens', (route) => route.fulfill({
      json: { tokens: [] },
    }))
    await target.route('**/api/public-snapshot*', (route) => route.fulfill({
      json: snapshot,
    }))
    await target.route('**/api/snapshot*', (route) => {
      ownerSnapshotRequests += 1
      return route.fulfill({ status: 403, body: '{}' })
    })
    await target.route('**/api/favorites', async (route) => {
      if (route.request().method() === 'POST') {
        if (rejectNextFavoriteMutation) {
          rejectNextFavoriteMutation = false
          rejectedFavoriteMutations += 1
          await route.fulfill({ status: 503, body: '{"error":"temporarily unavailable"}' })
          return
        }
        const action = FavoriteMutationRequestSchema.parse(route.request().postDataJSON())
        if (action.kind === 'merge') {
          anonymousMerges.push(action.symbols)
          action.symbols.forEach((symbol) => serverFavorites.add(symbol))
        } else {
          action.symbols.forEach((symbol) => serverFavorites.delete(symbol))
        }
      }
      await route.fulfill({
        json: { symbols: [...serverFavorites].sort() },
      })
    })
  }

  await stubDevice(page, () => laptopSignedIn)

  await page.goto('/')
  await page.getByRole('button', { name: 'Pin NVDA' }).click()
  await page.getByRole('button', { name: 'Pin META' }).click()
  laptopSignedIn = true
  await page.reload()

  await expect(page.getByRole('button', { name: 'Unpin BE' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unpin META' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unpin NVDA' })).toBeVisible()
  expect(anonymousMerges.some((symbols) => symbols.includes('META') && symbols.includes('NVDA'))).toBe(true)
  expect(ownerSnapshotRequests).toBe(0)

  const mobileContext = await browser.newContext()
  const mobile = await mobileContext.newPage()
  await stubDevice(mobile, () => mobileSignedIn)

  await mobile.goto('/')
  await mobile.getByRole('button', { name: 'Pin SPCX' }).click()
  await mobile.getByRole('button', { name: 'Pin INTC' }).click()
  mobileSignedIn = true
  await mobile.reload()
  await expect(mobile.getByRole('button', { name: 'Unpin META' })).toBeVisible()
  await expect(mobile.getByRole('button', { name: 'Unpin NVDA' })).toBeVisible()
  await expect(mobile.getByRole('button', { name: 'Unpin SPCX' })).toBeVisible()
  await expect(mobile.getByRole('button', { name: 'Unpin INTC' })).toBeVisible()
  expect(anonymousMerges.some((symbols) => symbols.includes('INTC') && symbols.includes('SPCX'))).toBe(true)

  await page.bringToFront()
  await page.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(page.getByRole('button', { name: 'Unpin SPCX' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unpin INTC' })).toBeVisible()

  rejectNextFavoriteMutation = true
  await mobile.getByRole('button', { name: 'Unpin NVDA' }).click()
  await expect.poll(() => rejectedFavoriteMutations).toBe(1)
  await expect(mobile.getByRole('alert')).toContainText('Favorite update failed')
  await expect(mobile.getByRole('alert')).toContainText('Favorite sync failed (503)')
  await expect(mobile.getByRole('button', { name: 'Unpin NVDA' })).toBeVisible()

  await page.getByRole('button', { name: 'Unpin META' }).click()
  await mobile.bringToFront()
  await mobile.evaluate(() => window.dispatchEvent(new Event('visibilitychange')))
  await expect(mobile.getByRole('button', { name: 'Pin META' })).toBeVisible()
  await page.reload()
  await expect(page.getByRole('button', { name: 'Pin META' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Unpin BE' })).toBeVisible()
  await navigateTo(page, 'Connect')
  await expect(page.getByRole('heading', { name: 'Connect your agent' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0)
  expect(ownerSnapshotRequests).toBe(0)
  await mobileContext.close()
})

test('watch gives a no-JavaScript reader a snapshot or explicit unavailability', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, javaScriptEnabled: false })
  try {
    const page = await context.newPage()
    await page.goto('/watch')
    const summary = page.getByRole('region', { name: 'Market snapshot' })
    await expect(summary.getByRole('heading', { name: 'Options Watch' })).toBeVisible()
    // Local runs may have no provider bindings; that must be visible to the reader too.
    await expect(summary).toContainText(/updated|Market snapshot is temporarily unavailable/)
    await expect(summary.getByRole('link', { name: 'risk disclosures' })).toHaveAttribute('href', '/disclosures')
  } finally {
    await context.close()
  }
})
