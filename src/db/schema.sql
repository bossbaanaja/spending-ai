CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  telegram_id INTEGER UNIQUE NOT NULL,
  display_name TEXT,
  token TEXT NOT NULL,              -- invite/group token they registered with
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'THB',
  category TEXT NOT NULL,           -- Food, Transport, Shopping, Bills, Health, Entertainment, Transfer, Other
  note TEXT,                        -- the user's caption
  receiver TEXT,                    -- merchant/recipient from the slip
  bank TEXT,
  trans_ref TEXT UNIQUE,            -- dedup: same slip can't be logged twice
  slip_datetime TEXT,               -- when the transfer actually happened
  raw_json TEXT,                    -- full extraction, for auditing/reprocessing
  source_item_id TEXT UNIQUE,       -- user:media-group:message identity, independent of OCR
  created_at TEXT DEFAULT (datetime('now')),
  -- Split bookkeeping, all NULL on an ordinary entry. Added after launch, so
  -- existing databases need the matching ALTER TABLE statements (see CLAUDE.md).
  split_kind TEXT CHECK (split_kind IN ('people', 'month')),
  split_group TEXT,                 -- shared id linking the parts of one month-split
  split_part INTEGER,               -- 1..split_total
  split_total INTEGER,
  original_amount REAL              -- amount before the split, for undo
);
CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions(user_id, slip_datetime);
CREATE INDEX IF NOT EXISTS idx_tx_split_group ON transactions(split_group);

CREATE TABLE IF NOT EXISTS pending_slips (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  file_id TEXT NOT NULL,            -- Telegram file_id, in case detail arrives later and re-download is needed
  parsed_json TEXT NOT NULL,        -- OCR result awaiting the user's "what was this for" reply
  created_at TEXT DEFAULT (datetime('now'))
);

-- ---------- photo albums (multi-slip intake) ----------
-- Telegram delivers an album as one webhook update per photo, all sharing a
-- media_group_id. These two tables are how those independent updates find each
-- other: the UNIQUE key below is the leader election (exactly one update can
-- insert the batch row; the rest register their photo and exit).
CREATE TABLE IF NOT EXISTS slip_batches (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  media_group_id TEXT NOT NULL,
  chat_id INTEGER NOT NULL,
  status_message_id INTEGER,        -- the single status bubble, later edited into the summary
  ask_message_id INTEGER,           -- the "slip n of N — what was this for?" prompt, edited in place
  caption TEXT,                     -- album caption; Telegram attaches it to one photo only
  state TEXT NOT NULL DEFAULT 'collecting'
    CHECK (state IN ('collecting', 'awaiting_note', 'asking', 'done')),
  ask_index INTEGER NOT NULL DEFAULT 0,  -- cursor for the per-slip note walk
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (user_id, media_group_id)
);
CREATE INDEX IF NOT EXISTS idx_batch_user_state ON slip_batches(user_id, state);

CREATE TABLE IF NOT EXISTS slip_batch_items (
  id INTEGER PRIMARY KEY,
  batch_id INTEGER NOT NULL REFERENCES slip_batches(id),
  message_id INTEGER NOT NULL,      -- ordering key: monotonic per chat, unlike arrival order
  file_id TEXT NOT NULL,
  parsed_json TEXT,                 -- filled once the slip is read; NULL while queued
  outcome TEXT NOT NULL DEFAULT 'queued'
    CHECK (outcome IN ('queued', 'saved', 'duplicate', 'failed', 'skipped')),
  tx_id INTEGER,                    -- the transactions row, once saved
  note TEXT,
  UNIQUE (batch_id, message_id)     -- a redelivered update can't register the same photo twice
);
CREATE INDEX IF NOT EXISTS idx_batch_items_batch ON slip_batch_items(batch_id, message_id);

-- ---------- pending splits (custom amount) ----------
-- Holds the split state while we wait for the user to type how much their share was.
-- One pending split per user at a time.
CREATE TABLE IF NOT EXISTS pending_splits (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  tx_id INTEGER NOT NULL REFERENCES transactions(id),
  message_id INTEGER,               -- the split prompt message, so we can edit it in place
  created_at TEXT DEFAULT (datetime('now')),
  UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS idx_pending_splits_user ON pending_splits(user_id);

-- Durable album scheduling. desired_version > completed_version is an outbox
-- entry: cron republishes it even if a queue send or worker dies.
CREATE TABLE IF NOT EXISTS album_jobs (
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
CREATE TABLE IF NOT EXISTS album_item_work (
  item_id INTEGER PRIMARY KEY REFERENCES slip_batch_items(id),
  ocr_text TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
-- A receipt survives deletion of its transaction, so replay cannot resurrect
-- an expense the user deliberately deleted. Pruned with its album.
CREATE TABLE IF NOT EXISTS album_receipts (
  item_id INTEGER PRIMARY KEY REFERENCES slip_batch_items(id),
  tx_id INTEGER,
  outcome TEXT NOT NULL CHECK (outcome IN ('saved', 'duplicate'))
);
CREATE TABLE IF NOT EXISTS active_questions (
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('album', 'single', 'none')),
  target_id INTEGER,
  generation INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0
);
