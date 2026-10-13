// @vitest-environment jsdom

import { createElement } from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'

import { ConnectScreen } from '../src/components/connect-screen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const UNEXPECTED = 'spicytrade answered with something unexpected. Reload the page and try again.'
const token = { createdAt: '2026-09-01T00:00:00Z', label: 'Laptop', lastUsedAt: '2026-09-02T00:00:00Z', tokenId: 't1' }

it('stops the spinner and names the server refusal when the first read fails', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'Token store unavailable' }, { status: 503 })))
  const { container } = render(createElement(ConnectScreen, { owner: false, signedIn: true }))
  await screen.findByText('Token store unavailable')
  expect(container.querySelector('[data-slot="spinner"], [role="status"]')).toBeNull()
})

it('reports a malformed token list as an unexpected response, never as the parser output', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tokens: [{ ...token, lastUsedAt: 7 }] })))
  const { container } = render(createElement(ConnectScreen, { owner: false, signedIn: true }))
  await screen.findByText(UNEXPECTED)
  expect(container.textContent).not.toContain('invalid_type')
  expect(container.querySelector('[data-slot="spinner"], [role="status"]')).toBeNull()
})

it('reports a malformed issue response as an unexpected response', async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ nope: true })
    : Response.json({ tokens: [token] }))
  vi.stubGlobal('fetch', fetchMock)
  const { container } = render(createElement(ConnectScreen, { owner: false, signedIn: true }))
  await screen.findByText('Laptop')
  fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'Phone' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create token' }))
  await screen.findByText(UNEXPECTED)
  expect(container.textContent).not.toContain('invalid_type')
  // The typed name survives a failed issue, so the member does not retype it.
  expect(screen.getByRole('textbox', { name: 'Token name' })).toHaveProperty('value', 'Phone')
})

it('reports a malformed revoke response as an unexpected response', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'DELETE'
    ? Response.json({ tokens: 'nope' })
    : Response.json({ tokens: [token] })))
  render(createElement(ConnectScreen, { owner: false, signedIn: true }))
  await screen.findByText('Laptop')
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
  await screen.findByText(UNEXPECTED)
})

it('keeps the server message for a refused revoke and shows the list it returns on success', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'DELETE'
    ? Response.json({ error: 'No such token' }, { status: 404 })
    : Response.json({ tokens: [token] })))
  render(createElement(ConnectScreen, { owner: false, signedIn: true }))
  await screen.findByText('Laptop')
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
  await screen.findByText('No such token')

  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tokens: [] })))
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))
  await screen.findByText('No computers or tokens yet.')
})

it('shows the spinner only while the first read is in flight', async () => {
  let finish!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve })))
  const { container } = render(createElement(ConnectScreen, { owner: false, signedIn: true }))
  const spinner = () => container.querySelector('[data-slot="spinner"], [role="status"]')
  expect(spinner()).not.toBeNull()
  finish(Response.json({ tokens: [] }))
  await screen.findByText('No computers or tokens yet.')
  await waitFor(() => expect(spinner()).toBeNull())
})

const phone = { createdAt: '2026-09-03T00:00:00Z', label: 'Phone', tokenId: 't2' }
const SECRET = 'hst_created_secret_value'

it('lists a created token from the create answer, with no second read that could fail it', async () => {
  let reads = 0
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ token: SECRET, tokenMetadata: phone })
    reads += 1
    // Any list read after the first fails: a create must not depend on one.
    return reads === 1 ? Response.json({ tokens: [token] }) : Response.json({ error: 'Token store unavailable' }, { status: 503 })
  }))
  const { container } = render(createElement(ConnectScreen, { owner: false, signedIn: true }))
  await screen.findByText('Laptop')
  fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'Phone' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create token' }))

  await screen.findByText('Copy this now')
  expect(screen.getByText('Phone')).toBeTruthy()
  expect(container.textContent).not.toContain('Token store unavailable')
  expect(screen.getByRole('textbox', { name: 'Token name' })).toHaveProperty('value', '')
  expect(reads).toBe(1)
})

it('takes a just-created token off the screen once it is revoked', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'POST') return Response.json({ token: SECRET, tokenMetadata: phone })
    if (init?.method === 'DELETE') return Response.json({ tokens: [token] })
    return Response.json({ tokens: [token] })
  }))
  const { container } = render(createElement(ConnectScreen, { owner: false, signedIn: true }))
  await screen.findByText('Laptop')
  fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'Phone' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create token' }))
  await screen.findByText('Copy this now')
  expect(container.textContent).toContain(SECRET)

  const revokeButtons = screen.getAllByRole('button', { name: 'Revoke' })
  fireEvent.click(revokeButtons[revokeButtons.length - 1]!)
  await waitFor(() => expect(screen.queryByText('Copy this now')).toBeNull())
  expect(container.textContent).not.toContain(SECRET)
})

it('keeps an unread token list unknown after a create, rather than showing only the new token', async () => {
  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'POST'
    ? Response.json({ token: SECRET, tokenMetadata: phone })
    : Response.json({ error: 'Token store unavailable' }, { status: 503 })))
  const { container } = render(createElement(ConnectScreen, { owner: false, signedIn: true }))
  await screen.findByText('Token store unavailable')
  fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'Phone' } })
  fireEvent.click(screen.getByRole('button', { name: 'Create token' }))

  await screen.findByText('Copy this now')
  // The list was never read, so it is still reported unknown and never shown as the new token alone.
  expect(screen.getByText('Token store unavailable')).toBeTruthy()
  expect(container.querySelector('.connect-tokens')).toBeNull()
})

it('shows a revoke working on its own row, not on Create token', async () => {
  let finish!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn((_input: RequestInfo | URL, init?: RequestInit) => init?.method === 'DELETE'
    ? new Promise<Response>((resolve) => { finish = resolve })
    : Promise.resolve(Response.json({ tokens: [token] }))))
  const { container } = render(createElement(ConnectScreen, { owner: false, signedIn: true }))
  await screen.findByText('Laptop')
  fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'Phone' } })
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }))

  await waitFor(() => expect(container.querySelector('.connect-tokens [data-slot="spinner"], .connect-tokens [role="status"]')).not.toBeNull())
  expect(screen.getByRole('button', { name: 'Create token' })).toBeTruthy()
  finish(Response.json({ tokens: [] }))
  await screen.findByText('No computers or tokens yet.')
})

it('holds Create until the first list read answers, so a late list cannot drop the new token', async () => {
  let finish!: (response: Response) => void
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => { finish = resolve })))
  render(createElement(ConnectScreen, { owner: false, signedIn: true }))
  fireEvent.change(screen.getByRole('textbox', { name: 'Token name' }), { target: { value: 'Phone' } })
  expect(screen.getByRole('button', { name: 'Create token' })).toHaveProperty('disabled', true)
  finish(Response.json({ tokens: [] }))
  await screen.findByText('No computers or tokens yet.')
  expect(screen.getByRole('button', { name: 'Create token' })).toHaveProperty('disabled', false)
})
