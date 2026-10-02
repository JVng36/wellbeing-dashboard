import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/server/db.js';
import { createSnapshot, restoreSnapshot } from '../../src/server/backup.js';
import { sha256 } from '../../src/server/util.js';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('startup, migration, demo, and restore regression contracts', () => {
  it('refuses a newer database schema version before serving it', () => {
    const dir = join(tmpdir(), `wellbeing-newer-schema-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir);
    const db = openDatabase(dir); db.close();
    const raw = new DatabaseSync(join(dir, 'wellbeing.sqlite')); raw.prepare("INSERT INTO schema_migrations(version,name,applied_at_utc,checksum) VALUES(999,'future.sql',datetime('now'),'future')").run(); raw.close();
    expect(() => openDatabase(dir)).toThrow(/newer database version|newer than this application supports/i);
  });

  it('upgrades a synthetic database frozen after migration 001 through all current migrations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-prior-migration-')); dirs.push(dir);
    const raw = new DatabaseSync(join(dir, 'wellbeing.sqlite'));
    raw.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at_utc TEXT NOT NULL)');
    raw.exec(await readFile(join(process.cwd(), 'migrations/001_initial.sql'), 'utf8'));
    raw.prepare("INSERT INTO schema_migrations(version,name,applied_at_utc) VALUES(1,'001_initial.sql',datetime('now'))").run(); raw.close();
    const upgraded = openDatabase(dir);
    expect((upgraded.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version).toBe(6);
    expect((upgraded.prepare("SELECT name FROM pragma_table_info('events') WHERE name='source_reference'").get() as { name: string }).name).toBe('source_reference');
    upgraded.close();
  });

  it('upgrades every supported prior migration with representative data intact', async () => {
    const migrationNames = ['001_initial.sql','002_integrity.sql','003_single_owner.sql','004_source_reference.sql','005_session_revisions.sql','006_revision_immutability.sql'];
    for (let prior = 1; prior < migrationNames.length; prior += 1) {
      const dir = await mkdtemp(join(tmpdir(), `wellbeing-prior-${prior}-`)); dirs.push(dir); const path = join(dir, 'wellbeing.sqlite'); const raw = new DatabaseSync(path);
      raw.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at_utc TEXT NOT NULL)');
      for (let version = 1; version <= prior; version += 1) { const name = migrationNames[version - 1]; raw.exec(await readFile(join(process.cwd(), 'migrations', name), 'utf8')); if (version === 1) raw.prepare('INSERT INTO schema_migrations(version,name,applied_at_utc) VALUES(?,?,?)').run(version, name, new Date().toISOString()); else raw.prepare('INSERT INTO schema_migrations(version,name,applied_at_utc,checksum) VALUES(?,?,?,?)').run(version, name, new Date().toISOString(), sha256(await readFile(join(process.cwd(), 'migrations', name), 'utf8'))); }
      raw.prepare("INSERT INTO events(id,event_type,local_date,timezone,duration_minutes,created_at_utc,updated_at_utc,current_revision,actor_id) VALUES('prior-event','sleep_duration','2026-01-01','UTC',420,?,?,1,'synthetic-prior')").run(new Date().toISOString(), new Date().toISOString()); raw.close();
      const upgraded = openDatabase(dir); expect((upgraded.prepare("SELECT duration_minutes FROM events WHERE id='prior-event'").get() as {duration_minutes:number}).duration_minutes).toBe(420); upgraded.close();
    }
  });

  it('refuses demo seeding without the explicit synthetic confirmation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-demo-refusal-')); dirs.push(dir);
    const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/server/demo-seed.ts'], { cwd: process.cwd(), env: { ...process.env, WELLBEING_DATA_DIR: dir, WELLBEING_DEMO_CONFIRM: '' }, encoding: 'utf8' });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).toMatch(/SYNTHETIC_ONLY/);
  });

  it('rejects traversal-like snapshot targets and source/target symlinks', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'wellbeing-restore-source-')); dirs.push(sourceDir);
    const db = openDatabase(sourceDir); const snapshot = await createSnapshot(db, sourceDir, 'synthetic'); db.close();
    const target = await mkdtemp(join(tmpdir(), 'wellbeing-restore-target-')); dirs.push(target);
    await expect(restoreSnapshot(join(sourceDir, 'backups', '..', 'wellbeing.sqlite'), target)).rejects.toThrow(/manifest|snapshot|unintended/i);
    const sourceLinkDir = await mkdtemp(join(tmpdir(), 'wellbeing-restore-source-link-')); dirs.push(sourceLinkDir);
    const sourceLink = join(sourceLinkDir, 'linked.sqlite'); await symlink(snapshot, sourceLink);
    await expect(restoreSnapshot(sourceLink, target)).rejects.toThrow(/symlink/i);
    const manifestPath = `${snapshot}.manifest.json`; const manifestCopy = join(sourceDir, 'manifest-copy.json'); await writeFile(manifestCopy, await readFile(manifestPath)); await unlink(manifestPath); await symlink(manifestCopy, manifestPath);
    await expect(restoreSnapshot(snapshot, target)).rejects.toThrow(/manifest.*symlink|symlink/i);
    await unlink(manifestPath); await writeFile(manifestPath, await readFile(manifestCopy));
    const targetLinkDir = await mkdtemp(join(tmpdir(), 'wellbeing-restore-target-link-')); dirs.push(targetLinkDir);
    await symlink(join(sourceDir, 'wellbeing.sqlite'), join(targetLinkDir, 'wellbeing.sqlite'));
    await expect(restoreSnapshot(snapshot, targetLinkDir)).rejects.toThrow(/symlink/i);
    const raceTarget = await mkdtemp(join(tmpdir(), 'wellbeing-restore-race-target-')); dirs.push(raceTarget);
    await mkdir(join(raceTarget, 'wellbeing.sqlite'));
    await expect(restoreSnapshot(snapshot, raceTarget)).rejects.toThrow(/non-empty|target|directory/i);
    expect((await readdir(raceTarget)).sort()).toEqual(['wellbeing.sqlite']);
    const parentReal = await mkdtemp(join(tmpdir(), 'wellbeing-restore-parent-real-')); dirs.push(parentReal); const parentLink = join(tmpdir(), `wellbeing-restore-parent-link-${Date.now()}-${Math.random().toString(16).slice(2)}`); await symlink(parentReal, parentLink); dirs.push(parentLink);
    await expect(restoreSnapshot(snapshot, join(parentLink, 'new-data'))).rejects.toThrow(/symlink|external/i);
  });

  it('refuses a target created after the empty-directory check without overwriting its sentinel', async () => {
    const sourceDir = await mkdtemp(join(tmpdir(), 'wellbeing-restore-hook-source-')); dirs.push(sourceDir); const db = openDatabase(sourceDir); const snapshot = await createSnapshot(db, sourceDir, 'synthetic'); db.close();
    const target = await mkdtemp(join(tmpdir(), 'wellbeing-restore-hook-target-')); dirs.push(target); const sentinel = 'race sentinel';
    await expect(restoreSnapshot(snapshot, target, { beforeExclusiveCopy: async () => { await writeFile(join(target, 'wellbeing.sqlite'), sentinel, { flag: 'wx' }); } } as any)).rejects.toThrow(/exist|overwrite|target/i);
    expect(await readFile(join(target, 'wellbeing.sqlite'), 'utf8')).toBe(sentinel);
  });
});
