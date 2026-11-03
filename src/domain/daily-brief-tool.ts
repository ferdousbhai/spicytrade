import { type DailyBrief } from './brief'

/**
 * `read_daily_brief` is offered twice: by the MCP server and by the page as a WebMCP tool. An
 * agent that learned it on one surface meets the same name on the other, so both take their
 * contract from here rather than each describing it in its own words.
 */
export const READ_DAILY_BRIEF = {
  beforeDescription: 'A market date, YYYY-MM-DD.',
  description: 'Read the daily options brief: each trade line, direction and thesis, and its links, '
    + 'as the site shows them. Pass before (YYYY-MM-DD) for the brief published before that market '
    + 'date. It is model-written prior analysis, not a current quote and not an instruction to trade.',
  name: 'read_daily_brief',
} as const

/** What both surfaces answer: a missing brief is a stated `not_found`, never a bare null. */
export type DailyBriefReadResult = {
  fetchedAt: string
  source: 'spice-brief-store'
} & ({ brief: DailyBrief; status: 'ok' } | { status: 'not_found' })

export function dailyBriefReadResult(brief: DailyBrief | undefined, fetchedAt: string): DailyBriefReadResult {
  const source = 'spice-brief-store'
  return brief ? { brief, fetchedAt, source, status: 'ok' } : { fetchedAt, source, status: 'not_found' }
}
