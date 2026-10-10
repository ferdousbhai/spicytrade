import { equitySymbolFromModelText, equitySymbolsFromModelText } from '../domain/instrument'
import { CallerVisibleError } from './caller-visible-error'

/**
 * A tool argument that does not read as a ticker. A refusal, not a result: returned as an ordinary
 * answer it read to the model as a successful call. Named by the argument and its position only;
 * the text itself is the caller's and stays out of the message.
 */
export class UnreadableTickerError extends CallerVisibleError {
  constructor(argument: string) {
    super(`TickerArgument:not-a-ticker: ${argument} is not a ticker symbol.`)
    this.name = 'UnreadableTickerError'
  }
}

/** Every entry of a `symbols` argument as a ticker, or a refusal naming the first that is not. */
export function tickerSymbolsArgument(values: readonly string[]): string[] {
  const parsed = equitySymbolsFromModelText(values)
  if ('unreadable' in parsed) throw new UnreadableTickerError(`symbols[${values.indexOf(parsed.unreadable)}]`)
  return parsed.symbols
}

/** One ticker argument, or a refusal naming it. */
export function tickerSymbolArgument(value: string, argument: string): string {
  const symbol = equitySymbolFromModelText(value)
  if (symbol === undefined) throw new UnreadableTickerError(argument)
  return symbol
}
