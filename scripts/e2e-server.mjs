import { isAbsolute } from 'node:path';
if (!process.env.WELLBEING_E2E_DATA_DIR || !isAbsolute(process.env.WELLBEING_E2E_DATA_DIR)) throw new Error('WELLBEING_E2E_DATA_DIR must be an external absolute temporary path');
if (process.env.WELLBEING_E2E_DATA_DIR === process.cwd()) throw new Error('E2E data must be outside the source tree');
await import('../dist-server/server/index.js');
