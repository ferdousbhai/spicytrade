import { createFileRoute } from '@tanstack/react-router'

import { ConnectView } from '../components/spice-app'
import { appViewHead } from '../domain/site'

export const Route = createFileRoute('/_app/connect')({
  component: ConnectView,
  head: () => appViewHead('/connect'),
})
