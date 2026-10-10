import { type AgentTool } from '../domain/agent-tool'
import { Type } from 'typebox'
import { Compile } from 'typebox/compile'

import { type JsonValue } from '../domain/json-payload'
import { textResult } from './agent-tool-result'
import { persistResearchCatalysts } from './catalysts'
import { type AppEnv } from './env'
import { MAX_CITED_SOURCE_URL_LENGTH } from '../domain/https-url'
import { bindCatalystCandidates, ResearchCatalystCandidateSchema } from './research-catalyst-output'
import { retainCitedPages } from './research-page-retention'
import { zodTypeBoxSchema } from './zod-typebox'
import { CallerVisibleError } from './caller-visible-error'

/**
 * The model-authored shapes a member's agent submits: a candidate dated event, and the pages it
 * indexes into. A source is an address and nothing more, because the server reads the page
 * itself and binds the date to that text; a title or summary from the agent would be a claim
 * about the page that nothing here checks.
 */
const CatalystSubmissionSchema = zodTypeBoxSchema(ResearchCatalystCandidateSchema)
const CitedSource = Type.Object({
  sourceUrl: Type.String({ minLength: 1, maxLength: MAX_CITED_SOURCE_URL_LENGTH }),
}, { additionalProperties: false })

/*
 * The gap this fills: catalyst coverage is bought by reader attention, one search per symbol per
 * window. A member's agent that has just spent a session on a name knows dates that search will
 * not find, and until now had nowhere to put them.
 *
 * It is a citation contract, deliberately not a shortcut around one: what arrives is untrusted
 * model output, so the Worker re-reads every cited page
 * through its own browser and `bindCatalystCandidates` refuses any date it cannot find in that
 * text. Rows land under their own producer id, which is what keeps them traceable to the surface
 * that wrote them and retractable as a set.
 *
 * All-or-nothing, for the same reason publishing is: writing whatever survived would leave the
 * agent looking at an apparent success while some of what it recorded silently vanished.
 */

/**
 * How many events one call may record. A recording is what an agent found while researching a
 * name or two -- the dated events behind a thesis -- not a calendar it imported from somewhere,
 * which is a provider adapter's job and would arrive under its own producer id. Twenty is more
 * than any one symbol's runway shows a reader, and small enough that one caller's recording
 * stays reviewable and retractable as a unit.
 */
const MAX_RECORDED_CATALYSTS = 20

const CatalystRecordParameters = Type.Object({
  catalysts: Type.Array(CatalystSubmissionSchema, {
    description: 'Dated events, each naming the source it was read from by index.',
    maxItems: MAX_RECORDED_CATALYSTS,
    minItems: 1,
  }),
  sources: Type.Array(CitedSource, {
    description: 'The pages the events were read from. The server reads each one itself.',
    minItems: 1,
  }),
}, { additionalProperties: false })

const RecordValidator = Compile(CatalystRecordParameters)

type CatalystRecording =
  | { catalystCount: number; status: 'recorded'; symbols: string[] }
  | { rejected: string[]; status: 'rejected' }

export async function recordResearchCatalysts(
  env: AppEnv,
  untrustedRecording: JsonValue,
  requestedNow?: Date,
): Promise<CatalystRecording> {
  const browser = env.BROWSER
  // Without page reading nothing can be bound, so nothing may be written. Fail closed.
  if (!browser) throw new CallerVisibleError('CatalystRecord:page-reading-unavailable')
  // Nothing bound here can be kept without the store, so fail closed before reading a page.
  if (!env.DB) throw new CallerVisibleError('CatalystStoreUnavailable')
  const now = requestedNow ?? new Date()
  // Re-parsed at the trust boundary whatever the transport already checked.
  const recording = RecordValidator.Parse(untrustedRecording)

  const { rejected, retained } = await retainCitedPages(
    browser,
    recording.sources,
    recording.catalysts.map((candidate) => candidate.sourceIndex),
  )
  if (rejected.length) return { rejected, status: 'rejected' }

  const binding = bindCatalystCandidates(
    recording.catalysts,
    recording.sources,
    retained,
    now,
    'member-research',
  )
  if (binding.rejected.length) return { rejected: binding.rejected, status: 'rejected' }

  // Additive, like every research producer: a member who stops recording an event has not
  // cancelled it, so `persistResearchCatalysts` refreshes rows and retires none.
  await persistResearchCatalysts(env, 'member-research', binding.catalysts, now)
  return {
    catalystCount: binding.catalysts.length,
    status: 'recorded',
    symbols: [...new Set(binding.catalysts.map((catalyst) => catalyst.symbol))],
  }
}

export function createCatalystRecordTool(env: AppEnv): AgentTool<typeof CatalystRecordParameters> {
  return {
    description: 'Record dated catalysts you researched, for every reader of this site. The '
      + 'server reads each cited page itself and refuses any event whose date it cannot find in '
      + 'that text; a rejection returns the exact reasons so the citations can be fixed and the '
      + 'recording sent again. Nothing is written unless every event binds. Events are additive '
      + 'and never cancel another producer\'s.',
    // SAFETY: `recordResearchCatalysts` re-parses its input with this same schema at the trust
    // boundary regardless of what the transport already checked.
    execute: async (params) => textResult(await recordResearchCatalysts(env, params as never)),
    name: 'record_catalysts',
    parameters: CatalystRecordParameters,
  }
}
