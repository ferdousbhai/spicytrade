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

function renderInteractive() {
  vi.stubGlobal('fetch', vi.fn(async () => Response.json({ tokens: [] })))
  return render(createElement(ConnectScreen, { owner: false }))
}

describe('Connect screen copy', () => {
  it('gives a proxy add command with no Authorization header, for the default client', () => {
    const html = renderToStaticMarkup(createElement(ConnectScreen, { owner: false }))
    // One command is the proxy path; it is also the repair, and doctor says which step to repair.
    expect(html).toContain('./ops/spicytrade/spicytrade.mjs setup')
    expect(html).toContain('./ops/spicytrade/spicytrade.mjs doctor')
    // The manual steps stay documented beneath it, for a machine the command does not fit.
    // From the trading folder, so account tools load there and not in every session.
    expect(html).toContain('mkdir -p ~/trading &amp;&amp; cd ~/trading &amp;&amp; claude mcp add --transport http spicytrade http://127.0.0.1:8787/mcp')
    expect(html).toContain('./ops/spicytrade/store-credentials.sh mcp-token')
    expect(html).toContain('./ops/spicytrade/store-credentials.sh tastytrade')
    // spicytrade's tastytrade app is the usual way; a personal grant stays documented beside it.
    expect(html).toContain('./ops/spicytrade/connect-tastytrade.mjs')
    // OAuth to the public URL remains for clients that can complete a browser sign-in.
    expect(html).toContain('claude mcp add --transport http spicytrade https://spicy.trade/mcp')
    // A header-less request is served at the public tier, never challenged, so adding the
    // server must not be described as what opens the browser.
    expect(html).toContain('connects straight away at the public tier')
    expect(html).not.toContain('Run this and your agent opens a browser')
    // The proxy path must not put a bearer token in the command the agent will store.
    expect(html).not.toMatch(/http:\/\/127\.0\.0\.1:8787\/mcp[^<]*Authorization/)
    // Only the chosen client's commands are shown.
    expect(html).not.toContain('grok mcp add')
    expect(html).not.toContain('codex mcp add')
  })

  it('shows only the picked client\'s commands, and remembers the pick', () => {
    const storage = stubStorage()
    const { container } = renderInteractive()
    fireEvent.click(screen.getByRole('radio', { name: 'Grok' }))
    const text = container.textContent ?? ''
    expect(text).toContain('grok mcp add --transport http spicytrade http://127.0.0.1:8787/mcp')
    expect(text).toContain('grok mcp add --transport http spicytrade https://spicy.trade/mcp')
    expect(text).toContain('Grok lists tools, not prompts')
    expect(text).not.toContain('codex mcp add')
    // The headless header flag is Claude Code's alone, so its block stays whatever is picked.
    expect(text).toContain('claude mcp add --transport http spicytrade https://spicy.trade/mcp --header')
    expect(storage.get('spice.connect-client.v1')).toBe('grok')

    cleanup()
    const again = renderInteractive()
    expect(screen.getByRole('radio', { name: 'Grok' })).toHaveProperty('checked', true)
    expect(again.container.textContent).toContain('grok mcp add')
  })

  it('gives any other client the bare endpoints rather than a command it may not have', () => {
    stubStorage()
    const { container } = renderInteractive()
    fireEvent.click(screen.getByRole('radio', { name: 'Other' }))
    const text = container.textContent ?? ''
    expect(text).toContain('Streamable HTTP server')
    expect(text).toContain('muse mcp login spicytrade')
    expect(text).not.toMatch(/(grok|codex) mcp add/)
    expect(text).not.toContain('claude mcp add --transport http spicytrade http://127.0.0.1:8787/mcp')
  })
})
