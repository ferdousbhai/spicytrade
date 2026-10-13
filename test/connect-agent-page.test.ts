// @vitest-environment jsdom

import { createElement, type ComponentType } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { Route } from '../src/routes/connect.agent'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  window.history.replaceState(null, '', '/')
})

// SAFETY: the route is declared with `component: ConnectAgentPage`, which takes no props.
const ConnectAgentPage = Route.options.component as ComponentType

const CHALLENGE = 'c'.repeat(43)
const STATE = 's'.repeat(43)
const MEMBER = Response.json({ user: { id: 'm', name: 'Dana', role: 'member' } })

function open(query: Record<string, string>) {
  window.history.replaceState(null, '', `/connect/agent?${new URLSearchParams(query).toString()}`)
  return render(createElement(ConnectAgentPage))
}

it('asks to connect the named machine, and posts the approval without the state', async () => {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => String(input) === '/api/agent-logins'
    ? new Promise<Response>(() => undefined)
    : MEMBER.clone())
  vi.stubGlobal('fetch', fetchMock)
  // A numeric hostname is still a label, not a number the router decoded.
  open({ challenge: CHALLENGE, label: '2024', port: '43210', state: STATE })
  await screen.findByText(/to spicytrade as/)
  expect(screen.getByText('2024')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
  await vi.waitFor(() => expect(fetchMock.mock.calls.some(([input]) => String(input) === '/api/agent-logins')).toBe(true))
  const [, init] = fetchMock.mock.calls.find(([input]) => String(input) === '/api/agent-logins')!
  expect(JSON.parse(String(init?.body))).toEqual({ codeChallenge: CHALLENGE, label: '2024', port: 43_210 })
})

it('says a malformed link is malformed rather than offering an approval', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => MEMBER.clone()))
  open({ challenge: CHALLENGE, label: 'laptop', port: '80', state: STATE })
  await screen.findByText(/This sign-in link is incomplete/)
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
})

it('reports a refused approval in the server\'s words', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input) === '/api/agent-logins'
    ? Response.json({ error: 'At most 3 computer sign-ins may be pending at once.' }, { status: 409 })
    : MEMBER.clone()))
  open({ challenge: CHALLENGE, label: 'laptop', port: '43210', state: STATE })
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
  await screen.findByText('At most 3 computer sign-ins may be pending at once.')
})

it('asks a signed-out visitor to sign in first', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ user: null })))
  open({ challenge: CHALLENGE, label: 'laptop', port: '43210', state: STATE })
  await screen.findByText(/is asking to sign in to spicytrade as you/)
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
})
