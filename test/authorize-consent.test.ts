// @vitest-environment jsdom

import { createElement, type ComponentType } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import { readConsentDestination } from '../src/domain/consent-destination'
import { Route } from '../src/routes/authorize.consent'

const LOCAL_AGENT_QUERY = '?client_id=c&redirect_uri=http%3A%2F%2F127.0.0.1%3A43210%2Fcallback&sig=s'
const signedIn = () => Promise.resolve(Response.json({ user: { id: 'm', name: 'Dana', role: 'member' } }))

beforeEach(() => {
  window.history.replaceState(null, '', `/authorize/consent${LOCAL_AGENT_QUERY}`)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

// SAFETY: the route is declared with `component: ConsentPage`, which takes no props.
const ConsentPage = Route.options.component as ComponentType

it('says the session check failed instead of stopping at the heading', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('unavailable', { status: 503 })))
  render(createElement(ConsentPage))
  await screen.findByText('spicytrade could not check whether you are signed in. Reload to try again.')
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
  expect(screen.queryByRole('status')).toBeNull()
})

it('shows a Deny in flight on Deny, never as Approve granting access', async () => {
  vi.stubGlobal('fetch', vi.fn((input: RequestInfo | URL) => String(input).includes('/oauth2/consent')
    ? new Promise<Response>(() => undefined)
    : Promise.resolve(Response.json({ user: { id: 'm', name: 'Dana', role: 'member' } }))))
  render(createElement(ConsentPage))
  const deny = await screen.findByRole('button', { name: 'Deny' })
  fireEvent.click(deny)

  const approve = screen.getByRole('button', { name: 'Approve' })
  await vi.waitFor(() => expect(deny.querySelector('[data-slot="spinner"], [role="status"]')).not.toBeNull())
  expect(approve.querySelector('[data-slot="spinner"], [role="status"]')).toBeNull()
})

it('reports a success body it cannot read in its own words, not as parser output', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => String(input).includes('/oauth2/consent')
    ? Response.json({ redirectURI: 'https://example.com/callback' })
    : Response.json({ user: { id: 'm', name: 'Dana', role: 'member' } })))
  const { container } = render(createElement(ConsentPage))
  fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
  await screen.findByText('spicytrade could not record that answer.')
  expect(container.textContent).not.toContain('invalid_type')
})

it('says an approval goes to this computer for a loopback agent', async () => {
  vi.stubGlobal('fetch', vi.fn(signedIn))
  render(createElement(ConsentPage))
  await screen.findByText(/an agent running on this computer \(port 43210\)/)
})

it('names the website an approval would go to when it is not this computer', async () => {
  window.history.replaceState(null, '', '/authorize/consent?client_id=c&redirect_uri=https%3A%2F%2Fattacker.example%2Fcb&sig=s')
  vi.stubGlobal('fetch', vi.fn(signedIn))
  const { container } = render(createElement(ConsentPage))
  await screen.findByRole('button', { name: 'Approve' })
  expect(container.querySelector('.authorize-warning strong')?.textContent).toBe('attacker.example')
})

it('offers no Approve for a request that does not say where access goes', async () => {
  window.history.replaceState(null, '', '/authorize/consent?client_id=c&sig=s')
  vi.stubGlobal('fetch', vi.fn(signedIn))
  render(createElement(ConsentPage))
  await screen.findByText(/does not say where access would be sent/)
  expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull()
})

it('reads each kind of destination from the redirect the provider signed', () => {
  const read = (redirect: string) => readConsentDestination(`?redirect_uri=${encodeURIComponent(redirect)}`)
  expect(read('http://localhost:3118/callback')).toEqual({ kind: 'this-computer', port: '3118' })
  expect(read('http://[::1]:9000/cb')).toEqual({ kind: 'this-computer', port: '9000' })
  expect(read('http://127.0.0.1.attacker.example/cb')).toEqual({ kind: 'website', host: '127.0.0.1.attacker.example' })
  expect(read('https://localhost.attacker.example/cb')).toEqual({ kind: 'website', host: 'localhost.attacker.example' })
  expect(read('cursor://anysphere.cursor-retrieval/oauth/callback')).toEqual({ kind: 'app', scheme: 'cursor' })
  expect(read('javascript:alert(1)')).toBeNull()
  expect(read('not a url')).toBeNull()
  expect(readConsentDestination('')).toBeNull()
})
