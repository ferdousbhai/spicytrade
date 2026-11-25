-- `broker_submissions` stops holding brokerage account numbers. A row is only ever matched to its
-- account, so it now stores `account_key`, a keyed hash of the broker and the number
-- (`src/server/broker-account-key.ts`), and the number never rests here.
--
-- The settled rows go first. Every order is a Day order, so a settled row is used only on the day
-- it was placed -- to rebuild a working order's shape for a price-only replacement, and to tell
-- this server's orders apart during reconciliation -- and a scheduled sweep now deletes them
-- after that. The rows here carry plain account numbers that the new lookups would never match.
-- An unresolved row is a live quarantine and is not deleted; production held none when this was
-- written, and one written by the outgoing code in the moments before the deploy has no key and
-- would need settling by hand.
DELETE FROM broker_submissions WHERE status <> 'unresolved';

ALTER TABLE broker_submissions ADD COLUMN account_key TEXT;

-- The quarantine, per broker account as before.
CREATE UNIQUE INDEX broker_submissions_one_unresolved_per_account_key
  ON broker_submissions (broker_id, account_key)
  WHERE status = 'unresolved';

-- An account's own orders, by the broker's order id: replacement and reconciliation lookups.
CREATE INDEX broker_submissions_account_key_order
  ON broker_submissions (broker_id, account_key, provider_order_id)
  WHERE provider_order_id IS NOT NULL;

-- `account_number` and its indexes are left in place: the live deployment still reads them until
-- this code ships. Until they are dropped in a later push, the column holds the same key.
