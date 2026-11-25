-- The account number column `broker_submissions` no longer uses. Since 0056 a row is matched by
-- `account_key`, and the deployed code only wrote that same key here to satisfy NOT NULL. Its
-- indexes go first, since a column an index names cannot be dropped.
DROP INDEX broker_submissions_one_unresolved_per_account;
DROP INDEX broker_submissions_account_submitted_at;
ALTER TABLE broker_submissions DROP COLUMN account_number;
