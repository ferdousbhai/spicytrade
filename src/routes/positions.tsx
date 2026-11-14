import { createFileRoute } from '@tanstack/react-router'

import { PositionsPage } from '../components/positions-page'
import { positionsHead } from '../components/public-page-head'
import { loadPositionsPage } from '../server/public-page-fns'

/** The server-rendered book: every position the brief has open, and the ones it has closed. */
export const Route = createFileRoute('/positions')({
  component: PositionsRoute,
  head: positionsHead,
  loader: () => loadPositionsPage(),
})

function PositionsRoute() {
  return <PositionsPage page={Route.useLoaderData()} />
}
