import { createFileRoute } from '@tanstack/react-router'

import { WatchView } from '../components/spice-app'
import { appViewHead } from '../domain/site'

export const Route = createFileRoute('/_app/watch')({
  component: WatchView,
  head: () => appViewHead('/watch'),
})
