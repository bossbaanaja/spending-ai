-- A separate identity survives ordinary edits, but never deletion/reinsertion.
CREATE TABLE IF NOT EXISTS transaction_versions (
  tx_id INTEGER PRIMARY KEY REFERENCES transactions(id) ON DELETE CASCADE,
  identity TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
  revision INTEGER NOT NULL DEFAULT 0,
  split_token TEXT
);
-- One sender per message. Unfinished refreshes are recovered by the minute cron.
CREATE TABLE IF NOT EXISTS transaction_card_jobs (
  chat_id INTEGER NOT NULL,
  message_id INTEGER NOT NULL,
  tx_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  identity TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  completed_generation INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (chat_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_transaction_cards_tx ON transaction_card_jobs(tx_id, identity);
CREATE INDEX IF NOT EXISTS idx_transaction_cards_pending ON transaction_card_jobs(next_run_at, lease_until)
  WHERE generation > completed_generation AND attempts < 5;
CREATE TRIGGER IF NOT EXISTS transaction_version_insert AFTER INSERT ON transactions BEGIN
  INSERT INTO transaction_versions (tx_id) VALUES (NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS transaction_version_update AFTER UPDATE ON transactions BEGIN
  UPDATE transaction_versions SET revision = revision + 1, split_token = NULL WHERE tx_id = NEW.id;
  UPDATE transaction_card_jobs SET generation = generation + 1, attempts = 0, next_run_at = 0
    WHERE tx_id = NEW.id AND identity = (SELECT identity FROM transaction_versions WHERE tx_id = NEW.id);
END;
CREATE TRIGGER IF NOT EXISTS transaction_version_delete AFTER DELETE ON transactions BEGIN
  UPDATE transaction_card_jobs SET generation = generation + 1, attempts = 0, next_run_at = 0 WHERE tx_id = OLD.id;
  DELETE FROM transaction_versions WHERE tx_id = OLD.id;
END;

-- Install triggers before backfilling so concurrent inserts from the old Worker are covered.
INSERT OR IGNORE INTO transaction_versions (tx_id) SELECT id FROM transactions;
