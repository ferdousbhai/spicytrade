import { type AppEnv } from './env'
import { readBoundSecret } from './secrets'

/**
 * What `broker_submissions` stores in place of a member's brokerage account number: an
 * HMAC-SHA256 of the broker and the number, in hex. The table only ever asks whether two rows
 * are the same account, which the key answers as well as the number does, so the number itself
 * never rests in the database.
 *
 * It is keyed because account numbers are short: an unkeyed digest could be reversed by trying
 * every number. The key is `BETTER_AUTH_SECRET`, with a label so this use shares no output with
 * the sessions that secret signs. Rotating that secret changes every key, so rows written before
 * a rotation stop matching their account: rotate only while no submission is unresolved, or the
 * quarantine it holds is released.
 */
const KEY_LABEL = 'broker-account'

export async function brokerAccountKey(env: AppEnv, broker: string, accountNumber: string): Promise<string> {
  const secret = readBoundSecret(env.BETTER_AUTH_SECRET, 'BETTER_AUTH_SECRET')
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { hash: 'SHA-256', name: 'HMAC' }, false, ['sign'])
  const mac = await crypto.subtle.sign('HMAC', key, encoder.encode(`${KEY_LABEL}:${broker}:${accountNumber}`))
  return Array.from(new Uint8Array(mac), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
