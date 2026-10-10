import {
  McpServer,
  OAuthError,
  bearerAuthChallengeResponse,
  fromJsonSchema,
} from '@modelcontextprotocol/server'
import { createMcpHandler } from 'agents/mcp/server'
import { type AgentTool } from '../domain/agent-tool'
import { EquitySymbolSchema } from '../domain/instrument'
import { type TSchema } from 'typebox'
import { z } from 'zod'

import { CancelOrderParameters, CancelOrderSchema, OrderPlacementParameters } from './agent-contracts'
import { textResult, toolErrorResult } from './agent-tool-result'
import { cancelBrokerageOrder, placeBrokerageOrder } from './order-placement'
import { createBrokerageReconciliationTool } from './brokerage-reconciliation'
import { createCatalystRecordTool } from './catalyst-record-tool'
import { createSymbolEvidenceTool } from './symbol-evidence-tool'
import { createBrokerageReadTools } from './brokerage-read-tools'
import { type AppEnv } from './env'
import { createMarketResearchTools } from './market-research-tools'
import { createPublicMarketReadTools } from './public-market-tools'
import { noteSymbolAttention, readsSymbols, type SymbolNamingCall } from './symbol-attention'
import { createExactOptionGreeksReadTool } from './option-greeks-tool'
import { createResearchReadTools } from './research-read-tools'
import {
  PLACE_BROKERAGE_ORDER_DESCRIPTION,
  PORTFOLIO_REVIEW_PROMPT,
  SPICE_GUIDE,
  spiceMcpInstructions,
  tradeIdeaPrompt,
} from './doctrine'
import { toolAnnotations } from './mcp-annotations'
import { authenticateMcpToken, isMintedMcpToken, presentedBearer } from './mcp-tokens'
import { getAuthRuntime, isOwnerEmail } from './auth'
import { verifyMcpAccessToken } from './mcp-token-verify'
import {
  createRememberSymbolsTool,
  createWatchlistIndexTool,
  createWatchlistManageTool,
  createWatchlistReadTool,
} from './watchlist-tool'
import { brokerCredentialFromHeaders, type BrokerCredential } from './broker-credential'
import { MCP_PATH } from '../domain/site'
import { errorName, toError } from '../domain/failure'

/**
 * A thesis is the user's own words for one idea, pasted into a prompt the agent then works from.
 * The bound is a budget on that injected context, not a policy about ideas: a few paragraphs,
 * which is what the prompt's own reasoning steps are sized for.
 */
const MAX_THESIS_LENGTH = 2_000

/**
 * The web app as a tool surface for whatever agent a caller runs on their own machine: every
 * member, the owner, and an anonymous caller at the public tier. Agent loops do not run in this
 * Worker any more — a year of closes, a grown conversation, and a 128 MB
 * isolate were a bad fit three failed runs proved — so the Worker keeps what it is good at:
 * authoritative reads, the deterministic guards, and the stores.
 *
 * Every tool here is stateless per call; all state lives in D1 and at the broker, which is
 * why the stateless handler lane fits and no Durable Object is involved.
 *
 * `waitUntil` is the platform's: the attention search and an accepted order's trade-intent write
 * are scheduled on it rather than awaited, so work the caller did not ask for never lengthens
 * their turn. It is required because there is no honest fallback -- dropping the promise would
 * leave that work running detached and unawaited, not done inline.
 */
function createSpiceMcpServer(
  env: AppEnv,
  caller: McpCaller,
  credential: BrokerCredential | undefined,
  waitUntil: (task: Promise<unknown>) => void,
): McpServer {
  // `instructions` reaches the caller's agent as system context, so it is assembled only from
  // this repository's own constants and never from anything a provider or model supplied. It is
  // built for this caller's tier: it is paid for on every turn, and a rule about a tool they
  // were not given is a per-turn tax on a refusal they cannot reach.
  const server = new McpServer(
    { name: 'spicytrade', version: '1.0.0' },
    { instructions: spiceMcpInstructions(caller.signedIn) },
  )

  const tools: AgentTool<TSchema>[] = [
    // Price history is the only historical read there is: quotes, metrics, chains and Greeks
    // are all "right now". Without it a connected agent cannot answer how a name has moved,
    // where it sits against its own range, or anything a study describes -- so it was left
    // guessing on exactly the questions a trader asks first. Yahoo, not this Worker's broker
    // quota, so it costs an anonymous caller nothing the website does not already spend.
    ...createMarketResearchTools(),
    // D1 reads. Already public through the website, and free of any per-call provider cost.
    ...createResearchReadTools(env),
    // One name at every tier. Only the owner may ask for a symbol's provenance: it names the
    // provider watchlists that seeded it, which are the owner's brokerage data and never public.
    caller.owner ? createWatchlistReadTool(env) : createWatchlistIndexTool(env),
    // Quotes and metrics exist at both tiers and mean different things: a signed-in caller asks
    // the broker on every call, an anonymous one reads the website's cached snapshot. They share
    // a name, so the tier chooses which is registered rather than both colliding.
    ...(caller.signedIn
      ? [
        ...createBrokerageReadTools(env, credential),
        createExactOptionGreeksReadTool(env),
        // Remembering symbols wants an account behind it because it admits a whole list of names
        // to the shared watchlist per call with no catalog check -- unlike the anonymous search,
        // which admits at most the one name its query resolved to. Clearing a quarantined
        // submission wants one because it settles an account's own row.
        createRememberSymbolsTool(env),
        createBrokerageReconciliationTool(env, credential),
        // Writing research back to the site: dated events for every reader's calendar, and the
        // passages a member's agent read them in. Both are bound against pages this Worker
        // re-reads. Evidence also records which member kept it; a catalyst is stored under the
        // shared member-research producer, so the tier adds no name behind that row.
        createCatalystRecordTool(env),
        createSymbolEvidenceTool(env, caller.userId),
        // Placement and cancellation need a broker credential, which needs a member. Advertising
        // them to a caller who presented nothing would offer a destructive tool that can only
        // ever refuse -- the same reason the owner tools are absent from a member's list.
        ...createOrderTools(env, credential, waitUntil),
      ]
      : createPublicMarketReadTools(env, waitUntil)),
    // Removing a name from the shared watchlist is an owner act. A member is not shown a surface
    // they cannot use, so it is absent from their tool list rather than present and refused.
    ...(caller.owner ? [createWatchlistManageTool(env)] : []),
  ]
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        annotations: toolAnnotations(tool.name),
        description: tool.description,
        // TypeBox parameter schemas are plain JSON Schema, which is what MCP advertises.
        inputSchema: fromJsonSchema(tool.parameters),
      },
      // A throw is answered here, as a result with `isError`, rather than left to the SDK: the
      // SDK would send the error's message verbatim, and only a message this repository wrote
      // for the caller may reach their agent. `toolErrorResult` is that redaction boundary.
      async (params) => {
        let result
        try {
          // SAFETY: the SDK validated `params` against this very tool's own JSON Schema before
          // dispatch, which is exactly the contract `execute` states for its parameters.
          result = await tool.execute(params as never)
        } catch (error) {
          return toolErrorResult(tool.name, toError(error))
        }
        // Reading a symbol is the same signal a reader opening it on the site is, and buys the
        // same bounded catalyst search for everyone. Scheduled after the answer, never blocking
        // it; `symbol-attention.ts` carries the reasoning and the bound.
        if (readsSymbols(tool.name)) {
          // SAFETY: `noteSymbolAttention` re-parses this with its own schema and ignores a call
          // that names no symbol, so a shape it does not expect costs nothing.
          waitUntil(noteSymbolAttention(env, params as SymbolNamingCall))
        }
        // AgentToolResult content is text only, which is already MCP CallToolResult content.
        return { content: result.content }
      },
    )
  }

  // Reviewing positions reads the account, which only a signed-in caller's tools can do; offering
  // the workflow to anyone else would walk their agent to a tool it was never given.
  if (caller.signedIn) {
    server.registerPrompt(
      'portfolio_review',
      {
        description: 'Review every open position against the account\'s risk posture.',
        title: 'Portfolio review',
      },
      () => ({ messages: [{ content: { text: PORTFOLIO_REVIEW_PROMPT, type: 'text' as const }, role: 'user' as const }] }),
    )
  }

  server.registerPrompt(
    'evaluate_trade_idea',
    {
      argsSchema: z.object({
        symbol: EquitySymbolSchema.describe('Underlying ticker'),
        thesis: z.string().min(1).max(MAX_THESIS_LENGTH).describe('The case to test, in the user\'s own words'),
      }),
      description: caller.signedIn
        ? 'Test a trade idea against evidence, timing, and what the order guards will admit.'
        : 'Test a trade idea against evidence and timing.',
      title: 'Evaluate a trade idea',
    },
    ({ symbol, thesis }) => ({
      messages: [{
        content: { text: tradeIdeaPrompt(symbol, thesis, caller.signedIn), type: 'text' as const },
        role: 'user' as const,
      }],
    }),
  )

  // Listed at connect time, fetched only when something wants it -- the orientation that is too
  // long for `instructions` (a per-turn cost) and unreachable in a prompt (user-invoked).
  // Registered for every tier, including the anonymous one: `instructions` points every caller
  // at this URI, and the guide describes the credential-free tier as well.
  server.registerResource(
    'guide',
    'spicytrade://guide',
    { description: 'What spicytrade can answer and which tool answers it.', mimeType: 'text/markdown', title: 'spicytrade guide' },
    (uri) => ({ contents: [{ text: SPICE_GUIDE, uri: uri.href }] }),
  )

  return server
}


/** The guarded mutations. Offered only to a caller who could hold a broker credential. */
function createOrderTools(
  env: AppEnv,
  credential: BrokerCredential | undefined,
  waitUntil: (task: Promise<unknown>) => void,
): AgentTool<TSchema>[] {
  return [
    {
      description: PLACE_BROKERAGE_ORDER_DESCRIPTION,
      // Annotated destructive and non-idempotent (see `mcp-annotations.ts`) so a client can see
      // that calling this twice places two orders. Annotations are hints a client may ignore,
      // and the spec says to treat them as untrusted anyway -- they inform a confirmation
      // prompt, they are not one. What bounds the damage is the guard chain it runs.
      execute: async (params) => {
        // SAFETY: `placeBrokerageOrder` re-parses its input with `parseOrderPlacement` at the
        // trust boundary regardless of what the transport already checked.
        return textResult(await placeBrokerageOrder(env, params as never, credential, waitUntil))
      },
      name: 'place_brokerage_order',
      parameters: OrderPlacementParameters,
    },
    {
      description: 'Cancel one working order on the connected brokerage account. An ambiguous '
        + 'result is reported as ambiguous and is never retried: read the account history to '
        + 'find out what happened before doing anything else.',
      // Destructive but idempotent: cancelling an order already cancelled changes nothing
      // further, which is the useful thing for a client to know after an ambiguous result.
      execute: async (params) => {
        // Re-parsed here at the trust boundary regardless of what the transport checked.
        const { orderId } = CancelOrderSchema.parse(params)
        return textResult(await cancelBrokerageOrder(env, orderId, credential))
      },
      name: 'cancel_brokerage_order',
      parameters: CancelOrderParameters,
    },
  ]
}

/**
 * Who is calling. A bearer token, not a session: the caller is a headless agent on a member's
 * own machine and a cookie jar is the wrong shape for it. Ownership is decided by the same
 * `isOwnerEmail` the cookie surface uses, so there is exactly one definition of it.
 *
 * Every signed-in caller is a spicytrade user row, reached one of two ways: a minted token's digest
 * in `user_mcp_tokens`, or an OAuth access token whose verified `sub` names the user. A caller who
 * presents nothing is `ANONYMOUS_CALLER`, which is no row at all and holds only the public tier.
 * There is no shared secret: the `HESTON_MCP_TOKEN` that authenticated as the owner during the
 * pivot is gone, because it could not be revoked, did not die with the account, sat outside the
 * per-member cap, and left no trace of use.
 */
type McpCaller = {
  owner: boolean
  /** False for a caller who presented no credential at all. */
  signedIn: boolean
  userId: string
}

/**
 * The caller who presented nothing.
 *
 * Reads the website's own cached snapshot and the rows behind it, so an agent can answer a market
 * question with no setup at all -- the same data a visitor gets, out of the same cache entry, at
 * the same cost. Everything that touches an account stays behind a credential, and so does every
 * other write to shared state and every per-call broker request, with one exception: the
 * anonymous `search_symbols` is the website's own search, so a name it resolves is admitted to the
 * shared watchlist as prunable `visitor-search`, and a query the edge cache has not answered may
 * spend one broker lookup -- claimed one at a time per query, exactly as the website's does.
 */
const ANONYMOUS_CALLER: McpCaller = { owner: false, signedIn: false, userId: '' }

/**
 * The token store could not answer: a missing binding or a failed read. Distinct from a token
 * the store answered "no" for, because telling the caller to issue a new token would misreport a
 * fault on this side as one on theirs. Either way it is no access, never open access.
 */
export class McpCallerLookupError extends Error {
  constructor() {
    super('McpCallerLookup:store-unavailable')
    this.name = 'McpCallerLookupError'
  }
}

/**
 * A minted `user_mcp_tokens` credential, resolved to its caller; undefined for anything the
 * store says is not a live token. Throws when the store itself cannot answer.
 */
export async function resolveMcpCaller(request: Request, env: AppEnv): Promise<McpCaller | undefined> {
  const presented = presentedBearer(request)
  if (!presented || !isMintedMcpToken(presented)) return undefined

  // No store means no way to recognise anyone: no access, never open access -- but reported as
  // this server's fault, not as a dead token.
  if (!env.DB) throw new McpCallerLookupError()
  const identity = await authenticateMcpToken(env.DB, presented)
  if (!identity) return undefined
  return callerForUser(env.DB, identity.userId)
}

/**
 * The slice of the platform context this module touches. The stateless MCP handler reads only
 * `props`, which carries OAuth material this server does not use; `waitUntil` is this module's
 * own, for scheduling the attention-driven search after a tool answers. Naming the slice lets a
 * test hand in a plain object instead of imitating the whole platform type.
 */
export type McpExecutionContext = Pick<ExecutionContext, 'props' | 'waitUntil'>

/**
 * The member a verified credential names, or undefined when no such user exists. A signed token
 * outlives the account it was issued to until it expires, so a deleted user must resolve to
 * nobody here rather than keep member access. Ownership is decided by the same `isOwnerEmail`
 * the cookie surface uses, in one place.
 */
async function callerForUser(database: D1Database, userId: string): Promise<McpCaller | undefined> {
  const row = await database.prepare('SELECT email FROM "user" WHERE id = ?')
    .bind(userId).first<{ email: string }>()
  if (!row) return undefined
  return { owner: isOwnerEmail(row.email), signedIn: true, userId }
}

function serveMcp(
  request: Request,
  env: AppEnv,
  ctx: McpExecutionContext,
  caller: McpCaller,
): Promise<Response> {
  const credential = brokerCredentialFromHeaders(request.headers)
  // SAFETY: the handler reads only `props` from the context (verified against its dist) and this
  // module calls only `waitUntil`, both of which McpExecutionContext carries; the platform type's
  // other members are never touched.
  return createMcpHandler(() => createSpiceMcpServer(env, caller, credential, (task) => ctx.waitUntil(task)), {
    route: MCP_PATH,
    // Out-of-band failures — a rejected request, an error raised after the response is under
    // way — are otherwise dropped without a trace. Named, never bodied: the argument may carry
    // provider or caller content, so only the error's own name is recorded.
    onerror: (error: Error) => console.error('McpHandlerError', error.name),
  })(request, env, ctx as ExecutionContext)
}

/**
 * RFC 9728 §3.1: the metadata for resource `<origin>/mcp` is published at the well-known name with
 * the resource path appended. `handleWellKnownDiscovery` serves it at exactly this path.
 */
const PROTECTED_RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`

/** A 401 `invalid_token` challenge that names the discovery document, for every refusal below. */
function authChallenge(request: Request, description: string): Response {
  return bearerAuthChallengeResponse(new OAuthError('invalid_token', description), {
    resourceMetadataUrl: new URL(PROTECTED_RESOURCE_METADATA_PATH, request.url).toString(),
  })
}

/**
 * A store fault while resolving who is calling. Answered as the auth-unavailable case is: a
 * challenge rather than an escaped exception, which the platform would turn into a bare 500 with
 * no challenge and no named log. Only the error's name is recorded; D1 detail can carry a token
 * id or user id.
 */
function callerLookupFailed(request: Request, errorName: string): Response {
  console.error('McpCallerLookupFailed', errorName)
  return authChallenge(request, 'spicytrade could not verify this request.')
}

/**
 * Two ways in, for two kinds of caller.
 *
 * A person at a terminal authenticates with OAuth: their client discovers this server, registers
 * itself, and sends them through Google in a browser. A machine that runs alone cannot do any of
 * that -- an unattended agent has no browser and no interactive session -- so a minted
 * `user_mcp_tokens` row stays the non-interactive path. Both resolve to the same user id, so
 * nothing downstream can tell them apart, which is the point.
 *
 * A minted token is recognised by its shape alone, so it is decided by one indexed read and never
 * reaches the JWT verifier, whether it authenticates or not. Anything else is verified here, in
 * process (`verifyMcpAccessToken`): signature against this server's own signing keys, then issuer,
 * audience and expiry. Every refusal is written here too, and each carries the RFC 9728
 * `resource_metadata` parameter naming the discovery document. That parameter is what makes the
 * OAuth flow self-starting: a client holding a stale or foreign token learns where to begin.
 */
export async function handleMcpRequest(request: Request, env: AppEnv, ctx: McpExecutionContext): Promise<Response> {
  // No credential at all is a caller, not a refusal. The public market surface has always been
  // readable without an account through the website, and an agent asking the same question should
  // not need more than a visitor does. A credential that is *present* and does not verify still
  // gets the challenge below: that is a caller trying to authenticate and failing, which they can
  // act on, rather than one who never claimed to be anybody.
  if (!request.headers.get('Authorization')) return serveMcp(request, env, ctx, ANONYMOUS_CALLER)

  const presented = presentedBearer(request)
  if (!presented) {
    return authChallenge(request, 'Send the token as a bearer credential.')
  }

  // A string shaped like a minted token is only ever that. A revoked or mistyped one is refused
  // here, and never handed to the JWT verifier, where it could only fail and be logged as an
  // OAuth verification failure it never was.
  if (isMintedMcpToken(presented)) {
    let minted
    try {
      minted = await resolveMcpCaller(request, env)
    } catch (error) {
      return callerLookupFailed(request, errorName(toError(error)))
    }
    if (minted) return serveMcp(request, env, ctx, minted)
    console.error('McpTokenRejected')
    return authChallenge(request, 'This agent token is not live. Issue a new one from the Connect tab.')
  }

  let runtime
  try {
    runtime = await getAuthRuntime(env)
  } catch (error) {
    // Without the authorization server nobody can be recognised, so the caller is unauthenticated
    // and told so. Not a 500: whether this server can reach its own auth is not the caller's
    // business and is not something they can act on, and answering anything but a refusal here
    // would be the one shape that risks opening the surface. The outage is observable in this log
    // line rather than in the status code.
    console.error('McpAuthUnavailable', errorName(toError(error)))
    return authChallenge(request, 'spicytrade could not verify this request.')
  }

  let claims
  try {
    claims = await verifyMcpAccessToken(runtime.auth, presented, {
      audience: runtime.mcpResource,
      issuer: runtime.authIssuer,
    })
  } catch (error) {
    // Refuse, never throw. A 500 from the auth path tells a caller nothing they can act on and
    // loses the challenge that would let them authenticate; it also reads as a broken endpoint
    // rather than a bad token, which is how a whole broken flow stayed invisible.
    console.error('McpOAuthVerificationFailed', errorName(toError(error)))
    return authChallenge(request, 'spicytrade could not verify this token.')
  }

  let caller
  try {
    caller = await callerForUser(runtime.database, claims.sub)
  } catch (error) {
    return callerLookupFailed(request, errorName(toError(error)))
  }
  // A token whose subject is not a user this server knows authenticates nothing.
  if (!caller) {
    console.error('McpAuthRejected')
    return authChallenge(request, 'This token does not identify a spicytrade member.')
  }
  return serveMcp(request, env, ctx, caller)
}
