import { backup } from 'node:sqlite';
import { chmod, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { AppDatabase } from './db.js';
import { isDatabaseActive } from './db.js';
import { sha256 } from './util.js';
import { validateExternalDataDir } from './config.js';

export async function createSnapshot(db: AppDatabase, dataDir: string, label = 'snapshot'): Promise<string> {
  dataDir = validateExternalDataDir(dataDir);
  const safe = label.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 50) || 'snapshot';
  const directory = join(resolve(dataDir), 'backups');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${new Date().toISOString().replace(/[:.]/g, '-')}-${safe}.sqlite`);
  await backup(db, target);
  await chmod(target, 0o600);
  const snapshot = await readFile(target);
  const check = new DatabaseSync(target, { readOnly: true });
  try { const result = check.prepare('PRAGMA integrity_check').get() as Record<string, string>; if (Object.values(result)[0] !== 'ok') throw new Error('backup integrity check failed'); } finally { check.close(); }
  const schemaVersion = Number((db.prepare('SELECT COALESCE(MAX(version),0) AS version FROM schema_migrations').get() as { version: number }).version);
  await writeFile(`${target}.manifest.json`, `${JSON.stringify({ formatVersion: 1, appVersion: '0.1.0', schemaVersion, createdAtUtc: new Date().toISOString(), file: basename(target), sha256: sha256(snapshot) }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return target;
}

export interface RestoreHooks { beforeExclusiveCopy?: () => Promise<void> | void }

export async function restoreSnapshot(snapshotPath: string, dataDir: string, hooks: RestoreHooks = {}): Promise<void> {
  const source = resolve(snapshotPath); const dir = validateExternalDataDir(resolve(dataDir)); const target = join(dir, 'wellbeing.sqlite');
  validateExternalDataDir(dirname(source));
  if (basename(source).startsWith('.') || !source.endsWith('.sqlite') || dirname(source) === dir) throw new Error('refusing unintended snapshot target');
  try { if ((await lstat(source)).isSymbolicLink()) throw new Error('snapshot path must not be a symlink'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('snapshot does not exist'); throw error; }
  const manifestPath = `${source}.manifest.json`;
  let manifest: { formatVersion: number; schemaVersion: number; file: string; sha256: string };
  try { if ((await lstat(manifestPath)).isSymbolicLink()) throw new Error('snapshot manifest must not be a symlink'); manifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch (error) { if (error instanceof Error && error.message.includes('symlink')) throw error; throw new Error('snapshot manifest is missing or invalid'); }
  if (manifest.formatVersion !== 1 || manifest.file !== basename(source) || !/^[a-f0-9]{64}$/.test(manifest.sha256)) throw new Error('snapshot manifest is invalid');
  const sourceBytes = await readFile(source);
  if (sha256(sourceBytes) !== manifest.sha256) throw new Error('snapshot checksum does not match its manifest');
  const sourceDb = new DatabaseSync(source, { readOnly: true });
  try {
    const result = sourceDb.prepare('PRAGMA integrity_check').get() as Record<string, string>; if (Object.values(result)[0] !== 'ok') throw new Error('snapshot integrity check failed');
    const version = Number((sourceDb.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as { version: number }).version);
    if (version !== manifest.schemaVersion) throw new Error('snapshot schema version does not match its manifest');
  } finally { sourceDb.close(); }
  if (isDatabaseActive(target) || await isMarkedActive(dir)) throw new Error('refusing to overwrite an active database');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    let entries = await readdir(dir);
    if (entries.length === 1 && entries[0] === 'service.active' && !(await isMarkedActive(dir))) { await unlink(join(dir, 'service.active')); entries = []; }
    if (!entries.length) { /* empty target */ }
    else if (entries.length === 1 && entries[0] === 'wellbeing.sqlite') {
      if ((await lstat(target)).isSymbolicLink()) throw new Error('restore target must not be a symlink');
      const [a, b] = await Promise.all([readFile(source), readFile(target)]);
      if (sha256(a) === sha256(b)) return;
      throw new Error('refusing to overwrite non-empty target; restore into an empty data directory');
    } else throw new Error('refusing to restore into an unintended non-empty directory');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await hooks.beforeExclusiveCopy?.();
  await writeFile(target, sourceBytes, { flag: 'wx', mode: 0o600 });
  await chmod(target, 0o600);
}

async function isMarkedActive(dir: string): Promise<boolean> {
  const marker = join(dir, 'service.active');
  try {
    const pid = Number(JSON.parse(await readFile(marker, 'utf8')).pid);
    try { process.kill(pid, 0); return true; } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
      return true;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; return true; }
}
