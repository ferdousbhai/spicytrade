// @vitest-environment jsdom

import { createElement, type ComponentType } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { Route } from '../src/routes/authorize.consent'

afterEach(() => {
  cleanup()
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
