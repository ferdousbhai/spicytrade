import { afterEach, describe, expect, it, vi } from 'vitest'

import { registerWebMcpTools, type WebMcpTool } from '../src/lib/webmcp'

const tool: WebMcpTool = {
  description: 'test',
  execute: async () => ({}),
  inputSchema: { type: 'object' },
  name: 'test_tool',
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('registerWebMcpTools', () => {
  it('does nothing in a browser without a model context', () => {
    vi.stubGlobal('document', {})
    vi.stubGlobal('navigator', {})
    expect(registerWebMcpTools([tool], new AbortController().signal)).toBe(false)
  })

  it('registers with document.modelContext and hands it the signal', () => {
    const registerTool = vi.fn()
    vi.stubGlobal('document', { modelContext: { registerTool } })
    vi.stubGlobal('navigator', {})
    const controller = new AbortController()
    expect(registerWebMcpTools([tool], controller.signal)).toBe(true)
    expect(registerTool).toHaveBeenCalledWith(tool, { signal: controller.signal })
  })

  it('falls back to the preview navigator.modelContext and unregisters on abort', () => {
    const registerTool = vi.fn()
    const unregisterTool = vi.fn()
    vi.stubGlobal('document', {})
    vi.stubGlobal('navigator', { modelContext: { registerTool, unregisterTool } })
    const controller = new AbortController()
    registerWebMcpTools([tool], controller.signal)
    expect(unregisterTool).not.toHaveBeenCalled()
    controller.abort()
    expect(unregisterTool).toHaveBeenCalledWith('test_tool')
  })

  it('keeps registering the rest when the browser refuses one', () => {
    const registerTool = vi.fn().mockImplementationOnce(() => { throw new Error('duplicate') })
    vi.stubGlobal('document', { modelContext: { registerTool } })
    vi.stubGlobal('navigator', {})
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    registerWebMcpTools([tool, { ...tool, name: 'second' }], new AbortController().signal)
    expect(registerTool).toHaveBeenCalledTimes(2)
  })
})
