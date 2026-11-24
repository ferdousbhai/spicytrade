import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { z } from 'zod'

import { AGENT_LOGIN_TTL_MS, connectCodeCheck, ConnectCodeSchema, MAX_PENDING_AGENT_LOGINS_PER_USER } from '../src/domain/agent-login'
import { type JsonValue } from '../src/domain/json-payload'
import { MAX_MCP_TOKENS_PER_USER, McpTokenIssuedResponseSchema } from '../src/domain/mcp-tokens'
import { approveAgentLogin, exchangeAgentLogin, signOutAgentLogin, sweepExpiredAgentLogins } from '../src/server/agent-logins'
import { type AuthenticatedIdentity } from '../src/server/auth'
import { base64Url, sha256Base64Url } from '../src/server/digest'
import { type AppEnv } from '../src/server/env'
import { authenticateMcpToken, issueMcpToken, listMcpTokens } from '../src/server/mcp-tokens'
import { migrationStore, seedMember, type SqliteD1Store } from './sqlite-d1'

const BASE_URL = 'https://spicy.trade'
const NOW = new Date('2026-09-28T12:00:00.000Z')

let store: SqliteD1Store
let env: AppEnv
let logged: unknown[][]

beforeEach(async () => {
  store = await migrationStore()
  seedMember(store, 'member-a')
  seedMember(store, 'member-b')
  env = { AUTH_BASE_URL: BASE_URL, DB: store.database }
  logged = []
  const record = (...args: unknown[]) => { logged.push(args) }
  vi.spyOn(console, 'error').mockImplementation(record)
  vi.spyOn(console, 'info').mockImplementation(record)
})

afterEach(() => {
  store.close()
})

function random32(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

/** What the CLI holds: a verifier only it knows, and the challenge it puts in the page address. */
async function pkce() {
  const codeVerifier = random32()
  return { codeChallenge: await sha256Base64Url(codeVerifier), codeVerifier }
}

const signedIn = (id: string) => async (): Promise<AuthenticatedIdentity> => ({
  email: `${id}@example.com`,
  id,
  name: 'Member',
})

function post(path: string, body: JsonValue, origin: string | undefined = BASE_URL): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (origin) headers.set('Origin', origin)
  return new Request(`${BASE_URL}${path}`, { body: JSON.stringify(body), headers, method: 'POST' })
}

/** The code a CLI prints beside its link, as the member types it. */
const LINK_CODE = '6A26A884'
const NamesChallengeSchema = z.looseObject({ codeChallenge: z.string() })
const TypesCodeSchema = z.looseObject({ code: z.string() })

/**
 * The member's approval. A body that names a challenge and no code is sent with the link's code
 * typed correctly, so each test states only what it is about.
 */
async function approve(
  sent: JsonValue,
  { member = 'member-a', now = NOW, origin = BASE_URL }: { member?: string | null; now?: Date; origin?: string } = {},
): Promise<Response> {
  const readIdentity = member === null ? async () => null : signedIn(member)
  const link = TypesCodeSchema.safeParse(sent).success ? undefined : NamesChallengeSchema.safeParse(sent).data
  const body = link ? { ...link, code: LINK_CODE, codeCheck: await connectCodeCheck(link.codeChallenge, LINK_CODE) } : sent
  return approveAgentLogin(post('/api/agent-logins', body, origin), env, now, readIdentity)
}

/** An approval that must succeed. */
async function approved(codeChallenge: string, member = 'member-a', now = NOW, label = 'laptop'): Promise<void> {
  const response = await approve({ codeChallenge, label }, { member, now })
  expect(response.status).toBe(200)
  expect(await response.json()).toEqual({})
}

function exchange(body: JsonValue, now = NOW): Promise<Response> {
  return exchangeAgentLogin(post('/api/agent-logins/exchange', body, undefined), env, now)
}

function pendingRows() {
  return store.sqlite.prepare('SELECT * FROM agent_approvals').all()
}

describe('agent login: approve', () => {
  it('records the approval under the challenge, with no credential', async () => {
    const { codeChallenge, codeVerifier } = await pkce()
    const response = await approve({ codeChallenge, label: 'laptop' })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const rows = pendingRows()
    expect(rows).toEqual([{
      challenge: codeChallenge,
      created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + AGENT_LOGIN_TTL_MS).toISOString(),
      label: 'laptop',
      user_id: 'member-a',
    }])
    expect(JSON.stringify(rows)).not.toContain(codeVerifier)
  })

  it('replaces the approval when one link is approved twice', async () => {
    const { codeChallenge, codeVerifier } = await pkce()
    await approved(codeChallenge)
    await approved(codeChallenge, 'member-b')
    expect(pendingRows()).toHaveLength(1)
    const issued = McpTokenIssuedResponseSchema.parse(await (await exchange({ codeVerifier })).json())
    expect(await authenticateMcpToken(store.database, issued.token)).toMatchObject({ userId: 'member-b' })
  })

  it('opens no brokerage consent it was not asked for, and refuses one it cannot open', async () => {
    const { codeChallenge } = await pkce()
    await approved(codeChallenge)
    expect(store.sqlite.prepare('SELECT * FROM broker_consents').all()).toEqual([])
    // This environment has no tastytrade app configured: nothing is approved on a link that
    // promised a brokerage.
    const other = await pkce()
    expect((await approve({ broker: 'tastytrade', codeChallenge: other.codeChallenge, label: 'laptop' })).status).toBe(503)
    expect(pendingRows()).toHaveLength(1)
  })

  it('requires a signed-in member posting from the site itself', async () => {
    const { codeChallenge } = await pkce()
    const body = { codeChallenge, label: 'laptop' }
    expect((await approve(body, { member: null })).status).toBe(401)
    expect((await approve(body, { origin: 'https://evil.example' })).status).toBe(403)
    expect(pendingRows()).toHaveLength(0)
  })

  it('refuses a malformed approval', async () => {
    const { codeChallenge } = await pkce()
    for (const body of [
      { codeChallenge: 'short', label: 'laptop' },
      { codeChallenge, label: '' },
      { broker: 'another-broker', codeChallenge, label: 'laptop' },
      { codeChallenge, label: 'laptop', port: 43_210 },
    ]) {
      expect((await approve(body)).status).toBe(400)
    }
    expect(pendingRows()).toHaveLength(0)
  })

  it('caps pending approvals per member, and a lapsed one frees its slot', async () => {
    for (let index = 0; index < MAX_PENDING_AGENT_LOGINS_PER_USER; index += 1) {
      await approved((await pkce()).codeChallenge)
    }
    const { codeChallenge } = await pkce()
    const refused = await approve({ codeChallenge, label: 'laptop' })
    expect(refused.status).toBe(409)
    // Another member is not affected by this one's cap.
    await approved(codeChallenge, 'member-b')
    // Once the earlier ones lapse, the member may approve again.
    await approved(codeChallenge, 'member-a', new Date(NOW.getTime() + AGENT_LOGIN_TTL_MS))
  })
})

describe('agent login: exchange', () => {
  it('answers pending until the member approves, then hands over a working agent token under the approved label', async () => {
    const { codeChallenge, codeVerifier } = await pkce()
    const waiting = await exchange({ codeVerifier })
    expect(waiting.status).toBe(202)
    expect(await waiting.json()).toEqual({ pending: true })
    await approved(codeChallenge, 'member-a', NOW, 'work laptop')
    const response = await exchange({ codeVerifier })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const issued = McpTokenIssuedResponseSchema.parse(await response.json())
    expect(issued.tokenMetadata.label).toBe('work laptop')
    expect(await authenticateMcpToken(store.database, issued.token)).toMatchObject({ userId: 'member-a' })
    expect(pendingRows()).toHaveLength(0)
    expect(JSON.stringify(logged)).not.toContain(issued.token)
  })

  it('hands the token over once', async () => {
    const { codeChallenge, codeVerifier } = await pkce()
    await approved(codeChallenge)
    expect((await exchange({ codeVerifier })).status).toBe(200)
    expect((await exchange({ codeVerifier })).status).toBe(202)
    expect(await listMcpTokens(store.database, 'member-a')).toHaveLength(1)
  })

  it('leaves a lapsed approval uncollected', async () => {
    const { codeChallenge, codeVerifier } = await pkce()
    await approved(codeChallenge)
    expect((await exchange({ codeVerifier }, new Date(NOW.getTime() + AGENT_LOGIN_TTL_MS))).status).toBe(202)
    expect(await listMcpTokens(store.database, 'member-a')).toHaveLength(0)
  })

  it('gives another verifier nothing, and leaves the approval for its own', async () => {
    const { codeChallenge, codeVerifier } = await pkce()
    await approved(codeChallenge)
    // Holding the challenge, which the link carries, is not holding the verifier.
    expect((await exchange({ codeVerifier: codeChallenge })).status).toBe(202)
    expect((await exchange({ codeVerifier: random32() })).status).toBe(202)
    expect((await exchange({ codeVerifier })).status).toBe(200)
  })

  it('refuses a malformed exchange', async () => {
    for (const body of [
      {},
      { codeVerifier: 'short' },
      { codeVerifier: random32(), extra: 1 },
      { code: random32(), codeVerifier: random32() },
      { codeVerifier: random32(), previousToken: '' },
    ]) {
      const response = await exchange(body)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({ error: 'Invalid agent sign-in exchange' })
    }
  })

  it('replaces the same member\'s previous token', async () => {
    const previous = await issueMcpToken(store.database, 'member-a', 'laptop')
    const { codeChallenge, codeVerifier } = await pkce()
    await approved(codeChallenge)
    const response = await exchange({ codeVerifier, previousToken: previous.token })
    expect(response.status).toBe(200)
    const issued = McpTokenIssuedResponseSchema.parse(await response.json())
    expect(await authenticateMcpToken(store.database, previous.token)).toBeUndefined()
    expect((await listMcpTokens(store.database, 'member-a')).map(({ tokenId }) => tokenId))
      .toEqual([issued.tokenMetadata.tokenId])
  })

  it('replaces the previous token even when the member is at the token cap', async () => {
    const tokens = []
    for (let index = 0; index < MAX_MCP_TOKENS_PER_USER; index += 1) {
      tokens.push(await issueMcpToken(store.database, 'member-a', `machine ${index}`))
    }
    const { codeChallenge, codeVerifier } = await pkce()
    await approved(codeChallenge)
    const response = await exchange({ codeVerifier, previousToken: tokens[0]!.token })
    expect(response.status).toBe(200)
    expect(await authenticateMcpToken(store.database, tokens[0]!.token)).toBeUndefined()
    expect(await listMcpTokens(store.database, 'member-a')).toHaveLength(MAX_MCP_TOKENS_PER_USER)
  })

  it('never revokes another member\'s token, and ignores a bogus previous token', async () => {
    const foreign = await issueMcpToken(store.database, 'member-b', 'desktop')
    for (const previousToken of [foreign.token, 'not-a-token']) {
      const { codeChallenge, codeVerifier } = await pkce()
      await approved(codeChallenge)
      expect((await exchange({ codeVerifier, previousToken })).status).toBe(200)
    }
    expect(await authenticateMcpToken(store.database, foreign.token)).toMatchObject({ userId: 'member-b' })
    expect(await listMcpTokens(store.database, 'member-a')).toHaveLength(2)
  })

  it('answers the token cap with 409 when there is nothing to replace', async () => {
    for (let index = 0; index < MAX_MCP_TOKENS_PER_USER; index += 1) {
      await issueMcpToken(store.database, 'member-a', `machine ${index}`)
    }
    const { codeChallenge, codeVerifier } = await pkce()
    await approved(codeChallenge)
    const response = await exchange({ codeVerifier })
    expect(response.status).toBe(409)
    expect(await response.json()).toEqual({
      error: `You can have at most ${MAX_MCP_TOKENS_PER_USER} signed-in computers and tokens. Revoke one you no longer use above, then try again.`,
    })
  })

  it('fails closed without a database', async () => {
    env = { AUTH_BASE_URL: BASE_URL }
    expect((await exchange({ codeVerifier: random32() })).status).toBe(503)
    const { codeChallenge } = await pkce()
    expect((await approve({ codeChallenge, label: 'laptop' })).status).toBe(503)
  })
})

describe('agent login: sign out', () => {
  const signOut = (token?: string) => signOutAgentLogin(new Request(`${BASE_URL}/api/agent-logins`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    method: 'DELETE',
  }), env, NOW)

  it('revokes the token presented, and only that one', async () => {
    const mine = await issueMcpToken(store.database, 'member-a', 'laptop')
    const other = await issueMcpToken(store.database, 'member-a', 'desktop')
    const theirs = await issueMcpToken(store.database, 'member-b', 'laptop')
    expect((await signOut(mine.token)).status).toBe(204)
    expect(await authenticateMcpToken(store.database, mine.token, NOW)).toBeUndefined()
    expect(await authenticateMcpToken(store.database, other.token, NOW)).toBeDefined()
    expect(await authenticateMcpToken(store.database, theirs.token, NOW)).toBeDefined()
    // Signing out twice is the same refusal as any token that is not live.
    expect((await signOut(mine.token)).status).toBe(401)
  })

  it('refuses a request with no token or a bogus one', async () => {
    expect((await signOut()).status).toBe(401)
    expect((await signOut('spice_0123456789abcdef_AAAAAAAAAAAAAAAAAAAA')).status).toBe(401)
  })
})

describe('agent login: sweep', () => {
  it('drops only lapsed approvals', async () => {
    // Another member's, since a member's own approval already clears their lapsed ones.
    await approved((await pkce()).codeChallenge, 'member-b', new Date(NOW.getTime() - AGENT_LOGIN_TTL_MS))
    await approved((await pkce()).codeChallenge)
    expect(await sweepExpiredAgentLogins(env, NOW)).toBe(1)
    expect(pendingRows()).toHaveLength(1)
  })
})

describe('the code a member types from their terminal', () => {
  it('is not approved without the code the terminal printed, which the link does not carry', async () => {
    const { codeChallenge, codeVerifier } = await pkce()
    const codeCheck = await connectCodeCheck(codeChallenge, LINK_CODE)
    const wrong = await approve({ code: '00000000', codeChallenge, codeCheck, label: 'laptop' })
    expect(wrong.status).toBe(403)
    // A code that belongs to another link's check approves nothing either.
    const other = await pkce()
    expect((await approve({ code: LINK_CODE, codeChallenge: other.codeChallenge, codeCheck, label: 'laptop' })).status).toBe(403)
    for (const code of ['', '6A26', 'not-a-code']) {
      expect((await approve({ code, codeChallenge, codeCheck, label: 'laptop' })).status).toBe(400)
    }
    expect(pendingRows()).toEqual([])
    expect((await exchange({ codeVerifier })).status).toBe(202)
    // Typed as the terminal prints it, in any case: the dash and spaces do not matter.
    expect((await approve({ code: ' 6a26-a884 ', codeChallenge, codeCheck, label: 'laptop' })).status).toBe(200)
    expect((await exchange({ codeVerifier })).status).toBe(200)
  })

  it('reads a typed code whatever its case and spacing, and refuses anything that is not one', () => {
    expect(ConnectCodeSchema.parse('6a26-a884')).toBe('6A26A884')
    expect(ConnectCodeSchema.parse(' 6A26 A884 ')).toBe('6A26A884')
    for (const typed of ['6A26A88', '6A26A8845', 'G0000000', '']) expect(ConnectCodeSchema.safeParse(typed).success).toBe(false)
  })
})
