import { type ReactNode, useEffect, useState } from 'react'
import { z } from 'zod'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Button } from '#/components/ui/button'
import { Spinner } from '#/components/ui/spinner'
import { authClient } from '../data/auth-client'
import { toError } from '../domain/failure'
import { BrandMark } from './wordmark'

const ViewerSchema = z.object({
  id: z.string().min(1),
  // Omitted whenever the server's own https check on the Google-supplied URL failed; never
  // repaired here.
  image: z.url({ protocol: /^https$/ }).optional(),
  name: z.string(),
  role: z.enum(['member', 'owner']),
})

export type Viewer = z.infer<typeof ViewerSchema>

const ViewerResponseSchema = z.object({
  user: ViewerSchema.nullable(),
})

type AuthState =
  | { phase: 'checking' }
  | { phase: 'ready'; user: Viewer | null }
  | { message: string; phase: 'error' }

/**
 * The frame every sign-in and approval page shares, so its heading and its unanswered-session
 * line cannot drift between them. Whose page this is comes first, before anything asks for a
 * sign-in or an approval; the mark is not a link, which would lead out of a flow the provider or
 * the terminal expects to finish here. An unanswered session check still says something: without
 * it the page stopped at its heading, and the member could not tell whether to wait or retry.
 */
export function AuthorizeFrame(
  { children, phase, title }: { children: ReactNode; phase: AuthState['phase']; title: string },
) {
  return (
    <main className="authorize-page">
      <div className="authorize-brand"><BrandMark /></div>
      <h1>{title}</h1>
      {phase === 'checking' && <Spinner />}
      {phase === 'error' && (
        <p className="authorize-error">
          spicytrade could not check whether you are signed in. Reload to try again.
        </p>
      )}
      {children}
    </main>
  )
}

export function useViewer(): AuthState {
  const [state, setState] = useState<AuthState>({ phase: 'checking' })

  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/viewer', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    }).then(async (response) => {
      if (!response.ok) throw new Error('Authentication is temporarily unavailable')
      const result = ViewerResponseSchema.parse(await response.json())
      setState({ phase: 'ready', user: result.user })
    }).catch((cause: unknown) => {
      if (controller.signal.aborted) return
      const error = toError(cause)
      setState({ message: error ? error.message : 'Authentication failed', phase: 'error' })
    })
    return () => controller.abort()
  }, [])

  return state
}

function GoogleMark() {
  return (
    <svg aria-hidden="true" data-icon="inline-start" viewBox="0 0 24 24">
      <path d="M21.6 12.23c0-.71-.06-1.4-.18-2.07H12v3.91h5.38a4.6 4.6 0 0 1-2 3.02v2.54h3.24c1.9-1.75 2.98-4.33 2.98-7.4Z" fill="#4285F4" />
      <path d="M12 22c2.7 0 4.98-.9 6.63-2.43l-3.24-2.54c-.9.6-2.05.96-3.39.96-2.61 0-4.82-1.76-5.61-4.13H3.04v2.62A10 10 0 0 0 12 22Z" fill="#34A853" />
      <path d="M6.39 13.86A6 6 0 0 1 6.08 12c0-.65.11-1.28.31-1.86V7.52H3.04A10 10 0 0 0 2 12c0 1.61.39 3.14 1.04 4.48l3.35-2.62Z" fill="#FBBC05" />
      <path d="M12 6.01c1.47 0 2.79.51 3.83 1.5l2.87-2.88A9.62 9.62 0 0 0 12 2a10 10 0 0 0-8.96 5.52l3.35 2.62C7.18 7.77 9.39 6.01 12 6.01Z" fill="#EA4335" />
    </svg>
  )
}
/**
 * `callbackURL` exists for the OAuth authorization page, which must return the browser to the
 * signed authorization request it arrived with, for the Connect view, which returns the reader
 * to itself, and for the terminal sign-in page (`/connect/agent`), which returns with its raw
 * query. Anywhere else a sign-in lands on Watch, the application's own address.
 */
export function GoogleSignInButton(
  { callbackURL = '/watch', compact = false }: { callbackURL?: string; compact?: boolean },
) {
  const [submitting, setSubmitting] = useState(false)
  const [signInError, setSignInError] = useState<string>()
  const beginSignIn = async () => {
    setSubmitting(true)
    setSignInError(undefined)
    try {
      const result = await authClient.signIn.social({ provider: 'google', callbackURL })
      if (result.error) throw new Error(result.error.message ?? 'Google sign-in failed')
    } catch (signInFailure) {
      setSubmitting(false)
      setSignInError(toError(signInFailure)?.message ?? 'Google sign-in failed')
    }
  }

  // The top bar has no room for an alert under its button, so the compact form says it failed
  // in its own label, as the account menu does for sign-out, and keeps the reason on hover.
  const label = submitting
    ? 'Opening Google…'
    : compact
      ? signInError ? 'Sign-in failed — try again' : 'Sign in'
      : 'Continue with Google'
  return (
    <>
      <Button
        className={compact ? 'owner-sign-in' : 'google-sign-in'}
        disabled={submitting}
        onClick={() => void beginSignIn()}
        size={compact ? 'sm' : 'auth'}
        title={compact ? signInError : undefined}
        type="button"
        variant={compact ? 'default' : 'inverted'}
      >
        {!compact && !submitting && <GoogleMark />}
        {submitting && <Spinner data-icon="inline-start" />}
        <span>{label}</span>
      </Button>
      {signInError && !compact && (
        <Alert className="auth-inline-error" variant="destructive">
          <AlertTitle>Google sign-in failed</AlertTitle>
          <AlertDescription>{signInError}</AlertDescription>
        </Alert>
      )}
    </>
  )
}

export function SignInScreen({ authError, callbackURL }: { authError?: string; callbackURL?: string }) {
  return (
    <section className="owner-access" aria-labelledby="owner-access-title">
      <p className="owner-access-kicker">Connect your agent</p>
      <h1 id="owner-access-title">Your agent.<br />Your <em>account.</em></h1>
      <p>Any agent can reach spicytrade&apos;s public tier without an account. Sign in with Google to add live broker-backed quotes, option chains, and Greeks, sync your favorites across devices, and let your agent record research — and, with your own brokerage credentials, read your account and place guarded orders.</p>
      {authError && (
        <Alert className="owner-access-error" variant="destructive">
          <AlertTitle>Sign-in unavailable</AlertTitle>
          <AlertDescription>{authError}</AlertDescription>
        </Alert>
      )}
      <GoogleSignInButton callbackURL={callbackURL} />
    </section>
  )
}
