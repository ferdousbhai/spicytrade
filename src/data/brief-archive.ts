import { z } from 'zod'

import { DailyBriefSchema, type DailyBrief } from '../domain/brief'
import { loadPublicJson } from './public-json'

const BriefArchiveResponseSchema = z.strictObject({ brief: DailyBriefSchema.nullable() })

/** The brief for the latest market date before `marketDateBefore`, the one the reader is on. */
export async function loadPreviousDailyBrief(marketDateBefore: string): Promise<DailyBrief | undefined> {
  const query = new URLSearchParams({ before: marketDateBefore })
  return (await loadPublicJson(`/api/public-daily-briefs?${query}`, BriefArchiveResponseSchema)).brief ?? undefined
}
