import { type DailyBrief, type DatedRecommendation } from './brief'
import { type Catalyst } from './catalyst'
import { EquitySymbolSchema } from './instrument'
import { IsoDateSchema } from './iso-date'
import { type MarketState, type PublicTicker } from './market'

/*
 * The server-rendered public pages: one per symbol on the public snapshot, one per published
 * brief, and the brief archive. They exist so a crawler, a link preview, or a reader without
 * JavaScript gets the text; the live application stays the client-rendered shell. Everything a
 * page carries already crosses the public boundary through the snapshot, catalyst, and brief
 * reads -- these shapes add nothing account-derived and nothing about watchlist provenance.
 */

/** One symbol as the stored public snapshot holds it, with what is already stored about it. */
export type SymbolPageData = {
  /** Upcoming dated events already on the calendar, one row per event, nearest first. */
  catalysts: Catalyst[]
  marketState: MarketState
  /** `null` is a name no published brief has recommended. */
  recommendation: DatedRecommendation | null
  /** The store's instant for this symbol's oldest reading, the same bound a snapshot reports. */
  syncedAt: string
  ticker: PublicTicker
}

/** One published brief with the market dates of its archive neighbours, when it has them. */
export type BriefPageData = {
  brief: DailyBrief
  newerMarketDate: string | null
  olderMarketDate: string | null
  /**
   * Which of the brief's names have a symbol page today. A brief keeps a name the public
   * snapshot has since dropped, and its page would be a 404, so only these are linked.
   */
  symbolsWithPages: string[]
}

/** One line of the archive index: a published market date and the names that brief argued. */
export type BriefArchiveEntry = {
  marketDate: string
  symbols: string[]
}

/**
 * The symbol a page address names, and whether the address is already its canonical spelling.
 * The repository's one symbol rule decides both: an address that does not parse names no page,
 * and one that parses to a different string (lower case, stray spaces) is the same page under a
 * non-canonical address, which the route redirects rather than serving twice.
 */
export function symbolFromPageAddress(segment: string): { canonical: boolean; symbol: string } | undefined {
  const parsed = EquitySymbolSchema.safeParse(segment)
  if (!parsed.success) return undefined
  return { canonical: parsed.data === segment, symbol: parsed.data }
}

/** The market date a brief address names; anything but a real `YYYY-MM-DD` date names no page. */
export function marketDateFromPageAddress(segment: string): string | undefined {
  return IsoDateSchema.safeParse(segment).data
}
