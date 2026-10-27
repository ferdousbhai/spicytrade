import { HeadContent, Link, Scripts, createRootRoute } from '@tanstack/react-router'
import { useEffect, useState } from 'react'

import { SitePage } from '#/components/site-page'
import { TooltipProvider } from '#/components/ui/tooltip'
import { bootRecoveryScript } from '../boot-recovery'
import { PUBLIC_SNAPSHOT_URL } from '../deployment'
import appCss from '../styles.css?url'
import { SITE_DESCRIPTION, SITE_NAME, SITE_ORIGIN } from '../domain/site'

export const Route = createRootRoute({
  head: () => ({
    meta: [
      {
        charSet: 'utf-8',
      },
      {
        name: 'viewport',
        content: 'width=device-width, initial-scale=1, viewport-fit=cover',
      },
      {
        name: 'theme-color',
        content: '#000000',
      },
      {
        name: 'apple-mobile-web-app-capable',
        content: 'yes',
      },
      {
        name: 'apple-mobile-web-app-status-bar-style',
        content: 'black-translucent',
      },
      {
        title: SITE_NAME,
      },
      {
        name: 'description',
        content: SITE_DESCRIPTION,
      },
      // Link previews read these from the server-rendered document; the shell itself is client-rendered.
      { property: 'og:type', content: 'website' },
      { property: 'og:site_name', content: SITE_NAME },
      { property: 'og:title', content: SITE_NAME },
      { property: 'og:description', content: SITE_DESCRIPTION },
      { property: 'og:image', content: `${SITE_ORIGIN}/spice-mark-512.png` },
      { name: 'twitter:card', content: 'summary' },
      { name: 'twitter:title', content: SITE_NAME },
      { name: 'twitter:description', content: SITE_DESCRIPTION },
      { name: 'twitter:image', content: `${SITE_ORIGIN}/spice-mark-512.png` },
    ],
    links: [
      // Starts the public boot read alongside the bundle. `syncFromCloud` only reuses this
      // preload while both sides stay a plain CORS fetch, so keep `crossOrigin` here and
      // request headers off the public read there.
      {
        rel: 'preload',
        href: PUBLIC_SNAPSHOT_URL,
        as: 'fetch',
        crossOrigin: 'anonymous',
      },
      {
        rel: 'stylesheet',
        href: appCss,
      },
      {
        rel: 'manifest',
        href: '/manifest.webmanifest',
      },
      {
        rel: 'icon',
        href: '/spice-mark.svg',
      },
      {
        rel: 'apple-touch-icon',
        href: '/spice-mark-180.png',
      },
    ],
  }),
  notFoundComponent: NotFoundPage,
  shellComponent: RootDocument,
})

/** An address that names no page: the site's own frame, and the one way back to the market. */
function NotFoundPage() {
  return (
    <SitePage intro="This address doesn't match a spicytrade page. It may have moved, or the link may be mistyped." title="Page not found">
      <section>
        <h2>Where to go instead</h2>
        <p>The watchlist is at <Link to="/watch">/watch</Link>, the daily brief at <Link to="/recommendations">/recommendations</Link>, and agent setup at <Link to="/connect">/connect</Link>.</p>
      </section>
    </SitePage>
  )
}

function RootDocument({ children }: { children: React.ReactNode }) {
  return (
    <html className="dark" lang="en">
      <head>
        <HeadContent />
        <script dangerouslySetInnerHTML={{ __html: bootRecoveryScript() }} />
      </head>
      <body>
        <TooltipProvider>{children}</TooltipProvider>
        <BootSignal />
        <LegacyServiceWorkerRetirement />

        <Scripts />
      </body>
    </html>
  )
}

const LEGACY_SPICE_CACHE_PREFIX = 'spice-public-shell-'

async function clearLegacySpiceCaches(): Promise<void> {
  if (!('caches' in globalThis)) return
  const names = await caches.keys()
  await Promise.all(names
    .filter((name) => name.startsWith(LEGACY_SPICE_CACHE_PREFIX))
    .map((name) => caches.delete(name)))
}

async function retireLegacyServiceWorker(): Promise<void> {
  // The worker clears caches on activation now, which is the path that survives a document
  // its own code cannot load. This covers the other case: caches orphaned by a worker that
  // is already gone, where no activation will ever come.
  await clearLegacySpiceCaches()
  const registration = await navigator.serviceWorker.getRegistration('/')
  if (registration) {
    // Registering the same URL updates the installed offline-shell worker to the
    // recovery-only worker, which clears its caches and unregisters itself.
    await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' })
  }
}

declare global {
  /** Installed by the inline recovery guard in the document head, before any module runs. */
  var __spiceBooted: (() => void) | undefined
}

/** Rendering at all is the proof the entry module ran; the recovery guard needs nothing more. */
function BootSignal() {
  useEffect(() => {
    globalThis.__spiceBooted?.()
  }, [])
  return null
}

function LegacyServiceWorkerRetirement() {
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return
    void retireLegacyServiceWorker().catch((cause: unknown) => {
      console.error('LegacyServiceWorkerRetirementFailed', cause)
      setFailed(true)
    })
  }, [])
  return failed ? (
    <aside className="service-worker-error" role="alert">
      spicytrade could not clear an obsolete offline copy. Clear this site's browser data, then reload.
    </aside>
  ) : null
}
