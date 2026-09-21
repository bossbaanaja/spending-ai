-- Existing installations only. Apply once using D1 migrations, before the new
-- worker. New installations use schema.sql (which already includes this column).
ALTER TABLE transactions ADD COLUMN source_item_id TEXT;
CREATE UNIQUE INDEX idx_tx_source_item ON transactions(source_item_id);

CREATE TABLE album_jobs (
  batch_id INTEGER PRIMARY KEY REFERENCES slip_batches(id),
  desired_version INTEGER NOT NULL DEFAULT 1,
  completed_version INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER NOT NULL DEFAULT 0,
  next_run_at INTEGER NOT NULL DEFAULT 0,
  last_arrival_at INTEGER NOT NULL DEFAULT 0,
  accepted_note TEXT,
  note_mode TEXT CHECK (note_mode IN ('shared', 'each')),
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE TABLE album_item_work (
  item_id INTEGER PRIMARY KEY REFERENCES slip_batch_items(id),
  ocr_text TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE TABLE album_receipts (
  item_id INTEGER PRIMARY KEY REFERENCES slip_batch_items(id),
  tx_id INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('saved', 'duplicate'))
);
CREATE TABLE active_questions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('album', 'single', 'none')),
  target_id INTEGER,
  generation INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
