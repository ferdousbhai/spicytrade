-- The company name as search compares it: description and short description, accents removed
-- and upper-cased by `searchFold` in `src/domain/instrument.ts`. SQLite's `upper()` folds ASCII
-- only, so a search for `société` could never match a stored `Société`; the Worker folds both
-- sides instead. NULL until the row is next written by the catalog refresh, and search falls back
-- to the raw columns meanwhile.
ALTER TABLE instrument_catalog ADD COLUMN search_name TEXT
  CHECK (search_name IS NULL OR length(search_name) BETWEEN 1 AND 2048);
