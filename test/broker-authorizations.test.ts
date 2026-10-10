import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  BROKER_AUTHORIZATION_TTL_MS,
  MAX_PENDING_BROKER_AUTHORIZATIONS_PER_USER,
} from '../src/domain/broker-authorization'
import { type JsonValue } from '../src/domain/json-payload'
import {
  authorizeTastytrade,
  exchangeTastytrade,
  sweepExpiredBrokerAuthorizations,
  tastytradeAccessToken,
  tastytradeCallback,
  TASTYTRADE_CALLBACK_PATH,
} from '../src/server/broker-authorizations'
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

const AuthorizeAnswerSchema = z.object({
  authorizationUrl: z.string(),
  expiresAt: z.string(),
  state: z.string(),
})

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
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

function post(path: string, body: JsonValue, bearer?: string): Request {
  const headers = new Headers({ 'content-type': 'application/json' })
  if (bearer) headers.set('Authorization', `Bearer ${bearer}`)
  return new Request(`${BASE_URL}${path}`, { body: JSON.stringify(body), headers, method: 'POST' })
}

function authorize(bearer = memberToken, port = 43_210, now = NOW): Promise<Response> {
  return authorizeTastytrade(post('/api/brokers/tastytrade/authorize', { port }, bearer), env, now)
}

/** A start that must succeed, and what it answered. */
async function start(bearer = memberToken, port = 43_210, now = NOW) {
  const response = await authorize(bearer, port, now)
  expect(response.status).toBe(200)
  return AuthorizeAnswerSchema.parse(await response.json())
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
  return store.sqlite.prepare('SELECT * FROM broker_authorizations').all()
}

describe('tastytrade connect: authorize', () => {
  it('returns tastytrade consent for this app and keeps only the state digest', async () => {
    const response = await authorize()
    expect(response.status).toBe(200)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    const body = AuthorizeAnswerSchema.parse(await response.json())
    const url = new URL(body.authorizationUrl)
    expect(`${url.origin}${url.pathname}`).toBe('https://my.tastytrade.com/auth.html')
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: 'spice-app-client-id',
      redirect_uri: `${BASE_URL}${TASTYTRADE_CALLBACK_PATH}`,
      response_type: 'code',
      scope: 'read trade',
      state: body.state,
    })
    expect(body.expiresAt).toBe(new Date(NOW.getTime() + BROKER_AUTHORIZATION_TTL_MS).toISOString())

    const rows = pendingRows()
    expect(rows).toEqual([expect.objectContaining({ broker: 'tastytrade', loopback_port: 43_210, user_id: 'member-a' })])
    // A database read yields nothing the callback would accept.
    expect(JSON.stringify(rows)).not.toContain(body.state)
  })

  it('refuses an absent, foreign-shaped, or unknown bearer', async () => {
    for (const bearer of [undefined, 'eyJhbGciOiJIUzI1NiJ9.e30.signature', `spice_${'0'.repeat(16)}_AAAAAAAAAAAAAAAA`]) {
      const response = await authorizeTastytrade(post('/api/brokers/tastytrade/authorize', { port: 43_210 }, bearer), env, NOW)
      expect(response.status).toBe(401)
    }
    expect(pendingRows()).toEqual([])
  })

  it('accepts only an unprivileged loopback port', async () => {
    for (const port of [80, 1023, 65_536, 4321.5, '4321']) {
      const response = await authorizeTastytrade(post('/api/brokers/tastytrade/authorize', { port }, memberToken), env, NOW)
      expect(response.status).toBe(400)
    }
    expect((await authorize(memberToken, 1024)).status).toBe(200)
    expect((await authorize(memberToken, 65_535)).status).toBe(200)
  })

  it('caps pending connections per member, counting only live ones', async () => {
    for (let index = 0; index < MAX_PENDING_BROKER_AUTHORIZATIONS_PER_USER; index += 1) {
      expect((await authorize()).status).toBe(200)
    }
    expect((await authorize()).status).toBe(409)
    // The cap is the member's own.
    expect((await authorize(otherMemberToken)).status).toBe(200)
    // Once those lapse, a new start clears them rather than counting them.
    const later = new Date(NOW.getTime() + BROKER_AUTHORIZATION_TTL_MS)
    expect((await authorize(memberToken, 43_210, later)).status).toBe(200)
    expect(pendingRows().filter((row) => row.user_id === 'member-a')).toHaveLength(1)
  })
})

describe('tastytrade connect: callback', () => {
  it('sends the browser only to the loopback port the member registered', async () => {
    const body = await start(memberToken, 51_234)
    const response = await callback({ code: CODE, state: body.state })
    expect(response.status).toBe(302)
    expect(response.headers.get('Cache-Control')).toBe('no-store')
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
    const location = new URL(response.headers.get('Location')!)
    expect(`${location.origin}${location.pathname}`).toBe('http://127.0.0.1:51234/callback')
    expect(Object.fromEntries(location.searchParams)).toEqual({ code: CODE, state: body.state })
    // Looked up, not consumed: the exchange is what spends it.
    expect(pendingRows()).toHaveLength(1)
    // The code is never exchanged here.
    expect(tokenCalls).toEqual([])
  })

  it('forwards a refusal and ignores any destination the request names', async () => {
    const body = await start(memberToken, 51_234)
    const response = await callback({
      error: 'access_denied',
      redirect_uri: 'https://attacker.example/steal',
      state: body.state,
    })
    const location = new URL(response.headers.get('Location')!)
    expect(location.host).toBe('127.0.0.1:51234')
    expect(Object.fromEntries(location.searchParams)).toEqual({ error: 'access_denied', state: body.state })
  })

  it('refuses an unknown, malformed, or expired state with a no-store page and no redirect', async () => {
    const body = await start()
    const unknown = 'A'.repeat(body.state.length)
    const expired = new Date(NOW.getTime() + BROKER_AUTHORIZATION_TTL_MS)
    for (const response of [
      await callback({ code: CODE, state: unknown }),
      await callback({ code: CODE, state: 'short' }),
      await callback({ code: CODE }),
      await callback({ code: CODE, state: body.state }, expired),
      await callback({ state: body.state }),
    ]) {
      expect(response.status).toBe(400)
      expect(response.headers.get('Location')).toBeNull()
      expect(response.headers.get('Cache-Control')).toBe('no-store')
      expect(response.headers.get('Referrer-Policy')).toBe('no-referrer')
      expect(await response.text()).not.toContain(CODE)
    }
  })
})

describe('tastytrade connect: exchange', () => {
  it('redeems the code under the app secret, once, and returns the refresh token only here', async () => {
    const body = await start()
    const response = await exchange({ code: CODE, state: body.state })
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
    const replay = await exchange({ code: CODE, state: body.state })
    expect(replay.status).toBe(404)
    expect(tokenCalls).toHaveLength(1)
    expect(JSON.stringify(logged)).not.toContain(MEMBER_REFRESH_TOKEN)
  })

  it('refuses another member redeeming the state, without spending it', async () => {
    const body = await start()
    const stolen = await exchange({ code: CODE, state: body.state }, otherMemberToken)
    expect(stolen.status).toBe(404)
    expect(await stolen.text()).not.toContain(MEMBER_REFRESH_TOKEN)
    expect(tokenCalls).toEqual([])
    expect(pendingRows()).toHaveLength(1)
    expect((await exchange({ code: CODE, state: body.state })).status).toBe(200)
  })

  it('refuses an expired state', async () => {
    const body = await start()
    const expired = new Date(NOW.getTime() + BROKER_AUTHORIZATION_TTL_MS)
    expect((await exchange({ code: CODE, state: body.state }, memberToken, expired)).status).toBe(404)
    expect(tokenCalls).toEqual([])
  })

  it('refuses an absent or non-minted bearer', async () => {
    const body = await start()
    for (const bearer of [undefined, 'eyJhbGciOiJIUzI1NiJ9.e30.signature']) {
      const response = await exchangeTastytrade(
        post('/api/brokers/tastytrade/exchange', { code: CODE, state: body.state }, bearer),
        env,
        NOW,
      )
      expect(response.status).toBe(401)
    }
    expect(pendingRows()).toHaveLength(1)
  })

  it('reports a tastytrade refusal by status, never its body', async () => {
    tastytradeAnswer = () => Response.json({ error: 'invalid_grant', echoed: MEMBER_REFRESH_TOKEN }, { status: 400 })
    const body = await start()
    const response = await exchange({ code: CODE, state: body.state })
    expect(response.status).toBe(502)
    const text = await response.text()
    expect(JSON.parse(text)).toEqual({ error: 'tastytrade refused the grant', tastytradeStatus: 400 })
    expect(logged).toContainEqual(['TastytradeExchangeFailed', 'TastytradeMemberGrantRefused'])
    expect(JSON.stringify(logged)).not.toContain(MEMBER_REFRESH_TOKEN)
    expect(JSON.stringify(logged)).not.toContain(CODE)
  })

  it('refuses a token response without a refresh token rather than returning part of one', async () => {
    tastytradeAnswer = () => Response.json({ access_token: 'access-only', expires_in: 900 })
    const body = await start()
    const response = await exchange({ code: CODE, state: body.state })
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
    const body = await start()
    env = without(env)
    const responses = [
      await authorizeTastytrade(post('/api/brokers/tastytrade/authorize', { port: 43_210 }, memberToken), env, NOW),
      await callback({ code: CODE, state: body.state }),
      await exchange({ code: CODE, state: body.state }),
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
    const body = await start()
    env = { ...env, TASTYTRADE_OAUTH_CLIENT_SECRET: { get: async () => { throw new Error('store down') } } }
    expect((await exchange({ code: CODE, state: body.state })).status).toBe(503)
    expect(pendingRows()).toHaveLength(1)
    expect(tokenCalls).toEqual([])
  })
})

describe('tastytrade connect: sweep', () => {
  it('drops only lapsed pending connections, and names a missing binding', async () => {
    await start(memberToken, 43_210, new Date(NOW.getTime() - BROKER_AUTHORIZATION_TTL_MS))
    await start(otherMemberToken)
    await expect(sweepExpiredBrokerAuthorizations(env, NOW)).resolves.toBe(1)
    expect(pendingRows()).toEqual([expect.objectContaining({ user_id: 'member-b' })])
    await expect(sweepExpiredBrokerAuthorizations({}, NOW)).rejects.toMatchObject({ name: 'BindingMissing' })
  })
})
