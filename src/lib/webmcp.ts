import { type JsonObject, type JsonValue } from '../domain/json-payload'

/**
 * WebMCP (W3C WebML CG draft): tools this page registers for an agent driving the browser. The
 * types are declared here because no shipped lib.dom carries them yet. Older Chrome previews put
 * the registry on `navigator`; a browser with neither has nothing to register with, and the page
 * behaves exactly as it does today.
 */

export type WebMcpTool = {
  name: string
  title?: string
  description: string
  /** JSON Schema. The browser checks a call against it; `execute` still parses its own input. */
  inputSchema: JsonObject
  execute: (input: JsonValue, client: { signal?: AbortSignal }) => Promise<JsonValue>
  annotations?: {
    readOnlyHint?: boolean
    consequentialHint?: boolean
    untrustedContentHint?: boolean
  }
}

type ModelContext = {
  registerTool: (tool: WebMcpTool, options?: { signal?: AbortSignal }) => void
  /** The older previews' way out, which may ignore the signal. */
  unregisterTool?: (name: string) => void
}

declare global {
  interface Document { modelContext?: ModelContext }
  interface Navigator { modelContext?: ModelContext }
}

function modelContext(): ModelContext | undefined {
  // Both globals are absent outside a browser, whatever lib.dom says.
  const context = globalThis.document?.modelContext ?? globalThis.navigator?.modelContext
  return context?.registerTool instanceof Function ? context : undefined
}

/**
 * Registers every tool until `signal` aborts. Returns whether a registry was there. A tool the
 * browser refuses (a name it already holds, say) is skipped rather than taking the rest with it.
 */
export function registerWebMcpTools(tools: readonly WebMcpTool[], signal: AbortSignal): boolean {
  const context = modelContext()
  if (!context) return false
  for (const tool of tools) {
    try {
      context.registerTool(tool, { signal })
      // A registry that honours the signal has already dropped the tool, so a second removal
      // that throws is the expected case, not a failure.
      signal.addEventListener('abort', () => {
        try {
          context.unregisterTool?.(tool.name)
        } catch {
          // Already unregistered by the signal.
        }
      }, { once: true })
    } catch (error) {
      console.warn('WebMcpToolRegistrationFailed', tool.name, error instanceof Error ? error.name : 'Error')
    }
  }
  return true
}
