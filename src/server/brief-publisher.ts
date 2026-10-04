import { WorkerEntrypoint } from 'cloudflare:workers'

import { type DailyBrief, type DailyBriefSubmission } from '../domain/brief'
import { publishDailyBrief } from './daily-brief-store'
import { type AppEnv } from './env'

/**
 * The one way a daily brief gets written. Reachable only over a service binding from another
 * Worker in this account, never over HTTP, so the producer needs no token and nothing public
 * can reach it. The caller is the private spicy-workflow Workflow; what it sends is treated as
 * untrusted model output: the type on the parameter is the caller's claim, and the store
 * re-parses the value against this Worker's own contract before anything is written.
 *
 * The class name, like the Worker name it is reached through, is fixed across rebrands: the
 * Workflow's service binding names this entrypoint, so renaming it breaks that repo's binding.
 */
export class BriefPublisher extends WorkerEntrypoint<AppEnv> {
  async publish(submission: DailyBriefSubmission): Promise<Pick<DailyBrief, 'id' | 'publishedAt'>> {
    if (!this.env.DB) throw new Error('BriefPublisher:store-unavailable')
    const brief = await publishDailyBrief(this.env.DB, submission)
    console.info(JSON.stringify({ event: 'DailyBriefPublished', id: brief.id, recommendations: brief.recommendations.length }))
    return { id: brief.id, publishedAt: brief.publishedAt }
  }
}
