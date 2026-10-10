import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { z } from 'zod'

import { Button } from '#/components/ui/button'
import { Spinner } from '#/components/ui/spinner'
import { AuthorizeFrame, useViewer } from '../components/auth-gate'
import { SUPPORT_EMAIL, pageTitle } from '../domain/site'
import { toError } from '../domain/failure'

/**
 * The consent step: what stands between a self-registered client and a member's account.
 *
 * Registration is open, because that is how an MCP client bootstraps -- it invents its own
 * credentials and asks. Nothing about holding a client id says the person meant to grant it
 * anything, so approval is asked for here every time the provider decides consent is needed, and
 * denial is a real answer rather than a way to close the tab.
 *
 * The provider owns the decision and the outcome. This page reports the member's answer and
 * follows the redirect it is given; it never constructs a redirect back to the client itself.
 */
export const Route = createFileRoute('/authorize/consent')({
  component: ConsentPage,
  head: () => ({ meta: [{ title: pageTitle('Approve access') }] }),
})

/**
 * Where to send the browser once the answer is recorded. The provider returns this shape to a
 * fetch rather than a 302, because the answer is posted by script; `redirectURI` was the older
 * spelling and reading for it turned a recorded consent into a page that looked broken.
 */
const ConsentResponseSchema = z.object({ redirect: z.boolean(), url: z.string().min(1) })
const FailureSchema = z.object({ error_description: z.string().min(1) })
const ANSWER_NOT_RECORDED = 'spicytrade could not record that answer.'

function ConsentPage() {
  const viewer = useViewer()
  /** The answer in flight, so the spinner is in the button that was pressed, never in Approve on a Deny. */
  const [submitting, setSubmitting] = useState<'approve' | 'deny'>()
  const [failure, setFailure] = useState<string>()

  const answer = async (accept: boolean) => {
    setSubmitting(accept ? 'approve' : 'deny')
    setFailure(undefined)
    try {
      // The authorization request comes back as `oauth_query`: the provider signed it on the way
      // here and re-verifies that signature before it will read the answer, which is what stops a
      // consent from being posted for a request nobody made. Posting only the answer -- as this
      // first did -- is refused with "missing oauth query", and the button appeared to do nothing.
      const response = await fetch('/api/auth/oauth2/consent', {
        // The raw query exactly as it arrived. The router's own `searchStr` is re-serialized
        // from parsed parameters, and the provider verifies a signature over the literal string,
        // so any re-encoding -- an escape, an order -- invalidates it. Read at click time, which
        // only ever runs in the browser.
        body: JSON.stringify({ accept, oauth_query: window.location.search }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
      if (!response.ok) {
        // Say what the provider said. A generic message here is how a refused consent looked
        // like a button that did nothing at all.
        const reason = FailureSchema.safeParse(await response.json().catch(() => undefined))
        throw new Error(reason.success ? reason.data.error_description : ANSWER_NOT_RECORDED)
      }
      // A success whose body is not the shape this page reads is reported in our words, never as
      // the parser's own output.
      const consented = ConsentResponseSchema.safeParse(await response.json().catch(() => undefined))
      if (!consented.success) throw new Error(ANSWER_NOT_RECORDED)
      window.location.replace(consented.data.url)
    } catch (error) {
      setSubmitting(undefined)
      setFailure(toError(error)?.message ?? ANSWER_NOT_RECORDED)
    }
  }

  return (
    <AuthorizeFrame phase={viewer.phase} title="Approve access">
      {viewer.phase === 'ready' && viewer.user === null && (
        <p>You are not signed in. Start the connection again from your agent.</p>
      )}
      {viewer.phase === 'ready' && viewer.user !== null && (
        <>
          <p>
            An agent is asking to connect to your spicytrade account, signed in as{' '}
            <strong>{viewer.user.name}</strong>. It will be able to read live market data, option
            chains and Greeks, and the shared research, to add symbols to the watchlist, and to record
            catalysts and evidence that every spicytrade reader sees.
          </p>
          <p>
            It cannot reach your brokerage this way. Balances, positions and order placement need a
            broker credential that stays on your own machine and is sent with each request.
          </p>
          <p>
            Approve only if you started this from your own agent. Removing spicytrade from that agent
            ends its use of this connection; to revoke it on spicytrade&apos;s side, email{' '}
            <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>.
          </p>
          {failure && <p className="authorize-error">{failure}</p>}
          <div className="authorize-actions">
            <Button disabled={submitting !== undefined} onClick={() => void answer(true)} type="button">
              {submitting === 'approve' ? <Spinner data-icon="inline-start" /> : null}
              <span>Approve</span>
            </Button>
            <Button
              disabled={submitting !== undefined}
              onClick={() => void answer(false)}
              type="button"
              variant="outline"
            >
              {submitting === 'deny' ? <Spinner data-icon="inline-start" /> : null}
              <span>Deny</span>
            </Button>
          </div>
        </>
      )}
    </AuthorizeFrame>
  )
}
