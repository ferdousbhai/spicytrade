import { type Static, Type } from 'typebox'

import { EquitySymbolType } from './instrument'
import { IsoDateType } from './iso-date'
import { StringEnum } from './string-enum'

/** The exact human option tuple accepted by read tools before broker-side resolution. */
export const EquityOptionTupleSchema = Type.Object({
  expiry: IsoDateType,
  optionType: StringEnum(['C', 'P']),
  strike: Type.Number({ exclusiveMinimum: 0 }),
  underlying: EquitySymbolType,
}, { additionalProperties: false })

export type EquityOptionTuple = Static<typeof EquityOptionTupleSchema>

function tupleKey(tuple: EquityOptionTuple): string {
  return `${tuple.underlying}|${tuple.expiry}|${tuple.optionType}|${tuple.strike}`
}

/** One entry per exact contract, in first-seen order, so duplicate tuples collapse before they reach the broker. */
export function distinctTuples<Tuple extends EquityOptionTuple>(tuples: readonly Tuple[]): Tuple[] {
  return [...new Map(tuples.map((tuple) => [tupleKey(tuple), tuple])).values()]
}
