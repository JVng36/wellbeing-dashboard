ALTER TABLE sessions ADD COLUMN current_revision INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sessions ADD COLUMN updated_at_utc TEXT;
ALTER TABLE sessions ADD COLUMN actor_id TEXT;
UPDATE sessions SET updated_at_utc = created_at_utc WHERE updated_at_utc IS NULL;
CREATE TABLE session_revisions (
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT,
  created_at_utc TEXT NOT NULL,
  PRIMARY KEY(session_id, revision)
);
