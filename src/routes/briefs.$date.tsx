import { createFileRoute, notFound } from '@tanstack/react-router'

import { BriefPage } from '../components/brief-page'
import { briefPageHead } from '../components/public-page-head'
import { marketDateFromPageAddress } from '../domain/public-page'
import { loadBriefPage } from '../server/public-page-fns'

/**
 * One server-rendered page per published brief, addressed by its market date. Outside the
 * `_app` shell for the same reason as `/options/$symbol`. An address that is not a real date,
 * or a date no brief was published for, is a 404.
 */
export const Route = createFileRoute('/briefs/$date')({
  component: BriefRoute,
  loader: async ({ params }) => {
    const marketDate = marketDateFromPageAddress(params.date)
    if (!marketDate) throw notFound()
    const page = await loadBriefPage({ data: marketDate })
    if (!page) throw notFound()
    return page
  },
  // After `loader` in this literal: the router infers `loaderData` from the loader above it.
  // A 404 has no loader data, and the router does not render this head for it anyway.
  head: ({ loaderData }) => (loaderData ? briefPageHead(loaderData.brief) : {}),
})

function BriefRoute() {
  return <BriefPage page={Route.useLoaderData()} />
}
