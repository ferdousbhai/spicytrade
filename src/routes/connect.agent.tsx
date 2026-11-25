import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Spinner } from '#/components/ui/spinner'
import { AuthorizeFrame, GoogleSignInButton, useRawQuery, useViewer } from '../components/auth-gate'
import { AgentLoginApproveResponseSchema, AgentLoginPageQuerySchema, ConnectCodeSchema } from '../domain/agent-login'
import { pageTitle } from '../domain/site'
import { toError } from '../domain/failure'

/**
 * Where the `spicytrade` CLI sends the member: they approve the computer that printed this link,
 * in any browser, and the CLI collects the result by polling. With a brokerage in the link, the
 * approval goes straight on to that broker's own consent page. The flow is in
 * `src/domain/agent-login.ts`.
 *
 * Nothing here proves this browser belongs to the computer being approved, so the link alone
 * approves nothing: the member types the code that computer's terminal printed, which is not in
 * the link. The label, which the link's author chose, is never the reason to approve.
 */
export const Route = createFileRoute('/connect/agent')({
  component: ConnectAgentPage,
  head: () => ({ meta: [{ title: pageTitle('Connect a computer') }] }),
})

const ErrorResponseSchema = z.object({ error: z.string().min(1) })
const APPROVAL_NOT_RECORDED = 'spicytrade could not record that approval.'
const SESSION_ENDED = 'Your spicytrade session ended. Reload this page and sign in again.'

/**
 * Read from the raw query rather than the router's parsed search, which JSON-decodes values: a
 * machine named `2024` would arrive as a number and fail the label check it should pass.
 */
function parseQuery(rawSearch: string) {
  return AgentLoginPageQuerySchema.safeParse(Object.fromEntries(new URLSearchParams(rawSearch)))
}

function ConnectAgentPage() {
  const viewer = useViewer()
  // Empty on the server pass; every use below waits for the viewer check, which resolves only in
  // the browser.
  const rawSearch = useRawQuery()
  const query = parseQuery(rawSearch)
  const [submitting, setSubmitting] = useState(false)
  const [approved, setApproved] = useState(false)
  const [failure, setFailure] = useState<string>()
  const [typed, setTyped] = useState('')
  const code = ConnectCodeSchema.safeParse(typed)

  const approve = async ({ broker, challenge, check, label }: z.infer<typeof AgentLoginPageQuerySchema>, entered: string) => {
    setSubmitting(true)
    setFailure(undefined)
    try {
      const response = await fetch('/api/agent-logins', {
        body: JSON.stringify({ broker, code: entered, codeChallenge: challenge, codeCheck: check, label }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      const body: unknown = await response.json().catch(() => undefined)
      // The web session can end between loading this page and approving; the Worker's bare
      // "Authentication required" would give no next step.
      if (response.status === 401) throw new Error(SESSION_ENDED)
      if (!response.ok) throw new Error(ErrorResponseSchema.safeParse(body).data?.error ?? APPROVAL_NOT_RECORDED)
      const recorded = AgentLoginApproveResponseSchema.safeParse(body)
      if (!recorded.success) throw new Error(APPROVAL_NOT_RECORDED)
      if (recorded.data.authorizationUrl) window.location.assign(recorded.data.authorizationUrl)
      else setApproved(true)
    } catch (error) {
      setSubmitting(false)
      setFailure(toError(error)?.message ?? APPROVAL_NOT_RECORDED)
    }
  }

  return (
    <AuthorizeFrame phase={viewer.phase} title="Connect a computer">
      {viewer.phase === 'ready' && !query.success && (
        <p className="authorize-error">
          This link is incomplete. Run <code>spicytrade connect</code> again.
        </p>
      )}
      {viewer.phase === 'ready' && query.success && viewer.user === null && (
        <>
          <p>
            A computer named <strong>{query.data.label}</strong> is asking to connect to spicytrade as
            you. Sign in to continue, and you will be returned here.
          </p>
          <GoogleSignInButton callbackURL={`/connect/agent${rawSearch}`} />
        </>
      )}
      {viewer.phase === 'ready' && query.success && viewer.user !== null && approved && (
        <p>Approved. Return to your terminal or agent; you can close this tab.</p>
      )}
      {viewer.phase === 'ready' && query.success && viewer.user !== null && !approved && (
        <>
          <p>
            Connect <strong>{query.data.label}</strong> to spicytrade as <strong>{viewer.user.name}</strong>?
          </p>
          <Alert variant="destructive">
            <AlertTitle>Only continue if you started this yourself</AlertTitle>
            <AlertDescription>
              Nobody from spicytrade or tastytrade will send you this link or a code to type. If
              someone did, stop here: approving would let them {query.data.broker
                ? 'see your tastytrade account and place trades in it'
                : 'use spicytrade as you'}.
            </AlertDescription>
          </Alert>
          <p>Enter the code shown in the terminal or agent you started this from.</p>
          <p>
            <Input
              aria-label="Code from your terminal"
              autoCapitalize="characters"
              autoComplete="off"
              inputMode="text"
              onChange={(event) => setTyped(event.target.value)}
              placeholder="XXXX-XXXX"
              spellCheck={false}
              value={typed}
            />
          </p>
          {failure && <p className="authorize-error">{failure}</p>}
          <div className="authorize-actions">
            <Button disabled={submitting || !code.success} onClick={() => { if (code.success) void approve(query.data, code.data) }} type="button">
              {submitting ? <Spinner data-icon="inline-start" /> : null}
              <span>{query.data.broker ? 'Approve and continue to tastytrade' : 'Approve'}</span>
            </Button>
          </div>
        </>
      )}
    </AuthorizeFrame>
  )
}
