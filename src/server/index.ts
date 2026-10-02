import { buildApp } from './app.js';
import { defaultDataDir, validateExternalDataDir, validateRuntimeConfig } from './config.js';

const args = new Set(process.argv.slice(2));
const development = args.has('--dev') || process.env.NODE_ENV !== 'production';
const host = process.env.WELLBEING_HOST ?? '127.0.0.1';
const port = Number(process.env.WELLBEING_PORT ?? 8787);
validateRuntimeConfig(host, port, process.env.WELLBEING_ALLOWED_ORIGIN, !development);
const dataDir = validateExternalDataDir(process.env.WELLBEING_DATA_DIR ?? defaultDataDir());
const app = await buildApp({ dataDir, secureCookies: !development, allowedOrigin: process.env.WELLBEING_ALLOWED_ORIGIN ?? `http://${host}:${port}` });
const shutdown = async () => { await app.close(); process.exit(0); };
process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
try { await app.listen({ host, port }); } catch (error) { await app.close(); throw new Error(`unable to bind ${host}:${port}: ${(error as Error).message}`); }
process.stdout.write(`Wellbeing Dashboard listening on http://${host}:${port} with data in ${dataDir}\n`);
