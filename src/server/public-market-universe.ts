import { z } from 'zod'

import { EquitySymbolSchema } from '../domain/instrument'
import { MAX_WATCHLIST_SYMBOLS } from '../domain/watchlist'
import { type AppEnv } from './env'
import { CallerVisibleError } from './caller-visible-error'

const PublicMarketUniverseSchema = z.strictObject({
  symbols: z.array(EquitySymbolSchema).max(MAX_WATCHLIST_SYMBOLS),
})
const StoredPublicMarketUniverseRowSchema = z.strictObject({ payload_json: z.string() })

type PublicMarketUniverse = z.infer<typeof PublicMarketUniverseSchema>

/** Publish only the current source-neutral D1 projection, never a stale caller snapshot. */
export async function publishInternalWatchlistUniverse(
  env: AppEnv,
  updatedAt = new Date(),
): Promise<void> {
  if (!env.DB) throw new CallerVisibleError('PublicMarketUniverse:store-unavailable')
  // A name the broker has stopped trading is excluded here rather than deleted from the list.
  // It quotes a stale last price forever and can never trade again, so offering it to a reader
  // is offering something to act on that cannot be acted on -- CRVW rode the original seed onto
  // the public page this way and priced at three cents for as long as anyone looked. A row the
  // catalog has never seen is kept: unknown is not the same as delisted.
  //
  // One statement reads the watchlist and writes its copy. Two publishes that each read and then
  // wrote could interleave so the older read landed last; D1 serializes statements, so the copy
  // left behind is always of the watchlist as the last publish saw it. The JSON is built to the
  // exact `JSON.stringify` shape of `PublicMarketUniverseSchema` -- alphabetized symbols and no
  // other field, so nothing stored reveals priority or provenance -- and `loadStored...` parses
  // it back through that schema. The size bound is the same one that schema enforces: an
  // oversized projection writes nothing and throws, leaving the previous copy in place.
  // `json_group_array(... ORDER BY ...)` needs SQLite 3.44, which D1 runs.
  const result = await env.DB.prepare(
    `INSERT INTO public_market_universe (id, payload_json, updated_at)
     SELECT 'primary', json_object('symbols', json_group_array(i.symbol ORDER BY i.symbol ASC)), ?
       FROM internal_watchlist_items i
       LEFT JOIN instrument_catalog c ON c.symbol = i.symbol
      WHERE coalesce(c.active, 1) = 1
     HAVING count(*) <= ?
     ON CONFLICT(id) DO UPDATE SET payload_json = excluded.payload_json, updated_at = excluded.updated_at`,
  ).bind(updatedAt.toISOString(), MAX_WATCHLIST_SYMBOLS).run()
  if (result.meta.changes !== 1) throw new CallerVisibleError('PublicMarketUniverse:too-many-symbols')
}

export async function loadStoredPublicMarketUniverse(env: AppEnv): Promise<PublicMarketUniverse> {
  if (!env.DB) throw new CallerVisibleError('PublicMarketUniverse:store-unavailable')
  const result = await env.DB.prepare(
    `SELECT payload_json FROM public_market_universe WHERE id = 'primary'`,
  ).first<{ payload_json: string }>()
  if (!result) throw new CallerVisibleError('PublicMarketUniverse:not-found')
  const row = StoredPublicMarketUniverseRowSchema.parse(result)
  return PublicMarketUniverseSchema.parse(JSON.parse(row.payload_json))
}
