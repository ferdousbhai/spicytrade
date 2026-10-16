import { Link } from '@tanstack/react-router'
import { type ReactNode } from 'react'
import { SUPPORT_EMAIL } from '../domain/site'
import { BrandMark, HOME_LINK_LABEL } from './wordmark'

/** Support and the legal pages, shared by the legal pages' header and the Connect view's footer. */
export function LegalLinks() {
  return (
    <>
      <a href={`mailto:${SUPPORT_EMAIL}`}>Support</a>
      <Link to="/terms">Terms</Link>
      <Link to="/privacy">Privacy</Link>
      <Link to="/disclosures">Disclosures</Link>
    </>
  )
}

export function SitePage({
  children,
  intro,
  title,
}: {
  children: ReactNode
  intro: string
  title: string
}) {
  return (
    <div className="site-page">
      <a className="skip-link" href="#page-content">Skip to content</a>
      <header className="site-header">
        <Link aria-label={HOME_LINK_LABEL} className="site-brand" to="/watch">
          <BrandMark />
        </Link>
        <nav aria-label="Information">
          <LegalLinks />
        </nav>
      </header>
      <main className="site-content" id="page-content">
        <header className="site-title">
          <h1>{title}</h1>
          <p>{intro}</p>
        </header>
        <div className="site-prose">{children}</div>
      </main>
      <footer className="site-footer">
        <span>© 2026 spicytrade</span>
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>
      </footer>
    </div>
  )
}
