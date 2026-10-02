import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/server/db.js';
import { importLegacyFiles } from '../../src/server/importer.js';
import { createSnapshot, restoreSnapshot } from '../../src/server/backup.js';

describe('legacy import and snapshots', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); });
  it('roundtrips every legacy field, is idempotent, and rolls back failures', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-import-')); dirs.push(dir);
    const db = openDatabase(dir);
    const raw = `---\nid: opaque-x\nevent_type: correction\nstart_at_local: 2025-01-02 01:30\nend_at_local: null\nlocal_date: 2025-01-02\ntimezone: UTC\nduration_minutes: null\nnumeric_value: null\nreported_at_utc: 2025-01-02T08:00:00Z\nsource: old_custom_source\nconfidence: low\nnotes: synthetic\nsource_message_id: "0007"\nsupersedes_event_id: opaque-y\ncreated_at_utc: 2025-01-02T08:00:01Z\nunknown_field: 2025-01-02\n---\nBody text.\n`;
    const base = `---\nid: opaque-y\nevent_type: duration_report\nlocal_date: 2025-01-02\ntimezone: UTC\nduration_minutes: 400\n---\n`;
    expect(importLegacyFiles(db, [{ name: 'a.md', content: raw }, { name: 'b.md', content: base }])).toEqual({ imported: 2, unchanged: 0 });
    expect(importLegacyFiles(db, [{ name: 'a.md', content: raw }, { name: 'b.md', content: base }])).toEqual({ imported: 0, unchanged: 2 });
    const row = db.prepare('SELECT * FROM events WHERE id=?').get('opaque-x') as Record<string, string | null>;
    expect(row.raw_legacy).toBe(raw);
    expect(row.source_message_id).toBe('0007');
    expect(row.legacy_unknown_json).toContain('unknown_field');
    expect(row.event_type).toBe('correction'); expect(row.start_at_local).toBe('2025-01-02 01:30'); expect(row.end_at_local).toBeNull();
    expect(row.local_date).toBe('2025-01-02'); expect(row.timezone).toBe('UTC'); expect(row.duration_minutes).toBeNull(); expect(row.numeric_value).toBeNull();
    expect(row.reported_at_utc).toBe('2025-01-02T08:00:00Z'); expect(row.source).toBe('old_custom_source'); expect(row.confidence).toBe('low'); expect(row.notes).toBe('synthetic'); expect(row.supersedes_event_id).toBe('opaque-y'); expect(row.created_at_utc).toBe('2025-01-02T08:00:01Z');
    expect(() => importLegacyFiles(db, [{ name: 'changed.md', content: raw.replace('notes: synthetic', 'notes: changed') }])).toThrow(/conflict/i);
    expect(() => importLegacyFiles(db, [{ name: 'bad.md', content: base.replace('opaque-y', 'new').replace('duration_report', 'correction') }])).toThrow(/dangling/i);
    const cycleA = `---\nid: cycle-a\nevent_type: correction\nsupersedes_event_id: cycle-b\n---\n`;
    const cycleB = `---\nid: cycle-b\nevent_type: correction\nsupersedes_event_id: cycle-a\n---\n`;
    expect(() => importLegacyFiles(db, [{name:'cycle-a.md',content:cycleA},{name:'cycle-b.md',content:cycleB}])).toThrow(/cycle/i);
    expect((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n).toBe(2);
    db.close();
  });

  it('accepts event_id fixtures, preserves body sections and rejects changed migrations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-fixture-import-')); dirs.push(dir);
    const db = openDatabase(dir);
    const base = await readFile(join(process.cwd(), 'fixtures/legacy-import/synthetic-base.md'), 'utf8');
    const correction = await readFile(join(process.cwd(), 'fixtures/legacy-import/synthetic-correction.md'), 'utf8');
    expect(importLegacyFiles(db, [{ name: 'synthetic-base.md', content: base }, { name: 'synthetic-correction.md', content: correction }])).toEqual({ imported: 2, unchanged: 0 });
    const row = db.prepare('SELECT * FROM events WHERE id=?').get('fixture-legacy-base') as Record<string, string>;
    const unknown = JSON.parse(row.legacy_unknown_json) as Record<string, unknown>;
    expect(row.source_message_id).toBe('0007');
    expect(unknown.future_field).toBe('preserved-synthetic-value');
    expect(unknown.observationBody).toMatch(/duration-only observation/);
    expect(unknown.provenanceBody).toMatch(/fictional/);
    expect(row.session_id).toBeNull();
    expect((db.prepare('SELECT count(*) AS n FROM event_revisions').get() as {n:number}).n).toBe(2);
    db.close();
    const raw = new DatabaseSync(join(dir, 'wellbeing.sqlite'));
    raw.prepare("UPDATE schema_migrations SET checksum='changed' WHERE version=1").run(); raw.close();
    expect(() => openDatabase(dir)).toThrow(/checksum has changed/);
  });

  it('restores semantic equality and refuses active/unintended targets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-backup-')); dirs.push(dir);
    const db = openDatabase(dir); db.prepare("INSERT INTO notes(id, body, created_at_utc, updated_at_utc) VALUES('n1','synthetic',datetime('now'),datetime('now'))").run();
    const snap = await createSnapshot(db, dir, 'fixture');
    const manifest = JSON.parse(await readFile(`${snap}.manifest.json`, 'utf8')) as Record<string, unknown>;
    expect(manifest).toMatchObject({ formatVersion: 1, appVersion: '0.1.0', schemaVersion: 6 });
    expect(String(manifest.sha256)).toMatch(/^[a-f0-9]{64}$/);
    await expect(restoreSnapshot(snap, dir)).rejects.toThrow(/active|non-empty/i);
    db.close();
    const fresh = await mkdtemp(join(tmpdir(), 'wellbeing-restore-')); dirs.push(fresh);
    await restoreSnapshot(snap, fresh);
    expect((await readFile(join(fresh, 'wellbeing.sqlite'))).byteLength).toBeGreaterThan(0);
    expect(await restoreSnapshot(snap, fresh)).toBeUndefined();
    const restored = openDatabase(fresh);
    expect((restored.prepare('SELECT body FROM notes WHERE id=?').get('n1') as {body:string}).body).toBe('synthetic');
    restored.close();
  });

  it('refuses tampered manifests and unrelated non-empty restore targets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-backup-guards-')); dirs.push(dir);
    const db = openDatabase(dir); const snap = await createSnapshot(db, dir, 'guard'); db.close();
    const manifestPath = `${snap}.manifest.json`; const original = await readFile(manifestPath, 'utf8');
    const { writeFile } = await import('node:fs/promises'); await writeFile(manifestPath, original.replace(/"sha256": "[a-f0-9]+"/, '"sha256": "' + '0'.repeat(64) + '"'));
    const checksumTarget = await mkdtemp(join(tmpdir(), 'wellbeing-backup-checksum-')); dirs.push(checksumTarget);
    await expect(restoreSnapshot(snap, checksumTarget)).rejects.toThrow(/checksum/);
    await writeFile(manifestPath, original);
    const target = await mkdtemp(join(tmpdir(), 'wellbeing-backup-target-')); dirs.push(target); await writeFile(join(target, 'unrelated.txt'), 'synthetic');
    await expect(restoreSnapshot(snap, target)).rejects.toThrow(/unintended non-empty/);
  });
});
