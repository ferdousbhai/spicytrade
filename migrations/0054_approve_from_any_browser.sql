-- Connecting a computer no longer returns the browser to a listener on that computer: the member
-- approves in any browser, and the CLI that printed the link collects the result by presenting
-- the verifier whose SHA-256 the link carried. These two tables replace `agent_logins` and
-- `broker_authorizations`, which the deployment before this one still reads; they are dropped
-- in a later migration.

-- A sign-in the member approved, until the CLI collects its agent token. It holds no credential:
-- the challenge is public, and only the verifier, which never leaves the CLI, redeems it.
--
-- The TTL, per-member cap and value shapes live in code (`src/domain/agent-login.ts`).
CREATE TABLE agent_approvals (
  challenge  TEXT PRIMARY KEY,
  -- A pending sign-in dies with the account, exactly as an agent token does.
  user_id    TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  label      TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX agent_approvals_user_id ON agent_approvals (user_id);
CREATE INDEX agent_approvals_expires_at ON agent_approvals (expires_at);

-- A brokerage consent the same approval started, until the CLI collects the grant. The state is
-- kept only as its SHA-256 digest, so a database read cannot be replayed through the callback.
-- `code` is the broker's one-time authorization code, held from the browser's return until the
-- CLI's next poll: redeeming it takes the app's client secret, the member's agent token and the
-- CLI's verifier, and the refresh token it yields goes to the member's keyring, never here.
-- `refusal` is the OAuth error the broker returned instead, from this repository's own list.
--
-- The broker and the bounds live in code (`src/domain/broker-authorization.ts`).
CREATE TABLE broker_consents (
  state_digest TEXT PRIMARY KEY,
  challenge    TEXT NOT NULL,
  user_id      TEXT NOT NULL REFERENCES "user" ("id") ON DELETE CASCADE,
  broker       TEXT NOT NULL,
  code         TEXT,
  refusal      TEXT,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

CREATE INDEX broker_consents_challenge ON broker_consents (challenge);
CREATE INDEX broker_consents_user_id ON broker_consents (user_id);
CREATE INDEX broker_consents_expires_at ON broker_consents (expires_at);
