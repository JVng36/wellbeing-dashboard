CREATE TRIGGER event_revisions_no_update BEFORE UPDATE ON event_revisions BEGIN SELECT RAISE(ABORT, 'event revisions are append-only'); END;
CREATE TRIGGER event_revisions_no_delete BEFORE DELETE ON event_revisions BEGIN SELECT RAISE(ABORT, 'event revisions are append-only'); END;
CREATE TRIGGER note_revisions_no_update BEFORE UPDATE ON note_revisions BEGIN SELECT RAISE(ABORT, 'note revisions are append-only'); END;
CREATE TRIGGER note_revisions_no_delete BEFORE DELETE ON note_revisions BEGIN SELECT RAISE(ABORT, 'note revisions are append-only'); END;
CREATE TRIGGER session_revisions_no_update BEFORE UPDATE ON session_revisions BEGIN SELECT RAISE(ABORT, 'session revisions are append-only'); END;
CREATE TRIGGER session_revisions_no_delete BEFORE DELETE ON session_revisions BEGIN SELECT RAISE(ABORT, 'session revisions are append-only'); END;
