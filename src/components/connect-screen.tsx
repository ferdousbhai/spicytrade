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
import { CopyBlock } from './copy-block'
import { MCP_ENDPOINT } from '../domain/site'

const PROXY_URL = 'http://127.0.0.1:8787/mcp'
/** The default of `TRADING_DIR` in `ops/spicytrade/config.mjs`, the one folder Claude Code loads the proxy in. */
const TRADING_DIR = '~/trading'
/** The name every client's config knows the server by; `spicytrade setup` adds it under this too. */
const MCP_SERVER_NAME = 'spicytrade'
const addCommands = (url: string) => ({
  claude: `claude mcp add --transport http ${MCP_SERVER_NAME} ${url}`,
  codex: `codex mcp add ${MCP_SERVER_NAME} --url ${url}`,
  grok: `grok mcp add --transport http ${MCP_SERVER_NAME} ${url}`,
  other: undefined,
}) satisfies Record<AgentClient, string | undefined>
/**
 * The one command for the proxy path: it runs the browser sign-in, the keyring, the service, the
 * brokerage and the agent's config in order, and is also the repair when any of them is missing.
 */
const SETUP_COMMAND = './ops/spicytrade/spicytrade.mjs setup'
const DOCTOR_COMMAND = './ops/spicytrade/spicytrade.mjs doctor'
/** Reads the spicytrade token from the keyring, so it needs the token stored first. */
const CONNECT_TASTYTRADE_COMMAND = './ops/spicytrade/connect-tastytrade.mjs'

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
const UNEXPECTED_RESPONSE = 'Agent tokens returned an unexpected response.'

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
        setListError(toError(cause)?.message ?? 'Agent tokens are unavailable')
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

export function ConnectScreen({ owner }: { owner: boolean }) {
  const { actionError, issue, issued, listError, loading, pending, revoke, tokens } = useAgentTokens()
  // Every token control waits for whichever action is in flight.
  const busy = pending !== undefined
  const [label, setLabel] = useState('')
  // The server renders the first client; the browser's stored choice takes over on hydration.
  const client = useSyncExternalStore(subscribeToClient, readClient, (): AgentClient => 'claude')

  // While a freshly issued token is on screen, both blocks carry it. A placeholder here made the
  // shortest path copy the token, copy the config, then splice one into the other by hand -- and
  // the token is shown exactly once, so that splice is the step with the most to lose. After the
  // reveal the placeholder is all that can honestly be shown: the digest is all the server kept.
  const bearer = issued?.token ?? 'YOUR_TOKEN'
  const mcpConfig = JSON.stringify({
    mcpServers: { [MCP_SERVER_NAME]: { headers: { Authorization: `Bearer ${bearer}` }, type: 'http', url: MCP_ENDPOINT } },
  }, null, 2)
  const headlessCommand = `${addCommands(MCP_ENDPOINT).claude} --header "Authorization: Bearer ${bearer}"`
  // No header. Claude Code skips the OAuth flow entirely when a static `Authorization` is
  // configured, so handing one out as the default would ship the browser sign-in and guarantee
  // nobody ever reaches it.
  const publicCommand = addCommands(MCP_ENDPOINT)[client]
  // No Authorization header: the proxy attaches the keyring token so the agent holds none.
  // Claude Code adds at local scope by default, so the command runs from the trading folder
  // `spicytrade setup` uses: account tools load there, not in every session or in a checkout.
  const proxyCommand = client === 'claude'
    ? `mkdir -p ${TRADING_DIR} && cd ${TRADING_DIR} && ${addCommands(PROXY_URL).claude}`
    : addCommands(PROXY_URL)[client]

  return (
    <section className="connect-screen">
      <header>
        <h1>Connect your agent</h1>
        <p>
          spicytrade is a tool surface for an agent running on your own machine — Claude Code, Grok, Codex, or
          anything that speaks MCP. Any agent can read the public market surface without signing in
          at all. Signing yours in adds live quotes, option chains and Greeks, lets it add symbols
          to the watchlist, and lets it record catalysts and evidence everyone reads.
        </p>
      </header>

      {/* One aside for the picker and the guards: a wide screen holds it beside the steps so the
          choice stays in reach while the commands under it change; one column dissolves it and
          the guards take their place after the steps. */}
      <aside className="connect-aside">
        <ClientPicker client={client} onChange={chooseClient} />
        <section className="connect-step connect-guards">
          <h2>What the agent cannot do</h2>
          <p>
            Orders run the same server-side guards regardless of what any agent recommends: the exact
            contract is resolved from the live chain, the portfolio and market checks
            run against fresh broker state, and the broker&apos;s own dry-run must come back clean. A
            refusal is final. spicytrade has no confirmation step of its own: any prompt before an order
            comes from your agent, and the server-side guards are what bound the risk.
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
        <h2>1 · Point your agent at spicytrade</h2>
        {/* A request with no credential is served, not challenged (src/server/mcp.ts), so adding
            the server never starts a sign-in by itself. Sign-in is whatever the client does with
            the OAuth discovery documents spicytrade publishes, which varies by client. */}
        <p>
          Run the command for your agent and it connects straight away at the public tier: the cached market
          snapshot, price history, and the shared research, with nothing to copy and no sign-in.
        </p>
        {publicCommand
          ? <CopyBlock label={AGENT_CLIENT_NAMES[client]} value={publicCommand} />
          : (
              <>
                <CopyBlock label="Streamable HTTP server" value={MCP_ENDPOINT} />
                <p className="connect-note">
                  Muse: add a streamable-HTTP <code>{MCP_SERVER_NAME}</code> entry under <code>mcpServers</code> in its
                  <code> settings.json</code>. Pi has no built-in MCP client; add one with an extension
                  (<code>pi install</code>).
                </p>
              </>
            )}
        <p>
          To add live quotes, option chains, and Greeks, sign in from your client&apos;s own
          authenticate action for this server. spicytrade publishes standard OAuth discovery, so a
          client that supports it opens a browser to sign you in with Google and renews its own
          access — you should not need to come back here.
          {client === 'claude' && <> In Claude Code that is <code>/mcp</code>.</>}
          {client === 'codex' && <> In Codex that is <code>codex mcp login {MCP_SERVER_NAME}</code>.</>}
          {client === 'other' && <> In Muse that is <code>muse mcp login {MCP_SERVER_NAME}</code>.</>}
        </p>
        <p className="connect-note">
          If your client cannot sign in this way, use the local proxy below. If you already run the
          proxy, point the agent there instead.
        </p>
      </section>

      {/* The two optional steps are folded: most members need only step one, and these two made
          the page several screens long on a phone. Native details keep the contents in the page
          for find-in-page and assistive technology, and open on their own when a search lands
          inside. */}
      <details className="connect-step connect-fold">
        <summary><h2>2 · Local proxy <span className="connect-optional">optional</span></h2></summary>
        <p>
          A process on this machine attaches your spicytrade token, and your brokerage&apos;s short-lived
          token, from the keyring, so the agent holds neither. That is how balances, positions and
          orders reach your agent, and how any client that cannot complete a browser sign-in gets
          live quotes, chains, and Greeks. From a checkout of this repository, run:
        </p>
        <CopyBlock label="Set up the proxy" value={SETUP_COMMAND} />
        <p>
          It signs you in through the browser, stores the token in your keyring, installs the proxy,
          offers to connect tastytrade, and adds spicytrade to your agent. Run it again at any time;
          it skips what is already done. If something stops working, run{' '}
          <code>{DOCTOR_COMMAND}</code> and it names the step to fix.
        </p>
        <details className="connect-manual">
          <summary>Manual setup</summary>
          <CopyBlock
            label="Store your spicytrade token"
            value={'./ops/spicytrade/store-credentials.sh mcp-token'}
          />
          <p>Issue the token in step 3, paste it at the prompt. The script restarts the proxy.</p>
          {proxyCommand
            ? <CopyBlock label={AGENT_CLIENT_NAMES[client]} value={proxyCommand} />
            : <CopyBlock label="Streamable HTTP server" value={PROXY_URL} />}
          <p className="connect-note">
            No <code>Authorization</code> header. Pointing at <code>{MCP_ENDPOINT}</code> without signing
            in is the public snapshot: cached quotes, no chains, no account.
            {client === 'grok' && <> Grok lists tools, not prompts; every tool&apos;s own description carries its contract.</>}
          </p>
          <p>
            A brokerage is a second store: balances, positions, order history, and orders against
            your account only. Run this, approve spicytrade on tastytrade&apos;s own page, and the grant
            lands in your keyring — spicytrade never keeps it. The script restarts the proxy.
          </p>
          <CopyBlock label="Connect tastytrade" value={CONNECT_TASTYTRADE_COMMAND} />
          <p className="connect-note">
            Already use a personal OAuth grant from my.tastytrade.com? Store it instead; keep only
            one kind, or the proxy will not start.
          </p>
          <CopyBlock
            label="Store a personal grant"
            value={'./ops/spicytrade/store-credentials.sh tastytrade'}
          />
        </details>
      </details>

      <details className="connect-step connect-fold">
        <summary><h2>3 · Headless access <span className="connect-optional">optional</span></h2></summary>
        <p>
          A machine that runs unattended cannot complete a browser sign-in, so it uses a token
          instead. If you are sitting at a terminal, step one is the one you want.
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
            placeholder="Laptop"
            value={label}
          />
          <Button disabled={busy || loading || !label.trim()} type="submit">
            {pending?.kind === 'issue' ? <Spinner /> : 'Create token'}
          </Button>
        </form>

        {/* Every token failure -- the list read, a create, a revoke -- comes from this step, so it
            is reported here, beside the control that caused it, not at the top of a long page. */}
        {actionError && (
          <Alert variant="destructive">
            <AlertTitle>Agent tokens</AlertTitle>
            <AlertDescription>{actionError}</AlertDescription>
          </Alert>
        )}
        {listError && (
          <Alert variant="destructive">
            <AlertTitle>Agent token list</AlertTitle>
            <AlertDescription>{listError}</AlertDescription>
          </Alert>
        )}

        {issued && (
          <>
            <Alert>
              <AlertTitle>Copy this now</AlertTitle>
              <AlertDescription>
                This is the only time this token is shown. If you lose it, revoke it and create another.
              </AlertDescription>
            </Alert>
            <CopyBlock label="Your token" value={issued.token} />
          </>
        )}

        {/* Only while the first read is in flight: once it has failed, the alert above the list is the
            answer, and a spinner beside it would claim a read that is no longer happening. */}
        {loading && <Spinner />}
        {tokens?.length === 0 && <p className="connect-empty">No tokens yet.</p>}
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
          {issued
            ? 'Both blocks below already carry the token you just created — copy either one.'
            : 'Substitute a token above; it is shown only at the moment it is issued.'}
        </p>
        {/* The header flag is Claude Code's; every other client takes the same entry as JSON. */}
        <CopyBlock label="Claude Code" value={headlessCommand} />
        <CopyBlock label=".mcp.json" value={mcpConfig} />
        <p className="connect-note">
          A configured <code>Authorization</code> header takes precedence over the browser flow, so
          use this only where there is no browser.
        </p>
      </details>
    </section>
  )
}
