-- Keep the claim identity separate from the failure instant: slow failures still get a full
-- retry backoff. Existing failed receipts predate this field and retain their original hold.
ALTER TABLE catalyst_runs ADD COLUMN failed_at TEXT;
