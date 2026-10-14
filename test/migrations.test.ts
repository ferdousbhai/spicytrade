import { readFile } from 'node:fs/promises'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'

/** Each test names the migration files it applies; `test/sqlite-d1.ts` explains why. */
const read = (name: string) => readFile(new URL(`../migrations/${name}`, import.meta.url), 'utf8')

describe('D1 migrations', () => {
  it('stores only constrained, per-user favorite symbols and cascades account deletion', async () => {
    const initial = await read('0001_spice.sql')
    const favorites = await read('0013_user_favorite_symbols.sql')
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(initial)
    db.exec(favorites)
    db.prepare(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES ('member-1', 'Member', 'member@example.com', 1, 'now', 'now')`,
    ).run()
    db.prepare(
      `INSERT INTO user_favorite_symbols (user_id, symbol, created_at)
       VALUES ('member-1', 'NVDA', 'now')`,
    ).run()

    expect(() => db.prepare(
      `INSERT INTO user_favorite_symbols (user_id, symbol, created_at)
       VALUES ('member-1', 'nvda', 'now')`,
    ).run()).toThrow()
    expect(() => db.prepare(
      `INSERT INTO user_favorite_symbols (user_id, symbol, created_at)
       VALUES ('missing-user', 'META', 'now')`,
    ).run()).toThrow()
    db.prepare(`DELETE FROM "user" WHERE "id" = 'member-1'`).run()
    expect(db.prepare('SELECT count(*) AS count FROM user_favorite_symbols').get()).toEqual({ count: 0 })
    db.close()
  })

  it('rebuilds every symbol constraint onto tastytrade symbology and carries rows over', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    for (const name of [
      '0001_spice.sql', '0003_public_market_universe.sql', '0004_catalyst_description.sql',
      '0006_internal_watchlist.sql', '0007_internal_watchlist_validation.sql',
      '0008_instrument_catalog.sql', '0009_instrument_catalog_resolution.sql',
      '0010_source_specific_market_data.sql', '0011_internal_watchlist_position_origin.sql',
      '0012_codex_catalyst_confidence.sql', '0013_user_favorite_symbols.sql',
    ]) db.exec(await read(name))

    db.exec(`
      INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
      VALUES ('BRK.B', 'Equity', 'owner', '{}', 'now', 'now'), ('NVDA', 'Equity', 'owner', '{}', 'now', 'now');
      INSERT INTO instrument_catalog
        (symbol, instrument_type, identity_refreshed_at, status_refreshed_at, created_at, updated_at)
      VALUES ('BRK.B', 'Equity', 'now', 'now', 'now', 'now');
      INSERT INTO instrument_tick_sizes (symbol, kind, tier_index, tick_value)
      VALUES ('BRK.B', 'equity', 0, 0.01);
      INSERT INTO tastytrade_market_quotes
        (symbol, price, previous_close, change_amount, change_percent, provider_updated_at, observed_at)
      VALUES ('BRK.B', 10, 9, 1, 11.1, 'now', 'now');
      INSERT INTO public_market_universe (id, payload_json, updated_at)
      VALUES ('primary', json_object('symbols', json_array('BRK.B', 'NVDA')), 'now');
      INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
      VALUES ('member-1', 'Member', 'member@example.com', 1, 'now', 'now');
      INSERT INTO user_favorite_symbols (user_id, symbol, created_at) VALUES ('member-1', 'BRK.B', 'now');
    `)

    db.exec(await read('0014_tastytrade_equity_symbology.sql'))

    expect(db.prepare('SELECT symbol FROM internal_watchlist_items ORDER BY symbol').all())
      .toEqual([{ symbol: 'BRK/B' }, { symbol: 'NVDA' }])
    expect(db.prepare('SELECT symbol FROM instrument_catalog').all()).toEqual([{ symbol: 'BRK/B' }])
    expect(db.prepare('SELECT symbol, tick_value FROM instrument_tick_sizes').all())
      .toEqual([{ symbol: 'BRK/B', tick_value: 0.01 }])
    expect(db.prepare('SELECT symbol FROM tastytrade_market_quotes').all()).toEqual([{ symbol: 'BRK/B' }])
    expect(db.prepare('SELECT symbol FROM user_favorite_symbols').all()).toEqual([{ symbol: 'BRK/B' }])
    expect(db.prepare("SELECT payload_json FROM public_market_universe WHERE id = 'primary'").get())
      .toEqual({ payload_json: '{"symbols":["BRK/B","NVDA"]}' })
    expect(db.prepare("SELECT symbol FROM public_market_overview WHERE symbol = 'BRK/B'").get())
      .toEqual({ symbol: 'BRK/B' })

    const insertItem = db.prepare(
      `INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
       VALUES (?, 'Equity', 'owner', '{}', 'now', 'now')`,
    )
    expect(() => insertItem.run('V2X')).not.toThrow()
    expect(() => insertItem.run('BF/A')).not.toThrow()
    for (const rejected of ['BRK.B', 'BRK-B', '/ES', 'BRK/', 'A/B/C', 'nvda', 'ABCDEFGHIJK']) {
      expect(() => insertItem.run(rejected)).toThrow()
    }

    db.prepare(`DELETE FROM "user" WHERE "id" = 'member-1'`).run()
    expect(db.prepare('SELECT count(*) AS count FROM user_favorite_symbols').get()).toEqual({ count: 0 })
    db.close()
  })

  it('quarantines an ambiguous submission per broker account, never globally', async () => {
    const initial = await read('0001_spice.sql')
    const migration = await read('0029_broker_submission_quarantine.sql')
    const db = new DatabaseSync(':memory:')
    // 0029 carries executed orders forward, so the table it reads must already exist.
    db.exec(initial)
    db.exec(migration)
    const insert = db.prepare(
      `INSERT INTO broker_submissions
        (id, broker_id, account_number, payload_json, submitted_at, status)
       VALUES (?, ?, ?, '{}', '2026-09-03T13:30:00.000Z', ?)`,
    )
    insert.run('one', 'tastytrade', 'ACCOUNT-1', 'unresolved')

    // A second unresolved submission for the same account is what the quarantine forbids.
    expect(() => insert.run('two', 'tastytrade', 'ACCOUNT-1', 'unresolved')).toThrow(/UNIQUE constraint/)
    // A different account, and a different broker for the same account, stay free to trade.
    expect(() => insert.run('other-account', 'tastytrade', 'ACCOUNT-2', 'unresolved')).not.toThrow()
    expect(() => insert.run('other-broker', 'future-broker', 'ACCOUNT-1', 'unresolved')).not.toThrow()
    // Resolving one releases the account.
    db.prepare("UPDATE broker_submissions SET status = 'executed' WHERE id = 'one'").run()
    expect(() => insert.run('three', 'tastytrade', 'ACCOUNT-1', 'unresolved')).not.toThrow()
    expect(() => insert.run('bad-status', 'tastytrade', 'ACCOUNT-9', 'whatever')).toThrow(/CHECK constraint/)
    db.close()
  })

  it('adds the resolved order beside the action, leaving existing rows without one', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec(await read('0001_spice.sql'))
    db.exec(await read('0029_broker_submission_quarantine.sql'))
    db.prepare(
      `INSERT INTO broker_submissions (id, broker_id, account_number, payload_json, submitted_at, status)
       VALUES ('legacy', 'tastytrade', 'ACCOUNT-1', '{}', '2026-09-03T13:30:00.000Z', 'unresolved')`,
    ).run()

    db.exec(await read('0047_broker_submission_resolved_payload.sql'))

    // A row claimed before the column existed has no resolved order; reconciliation falls back.
    expect(db.prepare('SELECT resolved_payload_json FROM broker_submissions').all())
      .toEqual([{ resolved_payload_json: null }])
    const insert = db.prepare(
      `INSERT INTO broker_submissions (id, broker_id, account_number, payload_json, resolved_payload_json, submitted_at, status)
       VALUES (?, 'tastytrade', 'ACCOUNT-2', '{}', ?, '2026-09-03T13:30:00.000Z', 'failed')`,
    )
    expect(() => insert.run('stored', '{"legs":[]}')).not.toThrow()
    expect(() => insert.run('garbled', '{not json')).toThrow(/CHECK constraint/)
    db.close()
  })

  it('carries executed orders forward so a pre-deploy order stays replaceable', async () => {
    const initial = await read('0001_spice.sql')
    const inFlight = await read('0005_brokerage_action_state.sql')
    const migration = await read('0029_broker_submission_quarantine.sql')
    const db = new DatabaseSync(':memory:')
    db.exec(initial)
    db.exec(inFlight)
    db.prepare(
      `INSERT INTO brokerage_actions
        (id, status, payload_json, token_digest, created_at, expires_at, resolved_at, provider_order_id)
       VALUES ('done', 'executed', '{"kind":"place_equity_order"}', 'd', '2026-09-01T00:00:00.000Z',
               '2026-09-01T00:05:00.000Z', '2026-09-01T00:01:00.000Z', '55512')`,
    ).run()
    // A draft that never became an order carries nothing forward.
    db.prepare(
      `INSERT INTO brokerage_actions (id, status, payload_json, token_digest, created_at, expires_at)
       VALUES ('abandoned', 'denied', '{}', 'd', '2026-09-01T00:00:00.000Z', '2026-09-01T00:05:00.000Z')`,
    ).run()

    db.exec(migration)

    const carried = db.prepare('SELECT id, status, provider_order_id FROM broker_submissions').all()
    expect(carried).toEqual([{ id: 'done', status: 'executed', provider_order_id: '55512' }])
    db.close()
  })

  it('adds the internal watchlist seed, normalized live items, and immutable provenance tables', async () => {
    const publicUniverse = await read('0003_public_market_universe.sql')
    const migration = await read('0006_internal_watchlist.sql')
    const validation = await read('0007_internal_watchlist_validation.sql')
    const positionOrigin = await read('0011_internal_watchlist_position_origin.sql')
    const db = new DatabaseSync(':memory:')
    db.exec(publicUniverse)
    db.exec(migration)

    expect(db.prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'internal_watchlist_%' ORDER BY name`,
    ).all()).toEqual([
      { name: 'internal_watchlist_items' },
      { name: 'internal_watchlist_seed' },
      { name: 'internal_watchlist_seed_entries' },
      { name: 'internal_watchlist_seed_sources' },
    ])
    db.prepare(
      `INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
       VALUES ('SPY', 'Equity', 'owner', '{}', 'now', 'now')`,
    ).run()
    db.exec(`
      INSERT INTO internal_watchlist_seed
        (id, status, attempt_id, started_at, seeded_at)
      VALUES ('primary', 'ready', 'legacy', '2026-08-26T10:00:00.000Z', '2026-08-26T10:00:00.000Z');
      INSERT INTO internal_watchlist_seed_sources
        (id, source_kind, source_index, name, metadata_json)
      VALUES ('tastytrade-private-0', 'private', 0, 'Private', '{}');
      INSERT INTO internal_watchlist_seed_entries
        (source_id, entry_index, broker_symbol, instrument_type, metadata_json)
      VALUES ('tastytrade-private-0', 0, 'NVDA', 'Equity', '{}');
    `)
    expect(() => db.exec(validation)).not.toThrow()
    expect(() => db.exec(positionOrigin)).not.toThrow()
    expect(db.prepare(
      `SELECT symbol, instrument_type FROM internal_watchlist_items WHERE symbol = 'SPY'`,
    ).get()).toEqual({ instrument_type: 'Equity', symbol: 'SPY' })
    expect(db.prepare(
      `SELECT finalized_at FROM internal_watchlist_seed WHERE id = 'primary'`,
    ).get()).toEqual({ finalized_at: '2026-08-26T10:00:00.000Z' })
    expect(db.prepare(
      `SELECT count(*) AS count FROM internal_watchlist_items WHERE symbol = 'NVDA'`,
    ).get()).toEqual({ count: 0 })
    expect(() => db.prepare(
      `INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
       VALUES ('NVDA', 'Equity', 'position-sync', '{}', 'now', 'now')`,
    ).run()).not.toThrow()
    expect(() => db.prepare(
      `INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
       VALUES ('nvda', 'Equity', 'owner', '{}', 'now', 'now')`,
    ).run()).toThrow()
    expect(() => db.prepare(
      `INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
       VALUES ('NVDA!', 'Equity', 'owner', '{}', 'now', 'now')`,
    ).run()).toThrow()
    expect(() => db.prepare(
      `INSERT INTO internal_watchlist_items
        (symbol, instrument_type, origin, metadata_json, created_at, updated_at)
       VALUES ('NVDA', 'Equity Option', 'owner', '{}', 'now', 'now')`,
    ).run()).toThrow()
    expect(() => db.prepare(
      `UPDATE internal_watchlist_items SET symbol = 'SPY!' WHERE symbol = 'SPY'`,
    ).run()).toThrow()
    expect(() => db.prepare(
      `UPDATE internal_watchlist_items SET instrument_type = 'Equity Option' WHERE symbol = 'SPY'`,
    ).run()).toThrow()
    db.close()
  })

  it('stores typed tastytrade Equity fields and normalized tick tiers without raw JSON', async () => {
    const migration = await read('0008_instrument_catalog.sql')
    const resolution = await read('0009_instrument_catalog_resolution.sql')
    const db = new DatabaseSync(':memory:')
    db.exec(migration)
    db.exec(resolution)

    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'instrument_%' ORDER BY name",
    ).all()).toEqual([
      { name: 'instrument_catalog' },
      { name: 'instrument_tick_sizes' },
    ])
    expect(db.prepare('PRAGMA table_info(instrument_catalog)').all().map((column) => column.name))
      .not.toContain('raw_json')
    expect(db.prepare('PRAGMA table_info(instrument_catalog)').all().map((column) => column.name))
      .toEqual(expect.arrayContaining(['resolution_status', 'identity_source']))
    db.close()
  })

  it('splits source facts into constrained tables and composes only through views', async () => {
    const initial = await read('0001_spice.sql')
    const catalystDescription = await read('0004_catalyst_description.sql')
    const publicUniverse = await read('0003_public_market_universe.sql')
    const instrumentCatalog = await read('0008_instrument_catalog.sql')
    const instrumentResolution = await read('0009_instrument_catalog_resolution.sql')
    const sourceTables = await read('0010_source_specific_market_data.sql')
    const codexConfidence = await read('0012_codex_catalyst_confidence.sql')
    const retireSocial = await read('0019_retire_social_catalyst_tables.sql')
    const unifyCatalysts = await read('0020_unify_catalyst_store.sql')
    const retireCodexCatalysts = await read('0021_retire_codex_web_catalysts.sql')
    const db = new DatabaseSync(':memory:')
    db.exec(initial)
    db.exec(publicUniverse)
    db.exec(catalystDescription)
    db.exec(instrumentCatalog)
    db.exec(instrumentResolution)
    db.prepare(
      `INSERT INTO catalysts
        (id, symbol, kind, title, event_date, timing, confidence, source_name,
         source_url, updated_at, last_seen_at)
       VALUES (
        'tastytrade:NVDA:earnings', 'NVDA', 'earnings', 'NVDA earnings', '2026-11-01',
        'after-hours', 'estimated', 'tastytrade market metrics', 'https://example.com', 'now', 'now'
       )`,
    ).run()

    db.exec(sourceTables)

    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'catalysts'").get())
      .toBeUndefined()
    expect(db.prepare('SELECT id, source_label FROM tastytrade_catalysts').get()).toEqual({
      id: 'tastytrade:NVDA:earnings',
      source_label: 'tastytrade market metrics',
    })
    expect(() => db.prepare(
      `INSERT INTO x_catalysts
        (id, symbol, kind, title, description, event_date, timing, confidence,
         source_label, source_url, updated_at, last_seen_at)
       VALUES (
        'reddit:wrong-source', 'NVDA', 'conference', 'Event', 'Description', '2026-11-01',
        'unknown', 'estimated', 'Reddit · r/wallstreetbets', 'https://example.com', 'now', 'now'
       )`,
    ).run()).toThrow()
    db.prepare(
      `INSERT INTO codex_web_catalysts
        (id, symbol, kind, title, description, event_date, timing, confidence,
         source_label, source_url, updated_at, last_seen_at)
       VALUES (
        'codex-web:NVDA:conference:legacy', 'NVDA', 'conference', 'Legacy event',
        'Legacy first-party research', '2026-11-02', 'unknown', 'confirmed',
        'Codex web · example.com', 'https://example.com/event', 'now', 'now'
       )`,
    ).run()

    db.exec(codexConfidence)

    expect(db.prepare(
      `SELECT confidence FROM codex_web_catalysts WHERE id = 'codex-web:NVDA:conference:legacy'`,
    ).get()).toEqual({ confidence: 'estimated' })
    expect(db.prepare(
      `SELECT confidence, source_provider FROM upcoming_catalysts
       WHERE id = 'codex-web:NVDA:conference:legacy'`,
    ).get()).toEqual({ confidence: 'estimated', source_provider: 'codex-web' })
    expect(() => db.prepare(
      `INSERT INTO codex_web_catalysts
        (id, symbol, kind, title, description, event_date, timing, confidence,
         source_label, source_url, updated_at, last_seen_at)
       VALUES (
        'codex-web:NVDA:conference:invalid', 'NVDA', 'conference', 'Invalid event',
        'Description', '2026-11-03', 'unknown', 'confirmed',
        'Codex web · example.com', 'https://example.com/invalid', 'now', 'now'
       )`,
    ).run()).toThrow()
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name").all())
      .toEqual(expect.arrayContaining([
        { name: 'public_market_overview' },
        { name: 'upcoming_catalysts' },
      ]))

    db.exec(retireSocial)

    // Storage no producer writes cannot be re-verified, so it stops being served.
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE name IN ('x_catalysts', 'reddit_catalysts')",
    ).all()).toEqual([])
    // What the one remaining research producer wrote is still public, unchanged.
    expect(db.prepare(
      `SELECT source_provider FROM upcoming_catalysts WHERE id = 'codex-web:NVDA:conference:legacy'`,
    ).get()).toEqual({ source_provider: 'codex-web' })

    db.exec(unifyCatalysts)

    // Both producers' rows survive the consolidation, and the view reads the same as before.
    expect(db.prepare(
      "SELECT source_provider FROM upcoming_catalysts ORDER BY id",
    ).all()).toEqual([{ source_provider: 'codex-web' }, { source_provider: 'tastytrade' }])
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE name IN ('tastytrade_catalysts', 'codex_web_catalysts')",
    ).all()).toEqual([])
    // A producer costs a value now, not a table — but a row still has to name the producer
    // that wrote it, so nothing lands that cannot be traced back and retracted.
    db.prepare(
      `INSERT INTO catalysts
        (id, source_provider, symbol, kind, title, description, event_date, timing,
         confidence, source_label, source_url, updated_at, last_seen_at)
       VALUES (
        'dan:NVDA:conference:2026-11-04', 'dan', 'NVDA', 'conference', 'Recorded by Dan',
        'From a page Dan read', '2026-11-04', 'unknown', 'estimated',
        'https://example.com/dan', 'https://example.com/dan', 'now', 'now'
       )`,
    ).run()
    expect(() => db.prepare(
      `INSERT INTO catalysts
        (id, source_provider, symbol, kind, title, description, event_date, timing,
         confidence, source_label, source_url, updated_at, last_seen_at)
       VALUES (
        'codex-web:NVDA:conference:2026-11-05', 'dan', 'NVDA', 'conference', 'Mislabelled',
        'Claims a producer its id denies', '2026-11-05', 'unknown', 'estimated',
        'https://example.com/x', 'https://example.com/x', 'now', 'now'
       )`,
    ).run()).toThrow()

    db.exec(retireCodexCatalysts)

    expect(db.prepare(
      'SELECT source_provider FROM catalysts ORDER BY source_provider',
    ).all()).toEqual([{ source_provider: 'dan' }, { source_provider: 'tastytrade' }])
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'catalyst_research_runs'",
    ).get()).toBeUndefined()
    expect(() => db.prepare(
      `INSERT INTO catalysts
        (id, source_provider, symbol, kind, title, event_date, timing, confidence,
         source_label, source_url, updated_at, last_seen_at)
       VALUES (
        'codex-web:NVDA:conference:retired', 'codex-web', 'NVDA', 'conference', 'Retired',
        '2026-11-06', 'unknown', 'estimated', 'Retired', 'https://example.com', 'now', 'now'
       )`,
    ).run()).toThrow()
    db.close()
  })

  it('admits member-research catalysts by rebuilding the table, keeping every row and the view', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    for (const name of [
      '0001_spice.sql', '0003_public_market_universe.sql', '0004_catalyst_description.sql',
      '0008_instrument_catalog.sql', '0009_instrument_catalog_resolution.sql',
      '0010_source_specific_market_data.sql', '0012_codex_catalyst_confidence.sql',
      '0019_retire_social_catalyst_tables.sql', '0020_unify_catalyst_store.sql',
      '0021_retire_codex_web_catalysts.sql', '0024_exa_catalyst_runs.sql',
    ]) db.exec(await read(name))
    const insert = db.prepare(
      `INSERT INTO catalysts
        (id, source_provider, symbol, kind, title, description, event_date, timing,
         confidence, source_label, source_url, updated_at, last_seen_at)
       VALUES (?, ?, ?, 'conference', 'An event', 'Its detail', '2026-11-04', 'unknown',
               'estimated', 'A label', 'https://example.com/event', 'now', 'now')`,
    )
    insert.run('tastytrade:NVDA:earnings', 'tastytrade', 'NVDA')
    insert.run('daily-research:NVDA:conference:2026-11-04', 'daily-research', 'NVDA')

    db.exec(await read('0038_member_research_catalysts.sql'))

    // Every producer's rows survive the rebuild, and the view reads exactly as it did.
    expect(db.prepare('SELECT id, source_provider FROM upcoming_catalysts ORDER BY id').all()).toEqual([
      { id: 'daily-research:NVDA:conference:2026-11-04', source_provider: 'daily-research' },
      { id: 'tastytrade:NVDA:earnings', source_provider: 'tastytrade' },
    ])
    expect(db.prepare('PRAGMA table_info(upcoming_catalysts)').all().map((column) => column.name))
      .toEqual([
        'id', 'symbol', 'kind', 'title', 'description', 'event_date', 'timing', 'confidence',
        'source_label', 'source_url', 'updated_at', 'last_seen_at', 'source_provider',
      ])
    // The read every symbol lookup makes keeps its index.
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'catalysts' AND name NOT LIKE 'sqlite_%'",
    ).all()).toEqual([{ name: 'catalysts_symbol_event_date' }])

    // The new producer is admitted, and still only under an id that names it.
    expect(() => insert.run('member-research:NVDA:conference:2026-11-04', 'member-research', 'NVDA')).not.toThrow()
    expect(() => insert.run('daily-research:TSLA:conference:2026-11-05', 'member-research', 'TSLA')).toThrow()
    // And nothing else: a producer costs a migration, which is what keeps a row retractable.
    expect(() => insert.run('some-agent:TSLA:conference:2026-11-06', 'some-agent', 'TSLA')).toThrow()
    db.close()
  })

  it('keeps an evidence card inside its rendering bounds and private to its recorder', async () => {
    const db = new DatabaseSync(':memory:')
    db.exec('PRAGMA foreign_keys = ON')
    db.exec(await read('0001_spice.sql'))
    db.exec(await read('0039_symbol_evidence.sql'))
    db.prepare(
      `INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt")
       VALUES ('member-1', 'Member', 'member@example.com', 1, 'now', 'now')`,
    ).run()
    const insert = db.prepare(
      `INSERT INTO symbol_evidence
        (id, symbol, quote, note, source_url, source_title, byline, recorded_at, recorded_by_user_id)
       VALUES (?, ?, ?, ?, ?, 'A title', ?, 'now', 'member-1')`,
    )

    expect(() => insert.run('member-evidence:one', 'NVDA', 'A quote', null, 'https://example.com/a', null))
      .not.toThrow()
    expect(db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'symbol_evidence' AND name NOT LIKE 'sqlite_%'",
    ).all()).toEqual([{ name: 'symbol_evidence_symbol_recorded_at' }])

    // A card the reader could not read is not a card: every bound is the store's last word.
    expect(() => insert.run('member-evidence:lowercase', 'nvda', 'A quote', null, 'https://example.com/b', null)).toThrow()
    expect(() => insert.run('member-evidence:http', 'NVDA', 'A quote', null, 'http://example.com/b', null)).toThrow()
    expect(() => insert.run('member-evidence:long-quote', 'NVDA', 'q'.repeat(301), null, 'https://example.com/c', null)).toThrow()
    expect(() => insert.run('member-evidence:long-note', 'NVDA', 'A quote', 'n'.repeat(241), 'https://example.com/d', null)).toThrow()
    expect(() => insert.run('member-evidence:long-byline', 'NVDA', 'A quote', null, 'https://example.com/e', 'b'.repeat(41))).toThrow()
    expect(() => insert.run('member-evidence:empty-note', 'NVDA', 'A quote', '', 'https://example.com/f', null)).toThrow()

    // The recorder is account-derived, so the card goes when the account does.
    db.prepare(`DELETE FROM "user" WHERE "id" = 'member-1'`).run()
    expect(db.prepare('SELECT count(*) AS count FROM symbol_evidence').get()).toEqual({ count: 0 })
    db.close()
  })
})
