import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export function defaultDataDir(): string {
  return join(homedir(), '.local', 'share', 'wellbeing-dashboard');
}

function realPathForValidation(path: string): string {
  if (existsSync(path)) return realpathSync(path);
  let cursor = path;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return resolve(realpathSync(cursor), relative(cursor, path));
}

export function validateExternalDataDir(dataDir: string, sourceRoot = process.cwd()): string {
  if (!isAbsolute(dataDir)) throw new Error(`WELLBEING_DATA_DIR must be an absolute external path; received ${dataDir}`);
  let component = resolve(dataDir);
  while (true) {
    if (existsSync(component) && lstatSync(component).isSymbolicLink()) throw new Error(`data directory path must not contain a symlink: ${component}`);
    const parent = dirname(component); if (parent === component) break; component = parent;
  }
  const source = realPathForValidation(resolve(sourceRoot));
  const candidate = realPathForValidation(resolve(dataDir));
  const rel = relative(source, candidate);
  if (rel === '' || (!rel.startsWith('..') && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`))) {
    throw new Error(`data directory must be outside the source tree: ${candidate}`);
  }
  if (candidate === resolve(tmpdir())) throw new Error('data directory must be a dedicated directory, not the system temporary root');
  if (existsSync(resolve(dataDir)) && lstatSync(resolve(dataDir)).isSymbolicLink()) throw new Error('data directory must not be a symlink');
  return resolve(dataDir);
}

export function validateRuntimeConfig(host: string, port: number, allowedOrigin?: string, production = false): void {
  const loopback = ['127.0.0.1', '::1', 'localhost'].includes(host);
  if (!host || (!loopback && !production)) throw new Error('Non-loopback binding requires production secure mode with an HTTPS reverse proxy');
  if (!loopback && !allowedOrigin) throw new Error('Non-loopback binding requires an exact WELLBEING_ALLOWED_ORIGIN and an HTTPS reverse proxy');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`WELLBEING_PORT must be an integer from 1 to 65535; received ${port}`);
  if (allowedOrigin) {
    let parsed: URL;
    try { parsed = new URL(allowedOrigin); } catch { throw new Error('WELLBEING_ALLOWED_ORIGIN must be an exact origin such as https://journal.example'); }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password || parsed.protocol !== 'https:') throw new Error('WELLBEING_ALLOWED_ORIGIN must be an exact HTTPS origin without path, query, or credentials');
  }
  if (production && !loopback && !allowedOrigin) throw new Error('production non-loopback binding requires WELLBEING_ALLOWED_ORIGIN');
}
