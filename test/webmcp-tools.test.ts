// @vitest-environment jsdom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useWebMcpTools, type WebMcpWorkspace } from '../src/components/webmcp-tools'
import { type JsonValue } from '../src/domain/json-payload'
import { type WebMcpTool } from '../src/lib/webmcp'
import { dailyBriefFixture, marketTickersFixture } from './fixtures/market'

type Registered = { options?: { signal?: AbortSignal }; tool: WebMcpTool }

function mount(overrides: Partial<WebMcpWorkspace> = {}) {
  const registered: Registered[] = []
  Object.defineProperty(document, 'modelContext', {
    configurable: true,
    value: { registerTool: (tool: WebMcpTool, options?: Registered['options']) => registered.push({ options, tool }) },
  })
  const workspace: WebMcpWorkspace = {
    brief: dailyBriefFixture,
    catalysts: [],
    chooseSymbol: vi.fn(),
    marketState: 'open',
    openView: vi.fn(),
    pinnedSymbols: ['NVDA'],
    selectedSymbol: 'SPY',
    signedIn: true,
    syncedAt: '2026-08-28T12:00:00.000Z',
    tickers: marketTickersFixture,
    togglePinned: vi.fn(),
    ...overrides,
  }
  const hook = renderHook(() => useWebMcpTools(workspace))
  const call = (name: string, input: JsonValue) => {
    const entry = registered.find((candidate) => candidate.tool.name === name)
    if (!entry) throw new Error(`${name} was not registered`)
    return entry.tool.execute(input, {})
  }
  return { call, hook, registered, workspace }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(document, 'modelContext')
  vi.unstubAllGlobals()
})

describe('WebMCP tools', () => {
  it('registers no order or account tool, and unregisters on unmount', () => {
    const { hook, registered } = mount()
    expect(registered.map(({ tool }) => tool.name).sort()).toEqual([
      'look_up_symbol', 'open_view', 'read_daily_brief', 'read_market', 'set_favorite', 'show_symbol',
    ])
    hook.unmount()
    expect(registered.every(({ options }) => options?.signal?.aborted)).toBe(true)
  })

  it('reads the favorites as shown, without the sparkline', async () => {
    const { call } = mount()
    const result = await call('read_market', { favoritesOnly: true })
    expect(result).toMatchObject({ tickers: [{ symbol: 'NVDA' }] })
    expect(JSON.stringify(result)).not.toContain('sparkline')
  })

  it('stars through the app\'s own toggle, and only when the state differs', async () => {
    const { call, workspace } = mount()
    await expect(call('set_favorite', { favorite: true, symbol: 'nvda' })).resolves.toMatchObject({ changed: false })
    await call('set_favorite', { favorite: true, symbol: 'AAPL' })
    expect(workspace.togglePinned).toHaveBeenCalledExactlyOnceWith('AAPL', undefined)
  })

  it('looks up a symbol the table does not carry the way the search box does', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }))
    vi.stubGlobal('fetch', fetch)
    const { call, workspace } = mount()
    await expect(call('show_symbol', { symbol: 'ZZZZ' })).rejects.toThrow('No listed symbol matches ZZZZ.')
    expect(fetch).toHaveBeenCalledWith('/api/public-symbol-search?q=ZZZZ', expect.anything())
    expect(workspace.chooseSymbol).not.toHaveBeenCalled()
  })
})
