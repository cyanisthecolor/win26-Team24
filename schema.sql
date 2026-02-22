-- schema.sql (fresh schema; recommended if you're starting a new DB)

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sync_state (
  source TEXT PRIMARY KEY,
  last_rowid INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  thread_key TEXT NOT NULL,
  display_name TEXT,
  UNIQUE(source, thread_key)
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,

  -- Gmail message id (or equivalent unique ID for other sources)
  source_msg_key TEXT NOT NULL,

  -- Gmail internalDate (ms); good for ordering + cursors but NOT guaranteed unique
  source_rowid INTEGER NOT NULL,

  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender TEXT,
  is_from_me INTEGER NOT NULL,
  sent_at_utc TEXT NOT NULL,
  text TEXT,

  UNIQUE(source, source_msg_key)
);

CREATE TABLE IF NOT EXISTS extracted_dates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  raw_span TEXT NOT NULL,
  parsed_at_utc TEXT NOT NULL,
  confidence REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Resolved absolute date from raw_span
  resolved_date TEXT
);

CREATE TABLE IF NOT EXISTS extracted_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  url TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS extracted_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT,
  mime_type TEXT,
  original_path TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Helpful indexes once the DB grows
CREATE INDEX IF NOT EXISTS idx_messages_source_rowid ON messages(source, source_rowid);
CREATE INDEX IF NOT EXISTS idx_messages_conversation_id ON messages(conversation_id);
CREATE INDEX IF NOT EXISTS idx_extracted_dates_message_id ON extracted_dates(message_id);
CREATE INDEX IF NOT EXISTS idx_extracted_links_message_id ON extracted_links(message_id);
CREATE INDEX IF NOT EXISTS idx_extracted_attachments_message_id ON extracted_attachments(message_id);