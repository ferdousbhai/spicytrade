import { ArrowUpRight } from '@phosphor-icons/react/ssr'

import { type DailyBrief } from '../domain/brief'

/** The morning's cited links, shared by the brief screen and a brief's own server-rendered page. */
export function BriefHeadlines({ links }: { links: DailyBrief['links'] }) {
  if (links.length === 0) return null
  return (
    <section aria-labelledby="brief-headlines-title" className="brief-headlines-section">
      <h2 id="brief-headlines-title">Headlines</h2>
      <ol className="brief-headlines">
        {links.map((link) => {
          const url = new URL(link.url)
          return (
            <li key={link.url}>
              {/* Title and snippet are third-party page text: React escapes them. With no
                  headline the host stands in as the title and the path follows on one
                  clipped line; nothing is derived from the slug, since that would put words
                  in the reader's view the page never said. The href keeps the whole URL. */}
              <a href={link.url} rel="noreferrer" target="_blank">
                <span className="brief-headline-title">{link.title ?? url.host}<ArrowUpRight aria-hidden="true" /></span>
                {link.snippet && <span className="brief-headline-snippet">{link.snippet}</span>}
                {link.title
                  ? <span className="brief-headline-host">{url.host}</span>
                  : <span className="brief-headline-host brief-headline-path">{url.pathname + url.search}</span>}
              </a>
            </li>
          )
        })}
      </ol>
    </section>
  )
}
