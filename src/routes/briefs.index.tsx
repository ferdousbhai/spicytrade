import { createFileRoute } from '@tanstack/react-router'

import { BriefArchivePage } from '../components/brief-page'
import { briefArchiveHead } from '../components/public-page-head'
import { loadBriefArchive } from '../server/public-page-fns'

/** The server-rendered index of every published brief, the way into each brief's own page. */
export const Route = createFileRoute('/briefs/')({
  component: BriefArchiveRoute,
  head: briefArchiveHead,
  loader: () => loadBriefArchive(),
})

function BriefArchiveRoute() {
  return <BriefArchivePage briefs={Route.useLoaderData()} />
}
