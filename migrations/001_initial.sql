PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS owners (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS assistant_credentials (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES owners(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes_json TEXT NOT NULL,
  expires_at_utc TEXT NOT NULL,
  revoked_at_utc TEXT,
  created_at_utc TEXT NOT NULL,
  last_used_at_utc TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK(kind IN ('overnight','nap')),
  local_date TEXT,
  timezone TEXT NOT NULL,
  provenance TEXT NOT NULL CHECK(provenance IN ('explicit','bounded_16h_pair')),
  created_at_utc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  event_type TEXT,
  start_at_local TEXT,
  end_at_local TEXT,
  local_date TEXT,
  timezone TEXT,
  local_offset TEXT,
  end_local_offset TEXT,
  duration_minutes INTEGER,
  numeric_value REAL,
  reported_at_utc TEXT,
  source TEXT,
  confidence TEXT,
  notes TEXT,
  source_message_id TEXT,
  supersedes_event_id TEXT REFERENCES events(id),
  created_at_utc TEXT,
  updated_at_utc TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id),
  pairing_provenance TEXT,
  uncertainty_json TEXT,
  metric_overrides_json TEXT,
  legacy_unknown_json TEXT,
  raw_legacy TEXT,
  raw_legacy_sha256 TEXT,
  current_revision INTEGER NOT NULL DEFAULT 1,
  actor_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_date_idx ON events(local_date);
CREATE INDEX IF NOT EXISTS events_session_idx ON events(session_id);
CREATE INDEX IF NOT EXISTS events_supersedes_idx ON events(supersedes_event_id);

CREATE TABLE IF NOT EXISTS event_revisions (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT,
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY(event_id, revision)
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  body TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id),
  range_start TEXT,
  range_end TEXT,
  current_revision INTEGER NOT NULL DEFAULT 1,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  actor_id TEXT
);
CREATE TABLE IF NOT EXISTS note_revisions (
  note_id TEXT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY(note_id, revision)
);

CREATE TABLE IF NOT EXISTS summaries (
  id TEXT PRIMARY KEY,
  window_days INTEGER NOT NULL,
  generated_at_utc TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  source_revision_refs_json TEXT NOT NULL,
  stale_at_utc TEXT
);

CREATE TABLE IF NOT EXISTS idempotency (
  actor_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  status_code INTEGER NOT NULL,
  response_json TEXT NOT NULL,
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY(actor_id, operation, key)
);

CREATE TABLE IF NOT EXISTS legacy_import_files (
  name TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  imported_at_utc TEXT NOT NULL,
  PRIMARY KEY(name, sha256)
);
