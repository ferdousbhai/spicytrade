import { createFileRoute, Link } from '@tanstack/react-router'

import { SitePage } from '../components/site-page'
import { PRIVACY_EMAIL, pageTitle } from '../domain/site'

export const Route = createFileRoute('/privacy')({
  component: PrivacyPage,
  head: () => ({
    meta: [
      { title: pageTitle('Privacy') },
      { name: 'description', content: 'What spicytrade stores, what it never stores, and who else handles your data.' },
    ],
  }),
})

function PrivacyPage() {
  return (
    <SitePage intro="What spicytrade stores, what it never stores, and who else handles your data." title="Privacy policy">
      <p className="site-effective">Effective <time dateTime="2026-09-25">September 25, 2026</time></p>
      <section>
        <h2>What spicytrade stores</h2>
        <p>If you sign in: your Google name, email, and profile picture link; your Google sign-in tokens, encrypted; your sessions, which may record your IP address and browser; your ticker favorites; the computers you sign in and the tokens you create (a name and a digest, never the token itself) and when each was last used; and the agent apps you approve. While you connect tastytrade, a pending record that holds no credential exists for a few minutes and is then deleted.</p>
        <p>If your agent records evidence, it is shown publicly under the byline you choose; the link to your account is never shown. Catalysts your agent records are shown publicly without attribution. Every order placed through spicytrade is kept with its brokerage account number, so an unclear submission can be checked against the broker&apos;s order history.</p>
        <p>Symbols that anyone looks up, adds through an agent, or trades join a shared watchlist that is not linked to anyone.</p>
      </section>
      <section>
        <h2>What spicytrade never stores</h2>
        <p>Your brokerage credential stays in your computer&apos;s keyring. It passes through spicytrade only in memory, when you connect and when spicytrade on your computer exchanges it for a short-lived access token. Balances, positions, and order history are read from your broker only on a request that presents that token, and are not saved. Your agent runs on your own machine, not here.</p>
      </section>
      <section>
        <h2>Cookies and browser storage</h2>
        <p>spicytrade sets a sign-in cookie and two cookies that let a page recover from a broken update. Your browser also keeps your preferences and the latest market data so pages open quickly. There are no advertising or analytics cookies.</p>
      </section>
      <section>
        <h2>Who else handles data</h2>
        <p>Cloudflare hosts spicytrade, its database, and its request logs. Google handles sign-in, and when your profile picture is shown, your browser loads it directly from Google. tastytrade supplies market data and, on requests that present your credential, your account data and orders. Exa and Yahoo Finance receive symbols and company names for research and price history, never your identity. The agent you connect receives what its tools return, under its provider&apos;s terms. spicytrade does not sell personal data or use it for advertising.</p>
      </section>
      <section>
        <h2>Your choices</h2>
        <p>You can sign out computers and revoke tokens under Signed-in computers on the <Link to="/connect">Connect</Link> tab and clear browser storage at any time. To request access, correction, or deletion, email <a href={`mailto:${PRIVACY_EMAIL}`}>{PRIVACY_EMAIL}</a>. Deleting your account removes your profile, sessions, favorites, tokens, approved apps, and recorded evidence. Order records are kept so past trades stay verifiable. Material changes to this policy will appear here with a new effective date.</p>
      </section>
    </SitePage>
  )
}
