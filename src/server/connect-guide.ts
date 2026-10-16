import { CONNECT_GUIDE_URL, INSTALL_SCRIPT_URL, MCP_ENDPOINT } from '../domain/site'

/** Installation instructions are repository-owned constants, never provider or model content. */
export const CONNECT_PROMPT = `Connect Spicytrade to this conversation so I can use my tastytrade account. Read ${CONNECT_GUIDE_URL} and follow its setup instructions.`

export function connectGuide(): string {
  return `# Connect Spicytrade in the current agent

The user is already in their chosen agent. Stay in that conversation. Never launch another
agent, choose a preferred agent, inspect unrelated installed harnesses, or move the user into
a special trading folder. Configure only this harness in the user's current workspace.

## Local account access

Requires a local Linux execution environment, Node.js 22+, secret-tool, a desktop keyring,
and a browser the user can approve in. If the harness has no local shell or no stdio MCP
support, explain that account access needs the local connector; offer research through
${MCP_ENDPOINT} instead. Do not claim a cloud shell is the user's local computer.

1. Inspect the install script before running it. Install the connector without configuring any
   agent or starting terminal setup:

   curl -fsSL ${INSTALL_SCRIPT_URL} | bash -s -- --connector-only

2. Run ~/.local/bin/spicytrade integration to get the exact absolute command and args for this
   installation. No returned value is a credential. Register that stdio server as spicytrade
   using the CURRENT harness's native mechanism, scoped to this workspace. Preserve unrelated
   settings. Do not configure every agent, store tokens in configuration, or add environment
   variables for credentials. If an existing spicytrade entry points somewhere else, inspect
   it before changing it; do not replace an unrelated server merely because its name matches.

   Claude Code: in the current workspace, use
   claude mcp add --scope local spicytrade -- <command from integration> mcp
   Confirm it from the same workspace: claude mcp get spicytrade must show a Local scope and
   that command. A server added during a conversation may load only when Claude Code restarts in
   this workspace; claude --continue resumes the conversation. Use /mcp to reconnect a server
   that was already loaded.

   Check from the workspace: ~/.local/bin/spicytrade doctor checks the folder it runs in, so run
   it there, never from another directory, before reporting the harness configured.

   Codex: merge into this trusted workspace's .codex/config.toml:
   [mcp_servers.spicytrade]
   command = "<absolute command from integration>"
   args = ["mcp"]
   enabled = true
   Do not add an entry disabled at user scope or ask the user to start with configuration flags.

   Other local harnesses: use their native stdio MCP configuration with the integration output.
   If the native registration mechanism is unknown, consult that harness's documentation;
   do not guess a configuration format or launch Claude/Codex as a substitute.

3. Refresh this harness's MCP tools using its supported mechanism. When connect_spicytrade is
   available, call it with action=start, give the user its browser link or explain the desktop
   dialog, and check action=status after they approve. The tool returns immediately, so the
   conversation stays responsive. Browser consent, never an agent-supplied answer, authorizes
   the brokerage connection. Do not collect passwords, tokens or authorization codes in chat.

   If newly registered tools cannot load in this running conversation, the current agent can
   run ~/.local/bin/spicytrade connect in its own shell. This explicit account-connection command
   works without a TTY, opens browser approval, and verifies a live snapshot. Keep the process
   running while the user approves. It never launches or configures an agent; run from Claude
   Code, its closing line says whether this workspace has the server, and if not, the command
   that adds it. Act on that line before telling the user to continue. On SSH, follow
   its port-forward instructions; remote browser approval needs a route back to that machine.

4. On success, call setup_required if available to reload saved credentials, then call
   read_account_snapshot in this conversation. Do not retry a trade as part of setup. Report
   success only after a live account read. If this harness cannot refresh MCP tools, clearly
   distinguish "account connected" from "tools loaded in this conversation" and give only its
   supported reconnect/resume step. Do not promise that every harness supports hot reload.

## Research without a local connector

Register ${MCP_ENDPOINT} as a Streamable HTTP MCP server using this harness's native settings.
Public research works without a credential. Use the harness's OAuth login for live market
features. This path cannot read accounts or place orders. Unattended jobs use research-only
credentials and never receive a broker token.

## Repair

Use connect_spicytrade to reconnect and setup_required to reload. Advanced manual setup remains
available as spicytrade setup. spicytrade start is an optional convenience, never a required
step in this onboarding flow. No credential belongs in a repository or an agent's settings.
`
}
