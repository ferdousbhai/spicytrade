import { type Static, type TSchema } from 'typebox'

/**
 * The tool shape every spicytrade tool factory produces and the MCP surface consumes.
 *
 * This was imported as a type from `@earendil-works/pi-agent-core`, the runtime that used to
 * run an agent loop inside the Worker. That loop is gone; nothing but this one interface was
 * still being used, and it kept an entire agent runtime — and the Google AI SDK behind it — in
 * the dependency tree for a declaration. Declaring it here costs nothing and lets the tools be
 * what they now are: descriptions handed to whatever agent the member runs on their own
 * machine, never to a loop we host.
 *
 * It is deliberately narrower than the interface it replaces, carrying only what this
 * repository builds and reads. Anything a future caller needs is added here on purpose.
 */

/** Text a tool returns to the model: the only content kind MCP is ever handed. */
type AgentToolContent = { type: 'text'; text: string }

/**
 * What a tool answers. Text only: the MCP surface forwards `content` and nothing else, so a
 * structured side channel would be read by no caller.
 */
export interface AgentToolResult {
  content: AgentToolContent[]
}

/**
 * No tool declares that it must run alone. The MCP surface is stateless per call and cannot
 * serialise one caller's calls against another's, so such a flag would promise what nothing
 * enforces: a write that must not interleave is made safe in its own store statement instead.
 */
export interface AgentTool<TParameters extends TSchema = TSchema> {
  description: string
  name: string
  parameters: TParameters
  /**
   * Throw on failure rather than encoding an error in `content`. The MCP boundary decides what
   * of a throw the caller sees (`toolErrorResult`): a `CallerVisibleError` passes its message,
   * anything else reaches the caller as its error name alone.
   */
  execute: (params: Static<TParameters>) => Promise<AgentToolResult>
}
