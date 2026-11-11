import { createFileRoute, notFound, redirect } from '@tanstack/react-router'

import { symbolPageHead } from '../components/public-page-head'
import { SymbolPage } from '../components/symbol-page'
import { symbolFromPageAddress } from '../domain/public-page'
import { loadSymbolPage } from '../server/public-page-fns'

/**
 * One server-rendered page per symbol on the public snapshot. It sits outside the `_app` shell
 * because a child of that `ssr: false` layout cannot be server-rendered, and a crawler needs the
 * text in the document.
 *
 * The loader only reads what is stored (`server/public-pages.ts`): opening this page never
 * starts a catalyst search, grows the watchlist, or counts as reader attention. An address that
 * is not a symbol, or a symbol the public snapshot does not show, is a 404 rather than an empty
 * page; a non-canonical spelling (`/options/nvda`) redirects permanently to the canonical one.
 */
export const Route = createFileRoute('/options/$symbol')({
  component: SymbolRoute,
  loader: async ({ params }) => {
    const address = symbolFromPageAddress(params.symbol)
    if (!address) throw notFound()
    if (!address.canonical) throw redirect({ params: { symbol: address.symbol }, replace: true, statusCode: 301, to: '/options/$symbol' })
    const page = await loadSymbolPage({ data: address.symbol })
    if (!page) throw notFound()
    return page
  },
  // After `loader` in this literal: the router infers `loaderData` from the loader above it.
  // A 404 has no loader data, and the router does not render this head for it anyway.
  head: ({ loaderData }) => (loaderData ? symbolPageHead(loaderData.ticker) : {}),
})

function SymbolRoute() {
  return <SymbolPage page={Route.useLoaderData()} />
}
