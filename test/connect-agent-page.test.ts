// @vitest-environment jsdom

import { createElement, type ComponentType } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'

import { Route } from '../src/routes/connect.agent'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

// SAFETY: the route is declared with `component: ConnectAgentPage`, which takes no props.
const ConnectAgentPage = Route.options.component as ComponentType

const CHALLENGE = 'c'.repeat(43)
/** What the link carries for its code; the page passes it on unread. */
const CHECK = 'k'.repeat(43)

/** Types the code a terminal printed into the page. */
async function typeCode(code: string) {
  fireEvent.change(await screen.findByLabelText('Code from your terminal'), { target: { value: code } })
}
const MEMBER = Response.json({ user: { id: 'm', name: 'Dana', role: 'member' } })

function open(query: Record<string, string>) {
  window.history.replaceState(null, '', `/connect/agent?${new URLSearchParams(query).toString()}`)
  return render(createElement(ConnectAgentPage))
}

/** Answers the approval with `approval`, and the viewer check with a signed-in member. */
function memberFetch(approval: () => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input) === '/api/agent-logins'
    ? approval()
    : MEMBER.clone())
  vi.stubGlobal('fetch', fetchMock)
  return (): Record<string, string> | undefined => {
    const [, init] = fetchMock.mock.calls.find(([input]) => String(input) === '/api/agent-logins') ?? []
    return init ? z.record(z.string(), z.string()).parse(JSON.parse(String(init.body))) : undefined
  }
}

it('names the computer, takes the code the terminal printed, and posts the approval', async () => {
  const posted = memberFetch(() => Response.json({}))
  // A numeric hostname is still a label, not a number the router decoded.
  open({ challenge: CHALLENGE, check: CHECK, label: '2024' })
  await screen.findByText(/to spicytrade as/)
  expect(screen.getByText('2024')).toBeTruthy()
  // The link alone approves nothing: there is no code on the page, and no approving without one.
  const button = screen.getByRole('button', { name: 'Approve' })
  expect(button).toHaveProperty('disabled', true)
  await typeCode('6a26')
  expect(button).toHaveProperty('disabled', true)
  await typeCode('6a26-a884')
  expect(button).toHaveProperty('disabled', false)
  fireEvent.click(button)
  await screen.findByText(/Approved\. Return to your terminal or agent/)
  expect(posted()).toEqual({ code: '6A26A884', codeChallenge: CHALLENGE, codeCheck: CHECK, label: '2024' })
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
})

it('says where a brokerage link continues, and goes on to the consent address it is given', async () => {
  const posted = memberFetch(() => Response.json({ authorizationUrl: 'https://my.tastytrade.com/auth.html?state=s' }))
  // jsdom cannot navigate, so the address the page reads and the one it leaves for are stood in.
  const assign = vi.fn()
  const search = `?${new URLSearchParams({ broker: 'tastytrade', challenge: CHALLENGE, check: CHECK, label: 'laptop' }).toString()}`
  vi.stubGlobal('location', { assign, href: `http://localhost/connect/agent${search}`, pathname: '/connect/agent', search })
  render(createElement(ConnectAgentPage))
  await typeCode('6A26-A884')
  fireEvent.click(await screen.findByRole('button', { name: 'Approve and continue to tastytrade' }))
  await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('https://my.tastytrade.com/auth.html?state=s'))
  expect(posted()).toEqual({ broker: 'tastytrade', code: '6A26A884', codeChallenge: CHALLENGE, codeCheck: CHECK, label: 'laptop' })
})

it('says a malformed link is malformed rather than offering an approval', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => MEMBER.clone()))
  open({ challenge: 'short', check: CHECK, label: 'laptop' })
  await screen.findByText(/This link is incomplete/)
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
})

it('reports a refused approval in the server\'s words', async () => {
  memberFetch(() => Response.json({ error: 'At most 3 computer sign-ins may be pending at once.' }, { status: 409 }))
  open({ challenge: CHALLENGE, check: CHECK, label: 'laptop' })
  await typeCode('6A26-A884')
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
  await screen.findByText('At most 3 computer sign-ins may be pending at once.')
})

it('asks a signed-out visitor to sign in first', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ user: null })))
  open({ challenge: CHALLENGE, check: CHECK, label: 'laptop' })
  await screen.findByText(/is asking to connect to spicytrade as you/)
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
})

it('treats a link with no code check, as an older CLI printed, as incomplete', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => MEMBER.clone()))
  open({ challenge: CHALLENGE, label: 'laptop' })
  await screen.findByText(/This link is incomplete/)
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
})
