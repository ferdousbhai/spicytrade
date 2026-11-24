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

it('names the computer and the code to match, and posts the approval', async () => {
  const posted = memberFetch(() => Response.json({}))
  // A numeric hostname is still a label, not a number the router decoded.
  open({ challenge: CHALLENGE, label: '2024' })
  await screen.findByText(/to spicytrade as/)
  expect(screen.getByText('2024')).toBeTruthy()
  // 'cccc…' decodes to 0x71 0xc7 0x1c 0x71.
  expect(screen.getByText('71C7-1C71')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await screen.findByText(/Approved\. Return to your terminal or agent/)
  expect(posted()).toEqual({ codeChallenge: CHALLENGE, label: '2024' })
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
})

it('says where a brokerage link continues, and goes on to the consent address it is given', async () => {
  const posted = memberFetch(() => Response.json({ authorizationUrl: 'https://my.tastytrade.com/auth.html?state=s' }))
  // jsdom cannot navigate, so the address the page reads and the one it leaves for are stood in.
  const assign = vi.fn()
  const search = `?${new URLSearchParams({ broker: 'tastytrade', challenge: CHALLENGE, label: 'laptop' }).toString()}`
  vi.stubGlobal('location', { assign, href: `http://localhost/connect/agent${search}`, pathname: '/connect/agent', search })
  render(createElement(ConnectAgentPage))
  fireEvent.click(await screen.findByRole('button', { name: 'Approve and continue to tastytrade' }))
  await vi.waitFor(() => expect(assign).toHaveBeenCalledWith('https://my.tastytrade.com/auth.html?state=s'))
  expect(posted()).toEqual({ broker: 'tastytrade', codeChallenge: CHALLENGE, label: 'laptop' })
})

it('says a malformed link is malformed rather than offering an approval', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => MEMBER.clone()))
  open({ challenge: 'short', label: 'laptop' })
  await screen.findByText(/This link is incomplete/)
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
})

it('reports a refused approval in the server\'s words', async () => {
  memberFetch(() => Response.json({ error: 'At most 3 computer sign-ins may be pending at once.' }, { status: 409 }))
  open({ challenge: CHALLENGE, label: 'laptop' })
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
  await screen.findByText('At most 3 computer sign-ins may be pending at once.')
})

it('asks a signed-out visitor to sign in first', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ user: null })))
  open({ challenge: CHALLENGE, label: 'laptop' })
  await screen.findByText(/is asking to connect to spicytrade as you/)
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
})
