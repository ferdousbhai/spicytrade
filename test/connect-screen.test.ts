// @vitest-environment jsdom

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectScreen } from '../src/components/connect-screen'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

/** A browser's storage for the page, shared across renders within one test. */
function stubStorage(): Map<string, string> {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) },
  })
  return values
}

function renderInteractive(signedIn = true) {
  const fetch = vi.fn(async () => Response.json({ tokens: [] }))
  vi.stubGlobal('fetch', fetch)
  return { fetch, ...render(createElement(ConnectScreen, { owner: false, signedIn })) }
}

describe('Connect screen copy', () => {
  it('leads with the one install command, fetched from this site', () => {
    const html = renderToStaticMarkup(createElement(ConnectScreen, { owner: false, signedIn: true }))
    expect(html).toContain('curl -fsSL https://spicy.trade/install.sh | bash')
    // One launcher handles both supported agents.
    expect(html).toContain('spicytrade start')
    expect(html).not.toContain('codex -c mcp_servers.spicytrade.enabled=true')
    expect(html).toContain('run the install again to update.')
    // The install is the path; nothing on the page asks for a checkout or a hand-run step.
    expect(html).not.toContain('ops/spicytrade')
    expect(html).not.toContain('store-credentials')
    expect(html).not.toContain('127.0.0.1:8787')
    // The no-install path stays, without a credential in the command the agent will store.
    expect(html).toContain('claude mcp add --transport http spicytrade https://spicy.trade/mcp')
    expect(html).not.toMatch(/spicy\.trade\/mcp<[^>]*>[^<]*Authorization/)
    // Only the chosen client's commands are shown.
    expect(html).not.toContain('grok mcp add')
    expect(html).not.toContain('codex mcp add')
  })

  it('reads the same signed out, and asks for a sign-in only where a token needs one', () => {
    stubStorage()
    const { container, fetch } = renderInteractive(false)
    expect(container.textContent).toContain('curl -fsSL https://spicy.trade/install.sh | bash')
    expect(screen.getByRole('button', { name: /Continue with Google/ })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Create token' })).toBeNull()
    // A signed-out reader has no tokens to list, so none are asked for.
    expect(fetch).not.toHaveBeenCalled()
  })

  it('shows only the picked client\'s commands, and remembers the pick', () => {
    const storage = stubStorage()
    const { container } = renderInteractive()
    fireEvent.click(screen.getByRole('radio', { name: 'Grok' }))
    const text = container.textContent ?? ''
    expect(text).toContain('grok mcp add --transport http spicytrade https://spicy.trade/mcp')
    expect(text).not.toContain('codex mcp add')
    // No token config is shown until there is a token to put in it.
    expect(text).not.toContain('--header')
    expect(storage.get('spice.connect-client.v1')).toBe('grok')

    cleanup()
    const again = renderInteractive()
    expect(screen.getByRole('radio', { name: 'Grok' })).toHaveProperty('checked', true)
    expect(again.container.textContent).toContain('grok mcp add')
  })

  it('gives any other client the bare endpoint rather than a command it may not have', () => {
    stubStorage()
    const { container } = renderInteractive()
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }))
    const text = container.textContent ?? ''
    expect(text).toContain('Streamable HTTP server')
    expect(text).toContain('muse mcp login spicytrade')
    expect(text).not.toMatch(/(grok|codex) mcp add/)
  })
})
