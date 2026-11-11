import { describe, expect, it } from 'vitest'

import { marketDateFromPageAddress, symbolFromPageAddress } from '../src/domain/public-page'
import { appViewHead, briefPagePath, isAppViewPath, symbolPagePath } from '../src/domain/site'

describe('public page addresses', () => {
  it('reads a canonical symbol address as itself', () => {
    expect(symbolFromPageAddress('NVDA')).toEqual({ canonical: true, symbol: 'NVDA' })
    expect(symbolFromPageAddress('BRK/B')).toEqual({ canonical: true, symbol: 'BRK/B' })
  })

  it('normalizes a lower-case or padded address to the upper-case symbol and marks it for redirect', () => {
    expect(symbolFromPageAddress('nvda')).toEqual({ canonical: false, symbol: 'NVDA' })
    expect(symbolFromPageAddress('brk/b')).toEqual({ canonical: false, symbol: 'BRK/B' })
    expect(symbolFromPageAddress(' NVDA')).toEqual({ canonical: false, symbol: 'NVDA' })
  })

  it.each(['', 'not-a-symbol!', 'TOOLONGSYM', '/ES', 'BRK.B', 'NVDA:XNAS', '$NVDA', '<script>'])(
    'names no page for %j',
    (segment) => { expect(symbolFromPageAddress(segment)).toBeUndefined() },
  )

  it('reads only a real calendar date as a brief address', () => {
    expect(marketDateFromPageAddress('2026-08-13')).toBe('2026-08-13')
    for (const segment of ['2026-13-45', '2026-02-30', '2026-8-13', 'latest', '', '2026-08-13T00:00:00Z']) {
      expect(marketDateFromPageAddress(segment)).toBeUndefined()
    }
  })

  it('builds the paths the routes match, with a share class percent-encoded', () => {
    expect(symbolPagePath('NVDA')).toBe('/options/NVDA')
    expect(symbolPagePath('BRK/B')).toBe('/options/BRK%2FB')
    expect(briefPagePath('2026-08-13')).toBe('/briefs/2026-08-13')
  })
})

describe('application view titles', () => {
  it('titles each shell view by its path and nothing else', () => {
    expect(isAppViewPath('/watch') && appViewHead('/watch')).toEqual({ meta: [{ title: 'Watch | spicytrade' }] })
    expect(isAppViewPath('/recommendations') && appViewHead('/recommendations')).toEqual({ meta: [{ title: 'Recommendations | spicytrade' }] })
    expect(isAppViewPath('/connect') && appViewHead('/connect')).toEqual({ meta: [{ title: 'Connect | spicytrade' }] })
    for (const path of ['/', '/briefs', '/watch/', 'toString', '__proto__']) expect(isAppViewPath(path)).toBe(false)
  })
})
