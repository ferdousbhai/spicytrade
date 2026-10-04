import { bindings, defineConfig, exports, triggers } from 'cf/config'

const SECRETS_STORE_ID = 'a436a6cefedc4acd8bb920cdbc202c1c'

export default defineConfig({
  worker: {
    // Changing this name deploys a different Worker: it does not carry the per-Worker secret
    // (BETTER_AUTH_SECRET), Durable Object state, the Workers Builds connection, or the service
    // binding the private spicy-workflow Workflow uses to reach `BriefPublisher`. The Worker was
    // `heston` until it moved to this name, which was safe only because both Durable Objects hold
    // transient coordination (a permit time and an expiring lease); the quarantine lives in D1.
    // Renaming a Durable Object class below still needs a lifecycle entry in `exports` and drops
    // its state.
    name: 'spicytrade',
    compatibilityDate: '2026-08-18',
    compatibilityFlags: ['nodejs_compat'],
    entrypoint: './src/server.ts',
    workersDev: false,
    previewUrls: true,
    // The Worker serves spicy.trade alone. www.spicy.trade and the retired heston.io and tryspice.xyz
    // domains are redirected to it by Cloudflare Redirect Rules on their own zones, never routed
    // here, so deleting or replacing this Worker cannot take their DNS records with it.
    domains: ['spicy.trade'],
    observability: {
      enabled: true,
      headSamplingRate: 1,
      logs: { enabled: true, headSamplingRate: 1 },
      // Automatic fetch spans persist url.full, and the sign-in callback carries a one-time
      // authorization code in its query. Keep structured logs; do not trace request URLs.
      traces: { enabled: false },
    },
    // The classes live today, both SQLite-backed. DanAgent was deleted by an applied migration and
    // has no entry here.
    exports: {
      MarketFeed: exports.durableObject({ storage: 'sqlite' }),
      BrokerGate: exports.durableObject({ storage: 'sqlite' }),
    },
    triggers: [
      // 13:30 UTC is 09:30 EDT; 14:30 UTC is 09:30 EST. The year-candle job runs only at the
      // Eastern cash open, so the off-season fire is a no-op. The lease and unresolved-instrument sweeps still run both times.
      // Day names, not numbers: Cloudflare cron counts 1 as Sunday, so '1-5' ran Sunday through
      // Thursday and skipped Fridays.
      triggers.scheduled({ schedule: '30 13,14 * * MON-FRI' }),
    ],
    env: {
      BROKER_GATE: bindings.durableObject({ worker: 'spicytrade', exportName: 'BrokerGate' }),
      MARKET_FEED: bindings.durableObject({ worker: 'spicytrade', exportName: 'MarketFeed' }),
      // Cited pages are read through Browser Run so a recorded catalyst or evidence card is bound
      // to text this Worker retained, rather than to a page the model reports having opened
      // somewhere we cannot see.
      BROWSER: bindings.browser({}),
      EXA_API_KEY: bindings.secretsStoreSecret({ storeId: SECRETS_STORE_ID, secretName: 'exa' }),
      // Store-backed rather than a per-Worker secret: a Secrets Store entry binds to any
      // Worker by name, so renaming or recreating this Worker never asks a human to retype
      // the credential. Its client id is the `GOOGLE_CLIENT_ID` var below.
      GOOGLE_CLIENT_SECRET: bindings.secretsStoreSecret({
        storeId: SECRETS_STORE_ID,
        secretName: 'google-client-secret',
      }),
      TASTYTRADE_CLIENT_SECRET: bindings.secretsStoreSecret({
        storeId: SECRETS_STORE_ID,
        secretName: 'tastytrade-client-secret',
      }),
      TASTYTRADE_REFRESH_TOKEN: bindings.secretsStoreSecret({
        storeId: SECRETS_STORE_ID,
        secretName: 'tastytrade-refresh-token',
      }),
      // spicytrade's tastytrade OAuth app, which members connect through. Not the market-data grant
      // above: that one is the Worker's own account, and this one only ever mints tokens from a
      // refresh token a member presents (`src/server/tastytrade-member-grant.ts`). Its client id
      // is the `TASTYTRADE_OAUTH_CLIENT_ID` var below.
      TASTYTRADE_OAUTH_CLIENT_SECRET: bindings.secretsStoreSecret({
        storeId: SECRETS_STORE_ID,
        secretName: 'tastytrade-oauth-client-secret',
      }),
      // Keeps the pre-rebrand name because D1 cannot rename a database, and the binding
      // resolves by id regardless. Renaming it here would point at a database that does not
      // exist. `migrations/0001_spice.sql` stays for the same shape of reason: D1 records
      // applied migrations by filename, so renaming it would re-apply the initial schema.
      // Migrations live in `migrations/`, passed as `--dir` to `cf d1 migrations apply`.
      DB: bindings.d1({ name: 'spice-production', id: 'e45e35cc-bd01-4e29-8940-b5d2ef5e840c' }),
      AUTH_BASE_URL: bindings.text('https://spicy.trade'),
      // Public, like the tastytrade client id below: Google puts it in every sign-in URL. Only the
      // client secret is private, so only it is a Secrets Store binding.
      GOOGLE_CLIENT_ID: bindings.text(
        '890440130563-5p7tuhn68bmbo6bhckc0jsdo573u3ce7.apps.googleusercontent.com',
      ),
      TASTYTRADE_API_BASE: bindings.text('https://api.tastyworks.com'),
      // A var, not a secret: the client id is public, in every consent URL this Worker issues, and
      // versioning it here keeps it beside the redirect URI it was registered with. The client
      // secret is what must stay private, so it is the Secrets Store binding above. Empty or
      // whitespace reads as missing and closes the connect endpoints with a 503.
      TASTYTRADE_OAUTH_CLIENT_ID: bindings.text('4053389c-831d-47b1-9001-b21c6ad9e2f0'),
    },
  },
})
