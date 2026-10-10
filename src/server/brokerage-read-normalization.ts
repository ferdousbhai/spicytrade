import { z } from 'zod'

import { BROKER_ORDER_ID_MAX_LENGTH } from '../domain/broker'
import { isValidIsoDate } from '../domain/iso-date'
import { envelopeRows, jsonNumber, jsonObject, type JsonObject, type JsonValue } from '../domain/json-payload'
import { CallerVisibleError } from './caller-visible-error'

type ItemEnvelope = { rows: JsonObject[]; totalItems?: number }


export function invalidResponse(label: string): never {
  throw new CallerVisibleError(`${label} returned an invalid response.`)
}

export function itemEnvelope(payload: JsonValue, label: string, maximumRows: number): ItemEnvelope {
  const body = jsonObject(payload)
  const data = jsonObject(body?.data ?? payload)
  const candidate = envelopeRows(payload)
  if (!candidate || candidate.length > maximumRows) return invalidResponse(label)
  const rows = candidate.map((value) => jsonObject(value) ?? invalidResponse(label))

  const rawPagination = body?.pagination ?? data?.pagination
  if (rawPagination === undefined || rawPagination === null) return { rows }
  const pagination = jsonObject(rawPagination) ?? invalidResponse(label)
  // A total the broker declared but that cannot be read is not the same fact as no total:
  // callers decide completeness from it, so it fails rather than reading as absent.
  if (!Object.hasOwn(pagination, 'total-items')) return { rows }
  const totalItems = finiteNumber(pagination['total-items'], label)
  if (!Number.isSafeInteger(totalItems) || totalItems < 0) return invalidResponse(label)
  return { rows, totalItems }
}

export function optionalText(
  row: JsonObject,
  keys: readonly string[],
  label: string,
  maxLength: number,
): string | undefined {
  for (const key of keys) {
    const value = row[key]
    if (value === undefined || value === null || value === '') continue
    const raw = z.string().safeParse(value).data
    if (raw === undefined) return invalidResponse(label)
    const normalized = raw.trim()
    if (!normalized || normalized.length > maxLength) return invalidResponse(label)
    return normalized
  }
  return undefined
}

export function requiredText(
  row: JsonObject,
  keys: readonly string[],
  label: string,
  maxLength: number,
): string {
  return optionalText(row, keys, label, maxLength) ?? invalidResponse(label)
}

export function finiteNumber(value: JsonValue, label: string): number {
  return jsonNumber(value) ?? invalidResponse(label)
}

export function optionalNumber(row: JsonObject, keys: readonly string[], label: string): number | undefined {
  for (const key of keys) {
    const value = row[key]
    if (value === undefined || value === null || value === '') continue
    return finiteNumber(value, label)
  }
  return undefined
}

export function optionalRatioPercent(row: JsonObject, keys: readonly string[], label: string): number | undefined {
  const value = optionalNumber(row, keys, label)
  return value === undefined ? undefined : Math.round(value * 10_000) / 100
}

/**
 * Fields tastytrade already reports in percent or points, so they are only rounded.
 *
 * The unit is per field, not per provider: `implied-volatility-index` arrives as a ratio while
 * `implied-volatility-30-day` arrives as points, carrying the same number. Which fields fall
 * on which side is recorded once, in the unit note above the helpers in
 * `tastytrade-market-normalization.ts` -- established from production rows rather than
 * documentation. Read it before choosing a converter here, and extend it there rather than
 * starting a second list: this module and that one consume the same payload, and the 100x
 * error on the 30-day survived because each had decided the units separately.
 *
 * When a field is not on that list, settle it arithmetically against a sibling that must
 * agree: `iv-hv-30-day-difference` is the 30-day minus the 30-day historical, which holds in
 * exactly one of the two readings.
 */
export function optionalPercentPoints(row: JsonObject, keys: readonly string[], label: string): number | undefined {
  const value = optionalNumber(row, keys, label)
  return value === undefined ? undefined : Math.round(value * 100) / 100
}

export function optionalBoolean(row: JsonObject, keys: readonly string[], label: string): boolean | undefined {
  for (const key of keys) {
    const value = row[key]
    if (value === undefined || value === null) continue
    return z.boolean().safeParse(value).data ?? invalidResponse(label)
  }
  return undefined
}

export function requiredIdentifier(row: JsonObject, key: string, label: string): string {
  const value = row[key]
  const numeric = z.number().safeParse(value).data
  if (numeric !== undefined && Number.isSafeInteger(numeric)) return String(numeric)
  const normalized = z.string().safeParse(value).data?.trim()
  if (normalized && normalized.length <= BROKER_ORDER_ID_MAX_LENGTH) return normalized
  return invalidResponse(label)
}

export function optionalDate(row: JsonObject, keys: readonly string[], label: string): string | undefined {
  const value = optionalText(row, keys, label, 40)
  if (value === undefined) return undefined
  return isValidIsoDate(value) ? value : invalidResponse(label)
}

export function optionalTimestamp(row: JsonObject, keys: readonly string[], label: string): string | undefined {
  const value = optionalText(row, keys, label, 40)
  if (value === undefined) return undefined
  if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value) || Number.isNaN(Date.parse(value))) return invalidResponse(label)
  return value
}

export function requiredTimestamp(row: JsonObject, keys: readonly string[], label: string): string {
  return optionalTimestamp(row, keys, label) ?? invalidResponse(label)
}
