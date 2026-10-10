import { useState, useSyncExternalStore } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { Button } from '#/components/ui/button'
import { Spinner } from '#/components/ui/spinner'
import { AuthorizeFrame, GoogleSignInButton, useViewer } from '../components/auth-gate'
import { AgentLoginApproveResponseSchema, AgentLoginPageQuerySchema } from '../domain/agent-login'
import { pageTitle } from '../domain/site'
import { toError } from '../domain/failure'

/**
 * Where `spicytrade login` sends the browser: the member approves the terminal on their own
 * machine, and the browser is handed back to that terminal's loopback listener with a one-time
 * code. The flow and why the token never rides in a URL are in `src/domain/agent-login.ts`.
 *
 * The destination is only ever `127.0.0.1` on the port the CLI put in this address, never a host
 * read from the request, so approving can deliver a code to nothing but a process on the machine
 * this browser runs on -- and that code redeems only with the verifier the CLI kept. The state is
 * the CLI's check that the return is its own; it is echoed back and never posted here.
 */
export const Route = createFileRoute('/connect/agent')({
  component: ConnectAgentPage,
  head: () => ({ meta: [{ title: pageTitle('Connect your terminal') }] }),
})

/** The literal address rather than `localhost`, which a resolver may map elsewhere. */
const LOOPBACK_HOST = '127.0.0.1'
const LOOPBACK_CALLBACK_PATH = '/callback'
const ErrorResponseSchema = z.object({ error: z.string().min(1) })
const APPROVAL_NOT_RECORDED = 'spicytrade could not record that approval.'

/** The address is fixed for the life of this page, so there is nothing to subscribe to. */
const subscribeToQuery = () => () => undefined
const readRawQuery = () => window.location.search

/**
 * Read from the raw query rather than the router's parsed search, which JSON-decodes values: a
 * machine named `2024` would arrive as a number and fail the label check it should pass.
 */
function parseQuery(rawSearch: string) {
  return AgentLoginPageQuerySchema.safeParse(Object.fromEntries(new URLSearchParams(rawSearch)))
}

function loopbackReturn(port: number, params: Record<string, string>): string {
  const destination = new URL(`http://${LOOPBACK_HOST}:${port}${LOOPBACK_CALLBACK_PATH}`)
  for (const [name, value] of Object.entries(params)) destination.searchParams.set(name, value)
  return destination.toString()
}

function ConnectAgentPage() {
  const viewer = useViewer()
  // Empty on the server pass; every use below waits for the viewer check, which resolves only in
  // the browser.
  const rawSearch = useSyncExternalStore(subscribeToQuery, readRawQuery, () => '')
  const query = parseQuery(rawSearch)
  const [submitting, setSubmitting] = useState<'approve' | 'cancel'>()
  const [failure, setFailure] = useState<string>()

  const approve = async (port: number, codeChallenge: string, label: string, state: string) => {
    setSubmitting('approve')
    setFailure(undefined)
    try {
      const response = await fetch('/api/agent-logins', {
        body: JSON.stringify({ codeChallenge, label, port }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      const body: unknown = await response.json().catch(() => undefined)
      if (!response.ok) throw new Error(ErrorResponseSchema.safeParse(body).data?.error ?? APPROVAL_NOT_RECORDED)
      const approved = AgentLoginApproveResponseSchema.safeParse(body)
      if (!approved.success) throw new Error(APPROVAL_NOT_RECORDED)
      window.location.replace(loopbackReturn(port, { code: approved.data.code, state }))
    } catch (error) {
      setSubmitting(undefined)
      setFailure(toError(error)?.message ?? APPROVAL_NOT_RECORDED)
    }
  }

  // A refusal is an answer the CLI is waiting for, so it goes back too rather than leaving the
  // terminal to time out.
  const cancel = (port: number, state: string) => {
    setSubmitting('cancel')
    window.location.replace(loopbackReturn(port, { error: 'access_denied', state }))
  }

  return (
    <AuthorizeFrame phase={viewer.phase} title="Connect your terminal">
      {viewer.phase === 'ready' && !query.success && (
        <p className="authorize-error">
          This sign-in link is incomplete or malformed. Run <code>spicytrade login</code> again from your
          terminal.
        </p>
      )}
      {viewer.phase === 'ready' && query.success && viewer.user === null && (
        <>
          <p>
            A terminal on <strong>{query.data.label}</strong> is asking to connect to spicytrade as you.
            Sign in to continue, and you will be returned here.
          </p>
          <GoogleSignInButton callbackURL={`/connect/agent${rawSearch}`} />
        </>
      )}
      {viewer.phase === 'ready' && query.success && viewer.user !== null && (
        <>
          <p>
            Connect the terminal on <strong>{query.data.label}</strong> to spicytrade, signed in as{' '}
            <strong>{viewer.user.name}</strong>?
          </p>
          <p>
            Approving creates an agent token for that machine. It is stored only in that machine&apos;s
            keyring, and you can revoke it any time from the Connect tab.
          </p>
          <p>Approve only if you just ran <code>spicytrade</code> on this computer.</p>
          {failure && <p className="authorize-error">{failure}</p>}
          <div className="authorize-actions">
            <Button
              disabled={submitting !== undefined}
              onClick={() => void approve(query.data.port, query.data.challenge, query.data.label, query.data.state)}
              type="button"
            >
              {submitting === 'approve' ? <Spinner data-icon="inline-start" /> : null}
              <span>Approve</span>
            </Button>
            <Button
              disabled={submitting !== undefined}
              onClick={() => cancel(query.data.port, query.data.state)}
              type="button"
              variant="outline"
            >
              <span>Cancel</span>
            </Button>
          </div>
        </>
      )}
    </AuthorizeFrame>
  )
}
