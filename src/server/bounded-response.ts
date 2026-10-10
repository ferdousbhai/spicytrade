import { toError } from '../domain/failure'
import { type JsonValue } from '../domain/json-payload'

export async function readBoundedText(response: Response, maxBytes: number, label: string): Promise<string> {
  const declared = Number(response.headers.get('Content-Length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel()
    throw new Error(`${label}:response-too-large`)
  }
  if (!response.body) return ''

  // The boundary is measured in raw bytes; decoding streams so no second pass over the body is needed.
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let text = ''
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        throw new Error(`${label}:response-too-large`)
      }
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    reader.releaseLock()
  }
  return text + decoder.decode()
}

/**
 * A bare `JSON.parse` SyntaxError names neither the provider nor the endpoint, so a
 * provider that transiently returns malformed or truncated JSON fails its caller
 * undiagnosably. Every parse of an untrusted payload goes through here and rethrows under
 * the caller's label in the same `label:code` shape as the size and status errors, so the
 * caller that catches it has a message naming the source that failed.
 *
 * Failure semantics are unchanged: what threw before still throws. The hint stays
 * structural — decoded length and the offset the parser reported — because provider bodies
 * must never reach Worker logs.
 */
function parseLabeledJson(text: string, label: string): JsonValue {
  try {
    return JSON.parse(text)
  } catch (cause) {
    const position = toError(cause)?.message.match(/position (\d+)/)?.[1]
    const at = position === undefined ? '' : `:at-${position}`
    throw new Error(`${label}:invalid-json:${text.length}-chars${at}`, { cause })
  }
}

export async function readBoundedJson(response: Response, maxBytes: number, label: string): Promise<JsonValue> {
  return parseLabeledJson(await readBoundedText(response, maxBytes, label), label)
}
