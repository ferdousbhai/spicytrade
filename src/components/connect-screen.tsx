import { useEffect, useState, useSyncExternalStore } from 'react'
import { z } from 'zod'

import { Alert, AlertDescription, AlertTitle } from '#/components/ui/alert'
import { Button } from '#/components/ui/button'
import { Input } from '#/components/ui/input'
import { Spinner } from '#/components/ui/spinner'
import {
  MAX_MCP_TOKEN_LABEL_LENGTH,
  McpTokenIssuedResponseSchema,
  McpTokenListResponseSchema,
  type McpTokenMetadata,
} from '../domain/mcp-tokens'
import { toError } from '../domain/failure'
import { GoogleSignInButton } from './auth-gate'
import { CopyBlock } from './copy-block'
import { INSTALL_SCRIPT_URL, MCP_ENDPOINT } from '../domain/site'
import { CONNECT_PROMPT } from '../server/connect-guide'

/** The name every client's config knows the server by; `spicytrade setup` adds it under this too. */
const MCP_SERVER_NAME = 'spicytrade'
const ADD_COMMANDS = {
  claude: `claude mcp add --transport http ${MCP_SERVER_NAME} ${MCP_ENDPOINT}`,
  codex: `codex mcp add ${MCP_SERVER_NAME} --url ${MCP_ENDPOINT}`,
  grok: `grok mcp add --transport http ${MCP_SERVER_NAME} ${MCP_ENDPOINT}`,
  other: undefined,
} satisfies Record<AgentClient, string | undefined>
/**
 * The whole path for an agent on the member's own computer: it installs the CLI from this site and
 * runs `spicytrade setup`, which signs in through the browser, offers tastytrade, and adds the
 * server to the agents it finds. Running it again updates it.
 */
const INSTALL_COMMAND = `curl -fsSL ${INSTALL_SCRIPT_URL} | bash`

/**
 * The clients the page has exact commands for, and "Other" for everything that speaks
 * streamable HTTP. Picking one shows only its commands: listing every client twice made the page
 * the site's longest by far, and a member runs one agent at a time.
 */
const AGENT_CLIENTS = ['claude', 'codex', 'grok', 'other'] as const
type AgentClient = (typeof AGENT_CLIENTS)[number]
const AGENT_CLIENT_NAMES = {
  claude: 'Claude Code',
  codex: 'Codex',
  grok: 'Grok',
  other: 'Other',
} satisfies Record<AgentClient, string>
/**
 * A per-browser convenience only. Storage that is missing or refuses (a private window, blocked
 * site data) keeps the choice in memory for the visit instead, and a first visit shows the first
 * client.
 */
const AGENT_CLIENT_STORAGE_KEY = 'spice.connect-client.v1'
let unstoredClient: AgentClient | undefined
const clientListeners = new Set<() => void>()

function subscribeToClient(listener: () => void): () => void {
  clientListeners.add(listener)
  return () => { clientListeners.delete(listener) }
}

function readClient(): AgentClient {
  try {
    const stored = localStorage.getItem(AGENT_CLIENT_STORAGE_KEY)
    return AGENT_CLIENTS.find((client) => client === stored) ?? unstoredClient ?? 'claude'
  } catch {
    return unstoredClient ?? 'claude'
  }
}

function chooseClient(next: AgentClient) {
  try {
    localStorage.setItem(AGENT_CLIENT_STORAGE_KEY, next)
  } catch {
    unstoredClient = next
  }
  for (const listener of clientListeners) listener()
}

function ClientPicker({ client, onChange }: { client: AgentClient; onChange: (client: AgentClient) => void }) {
  return (
    <fieldset className="connect-picker">
      <legend>Your agent</legend>
      <div>
        {AGENT_CLIENTS.map((option) => (
          <label key={option}>
            <input
              checked={client === option}
              name="agent-client"
              onChange={() => onChange(option)}
              type="radio"
              value={option}
            />
            <span>{AGENT_CLIENT_NAMES[option]}</span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

/** The shape every failing handler in api.mcp-tokens returns. */
const ErrorResponseSchema = z.object({ error: z.string() })

/**
 * A 2xx body that is not the documented shape is a server or deploy mismatch, not something the
 * member can act on, and a Zod issue list is not something they can read.
 */
const UNEXPECTED_RESPONSE = 'spicytrade answered with something unexpected. Reload the page and try again.'

async function readJson<T>(response: Response, schema: z.ZodType<T>): Promise<T> {
  const body: unknown = await response.json().catch(() => null)
  if (!response.ok) {
    // The server's own message is the useful one -- it names the token cap, or says the store
    // is unavailable. Anything that does not parse is reported generically rather than guessed at.
    throw new Error(ErrorResponseSchema.safeParse(body).data?.error ?? 'Request failed')
  }
  const parsed = schema.safeParse(body)
  if (!parsed.success) throw new Error(UNEXPECTED_RESPONSE)
  return parsed.data
}

function useAgentTokens() {
  const [tokens, setTokens] = useState<McpTokenMetadata[]>()
  // A failed list read and a failed action are different facts: a create that succeeds says
  // nothing about the list, so it clears its own error but never the read's.
  const [listError, setListError] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  /** Which action is in flight, so only its own button shows it working. */
  const [pending, setPending] = useState<{ kind: 'issue' } | { kind: 'revoke'; tokenId: string }>()
  /**
   * Shown once, held only in this component's state, never re-fetchable. Its id travels with it
   * so revoking that very token also takes it off the screen.
   */
  const [issued, setIssued] = useState<{ token: string; tokenId: string }>()

  // Mirrors useViewer: the first read is owned by the effect and abandoned on unmount, so a
  // slow response can never write into a component that has gone away. After that the list
  // changes only through create and revoke, whose answers carry what changed.
  useEffect(() => {
    const controller = new AbortController()
    void fetch('/api/mcp-tokens', { credentials: 'same-origin', signal: controller.signal })
      .then((response) => readJson(response, McpTokenListResponseSchema))
      .then((body) => { setTokens(body.tokens) })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setListError(toError(cause)?.message ?? 'Signed-in computers could not be loaded.')
      })
    return () => controller.abort()
  }, [])

  /** True only while the first read is in flight, so a failed read does not spin forever. */
  const loading = tokens === undefined && listError === undefined

  // Reports whether the token was created, so the caller can keep what the member typed when
  // it was not — a refusal at the token cap is the case where retyping the name is wasted.
  const issue = async (label: string): Promise<boolean> => {
    setPending({ kind: 'issue' })
    try {
      const body = await readJson(await fetch('/api/mcp-tokens', {
        body: JSON.stringify({ label }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }), McpTokenIssuedResponseSchema)
      // The create answers with the new token's metadata, so the list grows from that rather than
      // from a second read: a re-read that failed would report a created token as not created.
      setIssued({ token: body.token, tokenId: body.tokenMetadata.tokenId })
      // Only a list that was actually read grows; one that never loaded stays unknown rather
      // than being shown as just the new token.
      setTokens((current) => current && [...current, body.tokenMetadata])
      setActionError(undefined)
      return true
    } catch (cause) {
      setActionError(toError(cause)?.message ?? 'The token could not be created')
      return false
    } finally {
      setPending(undefined)
    }
  }

  const revoke = async (tokenId: string) => {
    setPending({ kind: 'revoke', tokenId })
    try {
      // A revoke answers with the remaining list, so it is read here rather than fetched again.
      const body = await readJson(await fetch('/api/mcp-tokens', {
        body: JSON.stringify({ tokenId }),
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        method: 'DELETE',
      }), McpTokenListResponseSchema)
      setTokens(body.tokens)
      setIssued((current) => (current?.tokenId === tokenId ? undefined : current))
      setActionError(undefined)
    } catch (cause) {
      setActionError(toError(cause)?.message ?? 'The token could not be revoked')
    } finally {
      setPending(undefined)
    }
  }

  return { actionError, issue, issued, listError, loading, pending, revoke, tokens }
}

/**
 * The page reads the same signed in or not: installing needs no web session, since the CLI's own
 * sign-in opens the browser. Only headless tokens, which belong to an account, wait for one.
 */
export function ConnectScreen({ authError, owner, signedIn }: { authError?: string; owner: boolean; signedIn: boolean }) {
  // The server renders the first client; the browser's stored choice takes over on hydration.
  const client = useSyncExternalStore(subscribeToClient, readClient, (): AgentClient => 'claude')
  // No header. Claude Code skips the OAuth flow entirely when a static `Authorization` is
  // configured, so handing one out as the default would ship the browser sign-in and guarantee
  // nobody ever reaches it.
  const publicCommand = ADD_COMMANDS[client]

  return (
    <section className="connect-screen">
      <header>
        <h1>Connect your agent</h1>
        <p>
          Give your agent live quotes, option chains, and research. Connect tastytrade through the local
          connector and it also sees your positions and places guarded orders.
        </p>
      </header>

      <aside className="connect-aside">
        <section className="connect-step connect-guards">
          <h2>Every order is checked</h2>
          <p>
            Every order passes spicytrade&apos;s own checks before it reaches tastytrade, whatever any
            agent recommends: defined risk only (never a naked short), checked against your live
            positions and the market, and a clean tastytrade dry run. A refused order stays refused.
            spicytrade does not ask you to confirm orders; any confirmation comes from your agent.
          </p>
          {owner && (
            <p className="connect-owner-note">
              Your account also carries the owner&apos;s watchlist reach: <code>read_watchlist</code>{' '}
              takes a symbol and names where it came from, and <code>manage_watchlist</code> adds to or
              removes from the shared watchlist.
            </p>
          )}
        </section>
      </aside>

      <section className="connect-step">
        <h2>Start in your agent</h2>
        <p>Open the agent you already use and paste this into your conversation:</p>
        <CopyBlock label="Message to your agent" value={CONNECT_PROMPT} />
        <p>
          Your agent installs the local connector and connects it to the current workspace.
          Approve the browser sign-ins and any desktop password dialog, then continue your conversation.
          Your credentials stay in this computer&apos;s keyring.
        </p>
        <p>Once connected, ask “How is my account doing?”</p>
        <p className="connect-note">
          Account access currently needs a local Linux agent with shell access and local MCP support.
          Other agents can use market data and research below. Some agents need a reconnect to load new tools;
          your agent will guide that step when needed.
        </p>
      </section>

      <details className="connect-step connect-fold">
        <summary><h2>Manual installation</h2></summary>
        <p>If you prefer to set up from a terminal on the computer your agent runs on:</p>
        <CopyBlock label="Terminal" value={INSTALL_COMMAND} />
        <p>
          Needs Linux, Node.js 22 or newer, secret-tool, and a desktop keyring.
          Run <code>spicytrade setup</code> to repair; run the install again to update.
          Return to your existing agent after setup. To remove it, run <code>spicytrade uninstall</code>.
        </p>
      </details>

      {/* Folded: the install is the path nearly every member wants, and these two made the page
          several screens long on a phone. Native details keep the contents in the page for
          find-in-page and assistive technology, and open on their own when a search lands inside. */}
      <details className="connect-step connect-fold">
        <summary><h2>Without installing</h2></summary>
        {/* A request with no credential is served, not challenged (src/server/mcp.ts), so adding
            the server never starts a sign-in by itself. Sign-in is whatever the client does with
            the OAuth discovery documents spicytrade publishes, which varies by client. */}
        <p>
          Any MCP client can reach market data and research by spicytrade&apos;s address alone. It
          cannot see your account: positions and orders need the install above.
        </p>
        <ClientPicker client={client} onChange={chooseClient} />
        {publicCommand
          ? <CopyBlock label={AGENT_CLIENT_NAMES[client]} value={publicCommand} />
          : <CopyBlock label="Streamable HTTP server" value={MCP_ENDPOINT} />}
        <p>
          Your agent connects straight away with the cached market snapshot, price history, and shared
          research. For live quotes, option chains, and Greeks, sign in from your client:
          {client === 'claude' && <> in Claude Code, <code>/mcp</code>.</>}
          {client === 'codex' && <> in Codex, <code>codex mcp login {MCP_SERVER_NAME}</code>.</>}
          {client === 'grok' && <> in Grok, its authenticate action for this server.</>}
          {client === 'other' && <> its authenticate action for this server; in Muse, <code>muse mcp login {MCP_SERVER_NAME}</code>.</>}
        </p>
      </details>

      <details className="connect-step connect-fold">
        <summary><h2>Signed-in computers</h2></summary>
        <p>Every computer you have signed in and every token you have created. Revoke one to sign it out.</p>
        {signedIn
          ? <HeadlessTokens />
          : (
              <>
                <p>Sign in to see your computers and create tokens.</p>
                {authError && (
                  <Alert variant="destructive">
                    <AlertTitle>Sign in is unavailable</AlertTitle>
                    <AlertDescription>{authError}</AlertDescription>
                  </Alert>
                )}
                <GoogleSignInButton callbackURL="/connect" />
              </>
            )}
      </details>
    </section>
  )
}

function HeadlessTokens() {
  const { actionError, issue, issued, listError, loading, pending, revoke, tokens } = useAgentTokens()
  // Every token control waits for whichever action is in flight.
  const busy = pending !== undefined
  const [label, setLabel] = useState('')

  return (
    <>
      {/* What a member opens this section for most -- signing a computer out -- comes first; the
          token form for a machine without a browser follows. Each failure is reported beside the
          control that caused it, not at the top of a long page. */}
      {listError && (
        <Alert variant="destructive">
          <AlertTitle>Signed-in computers could not be loaded</AlertTitle>
          <AlertDescription>{listError}</AlertDescription>
        </Alert>
      )}

      {/* Only while the first read is in flight: once it has failed, the alert above the list is the
          answer, and a spinner beside it would claim a read that is no longer happening. */}
      {loading && <Spinner />}
      {tokens?.length === 0 && <p className="connect-empty">No computers or tokens yet.</p>}
      {tokens && tokens.length > 0 && (
        <ul className="connect-tokens">
          {tokens.map((token) => (
            <li key={token.tokenId}>
              <div>
                <strong>{token.label}</strong>
                <span>
                  {token.lastUsedAt
                    ? `last used ${new Date(token.lastUsedAt).toLocaleDateString()}`
                    : 'never used'}
                </span>
              </div>
              <Button disabled={busy} onClick={() => void revoke(token.tokenId)} size="sm" variant="ghost">
                {pending?.kind === 'revoke' && pending.tokenId === token.tokenId
                  ? <Spinner data-icon="inline-start" />
                  : null}
                Revoke
              </Button>
            </li>
          ))}
        </ul>
      )}

      <p>
        For a job that runs with no one signed in, such as a scheduled script, create a token. It gets market
        and research tools only, never your account. A computer you SSH into can use the install above
        if your desktop session is logged in there; setup tells you how to finish signing in from your
        own computer.
      </p>
      <form
        className="connect-issue"
        onSubmit={(event) => {
          event.preventDefault()
          const trimmed = label.trim()
          // Not before the first read answers: a list that lands after the create would not
          // carry the new token, and would replace the list that did.
          if (!trimmed || busy || loading) return
          void issue(trimmed).then((created) => { if (created) setLabel('') })
        }}
      >
        <Input
          aria-label="Token name"
          maxLength={MAX_MCP_TOKEN_LABEL_LENGTH}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="Nightly job"
          value={label}
        />
        <Button disabled={busy || loading || !label.trim()} type="submit">
          {pending?.kind === 'issue' ? <Spinner /> : 'Create token'}
        </Button>
      </form>

      {actionError && (
        <Alert variant="destructive">
          <AlertTitle>Signed-in computers</AlertTitle>
          <AlertDescription>{actionError}</AlertDescription>
        </Alert>
      )}

      {issued && <IssuedToken token={issued.token} />}
    </>
  )
}

/**
 * Both config blocks carry the freshly issued token, so the shortest path never splices a token
 * into a config by hand -- the token is shown exactly once, so that splice is the step with the
 * most to lose. They render only while it is on screen; the digest is all the server kept. The
 * header flag is Claude Code's; every other client takes the same entry as JSON.
 */
function IssuedToken({ token }: { token: string }) {
  const mcpConfig = JSON.stringify({
    mcpServers: { [MCP_SERVER_NAME]: { headers: { Authorization: `Bearer ${token}` }, type: 'http', url: MCP_ENDPOINT } },
  }, null, 2)
  const headlessCommand = `${ADD_COMMANDS.claude} --header "Authorization: Bearer ${token}"`
  return (
    <>
      <Alert>
        <AlertTitle>Copy this now</AlertTitle>
        <AlertDescription>
          This is the only time this token is shown. If you lose it, revoke it and create another.
        </AlertDescription>
      </Alert>
      <CopyBlock label="Your token" value={token} />
      <p>Both blocks below already carry the token you just created. Copy either one.</p>
      <CopyBlock label="Claude Code" value={headlessCommand} />
      <CopyBlock label=".mcp.json" value={mcpConfig} />
    </>
  )
}
