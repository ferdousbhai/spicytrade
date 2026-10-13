import { CONNECT_GUIDE_URL, INSTALL_SCRIPT_URL, MCP_ENDPOINT, MCP_PATH, SITE_NAME } from '../domain/site'
import { SPICE_GUIDE } from './doctrine'

/**
 * `/llms.txt` and `/llms-full.txt` (https://llmstxt.org): what the site is and how an agent
 * should use it, for an agent that arrived at the address rather than at `/mcp`.
 *
 * Assembled from the same constants the connect screen and the MCP guide use, so a moved endpoint
 * or a renamed tool changes this with them instead of leaving a second copy to drift. Same trust
 * rule as the MCP doctrine: nothing here comes from D1, a provider, or a model.
 */

const ORIGIN = new URL(MCP_ENDPOINT).origin
const at = (path: string) => `${ORIGIN}${path}`

export function llmsTxt(): string {
  return `
# ${SITE_NAME}

> Options market data and research for US equities and ETFs -- quotes, implied-volatility
> metrics, a catalyst calendar, and a daily options brief -- with guarded order placement
> through a member's own tastytrade account. Agents should use the MCP server at
> ${MCP_ENDPOINT} rather than scraping the web app.

The web app is client-rendered; its pages need JavaScript. Every account read and every order
goes through the MCP server, never through the web app, and the server's own guards decide
what is admissible.

## MCP server

- [MCP endpoint (Streamable HTTP)](${MCP_ENDPOINT}): Connect directly with no credential for the public tier: the site's cached snapshot quotes, catalysts, research reads and the daily brief.
- [Connect in the current agent](${CONNECT_GUIDE_URL}): Follow this guide to install the local connector, register only the current harness in its workspace, and approve browser authorization without launching a new agent. The connector keeps credentials in the OS keyring; no MCP configuration holds a credential.
- [Local MCP server installer](${INSTALL_SCRIPT_URL}): Use \`--connector-only\` for agent-driven onboarding. Manual terminal setup remains available.
- [OAuth protected resource metadata](${at(`/.well-known/oauth-protected-resource${MCP_PATH}`)}): How an HTTP MCP client discovers sign-in for the endpoint.
- [Full agent guide](${at('/llms-full.txt')}): This file plus the guide the MCP server publishes as its \`spicytrade://guide\` resource.

## Public JSON

- [Market snapshot](${at('/api/public-snapshot')}): The tracked watchlist's tickers, catalysts, market state, and the latest brief.
- [Symbol search](${at('/api/public-symbol-search')}): \`?q=\` one ticker or company name; a resolved name may be added to the tracked watchlist.
- [Catalysts](${at('/api/public-catalysts')}): \`?symbol=\` dated events for one symbol, with sources.
- [Brief archive](${at('/api/public-daily-briefs')}): \`?before=YYYY-MM-DD\` the latest daily brief published before that market date.

## Pages

- [Watch](${at('/watch')}): The market table and one symbol's detail.
- [Recommendations](${at('/recommendations')}): The daily options brief and its archive.
- [Connect](${at('/connect')}): Setup commands for connecting an agent.

## Optional

- [Terms](${at('/terms')})
- [Privacy](${at('/privacy')})
- [Disclosures](${at('/disclosures')})
`.trim() + '\n'
}

export function llmsFullTxt(): string {
  return `${llmsTxt()}
## Agent guide

The guide below is the \`spicytrade://guide\` resource an MCP client reads on demand.

${SPICE_GUIDE.replace(/^# .*\n+/, '')}
`
}
