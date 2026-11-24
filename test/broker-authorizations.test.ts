import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  BROKER_AUTHORIZATION_TTL_MS,
  MAX_PENDING_BROKER_AUTHORIZATIONS_PER_USER,
} from '../src/domain/broker-authorization'
import { type JsonValue } from '../src/domain/json-payload'
import { approveAgentLogin } from '../src/server/agent-logins'
import {
  exchangeTastytrade,
  openTastytradeConsent,
  sweepExpiredBrokerAuthorizations,
  tastytradeAccessToken,
  tastytradeCallback,
  TASTYTRADE_CALLBACK_PATH,
} from '../src/server/broker-authorizations'
import { base64Url, sha256Base64Url } from '../src/server/digest'
import { type AppEnv } from '../src/server/env'
import { issueMcpToken } from '../src/server/mcp-tokens'
import { migrationStore, seedMember, type SqliteD1Store } from './sqlite-d1'

const BASE_URL = 'https://spicy.trade'
const TASTYTRADE = 'https://tastytrade.test'
const APP_SECRET = 'app-client-secret-held-only-by-the-worker'
const MEMBER_REFRESH_TOKEN = 'member-refresh-token-that-belongs-in-a-keyring'
const CODE = 'one-time-authorization-code'
const NOW = new Date('2026-09-25T12:00:00.000Z')

type TokenCall = { body: Record<string, string>; url: string }

let store: SqliteD1Store
let env: AppEnv
let memberToken: string
let otherMemberToken: string
let tokenCalls: TokenCall[]
let tastytradeAnswer: () => Response
let logged: unknown[][]

beforeEach(async () => {
  store = await migrationStore()
  seedMember(store, 'member-a')
  seedMember(store, 'member-b')
  memberToken = (await issueMcpToken(store.database, 'member-a', 'laptop')).token
  otherMemberToken = (await issueMcpToken(store.database, 'member-b', 'laptop')).token
  env = {
    AUTH_BASE_URL: BASE_URL,
    DB: store.database,
    TASTYTRADE_API_BASE: TASTYTRADE,
    TASTYTRADE_OAUTH_CLIENT_ID: 'spice-app-client-id',
    TASTYTRADE_OAUTH_CLIENT_SECRET: { get: async () => APP_SECRET },
  }
  tokenCalls = []
  tastytradeAnswer = () => Response.json({
    access_token: 'access-from-code',
    expires_in: 900,
    refresh_token: MEMBER_REFRESH_TOKEN,
    token_type: 'Bearer',
  })
  // tastytrade is never reached: every token request lands here and is recorded.
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    tokenCalls.push({ body: z.record(z.string(), z.string()).parse(JSON.parse(String(init?.body))), url: String(input) })
    return tastytradeAnswer()
  }))
  logged = []
  const record = (...args: unknown[]) => { logged.push(args) }
  vi.spyOn(console, 'error').mockImplementation(record)
  vi.spyOn(console, 'info').mockImplementation(record)
  vi.spyOn(console, 'warn').mockImplementation(record)
})

afterEach(() => {
  store.close()
})

function post(path: string, body: JsonValue, bearer?: string): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`)
  return new Request(`${BASE_URL}${path}`, { body: JSON.stringify(body), headers, method: 'POST' })
}

/** What the CLI holds: a verifier only it knows, and the challenge the member approves. */
async function pkce() {
  const codeVerifier = random32()
  return { codeChallenge: await sha256Base64Url(codeVerifier), codeVerifier }
}

function random32(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

/** A consent that must open, as the member's approval opens it: its address, state and verifier. */
async function start(member = 'member-a', now = NOW, link?: Awaited<ReturnType<typeof pkce>>) {
  const { codeChallenge, codeVerifier } = link ?? await pkce()
  const opened = await openTastytradeConsent(env, member, codeChallenge, now)
  if (opened instanceof Response) throw new Error(`consent refused with ${opened.status}`)
  const state = new URL(opened).searchParams.get('state')
  if (!state) throw new Error('the consent address carries no state')
  return { authorizationUrl: opened, codeChallenge, codeVerifier, state }
}

function callback(query: Record<string, string>, now = NOW): Promise<Response> {
  const url = new URL(`${BASE_URL}${TASTYTRADE_CALLBACK_PATH}`)
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, value)
  return tastytradeCallback(new Request(url), env, now)
}

function exchange(body: JsonValue, bearer = memberToken, now = NOW): Promise<Response> {
  return exchangeTastytrade(post('/api/brokers/tastytrade/exchange', body, bearer), env, now)
}

function pendingRows() {
  return store.sqlite.prepare('SELECT * FROM broker_consents').all()
}

describe('tastytrade connect: consent', () => {
  it('returns tastytrade consent for this app and keeps only the state digest', async () => {
    const consent = await start()
    const url = new URL(consent.authorizationUrl)
    expect(`${url.origin}${url.pathname}`).toBe('https://my.tastytrade.com/auth.html')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'spice-app-client-id',
      redirect_uri: `${BASE_URL}${TASTYTRADE_CALLBACK_PATH}`,
      response_type: 'code',
      scope: 'read trade',
      state: consent.state,
    })

    const rows = pendingRows()
    expect(rows).toEqual([{
      broker: 'tastytrade',
      challenge: consent.codeChallenge,
      code: null,
      created_at: NOW.toISOString(),
      expires_at: new Date(NOW.getTime() + BROKER_AUTHORIZATION_TTL_MS).toISOString(),
      refusal: null,
      state_digest: await sha256Base64Url(consent.state),
      user_id: 'member-a',
    }])
    // A database read yields nothing the callback would accept, and nothing that collects.
    expect(JSON.stringify(rows)).not.toContain(consent.state)
    expect(JSON.stringify(rows)).not.toContain(consent.codeVerifier)
  })

  it('is opened by the member\'s approval of a link that asks for it', async () => {
    const { codeChallenge } = await pkce()
    const request = new Request(`${BASE_URL}/api/agent-logins`, {
      body: JSON.stringify({ broker: 'tastytrade', codeChallenge, label: 'laptop' }),
      headers: { 'content-type': 'application/json', Origin: BASE_URL },
      method: 'POST',
    })
    const response = await approveAgentLogin(request, env, NOW, async () => ({ email: 'a@example.com', id: 'member-a', name: 'Member' }))
    expect(response.status).toBe(200)
    const { authorizationUrl } = z.object({ authorizationUrl: z.string() }).parse(await response.json())
    expect(authorizationUrl).toContain('https://my.tastytrade.com/auth.html?')
    expect(pendingRows()).toEqual([expect.objectContaining({ challenge: codeChallenge, user_id: 'member-a' })])
    expect(store.sqlite.prepare('SELECT challenge, user_id FROM agent_approvals').all())
      .toEqual([{ challenge: codeChallenge, user_id: 'member-a' }])
  })

  it('caps pending connections per member, counting only live ones', async () => {
    for (let index = 0; index < MAX_PENDING_BROKER_AUTHORIZATIONS_PER_USER; index += 1) await start()
    const refused = await openTastytradeConsent(env, 'member-a', (await pkce()).codeChallenge, NOW)
    expect(refused).toBeInstanceOf(Response)
    expect(refused).toMatchObject({ status: 409 })
    // The cap is the member's own.
    await start('member-b')
    // Once those lapse, a new start clears them rather than counting them.
    await start('member-a', new Date(NOW.getTime() + BROKER_AUTHORIZATION_TTL_MS))
    expect(pendingRows().filter((row) => row.user_id === 'member-a')).toHaveLength(1)
  })

  it('keeps one consent per link, so approving twice leaves only the later state', async () => {
    const link = await pkce()
    const first = await start('member-a', NOW, link)
    const second = await start('member-a', NOW, link)
    expect(pendingRows()).toHaveLength(1)
    expect((await callback({ code: CODE, state: first.state })).status).toBe(400)
    expect((await callback({ code: CODE, state: second.state })).status).toBe(200)
  })
})

describe('tastytrade connect: callback', () => {
  it('keeps the code for the CLI and sends the browser nowhere', async () => {
    const consent = await start()
    const response = await callback({ code: CODE, redirect_uri: 'https://attacker.example/steal', state: consent.state })
    expect(response.status).toBe(200)
    expect(response.headers.get('Location')).toBeNull()
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    const page = await response.text()
    expect(page).toContain('tastytrade approved.')
    expect(page).not.toContain(CODE)
    expect(pendingRows()).toEqual([expect.objectContaining({ code: CODE, refusal: null })])
    // The code is never exchanged here.
    expect(tokenCalls).toEqual([])
  })

  it('records a refusal as one of its own codes, never the broker\'s text', async () => {
    const declined = await start()
    expect(await (await callback({ error: 'access_denied', state: declined.state })).text()).toContain('Not connected.')
    const strange = await start()
    // A return carrying both is a refusal: the code is not kept.
    await callback({ code: CODE, error: '<script>alert(1)</script>', state: strange.state })
    expect(pendingRows().map(({ code, refusal }) => ({ code, refusal }))).toEqual([
      { code: null, refusal: 'access_denied' },
      { code: null, refusal: 'unrecognized' },
    ])
  })

  it('records one return, so a replayed address cannot swap the code', async () => {
    const consent = await start()
    expect((await callback({ code: CODE, state: consent.state })).status).toBe(200)
    expect((await callback({ code: 'another-code', state: consent.state })).status).toBe(400)
    expect(pendingRows()).toEqual([expect.objectContaining({ code: CODE })])
  })

  it('refuses an unknown, malformed, or expired state with a no-store page', async () => {
    const consent = await start()
    const unknown = 'A'.repeat(consent.state.length)
    const expired = new Date(NOW.getTime() + BROKER_AUTHORIZATION_TTL_MS)
    for (const response of [
      await callback({ code: CODE, state: unknown }),
      await callback({ code: CODE, state: 'short' }),
      await callback({ code: CODE }),
      await callback({ code: CODE, state: consent.state }, expired),
      await callback({ state: consent.state }),
    ]) {
      expect(response.status).toBe(400)
      expect(response.headers.get('Location')).toBeNull()
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
      expect(await response.text()).not.toContain(CODE)
    }
    expect(pendingRows()).toEqual([expect.objectContaining({ code: null, refusal: null })])
  })
})

/** A consent the browser has returned from with the code. */
async function returned(member = 'member-a') {
  const consent = await start(member)
  expect((await callback({ code: CODE, state: consent.state })).status).toBe(200)
  return consent
}

describe('tastytrade connect: exchange', () => {
  it('answers pending until the browser returns, then redeems the code once under the app secret', async () => {
    const consent = await start()
    const waiting = await exchange({ codeVerifier: consent.codeVerifier })
    expect(waiting.status).toBe(202)
    expect(await waiting.json()).toEqual({ pending: true })
    expect(tokenCalls).toEqual([])
    await callback({ code: CODE, state: consent.state })

    const response = await exchange({ codeVerifier: consent.codeVerifier })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(await response.json()).toEqual({ refreshToken: MEMBER_REFRESH_TOKEN })
    expect(tokenCalls).toEqual([{
      body: {
        client_id: 'spice-app-client-id',
        client_secret: APP_SECRET,
        code: CODE,
        grant_type: 'authorization_code',
        redirect_uri: `${BASE_URL}${TASTYTRADE_CALLBACK_PATH}`,
      },
      url: `${TASTYTRADE}/oauth/token`,
    }])
    // Nothing of the grant was kept, and the attempt is spent.
    expect(pendingRows()).toEqual([])
    const replay = await exchange({ codeVerifier: consent.codeVerifier })
    expect(replay.status).toBe(404)
    expect(tokenCalls).toHaveLength(1)
    expect(JSON.stringify(logged)).not.toContain(MEMBER_REFRESH_TOKEN)
  })

  it('reports the member\'s refusal, and spends the attempt', async () => {
    const consent = await start()
    await callback({ error: 'access_denied', state: consent.state })
    const response = await exchange({ codeVerifier: consent.codeVerifier })
    expect(response.status).toBe(403)
    expect(await response.json()).toEqual({ refusal: 'access_denied' })
    expect(pendingRows()).toEqual([])
    expect(tokenCalls).toEqual([])
  })

  it('refuses another member, the challenge, or another verifier, without spending it', async () => {
    const consent = await returned()
    for (const response of [
      await exchange({ codeVerifier: consent.codeVerifier }, otherMemberToken),
      // The link carries the challenge; it is not the verifier.
      await exchange({ codeVerifier: consent.codeChallenge }),
      await exchange({ codeVerifier: random32() }),
    ]) {
      expect(response.status).toBe(404)
      expect(await response.text()).not.toContain(MEMBER_REFRESH_TOKEN)
    }
    expect(tokenCalls).toEqual([])
    expect(pendingRows()).toHaveLength(1)
    expect((await exchange({ codeVerifier: consent.codeVerifier })).status).toBe(200)
  })

  it('refuses an expired consent', async () => {
    const consent = await returned()
    const expired = new Date(NOW.getTime() + BROKER_AUTHORIZATION_TTL_MS)
    expect((await exchange({ codeVerifier: consent.codeVerifier }, memberToken, expired)).status).toBe(404)
    expect(tokenCalls).toEqual([])
  })

  it('refuses an absent or non-minted bearer, and a malformed body', async () => {
    const consent = await returned()
    for (const bearer of [undefined, 'eyJhbGciOiJIUzI1NiJ9.e30.signature']) {
      const response = await exchangeTastytrade(
        post('/api/brokers/tastytrade/exchange', { codeVerifier: consent.codeVerifier }, bearer),
        env,
        NOW,
      )
      expect(response.status).toBe(401)
    }
    for (const body of [{}, { codeVerifier: 'short' }, { code: CODE, codeVerifier: consent.codeVerifier }]) {
      expect((await exchange(body)).status).toBe(400)
    }
    expect(pendingRows()).toHaveLength(1)
  })

  it('reports a tastytrade refusal by status, never its body', async () => {
    tastytradeAnswer = () => Response.json({ error: 'invalid_grant', echoed: MEMBER_REFRESH_TOKEN }, { status: 400 })
    const consent = await returned()
    const response = await exchange({ codeVerifier: consent.codeVerifier })
    expect(response.status).toBe(502)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ error: 'tastytrade refused the grant', tastytradeStatus: 400 })
    expect(logged).toContainEqual(['TastytradeExchangeFailed', 'TastytradeMemberGrantRefused'])
    expect(JSON.stringify(logged)).not.toContain(MEMBER_REFRESH_TOKEN)
    expect(JSON.stringify(logged)).not.toContain(CODE)
  })

  it('refuses a token response without a refresh token rather than returning part of one', async () => {
    tastytradeAnswer = () => Response.json({ access_token: 'access-only', expires_in: 900 })
    const consent = await returned()
    const response = await exchange({ codeVerifier: consent.codeVerifier })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'tastytrade answered with an unreadable token response' })
  })
})

describe('tastytrade connect: token', () => {
  function mint(body: JsonValue): Promise<Response> {
    return tastytradeAccessToken(post('/api/brokers/tastytrade/token', body, memberToken), env)
  }

  it('mints an access token under the app secret and stores nothing', async () => {
    tastytradeAnswer = () => Response.json({ access_token: 'fifteen-minute-token', expires_in: 900 })
    // The Worker's own market-data grant must never be read on this path.
    const marketSecret = { get: vi.fn(async () => 'market-secret') }
    env = { ...env, TASTYTRADE_CLIENT_SECRET: marketSecret, TASTYTRADE_REFRESH_TOKEN: marketSecret }
    const response = await mint({ refreshToken: MEMBER_REFRESH_TOKEN })
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ accessToken: 'fifteen-minute-token', expiresIn: 900 })
    expect(text).not.toContain(MEMBER_REFRESH_TOKEN)
    expect(tokenCalls).toEqual([{
      body: { client_secret: APP_SECRET, grant_type: 'refresh_token', refresh_token: MEMBER_REFRESH_TOKEN },
      url: `${TASTYTRADE}/oauth/token`,
    }])
    expect(marketSecret.get).not.toHaveBeenCalled()
    // Not cached: a second call is a second mint.
    await mint({ refreshToken: MEMBER_REFRESH_TOKEN })
    expect(tokenCalls).toHaveLength(2)
    expect(pendingRows()).toEqual([])
  })

  it('refuses an absent or non-minted bearer before spending the app secret', async () => {
    for (const bearer of [undefined, 'eyJhbGciOiJIUzI1NiJ9.e30.signature']) {
      const response = await tastytradeAccessToken(
        post('/api/brokers/tastytrade/token', { refreshToken: MEMBER_REFRESH_TOKEN }, bearer),
        env,
      )
      expect(response.status).toBe(401)
    }
    expect(tokenCalls).toEqual([])
  })

  it('reports a revoked grant by status and logs nothing of the credential', async () => {
    tastytradeAnswer = () => Response.json({ error: 'invalid_grant', refresh_token: MEMBER_REFRESH_TOKEN }, { status: 401 })
    const response = await mint({ refreshToken: MEMBER_REFRESH_TOKEN })
    expect(response.status).toBe(502)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ error: 'tastytrade refused the grant', tastytradeStatus: 401 })
    expect(text).not.toContain(MEMBER_REFRESH_TOKEN)
    expect(logged).toContainEqual(['TastytradeMemberTokenFailed', 'TastytradeMemberGrantRefused'])
    expect(JSON.stringify(logged)).not.toContain(MEMBER_REFRESH_TOKEN)
  })

  it('reports an unreachable tastytrade as that', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed') }))
    const response = await mint({ refreshToken: MEMBER_REFRESH_TOKEN })
    expect(response.status).toBe(502)
    expect(await response.json()).toEqual({ error: 'tastytrade could not be reached' })
  })
})

describe('tastytrade connect: configuration', () => {
  const missing: Array<[string, (base: AppEnv) => AppEnv]> = [
    ['DB', ({ DB: _, ...rest }) => rest],
    ['TASTYTRADE_OAUTH_CLIENT_ID', ({ TASTYTRADE_OAUTH_CLIENT_ID: _, ...rest }) => rest],
    // An empty var is refused like a missing one, so a deployment without the issued id fails closed.
    ['an empty TASTYTRADE_OAUTH_CLIENT_ID', (base) => ({ ...base, TASTYTRADE_OAUTH_CLIENT_ID: '' })],
    ['a blank TASTYTRADE_OAUTH_CLIENT_ID', (base) => ({ ...base, TASTYTRADE_OAUTH_CLIENT_ID: ' \t' })],
    ['TASTYTRADE_OAUTH_CLIENT_SECRET', ({ TASTYTRADE_OAUTH_CLIENT_SECRET: _, ...rest }) => rest],
    ['AUTH_BASE_URL', ({ AUTH_BASE_URL: _, ...rest }) => rest],
  ]

  it.each(missing)('closes every endpoint when %s is missing', async (_binding, without) => {
    const consent = await returned()
    env = without(env)
    const opened = await openTastytradeConsent(env, 'member-a', (await pkce()).codeChallenge, NOW)
    if (!(opened instanceof Response)) throw new Error('a consent opened without its configuration')
    const responses = [
      opened,
      await callback({ code: CODE, state: consent.state }),
      await exchange({ codeVerifier: consent.codeVerifier }),
      await tastytradeAccessToken(post('/api/brokers/tastytrade/token', { refreshToken: MEMBER_REFRESH_TOKEN }, memberToken), env),
    ]
    for (const response of responses) {
      expect(response.status).toBe(503)
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('Location')).toBeNull()
    }
    expect(tokenCalls).toEqual([])
  })

  it('does not spend the attempt when the app secret cannot be read', async () => {
    const consent = await returned()
    env = { ...env, TASTYTRADE_OAUTH_CLIENT_SECRET: { get: async () => { throw new Error('store down') } } }
    expect((await exchange({ codeVerifier: consent.codeVerifier })).status).toBe(503)
    expect(pendingRows()).toHaveLength(1)
    expect(tokenCalls).toEqual([])
  })
})

describe('tastytrade connect: sweep', () => {
  it('drops only lapsed pending connections, and names a missing binding', async () => {
    await start('member-a', new Date(NOW.getTime() - BROKER_AUTHORIZATION_TTL_MS))
    await start('member-b')
    await expect(sweepExpiredBrokerAuthorizations(env, NOW)).resolves.toBe(1)
    expect(pendingRows()).toEqual([expect.objectContaining({ user_id: 'member-b' })])
    await expect(sweepExpiredBrokerAuthorizations({}, NOW)).rejects.toMatchObject({ name: 'BindingMissing' })
  })
})
