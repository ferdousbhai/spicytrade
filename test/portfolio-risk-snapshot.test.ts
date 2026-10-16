import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { loadBrokerageContext } from '../src/server/brokerage-context'
import { assertPortfolioActionAllowed } from '../src/server/portfolio-risk'
import { resetBrokerApi, setBrokerApi } from '../src/server/tastytrade'
import { type JsonValue } from '../src/domain/json-payload'
import { brokerCredential, stubBroker, tastytradeBalances as balances } from './broker-stub'
import { unsupportedDatabase } from './fake-d1'

/**
 * The account context and the portfolio guard read one broker snapshot. These pin the
 * union of what the two separate readers used to reject, and the guard's own wording for
 * each — those messages reach a member's agent.
 */

const tastytrade = stubBroker()

const longEquity = {
  symbol: 'SPY', 'underlying-symbol': 'SPY', 'instrument-type': 'Equity',
  'quantity-direction': 'Long', quantity: '10',
}

const openEquityOrder = {
  kind: 'place_equity_order', symbol: 'SPY', action: 'Buy to Open',
  quantity: 1, limitPrice: 700, priceEffect: 'Debit',
} as const

type Overrides = Partial<Record<'balances' | 'complex' | 'orders' | 'positions', JsonValue>>

function respondWith(overrides: Overrides = {}) {
  tastytrade.tastyRequest.mockReset().mockImplementation((_env, path: string) => {
    if (path.includes('/balances')) return Promise.resolve(overrides.balances ?? { data: balances })
    if (path.includes('/complex-orders/live')) return Promise.resolve(overrides.complex ?? { data: { items: [] } })
    if (path.includes('/orders/live')) return Promise.resolve(overrides.orders ?? { data: { items: [] } })
    if (path.includes('/positions')) return Promise.resolve(overrides.positions ?? { data: { items: [longEquity] } })
    throw new Error(`Unexpected path: ${path}`)
  })
}

function guard(env = { DB: unsupportedDatabase() }) {
  return assertPortfolioActionAllowed(env, openEquityOrder, brokerCredential, { accountNumber: 'TEST123', optionContracts: [] })
}

beforeEach(() => {
  setBrokerApi(tastytrade)
  tastytrade.resolveAccountNumber.mockReset().mockResolvedValue('TEST123')
  respondWith()
})

afterEach(() => resetBrokerApi())

describe('portfolio guard over the merged account snapshot', () => {
  it('allows a bounded opening debit against a complete, long-only account', async () => {
    await expect(guard()).resolves.toBeUndefined()
  })

  it('judges only the contract placement resolved, and never resolves one of its own', async () => {
    const optionOrder = {
      kind: 'place_option_order', underlying: 'SPY', optionType: 'C', strike: 700, expiry: '2026-09-18',
      action: 'Buy to Open', quantity: 1, limitPrice: 1, priceEffect: 'Debit',
    } as const
    await expect(assertPortfolioActionAllowed({ DB: unsupportedDatabase() }, optionOrder, brokerCredential, {
      accountNumber: 'TEST123', optionContracts: [],
    })).rejects.toThrow('The guard could not verify the option contract.')
    expect(tastytrade.tastyRequest.mock.calls.map(([, path]) => String(path)))
      .not.toContainEqual(expect.stringContaining('/option-chains/'))
    expect(tastytrade.resolveAccountNumber).not.toHaveBeenCalled()
  })

  it('names the incomplete read rather than under-reporting the account', async () => {
    respondWith({ positions: { data: { items: [longEquity] }, pagination: { 'total-items': 2 } } })
    await expect(guard()).rejects.toThrow(
      'The portfolio guard could not verify every open position: TastytradeAccount:incomplete-positions.',
    )

    respondWith({ orders: { data: { items: [] }, pagination: { 'total-items': 1 } } })
    await expect(guard()).rejects.toThrow(
      'The portfolio guard could not verify every ordinary live order: TastytradeAccount:incomplete-orders.',
    )

    respondWith({ complex: { data: { items: [] }, pagination: { 'total-items': 1 } } })
    await expect(guard()).rejects.toThrow(
      'The portfolio guard could not verify every complex live order: TastytradeAccount:incomplete-complex-orders.',
    )

    respondWith({ balances: { data: { items: [] } } })
    await expect(guard()).rejects.toThrow(
      'The portfolio guard could not verify balances: TastytradePayload:invalid-account-balance-record.',
    )
  })

  it('refuses an unsupported position record instead of skipping it', async () => {
    respondWith({ positions: { data: { items: [{ ...longEquity, 'quantity-direction': 'Sideways' }] } } })
    await expect(guard()).rejects.toThrow('The portfolio guard found an unsupported position record.')
  })

  it('skips a flat position tastytrade labels Zero, and refuses Zero on a held quantity', async () => {
    const flat = { ...longEquity, 'quantity-direction': 'Zero', quantity: '0', symbol: 'QQQ', 'underlying-symbol': 'QQQ' }
    respondWith({ positions: { data: { items: [longEquity, flat] } } })
    await expect(guard()).resolves.toBeUndefined()

    respondWith({ positions: { data: { items: [{ ...flat, quantity: '3' }] } } })
    await expect(guard()).rejects.toThrow('The portfolio guard found an unsupported position record.')

    respondWith({ positions: { data: { items: [{ ...flat, 'quantity-direction': 'Sideways' }] } } })
    await expect(guard()).rejects.toThrow('The portfolio guard found an unsupported position record.')
  })

  it('reports a malformed position before a malformed balance, as the snapshot promises', async () => {
    respondWith({
      balances: { data: { items: [] } },
      positions: { data: { items: [{ ...longEquity, 'quantity-direction': 'Sideways' }] } },
    })
    await expect(guard()).rejects.toThrow('The portfolio guard found an unsupported position record.')
  })

  // Newly rejected here: the guard used to parse positions loosely enough that a row with no
  // underlying symbol passed, while the account context refused it. The merged read takes the
  // stricter of the two, so an unidentifiable position now stops a trade rather than sizing it.
  it('refuses a position the broker did not name an underlying for', async () => {
    const { 'underlying-symbol': _dropped, ...unnamed } = longEquity
    respondWith({ positions: { data: { items: [unnamed] } } })
    await expect(guard()).rejects.toThrow('The portfolio guard found an unsupported position record.')
  })

  // Newly rejected here for the same reason: the guard used to count live-order rows without
  // parsing them, so a malformed working order silently became "one live order".
  it('refuses a malformed live order instead of counting it', async () => {
    respondWith({ orders: { data: { items: [{ id: '5', status: 'Live', 'order-type': 'Limit', legs: [] }] } } })
    await expect(guard()).rejects.toThrow(
      'The portfolio guard could not verify every ordinary live order: TastytradePayload:invalid-working-order.',
    )
  })

  it('names an unexpected parser failure by its error name, never its message', async () => {
    // A parser fault's message can quote the payload it choked on; only a repo code may pass.
    const hostile = {
      id: '5',
      get status(): string {
        throw new TypeError('Cannot read ACCOUNT-SECRET-9 of payload')
      },
    }
    respondWith({ orders: { data: { items: [hostile] } } })
    const refusal = guard()
    await expect(refusal).rejects.toThrow(/could not verify every ordinary live order: TypeError\.$/)
    await expect(refusal).rejects.not.toThrow('ACCOUNT-SECRET-9')
  })

  it('reports a broker that would not answer separately from one that answered badly', async () => {
    tastytrade.tastyRequest.mockReset().mockRejectedValue(new Error('TastytradeApi:503:/accounts/[redacted]/positions'))
    await expect(guard()).rejects.toThrow('The portfolio guard could not refresh the complete brokerage account.')
  })

  it('refuses a non-positive net liquidation value and a negative cash reserve', async () => {
    respondWith({ balances: { data: { ...balances, 'net-liquidating-value': '0' } } })
    await expect(guard()).rejects.toThrow(
      'The portfolio guard could not verify net liquidation value.',
    )

    respondWith({ balances: { data: { ...balances, 'cash-balance': '-1' } } })
    await expect(guard()).rejects.toThrow('The portfolio guard found a negative cash reserve.')
  })
})

describe('live orders do not veto a new ticket', () => {
  const liveOrder = {
    id: '101', status: 'Live', 'order-type': 'Limit', price: '1.20',
    'price-effect': 'Debit', 'time-in-force': 'Day',
    legs: [{ action: 'Buy to Open', quantity: '1', symbol: 'SPY', 'instrument-type': 'Equity' }],
  }

  it('allows a new order while another is live', async () => {
    respondWith({ orders: { data: { items: [liveOrder] } } })
    await expect(guard()).resolves.toBeUndefined()
  })

  it('lists no working order for a complex order whose children have all gone terminal', async () => {
    const complex = { data: { items: [{
      id: 'c1', status: 'Received',
      orders: [{ id: 'c1a', status: 'Filled', 'terminal-at': '2026-09-03T12:00:00Z' }],
    }] } }
    respondWith({ complex })

    await expect(guard()).resolves.toBeUndefined()
    const context = await loadBrokerageContext({}, brokerCredential)
    expect(context.orders).toEqual([])
  })
})
