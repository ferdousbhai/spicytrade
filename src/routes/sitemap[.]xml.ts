import { createFileRoute } from '@tanstack/react-router'

import { sitemapResponse } from '../server/sitemap'
import { appEnv } from '../server/worker-env'

export const Route = createFileRoute('/sitemap.xml')({
  server: {
    handlers: {
      GET: () => sitemapResponse(appEnv),
    },
  },
})
