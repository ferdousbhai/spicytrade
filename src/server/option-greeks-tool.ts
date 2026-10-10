import { type AgentTool } from '../domain/agent-tool'
import { type Static, Type } from 'typebox'
import { Compile } from 'typebox/compile'

import {
  distinctTuples,
  EquityOptionTupleSchema,
  type EquityOptionTuple,
} from '../domain/equity-option'
import { isValidIsoDate } from '../domain/iso-date'
import { type AppEnv } from './env'
import {
  MARKET_FEED_INSTANCE,
  MAX_OPTION_GREEKS_CONTRACTS,
  type OptionGreeksEvent,
  OptionGreeksReadResultSchema,
  OptionStreamerSymbolSchema,
} from './market-feed-contracts'
import { textResult } from './agent-tool-result'
import { resolveEquityOptionTuples } from './option-contract'
import { CallerVisibleError } from './caller-visible-error'

export const ExactOptionGreeksReadParameters = Type.Object({
  contracts: Type.Array(EquityOptionTupleSchema, {
    maxItems: MAX_OPTION_GREEKS_CONTRACTS,
    minItems: 1,
  }),
}, { additionalProperties: false })

const ExactOptionGreeksReadValidator = Compile(ExactOptionGreeksReadParameters)

type ExactOptionGreeksReadInput = Static<typeof ExactOptionGreeksReadParameters>

type ExactOptionGreeksReadResult = {
  asOf: string
  contracts: Array<EquityOptionTuple & OptionGreeksEvent & { sharesPerContract: number; symbol: string }>
  impliedVolatilityUnit: 'decimal_ratio'
  source: 'tastytrade-dxlink'
}

/** Resolve exact broker instruments server-side, then ask the shared MarketFeed DO for live Greeks. */
export async function readExactOptionGreeks(
  env: AppEnv,
  input: ExactOptionGreeksReadInput,
): Promise<ExactOptionGreeksReadResult> {
  const parsed = ExactOptionGreeksReadValidator.Parse(input)
  if (parsed.contracts.some((contract) => !isValidIsoDate(contract.expiry))) {
    throw new CallerVisibleError('Option expiry is invalid.')
  }
  const contracts = distinctTuples(parsed.contracts)
  const resolved = (await resolveEquityOptionTuples(env, contracts, { requireStreamerSymbol: true })).map((instrument) => ({
    ...instrument,
    streamerSymbol: OptionStreamerSymbolSchema.parse(instrument.streamerSymbol),
  }))
  const streamerSymbols = resolved.map((contract) => contract.streamerSymbol)
  if (new Set(streamerSymbols).size !== streamerSymbols.length) {
    throw new CallerVisibleError('Requested option contracts did not resolve to unique market-data instruments.')
  }
  if (!env.MARKET_FEED) throw new CallerVisibleError('Live option Greeks are unavailable.')
  const observation = OptionGreeksReadResultSchema.parse(
    await env.MARKET_FEED.getByName(MARKET_FEED_INSTANCE).readOptionGreeks(streamerSymbols),
  )
  const byStreamerSymbol = new Map(observation.greeks.map((greeks) => [greeks.streamerSymbol, greeks]))
  if (byStreamerSymbol.size !== streamerSymbols.length
    || observation.greeks.length !== streamerSymbols.length
    || streamerSymbols.some((symbol) => !byStreamerSymbol.has(symbol))) {
    throw new CallerVisibleError('Live option Greeks returned an incomplete or mismatched observation.')
  }
  return {
    asOf: observation.asOf,
    contracts: resolved.map(({ expiry, optionType, strike, underlying, sharesPerContract, streamerSymbol, symbol }) => ({
      expiry,
      optionType,
      strike,
      underlying,
      ...byStreamerSymbol.get(streamerSymbol)!,
      sharesPerContract,
      streamerSymbol,
      symbol,
    })),
    impliedVolatilityUnit: 'decimal_ratio',
    source: 'tastytrade-dxlink',
  }
}

export function createExactOptionGreeksReadTool(
  env: AppEnv,
): AgentTool<typeof ExactOptionGreeksReadParameters> {
  return {
    description: 'Live broker IV and Greeks for exact option tuples.',
    execute: async (params) => textResult(await readExactOptionGreeks(env, params)),
    name: 'read_option_greeks',
    parameters: ExactOptionGreeksReadParameters,
  }
}
