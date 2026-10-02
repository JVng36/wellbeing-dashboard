import { resolve } from 'node:path';
import { openDatabase } from './db.js';
import { createSnapshot, restoreSnapshot } from './backup.js';
import { defaultDataDir, validateExternalDataDir } from './config.js';

const [command, value] = process.argv.slice(2);
const dataDir = validateExternalDataDir(process.env.WELLBEING_DATA_DIR ?? defaultDataDir());
if (command === 'create') {
  const db = openDatabase(dataDir);
  try { process.stdout.write(await createSnapshot(db, dataDir, value) + '\n'); } finally { db.close(); }
} else if (command === 'restore' && value) {
  await restoreSnapshot(value, dataDir);
  process.stdout.write('Snapshot restored.\n');
} else throw new Error('usage: npm run backup -- create [label] | restore path/to/snapshot.sqlite');
