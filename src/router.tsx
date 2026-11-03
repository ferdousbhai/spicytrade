import { createRouter as createTanStackRouter } from '@tanstack/react-router'
import { getGlobalStartContext } from '@tanstack/react-start'
import { routeTree } from './routeTree.gen'

/** The Worker's per-request nonce on the server (`server.ts`); undefined in the browser. */
function documentNonce(): string | undefined {
  // SAFETY: Start seeds this context from `handler.fetch`'s `context`, which `Register['server']`
  // below requires to carry `nonce`; the installed types resolve the read to `never` regardless.
  return (getGlobalStartContext() as { nonce?: string } | undefined)?.nonce
}

export function getRouter() {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreload: 'intent',
    defaultPreloadStaleTime: 0,
    // The document CSP requires it of every script. In the browser the router reads it back
    // from the document's `csp-nonce` meta tag instead.
    ssr: { nonce: documentNonce() },
  })

  return router
}

declare module '@tanstack/react-router' {
  interface Register {
    router: ReturnType<typeof getRouter>
    /** What `server.ts` hands every render, so a document cannot be rendered without its nonce. */
    server: { requestContext: { nonce: string } }
  }
}
