import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../src/server/app.js';

describe('error handler compatibility', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('preserves structured framework 4xx responses without exposing the thrown value', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-error-handler-')); dirs.push(dir);
    const app = await buildApp({ dataDir: dir, secureCookies: false });
    app.get('/test/framework-error', async () => { throw { statusCode: 429, message: 'secret framework detail' }; });
    try {
      const response = await app.inject({ method: 'GET', url: '/test/framework-error' });
      expect(response.statusCode).toBe(429);
      expect(response.json()).toEqual({ error: 'invalid request', code: 'invalid_request' });
      expect(response.body).not.toContain('secret framework detail');
    } finally { await app.close(); }
  });

  it('returns a generic 500 for unexpected null values without leaking secrets', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-error-handler-')); dirs.push(dir);
    const app = await buildApp({ dataDir: dir, secureCookies: false });
    app.get('/test/unexpected-error', async () => { throw null; });
    try {
      const response = await app.inject({ method: 'GET', url: '/test/unexpected-error' });
      expect(response.statusCode).toBe(500);
      expect(response.json()).toEqual({ error: 'internal error', code: 'internal_error' });
      expect(response.body).not.toContain('secret');
    } finally { await app.close(); }
  });
});
