import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { openDatabase } from './db.js';
import { importLegacyFiles } from './importer.js';
import { defaultDataDir, validateExternalDataDir } from './config.js';

const files = process.argv.slice(2);
if (!files.length) throw new Error('usage: npm run import:legacy -- record1.md [record2.md ...]');
const dataDir = validateExternalDataDir(process.env.WELLBEING_DATA_DIR ?? defaultDataDir());
const db = openDatabase(dataDir);
try {
  const input = await Promise.all(files.map(async (path) => ({ name: basename(path), content: await readFile(path, 'utf8') })));
  process.stdout.write(JSON.stringify(importLegacyFiles(db, input), null, 2) + '\n');
} finally { db.close(); }
