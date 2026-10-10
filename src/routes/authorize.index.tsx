import { useEffect, useSyncExternalStore } from 'react'
import { createFileRoute } from '@tanstack/react-router'

import { AuthorizeFrame, GoogleSignInButton, useViewer } from '../components/auth-gate'
import { pageTitle } from '../domain/site'

/**
 * Where an MCP client's authorization request lands when nobody is signed in.
 *
 * The provider redirects here carrying the whole authorization request as signed query
 * parameters. This page's only job is to get a session and hand that request straight back: it
 * never inspects or rebuilds the parameters, because they are signed as a set and altering any of
 * them invalidates the request.
 *
 * The first version of this pointed `loginPage` at `/connect`, which was then a tab inside the
 * application rather than a route -- so the browser reached a 404 with the authorization request
 * in its address bar and the flow simply stopped. `/connect` is a route now, but it still must not
 * be the login page: it signs a reader in and returns them to itself, never to the request.
 */
export const Route = createFileRoute('/authorize/')({
  component: AuthorizePage,
  head: () => ({ meta: [{ title: pageTitle('Connect your agent') }] }),
})

/**
 * The authorization request is fixed for the life of this page: the provider hands it over once,
 * and anything that would change it navigates away instead. So there is nothing to subscribe to.
 */
const subscribeToQuery = () => () => undefined
const readRawQuery = () => window.location.search

function AuthorizePage() {
  const viewer = useViewer()
  const signedIn = viewer.phase === 'ready' && viewer.user !== null
  // The raw query exactly as it arrived, read from the browser like the consent page does. The
  // router's `searchStr` is re-serialized from parsed parameters and carries a `?` of its own,
  // and the provider verifies its signature over the literal string, so either spelling would
  // invalidate the request. A server pass has no query to read and no reader for one: both uses
  // below wait for the viewer check, which only ever resolves in the browser.
  const rawSearch = useSyncExternalStore(subscribeToQuery, readRawQuery, () => '')

  useEffect(() => {
    if (!signedIn) return
    // Signed in: hand the request back to the provider rather than deciding anything here. It
    // owns what comes next -- consent, or the redirect to the client with a code.
    window.location.replace(`/api/auth/oauth2/authorize${rawSearch}`)
  }, [rawSearch, signedIn])

  return (
    <AuthorizeFrame phase={viewer.phase} title="Connect your agent">
      {viewer.phase === 'ready' && viewer.user === null && (
        <>
          <p>
            An agent is asking to connect to spicytrade as you. Sign in to continue, and you will be
            returned here automatically.
          </p>
          <GoogleSignInButton callbackURL={`/authorize${rawSearch}`} />
        </>
      )}
      {viewer.phase === 'ready' && viewer.user !== null && (
        <p>Signed in as {viewer.user.name}. Continuing…</p>
      )}
    </AuthorizeFrame>
  )
}
