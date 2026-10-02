ALTER TABLE schema_migrations ADD COLUMN checksum TEXT;
ALTER TABLE legacy_import_files ADD COLUMN event_id TEXT;
ALTER TABLE legacy_import_files ADD COLUMN importer_version TEXT;
CREATE UNIQUE INDEX legacy_import_event_idx ON legacy_import_files(event_id);
