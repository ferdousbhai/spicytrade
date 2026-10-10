import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { JsonObjectSchema, type JsonValue } from '../src/domain/json-payload'

import { type AppEnv } from '../src/server/env'

import {
  MarketFeedCore,
  type FeedClientSocket,
  type FeedContext,
  type FeedControlSocket,
} from '../src/server/market-feed-core'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { stubBroker } from './broker-stub'
import { MAX_LIVE_STREAM_SYMBOLS } from '../src/domain/watchlist'
import { CLIENT_HEARTBEAT_MS } from '../src/server/market-feed-contracts'
import { migrationStore } from './sqlite-d1'
import { symbolAt } from './symbols'

const tasty = stubBroker()

const GREEKS_FIELDS = [
  'eventSymbol', 'eventFlags', 'index', 'time', 'sequence', 'price',
  'volatility', 'delta', 'gamma', 'theta', 'rho', 'vega',
]
const QUOTE_FIELDS = [
  'eventSymbol', 'eventTime', 'sequence', 'timeNanoPart', 'bidTime', 'bidExchangeCode',
  'askTime', 'askExchangeCode', 'bidPrice', 'askPrice', 'bidSize', 'askSize',
]

const CANDLE_FIELDS = [
  'eventSymbol', 'eventTime', 'eventFlags', 'index', 'time', 'sequence', 'count', 'volume',
  'vwap', 'bidVolume', 'askVolume', 'impVolatility', 'openInterest', 'open', 'high', 'low', 'close',
]

const TRADE_FIELDS = [
  'eventSymbol', 'eventTime', 'time', 'timeNanoPart', 'sequence', 'exchangeCode',
  'dayId', 'tickDirection', 'extendedTradingHours', 'price', 'change', 'size',
  'dayVolume', 'dayTurnover',
]

type Listener = (event: { data?: unknown }) => void

class FakeUpstreamWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3
  static instances: FakeUpstreamWebSocket[] = []

  readonly listeners = new Map<string, Listener[]>()
  readonly sent: string[] = []
  readyState = FakeUpstreamWebSocket.CONNECTING

  constructor(readonly url: string) {
    FakeUpstreamWebSocket.instances.push(this)
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...this.listeners.get(type) ?? [], listener])
  }

  send(frame: string): void {
    if (this.readyState !== FakeUpstreamWebSocket.OPEN) throw new Error('Socket is not open')
    this.sent.push(frame)
  }

  close(): void {
    this.readyState = FakeUpstreamWebSocket.CLOSED
    this.emit('close')
  }

  open(): void {
    this.readyState = FakeUpstreamWebSocket.OPEN
    this.emit('open')
  }

  message(payload: JsonValue): void {
    this.emit('message', JSON.stringify(payload))
  }

  emit(type: string, data?: string | ArrayBuffer): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ data })
  }
}

class FakeContext implements FeedContext {
  readonly acceptWebSocket = vi.fn()
  readonly blockConcurrencyWhile = vi.fn()
  readonly deleteAlarm = vi.fn(async () => undefined)
  readonly setAlarm = vi.fn(async () => undefined)
  readonly tasks: Promise<unknown>[] = []
  readonly storage = { deleteAlarm: this.deleteAlarm, setAlarm: this.setAlarm }

  constructor(readonly clients: FeedClientSocket[]) {}

  getWebSockets(): FeedClientSocket[] {
    return this.clients
  }

  waitUntil(task: Promise<unknown>): void {
    this.tasks.push(task)
  }

  async drain(): Promise<void> {
    while (this.tasks.length) await Promise.all(this.tasks.splice(0))
  }
}

function downstream(symbols: string[], seenAt = Date.now()): FeedControlSocket {
  let attachment: JsonValue = { seenAt, symbols }
  return {
    close: vi.fn(),
    deserializeAttachment: () => attachment,
    send: vi.fn(),
    serializeAttachment: vi.fn((next: JsonValue) => { attachment = next }),
  }
}

function liveEnvironment(): AppEnv {
  const secret: SecretsStoreSecret = { get: vi.fn() }
  return {
    TASTYTRADE_CLIENT_SECRET: secret,
    TASTYTRADE_REFRESH_TOKEN: secret,
  }
}

/** Open the one upstream socket and walk it through auth and every channel's configuration. */
async function openConfiguredUpstream(context: FakeContext): Promise<FakeUpstreamWebSocket> {
  await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))
  const socket = FakeUpstreamWebSocket.instances[0]!
  socket.open()
  await context.drain()
  socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
  await context.drain()
  const handshake = [
    [1, 'Quote', QUOTE_FIELDS],
    [3, 'Trade', TRADE_FIELDS],
    [5, 'Candle', CANDLE_FIELDS],
    [7, 'Greeks', GREEKS_FIELDS],
  ] as const
  for (const [channel, type, fields] of handshake) {
    socket.message({ type: 'CHANNEL_OPENED', channel, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { [type]: fields },
    })
    await context.drain()
  }
  return socket
}

afterEach(() => {
  // A test that fails under fake timers must not leave them installed: every later test here
  // waits on a real-timer `vi.waitFor`, so one failure would cascade into unrelated timeouts.
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  resetBrokerApi()
})

beforeEach(() => {
  vi.clearAllMocks()
  setBrokerApi(tasty)
  FakeUpstreamWebSocket.instances = []
  vi.stubGlobal('WebSocket', FakeUpstreamWebSocket)
  tasty.loadQuoteToken.mockResolvedValue({ token: 'quote-token', url: 'wss://streamer.test' })
})

describe('MarketFeedCore', () => {
  it('rejects invalid initial and resubscribe requests without accepting a partial symbol list', async () => {
    const context = new FakeContext([])
    const feed = new MarketFeedCore(context, liveEnvironment())
    const initial = await feed.fetch(new Request(
      'https://spice.test/api/stream?symbols=SPY,../secret,NVDA',
      { headers: { Upgrade: 'websocket' } },
    ))
    expect(initial.status).toBe(400)
    expect(context.acceptWebSocket).not.toHaveBeenCalled()

    const client = downstream(['SPY'])
    await feed.webSocketMessage(client, JSON.stringify({ type: 'subscribe', symbols: ['NVDA', '../secret'] }))
    expect(client.serializeAttachment).not.toHaveBeenCalled()
    expect(client.close).toHaveBeenCalledWith(1008, 'Invalid subscription request')
    expect(vi.mocked(client.send).mock.calls.some(([frame]) => (
      JsonObjectSchema.parse(JSON.parse(frame)).state === 'degraded'
    ))).toBe(true)

    const oversized = downstream(['SPY'])
    await feed.webSocketMessage(oversized, JSON.stringify({
      type: 'subscribe',
      symbols: Array.from({ length: MAX_LIVE_STREAM_SYMBOLS + 1 }, (_, index) => `A${index}`),
    }))
    expect(oversized.serializeAttachment).not.toHaveBeenCalled()
    expect(oversized.close).toHaveBeenCalledWith(1008, 'Invalid subscription request')
  })

  it('stays visibly degraded when the quote token cannot be loaded', async () => {
    tasty.loadQuoteToken.mockRejectedValueOnce(new Error('quote-token-unavailable'))
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(tasty.loadQuoteToken).toHaveBeenCalledTimes(1))
    await context.drain()

    expect(FakeUpstreamWebSocket.instances).toHaveLength(0)
    expect(context.setAlarm).toHaveBeenCalled()
    expect(vi.mocked(client.send).mock.calls.some(([frame]) => {
      const status = JsonObjectSchema.parse(JSON.parse(frame))
      return status.type === 'feed-status' && status.state === 'degraded'
    })).toBe(true)
  })

  it('single-flights concurrent reads, completes both, unsubscribes, and ignores stale close callbacks', async () => {
    const context = new FakeContext([downstream(['SPY'])])
    const feed = new MarketFeedCore(context, liveEnvironment())
    expect(context.blockConcurrencyWhile).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(tasty.loadQuoteToken).toHaveBeenCalledTimes(1))

    const first = feed.readOptionGreeks(['.NVDA260814C250'])
    const second = feed.readOptionGreeks(['.NVDA260814C250'])
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))
    expect(tasty.loadQuoteToken).toHaveBeenCalledTimes(1)

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    expect(socket.sent.map((frame) => JsonObjectSchema.parse(JSON.parse(frame))).slice(0, 2))
      .toEqual([
        expect.objectContaining({ channel: 0, type: 'SETUP' }),
        { channel: 0, token: 'quote-token', type: 'AUTH' },
      ])
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'UNAUTHORIZED' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 7, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel: 7, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { Greeks: GREEKS_FIELDS },
    })
    await context.drain()

    socket.message({
      type: 'FEED_DATA',
      channel: 7,
      data: ['Greeks', [
        '.NVDA260814C250', 0, 0, 1_786_629_600_000, 1,
        3.2, 0.42, 0.5, 0.03, -0.04, 0.02, 0.12,
      ]],
    })
    await context.drain()
    const results = await Promise.all([first, second])
    expect(results[0].greeks).toEqual(results[1].greeks)
    expect(results[0].greeks[0]).toMatchObject({
      impliedVolatilityUnit: 'decimal_ratio',
      source: 'tastytrade-dxlink',
      streamerSymbol: '.NVDA260814C250',
    })

    const subscriptions = socket.sent
      .map((frame) => JsonObjectSchema.parse(JSON.parse(frame)))
      .filter((frame) => frame.type === 'FEED_SUBSCRIPTION' && frame.channel === 7)
    expect(subscriptions).toEqual([
      { add: [{ symbol: '.NVDA260814C250', type: 'Greeks' }], channel: 7, type: 'FEED_SUBSCRIPTION' },
      { channel: 7, remove: [{ symbol: '.NVDA260814C250', type: 'Greeks' }], type: 'FEED_SUBSCRIPTION' },
    ])

    socket.emit('error')
    await context.drain()
    await feed.alarm()
    expect(FakeUpstreamWebSocket.instances).toHaveLength(2)
    const reconnectAlarmCount = context.setAlarm.mock.calls.length
    socket.emit('close')
    await context.drain()
    expect(context.setAlarm).toHaveBeenCalledTimes(reconnectAlarmCount)

    FakeUpstreamWebSocket.instances[1]!.close()
    await context.drain()
  })

  // dxLink spells a slot it has no value for as "NaN". A contract with no Greeks right now is
  // not a broken frame, so it must not close the one upstream every browser shares.
  it('skips an all-absent Greeks row and keeps the upstream open', async () => {
    const context = new FakeContext([downstream(['SPY'])])
    const feed = new MarketFeedCore(context, liveEnvironment())
    const read = feed.readOptionGreeks(['.NVDA260814C250'])
    const socket = await openConfiguredUpstream(context)

    socket.message({
      type: 'FEED_DATA',
      channel: 7,
      data: ['Greeks', [
        // eventSymbol, eventFlags (SNAPSHOT_BEGIN|SNAPSHOT_END|REMOVE_EVENT), index, time and
        // sequence as the numbers dxLink writes for an empty snapshot, then seven NaN doubles.
        '.NVDA260814C250', 0x0e, 0, 0, 0,
        'NaN', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN',
      ]],
    })
    await context.drain()
    expect(socket.readyState).toBe(FakeUpstreamWebSocket.OPEN)

    socket.message({
      type: 'FEED_DATA',
      channel: 7,
      data: ['Greeks', [
        '.NVDA260814C250', 0, 0, 1_786_629_600_000, 1,
        3.2, 0.42, 0.5, 0.03, -0.04, 0.02, 0.12,
      ]],
    })
    await context.drain()
    expect((await read).greeks[0]).toMatchObject({ delta: 0.5, streamerSymbol: '.NVDA260814C250' })
    socket.close()
    await context.drain()
  })

  it('still closes the upstream on a Greeks slot that is present but not a number', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const context = new FakeContext([downstream(['SPY'])])
    const feed = new MarketFeedCore(context, liveEnvironment())
    const read = feed.readOptionGreeks(['.NVDA260814C250'])
    read.catch(() => undefined)
    const socket = await openConfiguredUpstream(context)

    socket.message({
      type: 'FEED_DATA',
      channel: 7,
      data: ['Greeks', [
        '.NVDA260814C250', 0, 0, 1_786_629_600_000, 1,
        3.2, 'NaN', 'half', 0.03, -0.04, 0.02, 0.12,
      ]],
    })
    await context.drain()
    expect(socket.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
  })

  it.each([
    // Partly filled: a real observation with its Greeks missing, not the empty-snapshot row.
    ['partly filled', ['.NVDA260814C250', 0, 0, 1_786_629_600_000, 1, 3.2, 0.42, 'NaN', 'NaN', 'NaN', 'NaN', 'NaN']],
    // Numbers out of optionGreeksFromRow's bounds beside one NaN slot are a broken range.
    ['out of range beside a NaN', ['.NVDA260814C250', 0, 0, 1_786_629_600_000, 1, -3.2, 0.42, 0.5, 0.03, -0.04, 0.02, 'NaN']],
    // A real instant with every double NaN is an observation that failed, not the empty row.
    ['stamped but empty', ['.NVDA260814C250', 0, 0, 1_786_629_600_000, 1, 'NaN', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN']],
  ])('closes the upstream on a Greeks row that is %s rather than skipping it', async (_label, row) => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const context = new FakeContext([downstream(['SPY'])])
    const feed = new MarketFeedCore(context, liveEnvironment())
    const read = feed.readOptionGreeks(['.NVDA260814C250'])
    read.catch(() => undefined)
    const socket = await openConfiguredUpstream(context)

    socket.message({ type: 'FEED_DATA', channel: 7, data: ['Greeks', row] })
    await context.drain()
    expect(socket.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
  })

  it('does not turn an absent trade change into a false zero-percent move', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))
    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 3, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel: 3, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { Trade: TRADE_FIELDS },
    })
    await context.drain()

    socket.message({
      type: 'FEED_DATA',
      channel: 3,
      data: ['Trade', [
        'SPY', 1_786_629_600_000, 1_786_629_600_000, null, 1, 'Q',
        1, 'Up', false, 700, null, 10, 1_000, 700_000,
      ]],
    })
    await context.drain()

    const marketFrame = vi.mocked(client.send).mock.calls
      .map(([frame]) => JsonObjectSchema.parse(JSON.parse(frame)))
      .find((frame) => frame.type === 'market')
    expect(marketFrame).toMatchObject({ price: 700, symbol: 'SPY', type: 'market' })
    expect(marketFrame).not.toHaveProperty('change')
    socket.close()
    await context.drain()
  })

  it('keeps the year series off the intraday chart while both ride one candle channel', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    const feed = new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))
    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 5, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel: 5, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { Candle: CANDLE_FIELDS },
    })
    await context.drain()

    const yearRead = feed.readDailyCandles(['SPY'])
    await context.drain()
    const candleAdds = socket.sent
      .map((frame) => JsonObjectSchema.parse(JSON.parse(frame)))
      .filter((frame) => frame.type === 'FEED_SUBSCRIPTION' && frame.channel === 5)
      .flatMap((frame) => Array.isArray(frame.add) ? frame.add : [])
      .map((entry) => JsonObjectSchema.parse(entry).symbol)
    expect(candleAdds).toContain('SPY{=5m,tho=true}')
    expect(candleAdds).toContain('SPY{=d}')

    // One batch carrying both periods: the daily row is a complete snapshot (BEGIN | END).
    socket.message({
      type: 'FEED_DATA',
      channel: 5,
      data: ['Candle', [
        'SPY{=5m,tho=true}', 1_786_629_600_000, 0, 0, 1_786_629_600_000, 1, 1, 100,
        null, null, null, null, null, 699, 701, 698, 700,
        'SPY{=d}', 1_786_543_200_000, 0xC, 0, 1_786_543_200_000, 0, 1, 100,
        null, null, null, null, null, 690, 695, 689, 694,
      ]],
    })
    await context.drain()

    const year = await yearRead
    expect(year.series).toEqual([{ symbol: 'SPY', closes: [{ close: 694, sequence: 0, time: 1_786_543_200_000 }] }])

    const candleFrames = vi.mocked(client.send).mock.calls
      .map(([frame]) => JsonObjectSchema.parse(JSON.parse(frame)))
      .filter((frame) => frame.type === 'market' && frame.candle)
      .map((frame) => JsonObjectSchema.parse(frame.candle))
    expect(candleFrames.map((candle) => candle.close)).toEqual([700])

    socket.close()
    await context.drain()
  })

  it('drops a reader that stopped announcing itself and closes the upstream with it', async () => {
    vi.useFakeTimers()
    // The fake clock starts at the epoch, so pin a real instant before deriving a past one.
    vi.setSystemTime(new Date('2026-08-28T14:00:00.000Z'))
    // A browser that crashed or slept never sends a close frame, so its socket looks attached.
    const abandoned = downstream(['SPY'], Date.now() - 5 * 60_000)
    const context = new FakeContext([abandoned])
    const feed = new MarketFeedCore(context, liveEnvironment())
    await vi.advanceTimersByTimeAsync(0)
    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    // The handshake has to finish, or the setup timeout closes the upstream before the sweep.
    const handshake = [
      [1, 'Quote', QUOTE_FIELDS],
      [3, 'Trade', TRADE_FIELDS],
      [5, 'Candle', CANDLE_FIELDS],
      [7, 'Greeks', GREEKS_FIELDS],
    ] as const
    for (const [channel, type, fields] of handshake) {
      socket.message({ type: 'CHANNEL_OPENED', channel, service: 'FEED', parameters: { contract: 'AUTO' } })
      await context.drain()
      socket.message({
        type: 'FEED_CONFIG', channel, aggregationPeriod: 0.25,
        dataFormat: 'COMPACT', eventFields: { [type]: fields },
      })
      await context.drain()
    }
    expect(socket.readyState).toBe(FakeUpstreamWebSocket.OPEN)

    // The sweep rides the keepalive interval; the socket is still attached, just silent.
    await vi.advanceTimersByTimeAsync(CLIENT_HEARTBEAT_MS)
    await context.drain()
    expect(abandoned.close).toHaveBeenCalledWith(1000, 'Idle reader')

    // The runtime retires a closed socket and reports it; that is what drops the last demand.
    context.clients.length = 0
    await feed.webSocketClose()
    await context.drain()
    expect(socket.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
  })

  // Enough readers on different lists can ask for more than one connection relays. The cut used
  // to be silent: the readers who lost symbols were told the feed was live.
  it('logs a cut subscription union and tells only the readers who lost symbols', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    // No store here, so the cut ranks by demand alone and says it could not read the universe.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const lists = Array.from({ length: 6 }, (_, reader) => (
      Array.from({ length: 100 }, (_, index) => symbolAt(reader * 100 + index))
    ))
    const clients = lists.map((symbols) => downstream(symbols))
    const context = new FakeContext(clients)
    new MarketFeedCore(context, liveEnvironment())
    const socket = await openConfiguredUpstream(context)

    expect(warn).toHaveBeenCalledWith('MarketFeedSubscriptionsTruncated', 100)
    expect(warn.mock.calls.filter(([event]) => event === 'MarketFeedSubscriptionsTruncated')).toHaveLength(1)
    const relayed = new Set(lists.flat().sort().slice(0, 500))
    const statuses = (client: FeedControlSocket) => vi.mocked(client.send).mock.calls
      .map(([frame]) => JsonObjectSchema.parse(JSON.parse(frame)))
      .filter((frame) => frame.type === 'feed-status')
    let truncatedReaders = 0
    for (const [reader, client] of clients.entries()) {
      const symbols = lists[reader]!
      const received = statuses(client)
      if (symbols.every((symbol) => relayed.has(symbol))) {
        expect(received.at(-1)).toMatchObject({ state: 'live' })
        continue
      }
      truncatedReaders += 1
      expect(received.some((status) => status.state === 'live')).toBe(false)
      expect(received.at(-1)).toMatchObject({
        detail: 'Live feed is at capacity; some symbols are not streaming',
        state: 'degraded',
      })
    }
    expect(truncatedReaders).toBeGreaterThan(0)
    socket.close()
    await context.drain()
  })

  // The stream accepts any caller with a matching Origin, which a script can forge. Anonymous
  // sockets naming early-alphabet junk used to take every relay slot from the listed names.
  it('keeps published-universe names and shared demand ahead of junk subscriptions', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const store = await migrationStore()
    try {
      store.sqlite.prepare(
        `INSERT INTO public_market_universe (id, payload_json, updated_at) VALUES ('primary', ?, ?)`,
      ).run(JSON.stringify({ symbols: ['ZZZA', 'ZZZB'] }), new Date().toISOString())
      const reader = downstream(['ZZZA', 'ZZZB', 'ZZZY'])
      // A name outside the universe that two readers want outranks one nobody else names.
      const secondReader = downstream(['ZZZY'])
      const junk = Array.from({ length: 5 }, (_, socket) => (
        downstream(Array.from({ length: 100 }, (_, index) => symbolAt(socket * 100 + index)))
      ))
      const context = new FakeContext([...junk, reader, secondReader])
      new MarketFeedCore(context, { ...liveEnvironment(), DB: store.database })
      const socket = await openConfiguredUpstream(context)

      for (const client of [reader, secondReader]) {
        const statuses = vi.mocked(client.send).mock.calls
          .map(([frame]) => JsonObjectSchema.parse(JSON.parse(frame)))
          .filter((frame) => frame.type === 'feed-status')
        expect(statuses.at(-1)).toMatchObject({ state: 'live' })
      }
      socket.close()
      await context.drain()
    } finally {
      store.close()
    }
  })

  it('keeps a reader that is still announcing itself', async () => {
    const live = downstream(['SPY'])
    const context = new FakeContext([live])
    const feed = new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    await feed.webSocketMessage(live, JSON.stringify({ type: 'heartbeat' }))

    // A heartbeat is liveness only: it must never be mistaken for a subscription change.
    expect(live.close).not.toHaveBeenCalled()
    expect(vi.mocked(live.serializeAttachment).mock.calls.at(-1)?.[0])
      .toMatchObject({ symbols: ['SPY'] })
    FakeUpstreamWebSocket.instances[0]!.close()
    await context.drain()
  })

  it('survives a quiet candle bucket instead of tearing the feed down', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))
    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 5, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel: 5, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { Candle: CANDLE_FIELDS },
    })
    await context.drain()

    // A days-long backfill crosses buckets where nothing traded. COMPACT omits zero-valued
    // slots, so such a row nulls its close, its sequence, its flags — even its instant on a
    // boundary marker. Every shape must be survivable, or the first quiet bucket of a daily
    // backfill tears the whole feed down.
    socket.message({
      type: 'FEED_DATA',
      channel: 5,
      data: ['Candle', [
        'SPY{=5m,tho=true}', 1_786_629_600_000, 0, 0, 1_786_629_600_000, 1, 0, 0,
        null, null, null, null, null, null, null, null, null,
        'SPY{=5m,tho=true}', 0, 0x8, 0, 0, 0, 0, 0,
        null, null, null, null, null, null, null, null, null,
        'SPY{=5m,tho=true}', 1_786_629_900_000, null, null, 1_786_629_900_000, null, null, null,
        null, null, null, null, null, null, null, null, null,
        'SPY{=5m,tho=true}', null, null, null, null, null, null, null,
        null, null, null, null, null, null, null, null, null,
      ]],
    })
    await context.drain()

    expect(socket.readyState).toBe(FakeUpstreamWebSocket.OPEN)
    expect(vi.mocked(client.send).mock.calls.some(([frame]) => (
      JsonObjectSchema.parse(JSON.parse(frame)).state === 'degraded'
    ))).toBe(false)
    socket.close()
    await context.drain()
  })

  // The failure this pins emptied `year_candles` in production: every daily refresh from
  // 2026-09-01 on logged `Malformed upstream Candle row.` in a reconnect loop, because the
  // watchlist holds names dxFeed has no daily history for and an empty snapshot terminates
  // with one all-`"NaN"` row. JSON cannot spell a non-finite double, so dxLink writes it as
  // that string; reading it as damage rather than as absence condemned the connection.
  it('survives an empty dxFeed snapshot instead of tearing the feed down', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))
    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 5, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel: 5, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { Candle: CANDLE_FIELDS },
    })
    await context.drain()

    socket.message({
      type: 'FEED_DATA',
      channel: 5,
      data: ['Candle', [
        // The terminator of an empty daily snapshot: SNAPSHOT_BEGIN|SNAPSHOT_END|REMOVE_EVENT
        // over a row that carries no value at all.
        'SPY{=d}', 0, 0x0e, 0, 0, 0, 'NaN', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN',
        'NaN', 'NaN', 'NaN', 'NaN',
        // A live bucket that traded nothing prices the same way on the intraday series.
        'SPY{=5m,tho=true}', 1_786_629_900_000, 0, 0, 1_786_629_900_000, 0, 0, 'NaN',
        'NaN', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN',
      ]],
    })
    await context.drain()

    expect(socket.readyState).toBe(FakeUpstreamWebSocket.OPEN)
    expect(vi.mocked(client.send).mock.calls.some(([frame]) => (
      JsonObjectSchema.parse(JSON.parse(frame)).state === 'degraded'
    ))).toBe(false)
    socket.close()
    await context.drain()
  })

  // The empty snapshot's one row carries no instant, so it publishes nothing; but its flags are
  // what close the snapshot, and dropping them left the year read waiting out its whole timeout.
  it('settles a year read on an empty daily snapshot instead of waiting it out', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    const feed = new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))
    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 5, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel: 5, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { Candle: CANDLE_FIELDS },
    })
    await context.drain()

    const yearRead = feed.readDailyCandles(['SPY'])
    await context.drain()
    socket.message({
      type: 'FEED_DATA',
      channel: 5,
      data: ['Candle', [
        'SPY{=d}', 0, 0x0e, 0, 0, 0, 'NaN', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN', 'NaN',
        'NaN', 'NaN', 'NaN', 'NaN',
      ]],
    })
    await context.drain()

    // Settled by the frame itself, long before the read's own timeout could.
    const year = await Promise.race([
      yearRead,
      new Promise<'timed out'>((resolve) => { setTimeout(() => resolve('timed out'), 1_000) }),
    ])
    expect(year).toMatchObject({ series: [{ symbol: 'SPY', closes: [] }] })
    socket.close()
    await context.drain()
  })

  // A candle reads four numeric slots, so a refusal that named none of them left the
  // production failure above undiagnosable from logs alone.
  it('names the candle field that refused a row', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))
    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 5, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel: 5, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { Candle: CANDLE_FIELDS },
    })
    await context.drain()

    socket.message({
      type: 'FEED_DATA',
      channel: 5,
      data: ['Candle', [
        'SPY{=5m,tho=true}', 1_786_629_600_000, 0, 0, 1_786_629_600_000, 0, 0, 0,
        null, null, null, null, null, null, null, null, 'not-a-number',
      ]],
    })
    await context.drain()

    expect(vi.mocked(client.send).mock.calls.some(([sent]) => {
      const status = JsonObjectSchema.parse(JSON.parse(sent))
      return status.state === 'degraded' && status.detail === 'Malformed upstream Candle row: close.'
    })).toBe(true)
  })

  it('reconnects when the upstream never completes setup', async () => {
    vi.useFakeTimers()
    const context = new FakeContext([downstream(['SPY'])])
    new MarketFeedCore(context, liveEnvironment())
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeUpstreamWebSocket.instances).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(15_000)
    await context.drain()
    expect(FakeUpstreamWebSocket.instances[0]?.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
    expect(context.setAlarm).toHaveBeenCalled()
  })

  it('treats a second pre-authorization rejection as an invalid token', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'UNAUTHORIZED' })
    await context.drain()
    expect(socket.readyState).toBe(FakeUpstreamWebSocket.OPEN)

    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'UNAUTHORIZED' })
    await context.drain()
    expect(socket.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
    expect(vi.mocked(client.send).mock.calls.some(([frame]) => (
      JsonObjectSchema.parse(JSON.parse(frame)).detail === 'Upstream authorization failed'
    ))).toBe(true)
  })

  it('keeps a working quote token across a reconnect after the usual initial UNAUTHORIZED', async () => {
    const context = new FakeContext([downstream(['SPY'])])
    const feed = new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'UNAUTHORIZED' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.close()
    await context.drain()
    await feed.alarm()
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(2))

    expect(tasty.loadQuoteToken).toHaveBeenCalledTimes(1)
    FakeUpstreamWebSocket.instances[1]!.close()
    await context.drain()
  })

  it('buys a fresh quote token after the upstream rejects one', async () => {
    const context = new FakeContext([downstream(['SPY'])])
    const feed = new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'UNAUTHORIZED' })
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'UNAUTHORIZED' })
    await context.drain()
    expect(socket.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
    await feed.alarm()
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(2))

    expect(tasty.loadQuoteToken).toHaveBeenCalledTimes(2)
    FakeUpstreamWebSocket.instances[1]!.close()
    await context.drain()
  })

  it('buys a fresh quote token when the upstream closes before authorizing', async () => {
    const context = new FakeContext([downstream(['SPY'])])
    const feed = new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'UNAUTHORIZED' })
    await context.drain()
    // Rejected by closing rather than by a second AUTH_STATE.
    socket.close()
    await context.drain()
    await feed.alarm()
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(2))

    expect(tasty.loadQuoteToken).toHaveBeenCalledTimes(2)
    FakeUpstreamWebSocket.instances[1]!.close()
    await context.drain()
  })

  it('buys a fresh quote token only when setup timed out before authorization', async () => {
    vi.useFakeTimers()
    const context = new FakeContext([downstream(['SPY'])])
    const feed = new MarketFeedCore(context, liveEnvironment())
    await vi.advanceTimersByTimeAsync(0)
    const first = FakeUpstreamWebSocket.instances[0]!
    first.open()
    await context.drain()
    first.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    await vi.advanceTimersByTimeAsync(15_000)
    await context.drain()
    expect(first.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
    await feed.alarm()
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeUpstreamWebSocket.instances).toHaveLength(2)
    expect(tasty.loadQuoteToken).toHaveBeenCalledTimes(1)

    const second = FakeUpstreamWebSocket.instances[1]!
    second.open()
    await context.drain()
    await vi.advanceTimersByTimeAsync(15_000)
    await context.drain()
    expect(second.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
    await feed.alarm()
    await vi.advanceTimersByTimeAsync(0)
    expect(FakeUpstreamWebSocket.instances).toHaveLength(3)
    expect(tasty.loadQuoteToken).toHaveBeenCalledTimes(2)
    FakeUpstreamWebSocket.instances[2]!.close()
    await context.drain()
  })

  it('treats any rejection after authorization as terminal', async () => {
    const context = new FakeContext([downstream(['SPY'])])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'UNAUTHORIZED' })
    await context.drain()

    expect(socket.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
  })

  it('does not expose provider-supplied protocol details to logs or clients', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'ERROR', channel: 0, message: 'private-provider-payload' })
    await context.drain()

    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain('private-provider-payload')
    expect(JSON.stringify(vi.mocked(client.send).mock.calls)).not.toContain('private-provider-payload')
    expect(vi.mocked(client.send).mock.calls.some(([frame]) => frame.includes('Upstream feed error'))).toBe(true)
  })

  it('degrades and reconnects instead of dropping malformed upstream envelopes', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.emit('message', '{not-json')
    await context.drain()

    expect(socket.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
    expect(context.setAlarm).toHaveBeenCalled()
    expect(vi.mocked(client.send).mock.calls.some(([frame]) => {
      const status = JsonObjectSchema.parse(JSON.parse(frame))
      return status.type === 'feed-status'
        && status.state === 'degraded'
        && status.detail === 'Upstream feed frame was not JSON'
    })).toBe(true)
  })

  it('waits for the layout instead of failing on dxLink\'s own opening config', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 3, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    // dxLink's answer to the channel request: its own defaults, carrying no field layout.
    socket.message({ type: 'FEED_CONFIG', channel: 3, aggregationPeriod: 0.25, dataFormat: 'COMPACT' })
    await context.drain()

    expect(socket.readyState).toBe(FakeUpstreamWebSocket.OPEN)
    expect(vi.mocked(client.send).mock.calls.some(([sent]) => {
      const status = JsonObjectSchema.parse(JSON.parse(sent))
      return status.type === 'feed-status' && status.state === 'live'
    })).toBe(false)

    // The channel is not configured, so data on it is still refused rather than mapped
    // against a layout nobody validated.
    socket.message({
      type: 'FEED_DATA',
      channel: 3,
      data: ['Trade', ['SPY', 1_786_629_600_000, 1_786_629_600_000, null, 1, 'Q',
        1, 'Up', false, 700, null, 10, 1_000, 700_000]],
    })
    await context.drain()
    expect(vi.mocked(client.send).mock.calls.some(([sent]) => {
      const status = JsonObjectSchema.parse(JSON.parse(sent))
      return status.detail === 'Unconfigured feed data channel.'
    })).toBe(true)
  })

  it('publishes a quote from its own bid and ask instants, and stays up when unquoted', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'SETUP', channel: 0, version: '0.1-test' })
    await context.drain()
    socket.message({ type: 'AUTH_STATE', channel: 0, state: 'AUTHORIZED' })
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 1, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel: 1, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { Quote: QUOTE_FIELDS },
    })
    await context.drain()

    // dxLink leaves eventTime at zero on a quote, so a real one is only publishable if the
    // bid and ask instants are read instead.
    socket.message({
      type: 'FEED_DATA',
      channel: 1,
      data: ['Quote', ['SPY', 0, 1, null, 1_786_629_600_000, 'Q',
        1_786_629_599_000, 'Q', 699, 701, 10, 12]],
    })
    await context.drain()

    expect(socket.readyState).toBe(FakeUpstreamWebSocket.OPEN)
    const quote = vi.mocked(client.send).mock.calls
      .map(([sent]) => JsonObjectSchema.parse(JSON.parse(sent)))
      .find((frame) => frame.type === 'market')
    expect(quote).toMatchObject({
      symbol: 'SPY', bid: 699, ask: 701, price: 700,
      timestamp: new Date(1_786_629_600_000).toISOString(),
    })

    // A name that is simply not quoted right now is ordinary silence, not a broken frame.
    socket.message({
      type: 'FEED_DATA',
      channel: 1,
      data: ['Quote', ['SPY', 0, 2, null, 0, 'Q', 0, 'Q', 0, 0, 0, 0]],
    })
    await context.drain()

    expect(socket.readyState).toBe(FakeUpstreamWebSocket.OPEN)
    expect(vi.mocked(client.send).mock.calls.some(([sent]) => {
      const status = JsonObjectSchema.parse(JSON.parse(sent))
      return status.detail === 'Malformed upstream Quote row.'
    })).toBe(false)
  })

  // A refused frame used to report one generic string whatever refused it, which left a live
  // production failure undiagnosable. Each check now names itself without quoting the frame.
  it.each([
    ['a frame that is not text', new ArrayBuffer(4), 'Upstream feed frame was not text'],
    ['a message type it does not handle', '{"type":"NOPE","channel":0}', 'Unexpected upstream message.'],
    ['a keepalive off channel zero', '{"type":"KEEPALIVE","channel":3}', 'Unexpected keepalive channel.'],
    // The code is used only to select one of this file's own literals, so a refusal can say why
    // dxLink rejected a subscription without echoing anything the frame carried.
    [
      'an upstream error naming a protocol code',
      '{"type":"ERROR","channel":0,"error":"LIMIT_EXCEEDED","message":"too many subscriptions"}',
      'Upstream feed error: LIMIT_EXCEEDED',
    ],
    [
      'an upstream error naming a code it does not know',
      '{"type":"ERROR","channel":0,"error":"tok_live_should_never_be_logged"}',
      'Upstream feed error: unrecognised',
    ],
  ])('names the check that refused %s', async (_name, frame, detail) => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.emit('message', frame)
    await context.drain()

    expect(vi.mocked(client.send).mock.calls.some(([sent]) => {
      const status = JsonObjectSchema.parse(JSON.parse(sent))
      return status.type === 'feed-status' && status.state === 'degraded' && status.detail === detail
    })).toBe(true)
  })

  it('validates a whole COMPACT batch before broadcasting any of its rows', async () => {
    const client = downstream(['SPY'])
    const context = new FakeContext([client])
    new MarketFeedCore(context, liveEnvironment())
    await vi.waitFor(() => expect(FakeUpstreamWebSocket.instances).toHaveLength(1))

    const socket = FakeUpstreamWebSocket.instances[0]!
    socket.open()
    await context.drain()
    socket.message({ type: 'CHANNEL_OPENED', channel: 3, service: 'FEED', parameters: { contract: 'AUTO' } })
    await context.drain()
    socket.message({
      type: 'FEED_CONFIG', channel: 3, aggregationPeriod: 0.25,
      dataFormat: 'COMPACT', eventFields: { Trade: TRADE_FIELDS },
    })
    await context.drain()
    socket.message({
      type: 'FEED_DATA',
      channel: 3,
      // The second row's change is present but unreadable, so the layout itself is in doubt
      // and the sibling row cannot be trusted either, however well it happens to parse.
      data: ['Trade', [
        'SPY', 1_786_629_600_000, 1_786_629_600_000, null, 1, 'Q',
        1, 'Up', false, 700, 1, 10, 1_000, 700_000,
        'SPY', 1_786_629_600_100, 1_786_629_600_100, null, 2, 'Q',
        1, 'Up', false, 700, 'not-a-number', 10, 1_010, 707_000,
      ]],
    })
    await context.drain()

    expect(vi.mocked(client.send).mock.calls.every(([frame]) => (
      JsonObjectSchema.parse(JSON.parse(frame)).type !== 'market'
    ))).toBe(true)
    expect(socket.readyState).toBe(FakeUpstreamWebSocket.CLOSED)
  })
})
