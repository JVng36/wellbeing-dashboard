import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from './util.js';

const activePaths = new Set<string>();
export function isDatabaseActive(path: string): boolean { return activePaths.has(resolve(path)); }

export type AppDatabase = DatabaseSync & { path: string };

export function openDatabase(dataDir: string): AppDatabase {
  const resolvedDir = resolve(dataDir);
  mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
  const dbPath = join(resolvedDir, 'wellbeing.sqlite');
  const db = new DatabaseSync(dbPath) as AppDatabase;
  Object.defineProperty(db, 'path', { value: dbPath });
  activePaths.add(dbPath);
  const originalClose = db.close.bind(db);
  db.close = (() => { activePaths.delete(dbPath); originalClose(); }) as typeof db.close;
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at_utc TEXT NOT NULL)');
  const migrationDir = resolve(process.cwd(), 'migrations');
  const migrations = readdirSync(migrationDir).filter((x) => /^\d+.*\.sql$/.test(x)).sort();
  const sourceVersions = migrations.map((name) => Number(name.match(/^\d+/)![0]));
  const databaseVersion = Number((db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get() as { version: number }).version);
  if (databaseVersion > Math.max(0, ...sourceVersions)) { db.close(); throw new Error(`database schema version ${databaseVersion} is newer than this application supports`); }
  for (const name of migrations) {
    const version = Number(name.match(/^\d+/)![0]);
    const sql = readFileSync(join(migrationDir, name), 'utf8');
    const checksum = sha256(sql);
    const prior = db.prepare('SELECT * FROM schema_migrations WHERE version=?').get(version) as { name: string; checksum?: string | null } | undefined;
    if (prior) {
      if (prior.name !== name) { db.close(); throw new Error(`applied migration ${version} name has changed`); }
      if (prior.checksum && prior.checksum !== checksum) { db.close(); throw new Error(`applied migration ${version} checksum has changed`); }
      continue;
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(sql);
      const hasChecksum = (db.prepare('PRAGMA table_info(schema_migrations)').all() as { name: string }[]).some((column) => column.name === 'checksum');
      if (hasChecksum) db.prepare('INSERT INTO schema_migrations(version,name,applied_at_utc,checksum) VALUES(?,?,?,?)').run(version, name, new Date().toISOString(), checksum);
      else db.prepare('INSERT INTO schema_migrations(version,name,applied_at_utc) VALUES(?,?,?)').run(version, name, new Date().toISOString());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const hasChecksum = (db.prepare('PRAGMA table_info(schema_migrations)').all() as { name: string }[]).some((column) => column.name === 'checksum');
  if (hasChecksum) for (const name of migrations) db.prepare('UPDATE schema_migrations SET checksum=? WHERE version=? AND checksum IS NULL').run(sha256(readFileSync(join(migrationDir, name), 'utf8')), Number(name.match(/^\d+/)![0]));
  return db;
}
