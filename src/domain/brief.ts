import { z } from 'zod'

import { CitedSourceUrlSchema } from './https-url'
import { EquitySymbolSchema } from './instrument'
import { IsoDateSchema } from './iso-date'

/*
 * The daily brief: a trade line and a thesis per name, and the morning's market-moving links. It
 * is produced by exactly one writer, the private spicy-workflow Workflow, and delivered through
 * `BriefPublisher`; this schema is the contract that boundary
 * holds the submission to, and the shape every reader of a stored brief gets back. It carries
 * what the site renders and nothing the producer keeps for itself: the structured legs stay in
 * the producer's ledger, and the trade line is the producer's own rendering of them.
 *
 * Every bound below is a rendering envelope for untrusted model text, not a research limit.
 */

export const BRIEF_DIRECTIONS = ['bullish', 'bearish', 'neutral'] as const
/**
 * A thesis is untrusted model markdown rendered in full on the brief card, so this is its
 * rendering envelope: room for an argued page, not an essay the card was never laid out for.
 */
export const MAX_THESIS_LENGTH = 4_096
/** A trade line is one short line: `NVDA 1/16/26: Buy 150c Sell 170c` is the long case. */
export const MAX_TRADE_LABEL_LENGTH = 80
/** A morning's hot page yields a few dozen links at most; more than this is a sweep, not a reading list. */
export const MAX_BRIEF_LINKS = 50
/**
 * A headline is the link's text on the brief: one line on a desktop and at most a few wrapped
 * lines at phone width. Longer than this is a page's body, not its headline.
 */
export const MAX_BRIEF_LINK_TITLE_LENGTH = 200
/**
 * A snippet is the short paragraph under a headline that says why it moved: a few sentences, a
 * handful of lines at phone width. Longer is an excerpt of the article rather than its summary.
 */
export const MAX_BRIEF_LINK_SNIPPET_LENGTH = 500
/** High conviction only: a brief that argues more names than this is a screener dump. */
export const MAX_BRIEF_RECOMMENDATIONS = 10
/** A model id as its runtime names it, one line on the cover beside the date. */
export const MAX_BRIEF_MODEL_LENGTH = 80

export const BriefRecommendationSchema = z.strictObject({
  symbol: EquitySymbolSchema,
  direction: z.enum(BRIEF_DIRECTIONS),
  /** The brief's one-line trade, as the producer rendered it from the legs it keeps. */
  trade: z.string().min(1).max(MAX_TRADE_LABEL_LENGTH),
  /** Markdown, rendered by the site's own subset renderer; never HTML. */
  thesis: z.string().min(1).max(MAX_THESIS_LENGTH),
})

/*
 * A headline and its snippet are text the producer lifted from a third-party page, so they are
 * untrusted plain text: rendered as escaped text, never markup, and held to one line each. An
 * over-length, blank, or multi-line value is refused rather than trimmed or cut — bounding it to
 * this envelope is the producer's job, and a cut here would publish words the page never said.
 */
const BriefLinkTextSchema = (maxLength: number) => z.string()
  .max(maxLength)
  .regex(/\S/, 'blank')
  .regex(/^\P{Cc}*$/u, 'control character')

/**
 * Both texts are optional: a producer that sends only the URL, and every brief stored before
 * headlines existed, still parses, and the page falls back to showing the URL itself.
 */
export const BriefLinkSchema = z.strictObject({
  url: CitedSourceUrlSchema,
  title: BriefLinkTextSchema(MAX_BRIEF_LINK_TITLE_LENGTH).optional(),
  snippet: BriefLinkTextSchema(MAX_BRIEF_LINK_SNIPPET_LENGTH).optional(),
})

/** What the producer submits. The id and the instant are assigned at the publish boundary. */
export const DailyBriefSubmissionSchema = z.strictObject({
  marketDate: IsoDateSchema,
  /** The model that produced it, as the producer's runtime names it. */
  model: z.string().min(1).max(MAX_BRIEF_MODEL_LENGTH),
  links: z.array(BriefLinkSchema).max(MAX_BRIEF_LINKS),
  recommendations: z.array(BriefRecommendationSchema).max(MAX_BRIEF_RECOMMENDATIONS),
})

export const DailyBriefSchema = DailyBriefSubmissionSchema.extend({
  id: z.string().regex(/^brief-\d{4}-\d{2}-\d{2}$/),
  publishedAt: z.string().datetime(),
})

/** One brief per market date: a second publication for the same date replaces the first. */
export function dailyBriefId(marketDate: string): string {
  return `brief-${marketDate}`
}

export type BriefLink = z.infer<typeof BriefLinkSchema>
export type BriefRecommendation = z.infer<typeof BriefRecommendationSchema>
export type DailyBriefSubmission = z.infer<typeof DailyBriefSubmissionSchema>
export type DailyBrief = z.infer<typeof DailyBriefSchema>
