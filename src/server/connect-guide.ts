import { CONNECT_GUIDE_URL, INSTALL_SCRIPT_URL, MCP_ENDPOINT } from '../domain/site'

/** Installation instructions are repository-owned constants, never provider or model content. */
export const CONNECT_PROMPT = `Connect Spicytrade to this conversation so I can use my tastytrade account. Read ${CONNECT_GUIDE_URL} and follow its setup instructions.`

export function connectGuide(): string {
  return `# Connect Spicytrade in the current agent

The user is already in their chosen agent. Stay in that conversation. Never launch another
agent or move the user into a special trading folder.

## Local account access

Requires a shell on the user's own Linux or macOS computer and Node.js 22+. Linux also needs
secret-tool and a desktop keyring; macOS uses its login keychain. The user approves one link in
any browser, on that computer or another device such as their phone.
Windows is not supported: on Windows, do not attempt the install. Tell the user account access
needs Linux or macOS, and offer research through ${MCP_ENDPOINT} instead.
If you have no shell on the user's computer, explain that account access needs the local
command; offer research through ${MCP_ENDPOINT} instead. Do not claim a cloud shell is the
user's local computer.

Do every step yourself. The user's only part is approving one link; do not hand them commands
to run. There is nothing to register with the agent and nothing to restart.

1. If ~/.local/bin/spicytrade already exists, skip this step. Otherwise inspect the install
   script before running it, then install the command without starting terminal setup:

   curl -fsSL ${INSTALL_SCRIPT_URL} | bash -s -- --connector-only

2. Run ~/.local/bin/spicytrade connect from the user's current workspace and keep it running.
   It prints one link and a short code: give the user both. The page asks them to type the
   code. The one approval signs in and continues to tastytrade, which they approve in that same
   browser. Browser
   consent, never an agent-supplied answer, authorizes the brokerage connection. Do not collect
   passwords, tokens or authorization codes in chat. Over SSH nothing more is needed: the link
   is approved in whichever browser the user opens it in.

   The command then verifies a live account snapshot and writes a spicytrade skill into this
   workspace, for Claude Code and Codex when they are installed, so later conversations started
   here know the command exists. Report success only after it says the snapshot was verified.

3. Use it in this conversation straight away, from your shell:

   ~/.local/bin/spicytrade tools                    how to use it, and every tool
   ~/.local/bin/spicytrade tools <name>             one tool's arguments
   ~/.local/bin/spicytrade call <name> '<json>'      call a tool

   Do not place a trade as part of setup. Place, replace or cancel an order only when the user
   asks for exactly that, as its own command, never inside a script or a loop.

## Research without the local command

Register ${MCP_ENDPOINT} as a Streamable HTTP MCP server using this harness's native settings.
Public research works without a credential. Use the harness's OAuth login for live market
features. This path cannot read accounts or place orders. Unattended jobs use research-only
credentials and never receive a broker token.

## Repair

Run ~/.local/bin/spicytrade doctor to check the connection without changing anything, and
~/.local/bin/spicytrade connect to sign in or reconnect tastytrade again. No credential belongs
in a repository or an agent's settings.
`
}
