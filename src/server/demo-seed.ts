import { openDatabase } from './db.js';
import { createEvent } from './events.js';
import { defaultDataDir, validateExternalDataDir } from './config.js';

if (process.env.WELLBEING_DEMO_CONFIRM !== 'SYNTHETIC_ONLY') throw new Error('Set WELLBEING_DEMO_CONFIRM=SYNTHETIC_ONLY to opt in to synthetic demo records.');
const db = openDatabase(validateExternalDataDir(process.env.WELLBEING_DATA_DIR ?? defaultDataDir()));
try {
  if (db.prepare("SELECT 1 FROM events WHERE actor_id='synthetic-demo' LIMIT 1").get()) throw new Error('Synthetic demo records already exist.');
  createEvent(db, { id: 'demo_sleep_1', eventType: 'sleep_duration', localDate: '2025-01-14', timezone: 'UTC', durationMinutes: 425, source: 'user_reported', confidence: 'high', notes: 'Synthetic example: a settled night.' }, 'synthetic-demo');
  createEvent(db, { id: 'demo_rested_1', eventType: 'restedness', localDate: '2025-01-14', timezone: 'UTC', numericValue: 7, source: 'user_reported', confidence: 'high', notes: 'Synthetic example only.' }, 'synthetic-demo');
  process.stdout.write('Added 2 clearly labeled synthetic demo records.\n');
} finally { db.close(); }
