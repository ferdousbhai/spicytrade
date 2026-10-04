import { Type } from 'typebox'
import { z } from 'zod'

/**
 * tastytrade equity symbology, the one rule every symbol in spicytrade is bound by.
 *
 * "Equity symbols contain only alphanumeric characters (A-Z, 0-9) with an occasional `/`.
 * A few examples: `AAPL` `BRK/A`" — https://developer.tastytrade.com/api-overview/
 * (#tastytrade-symbology).
 *
 * tastytrade publishes no regex and no length: its OpenAPI spec declares `symbol` as a bare
 * string with no `pattern` or `maxLength`. The bounds below are therefore the documented
 * character set plus the shape every published example honors — a root of at most six
 * alphanumerics, which is also the width of the OCC root field, so any optionable equity
 * fits, followed by an optional share class after a single slash that never leads. A
 * leading `/` is a futures symbol and a `:` suffix marks a streamer symbol; neither is an
 * equity, so neither is accepted here.
 *
 * The dot form (`BRK.B`) is the NASDAQ file convention rather than tastytrade's, and the
 * broker 404s on it. A provider with its own rendering translates at that provider's own
 * boundary and nowhere else — `yahooSymbol` maps the slash to Yahoo's dash.
 */
/** The OCC root field's width, which every optionable equity's root fits. */
const MAX_SYMBOL_ROOT = 6
/** The share-class width of the shape described above, after the single slash. */
const MAX_SHARE_CLASS = 3
const equitySymbolBody = (characters: string): string =>
  `${characters}{1,${MAX_SYMBOL_ROOT}}(?:/${characters}{1,${MAX_SHARE_CLASS}})?`
const EQUITY_SYMBOL_BODY = equitySymbolBody('[A-Z0-9]')

/**
 * The shape a symbol may arrive in when it comes out of model text: X's cashtag, any letter
 * case, and nothing else. It admits exactly what `equitySymbolFromModelText` can read, so the
 * schema a provider validates against and the reader behind it cannot disagree about what is
 * well formed. Another venue's notation stays a visible refusal until it is named a
 * convention here, and both halves change together in this one place.
 */
export const MODEL_TEXT_EQUITY_SYMBOL_PATTERN = `^\\$?${equitySymbolBody('[A-Za-z0-9]')}$`
export const ModelTextEquitySymbolType = Type.String({ pattern: MODEL_TEXT_EQUITY_SYMBOL_PATTERN })

/** Root, the one slash, and the share class: derived from the pattern's bounds, never restated. */
export const MAX_EQUITY_SYMBOL_LENGTH = MAX_SYMBOL_ROOT + '/'.length + MAX_SHARE_CLASS

export const EQUITY_SYMBOL_PATTERN = `^${EQUITY_SYMBOL_BODY}$`
export const EQUITY_SYMBOL_REGEX = new RegExp(EQUITY_SYMBOL_PATTERN)
export const EquitySymbolType = Type.String({ pattern: EQUITY_SYMBOL_PATTERN })
export const EquitySymbolSchema = z.string().trim().toUpperCase().regex(EQUITY_SYMBOL_REGEX)

/**
 * The same grammar as a SQL predicate over `column`, for a read that must filter before its LIMIT
 * so the limit counts only symbols the schema will accept. A value satisfies it exactly when it
 * matches `EQUITY_SYMBOL_REGEX`: only `[A-Z0-9/]`, at most one slash, a root of 1 to
 * `MAX_SYMBOL_ROOT` characters, and a share class of 1 to `MAX_SHARE_CLASS` after the slash.
 * The bounds are checked with `length`/`instr` rather than spelled out as one GLOB per width,
 * because D1 refuses a GLOB pattern over 50 bytes and the widest spelled-out shape needs 73.
 * GLOB is case sensitive, so pass the column upper-cased, as `EquitySymbolSchema` reads it.
 */
export function equitySymbolSql(column: string): string {
  const slash = `instr(${column}, '/')`
  return `(${column} NOT GLOB '*[^A-Z0-9/]*'
    AND CASE ${slash}
      WHEN 0 THEN length(${column}) BETWEEN 1 AND ${MAX_SYMBOL_ROOT}
      ELSE ${slash} - 1 BETWEEN 1 AND ${MAX_SYMBOL_ROOT}
        AND length(${column}) - ${slash} BETWEEN 1 AND ${MAX_SHARE_CLASS}
        AND instr(substr(${column}, ${slash} + 1), '/') = 0
    END)`
}

/**
 * A ticker arriving from model text may still wear the cashtag X writes it with, and Reddit
 * uses both forms. Search keeps whichever the venue expects; every provider and internal
 * lookup takes the bare symbol, so a symbol crossing out of model text is read here rather
 * than rejected for a convention it was written in. Anything still unreadable stays refused.
 */
export function equitySymbolFromModelText(value: string): string | undefined {
  return EquitySymbolSchema.safeParse(value.trim().replace(/^\$/, '').toUpperCase()).data
}

/** Reads every value as a ticker, or names the first one that is not. */
export function equitySymbolsFromModelText(values: readonly string[]):
  { symbols: string[] } | { unreadable: string } {
  const symbols: string[] = []
  for (const value of values) {
    const symbol = equitySymbolFromModelText(value)
    if (symbol === undefined) return { unreadable: value }
    symbols.push(symbol)
  }
  return { symbols }
}

const OptionalBoolean = z.boolean().nullable()

/**
 * The longest provider identifier or one-line label accepted: a country, a listed market, an
 * instrument sub-type, a streamer symbol. Real values are a few dozen characters at most; this only
 * refuses a runaway value. It is also the `length(...) <= 128` CHECK on the instrument catalog's
 * columns (migrations 0008 and 0014), so the two change together or not at all.
 */
export const MAX_PROVIDER_LABEL_LENGTH = 128
/**
 * The longest provider description accepted: a company's or fund's name line, far shorter in
 * practice. It is the `length(description) BETWEEN 1 AND 512` CHECK on the instrument catalog, so the two
 * change together.
 */
export const MAX_PROVIDER_DESCRIPTION_LENGTH = 512

// Provider description fields are untrusted storage input. These generous text widths bound
// D1 rows and UI strings without classifying or shortening any valid symbol or trading field.
export const InstrumentCatalogItemSchema = z.object({
  /**
   * Whether the broker still trades it. False is a delisted or acquired name -- ANSS, ATVI and
   * a hundred others -- which quotes a stale last price forever and can never trade again. The
   * column was always stored and never read, so a dead ticker resolved like any other.
   */
  active: OptionalBoolean,
  borrowRate: z.number().finite().nullable(),
  countryOfIncorporation: z.string().trim().min(1).max(MAX_PROVIDER_LABEL_LENGTH).nullable(),
  description: z.string().trim().min(1).max(MAX_PROVIDER_DESCRIPTION_LENGTH).nullable(),
  isEtf: OptionalBoolean,
  isIndex: OptionalBoolean,
  lendability: z.string().trim().min(1).max(MAX_PROVIDER_LABEL_LENGTH).nullable(),
  listedMarket: z.string().trim().min(1).max(MAX_PROVIDER_LABEL_LENGTH).nullable(),
  resolutionStatus: z.enum(['resolved', 'unresolved']),
  shortDescription: z.string().trim().min(1).max(256).nullable(),
  symbol: EquitySymbolSchema,
})

export type InstrumentCatalogItem = z.infer<typeof InstrumentCatalogItemSchema>

/**
 * Tradeable today. A catalog row exists for names the broker has stopped trading, and they are
 * kept rather than deleted -- a held position or an old citation still needs to resolve one --
 * but nothing may offer them as something to look at or act on.
 */
export function isTradeableInstrument(item: Pick<InstrumentCatalogItem, 'active' | 'resolutionStatus'>): boolean {
  return item.resolutionStatus === 'resolved' && item.active !== false
}
