import { createFileRoute } from '@tanstack/react-router'

import { RecommendationsView } from '../components/spice-app'
import { appViewHead } from '../domain/site'

export const Route = createFileRoute('/_app/recommendations')({
  component: RecommendationsView,
  head: () => appViewHead('/recommendations'),
})
