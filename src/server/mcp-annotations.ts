/**
 * What each tool does to the world, declared the way MCP asks servers to declare it.
 *
 * The defaults matter and are the cautious reading: `destructiveHint` defaults to true and
 * `idempotentHint` to false, so saying nothing describes the most dangerous possible tool.
 * Stating them is how a client learns that remembering a symbol is additive while cancelling an
 * order is not, and that placing an order twice places two orders.
 *
 * These are hints. The spec is explicit that a client must treat annotations from an untrusted
 * server as untrusted, and nothing here is a control: the server's own guards decide what is
 * admissible, and they run whether or not a client read a single one of these.
 *
 * Every registered tool must appear here. `toolAnnotations` throws on a name it does not know,
 * so a new tool cannot reach the wire without someone deciding what it does.
 */
import type { ToolAnnotations } from '@modelcontextprotocol/server'

/** The SDK's annotations, with a title every tool must state. */
type McpToolAnnotations = ToolAnnotations & { title: string }

/** A read that leaves our stores and the broker untouched. `openWorld` is about where it reads from. */
function read(title: string, openWorld: boolean): McpToolAnnotations {
  return { openWorldHint: openWorld, readOnlyHint: true, title }
}

// `satisfies` keeps the literal keys as evidence, so `ANNOTATED_TOOL_NAMES` is the real
// list of declared tools rather than an open dictionary that could be anything.
const ANNOTATIONS = {
  // Reads that reach a provider or the open web.
  find_option_contracts: read('Find option contracts', true),
  read_account_history: read('Read account history', true),
  read_account_snapshot: read('Read the account snapshot', true),
  read_instrument_quotes: read('Read quotes', true),
  read_market_metrics: read('Read market metrics', true),
  read_option_greeks: read('Read option Greeks', true),
  read_price_history: read('Read price history', true),
  // Reads answered entirely from spicytrade's own stores.
  read_catalysts: read('Read catalysts', false),
  read_daily_brief: read('Read the daily brief', false),
  read_watchlist: read('Read the watchlist', false),

  // Writes.
  search_symbols: {
    // Annotations are per name, and both tiers share this one, so it carries the stricter of the
    // two. The signed-in search is a pure read. The anonymous one is the website's search: a name
    // that resolves is admitted to the shared watchlist as prunable visitor-search and the public
    // universe is republished. Additive, and searching the same name again admits nothing new.
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
    title: 'Search symbols',
  },
  place_brokerage_order: {
    // The one tool here that spends money. Calling it twice places two orders, which is
    // precisely what `idempotentHint: false` is for.
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: true,
    readOnlyHint: false,
    title: 'Place a brokerage order',
  },
  cancel_brokerage_order: {
    // Destructive in that it removes a working order, but cancelling an already-cancelled
    // order changes nothing further.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
    title: 'Cancel a brokerage order',
  },
  reconcile_brokerage_action: {
    // Only settles a quarantine against what the broker already did; it never places or
    // cancels anything.
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
    title: 'Reconcile an ambiguous submission',
  },
  remember_symbols: {
    // Additive by construction: it can admit a name to the shared watchlist, never remove one.
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
    title: 'Remember symbols',
  },
  record_catalysts: {
    // Additive: it admits dated events to the shared calendar under its own producer id and
    // retires nothing another producer wrote. Recording the same event again refreshes that
    // row rather than adding one, so a repeat leaves the calendar where it was.
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
    title: 'Record catalysts',
  },
  record_evidence: {
    // Additive, and keyed by the passage itself: recording the same quote for the same symbol
    // and page refreshes that card instead of stacking another under the name.
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
    readOnlyHint: false,
    title: 'Record evidence',
  },
  manage_watchlist: {
    // Can remove a symbol, which takes it from every reader — hence owner-only, and hence
    // destructive where `remember_symbols` is not.
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
    readOnlyHint: false,
    title: 'Manage the watchlist',
  },
} satisfies Readonly<Record<string, McpToolAnnotations>>

const BY_NAME = new Map<string, McpToolAnnotations>(Object.entries(ANNOTATIONS))

export function toolAnnotations(name: string): McpToolAnnotations {
  const annotations = BY_NAME.get(name)
  if (!annotations) throw new Error(`McpAnnotations:undeclared-tool:${name}`)
  return annotations
}

/** Exposed so a test can assert the table and the registered surface never drift apart. */
export const ANNOTATED_TOOL_NAMES = [...BY_NAME.keys()]
