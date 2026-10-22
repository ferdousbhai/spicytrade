import { type DailyCandlesReadResult, type OptionGreeksReadResult } from './market-feed-contracts'


interface BrokerGateRpcStub {
  acquire(): Promise<void>
  acquireMutation(): Promise<string>
  renewMutation(token: string): Promise<boolean>
  releaseMutation(token: string): Promise<void>
}

interface BrokerGateNamespace {
  getByName(name: string): BrokerGateRpcStub
}

interface MarketFeedRpcStub {
  fetch(request: Request): Promise<Response>
  readDailyCandles(symbols: readonly string[]): Promise<DailyCandlesReadResult>
  readOptionGreeks(streamerSymbols: readonly string[]): Promise<OptionGreeksReadResult>
}

interface MarketFeedNamespace {
  getByName(name: string): MarketFeedRpcStub
}

export interface AppEnv {
  PUBLIC_READ_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> }
  AUTH_BASE_URL?: string
  BETTER_AUTH_SECRET?: string
  BROKER_GATE?: BrokerGateNamespace
  BROWSER?: BrowserRun
  DB?: D1Database
  EXA_API_KEY?: SecretsStoreSecret
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: SecretsStoreSecret
  MARKET_FEED?: MarketFeedNamespace
  TASTYTRADE_API_BASE?: string
  TASTYTRADE_CLIENT_SECRET?: SecretsStoreSecret
  TASTYTRADE_OAUTH_CLIENT_ID?: string
  TASTYTRADE_OAUTH_CLIENT_SECRET?: SecretsStoreSecret
  TASTYTRADE_REFRESH_TOKEN?: SecretsStoreSecret
}
