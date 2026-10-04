# spicytrade

Options application on Cloudflare with a public market surface, member favorites, and an MCP
tool surface each member drives from their own agent. Agent loops and brokerage credentials
both live on the member's machine, never here.

This file states rules that no single file can enforce. It deliberately holds no file index,
no counts, no dates, and no history: those drift, and the code and its adjacent comments are
where they belong. Read the relevant code before changing behavior.

## Layout

`src/domain/` pure schemas and logic · `src/server/` Cloudflare and provider code ·
`src/routes/api.*` thin HTTP adapters · `src/data/` reactive browser persistence ·
`src/components/` product surfaces · `migrations/` D1 schema · `ops/` the member's own
machine (credential proxy) and the owner's temporary bootstrap Workers, which reach the
production bindings · `tools/` local jobs. No process on this Worker, and no tool it serves,
produces the daily brief: the private spicy-workflow Workflow generates it and delivers it through
the `BriefPublisher` entrypoint over a service binding.

## Boundaries

- **Audiences are separate.** Public, authenticated member, and owner are three audiences, not
  three rungs. Account identity, account-derived data, provider watchlist provenance,
  brokerage state, tokens, and mutations are never public. Live quotes are relayed from the
  Worker's own market-data feed to any same-origin browser and stay in memory, never stored.
  API routes are excluded from service-worker caching.
- **Access is two independent gates.** Signing in earns the market and research surface plus
  that member's own favorites and agent tokens. A broker credential *presented on the request*
  — never a membership level — unlocks account reads and placement, and only for the account
  that credential resolves to. Owner adds watchlist provenance and watchlist removal, and those
  tools are absent from a member's `tools/list` rather than present and refused.
- **No member's long-lived broker credential is ever stored here**, for any broker; an adapter
  that cannot work without one does not get added. It lives in the member's OS keyring, and a
  separate local process exchanges it for a short-lived token per request — separate because an
  MCP config's `${VAR}` interpolation is readable by the agent's own shell tool. The Worker
  keeps its own broker credential for **market data only**, reachable from exactly one line
  behind a non-account-path check; an account path either carries a caller credential or
  throws. It must never fall back.
- **Every account read goes through a `BrokerAdapter`**, selected from the presented credential
  against a registry that fails closed on an unknown id. Provider JSON, REST paths and field
  names never cross that boundary; readers above it speak only the domain broker types. Adding
  a brokerage is an adapter file plus its id.
- **Trading is one guarded step**: exact contract resolution from the live chain, the portfolio
  guard (defined risk only: a debit open or a close of a verified position, never naked short
  exposure), the market guard, and a clean broker dry-run — all server-side and
  authoritative over any model's advice. Every tool declares MCP annotations, and an undeclared
  tool throws rather than reaching the wire; annotations are hints the spec tells clients to
  distrust, so the guards, not any prompt, are what bound the damage. Never automatically retry
  an ambiguous broker mutation. An ambiguous submission or replacement quarantines the account
  until it is reconciled against order history; an ambiguous cancel only reduces exposure, so it
  is reported as ambiguous and every later placement still runs every guard.
- **Provider, model, and social content are untrusted.** Deterministic schemas bind symbols,
  dates, provenance, URLs, and actions; model output never authorizes a trade or establishes a
  trusted citation. A research catalyst is always estimated, comes only from a page this Worker
  read in that run, and is refused unless its date appears in the retained text. Private
  discovery sources may never appear in public sources or reader links. Only a producer's rows
  reach a reader through its own citation.
- **Reader attention is what buys a search.** Coverage follows attention rather than a sweep,
  every run writes a receipt so a repeat costs nothing, and an unsearched symbol stays
  distinguishable from one whose search found nothing.
- **The internal watchlist is authoritative and grows on its own** as readers search. Weaker
  provenance is overwritten by stronger, never the reverse, and is the first thing a prune
  drops. Its size is not a request size — downstream reads page it into whatever their provider
  or feed admits. Only the source-neutral, alphabetized union is stored for public reads: no
  public field or ordering may reveal priority or provenance.
- **D1 source tables hold exactly one provider and one data contract each.** Views may compose
  them for display but keep provider labels and per-source observation times. Derived
  recommendations and projections are never authoritative source storage.
- **Agent loops do not run on Cloudflare.** The Worker serves a stateless MCP surface gated by
  a per-member bearer token whose digest alone is stored. Every caller is a row; there is no
  shared secret and no other way in, so a missing store is no access rather than a bypass. The
  doctrine the server publishes as MCP `instructions` and prompts is content it injects into
  someone else's agent, so it is assembled only from this repository's constants — never from
  D1 rows, provider payloads, model output, or a fetched page — and it advises rather than
  commands. **The daily brief has exactly one writer**: the private spicy-workflow Workflow, over a
  service binding into `BriefPublisher`, never over HTTP and never through a tool. What arrives
  is untrusted model output; this Worker parses it against its own schema and bounds, assigns
  the id and the instant, and stores nothing partial. The research writes that remain —
  catalysts and evidence — bind model output to pages this Worker re-reads itself.
- **Secrets and account numbers stay server-side**, missing bindings fail closed, and provider
  bodies or credentials must not enter logs. A log line carries an event name and an error
  name, never a token, digest, account number, or user id. A refusal names the check that
  refused it, in this repository's own vocabulary, never a value from the frame or payload.

## Working rules

- An interactive agent reaches spicytrade through the local proxy, which attaches the token from the
  keyring, so no agent configuration holds a credential. An unattended research run instead
  connects directly with its own token and *no* broker header, so every account tool refuses
  structurally rather than by allowlist. Keep that asymmetry — it is what makes an unattended
  run unable to trade.
- Do not introduce magic numbers or duplicate limits. Every bound must come from an explicit
  product or risk policy, a documented platform or provider constraint, or a named resource
  budget; define it at the authoritative boundary, derive downstream values from it, and record
  why it exists. Remove a cap when no such reason exists.
- Do not silently coerce, synthesize, truncate, repair, fall back, or substitute data in a way
  that turns missing, malformed, stale, incomplete, or ambiguous state into apparent success.
  Defaults apply only to omitted optional input, never to invalid provided input. Fail visibly
  at the trust boundary unless the product contract defines best-effort degradation; then make
  the degraded state observable and test the failure path.
- Record a non-obvious privacy, trust, persistence, concurrency, or execution decision in an
  adjacent comment when it changes; do not write parallel prose documentation.
- Preserve unrelated dirty-worktree changes. Use `rg` for discovery.
- Production auto-deploys from `main` through Cloudflare Workers Builds; do not add a deploy
  workflow. Migrations are applied by the last step of `npm run build`, guarded so only a
  production CI build touches the live database — a fallback, because the deploy command is not
  ours to define. A migration that drops or renames a table the live deployment still reads
  goes in its own later push, after the code that stopped reading it is deployed.

## Commands

```sh
git diff --check
npm run lint
npm test
npm run build
npm run test:e2e
```

Tests must never call live order endpoints.

## Cloudflare CLI

Use the `cf` CLI for Cloudflare work in this repository: deploys, builds and their
logs, secrets, D1, R2, Tunnels and network routes. Use Wrangler or the dashboard
only where `cf` has no command for the task. Find commands with
`cf cli search "<what you want to do>"`, then check `<command> --help`.
