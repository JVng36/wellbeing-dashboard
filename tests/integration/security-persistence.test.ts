import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../../src/server/app.js';

const dirs: string[] = [];
const cookieOf = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0];

describe('security boundaries and restart persistence', () => {
  afterEach(async () => { await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))); dirs.length = 0; });

  it('denies origin, missing scope, expired assistant credential and expired owner session', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-security-')); dirs.push(dir);
    const app = await buildApp({ dataDir: dir, secureCookies: false });
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'owner', password: 'a synthetic long password' } })).statusCode).toBe(403);
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: { origin: 'http://localhost' }, payload: { username: 'owner', password: 'a synthetic long password' } });
    const cookie = cookieOf(setup); const csrf = setup.json().csrfToken;
    expect((await app.inject({ method: 'POST', url: '/api/v1/events', headers: { cookie, 'x-csrf-token': csrf, origin: 'http://evil.invalid' }, payload: { eventType: 'nap', timezone: 'UTC' } })).statusCode).toBe(403);
    const tokenResponse = await app.inject({ method: 'POST', url: '/api/v1/credentials', headers: { cookie, 'x-csrf-token': csrf, origin: 'http://localhost' }, payload: { name: 'read only', scopes: ['events:read'], expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const token = tokenResponse.json().token; const auth = { authorization: `Bearer ${token}` };
    expect((await app.inject({ method: 'POST', url: '/api/v1/events', headers: auth, payload: { eventType: 'nap', timezone: 'UTC' } })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/api/v1/notes', headers: auth })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie, origin: 'http://localhost' } })).statusCode).toBe(403);
    const malformedBody = await app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...({ cookie, origin: 'http://localhost', 'x-csrf-token': csrf }), 'content-type': 'application/json' }, payload: '' });
    expect(malformedBody.statusCode).toBe(400); expect(malformedBody.json()).toEqual({ error: 'invalid request', code: 'invalid_request' });
    app.db.prepare("UPDATE assistant_credentials SET expires_at_utc='2000-01-01T00:00:00.000Z'").run();
    expect((await app.inject({ method: 'GET', url: '/api/v1/events', headers: auth })).statusCode).toBe(401);
    await app.close();

    const expiredApp = await buildApp({ dataDir: dir, secureCookies: false, sessionSeconds: 0 });
    const login = await expiredApp.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://localhost' }, payload: { username: 'owner', password: 'a synthetic long password' } });
    expect((await expiredApp.inject({ method: 'GET', url: '/api/v1/events', headers: { cookie: cookieOf(login) } })).statusCode).toBe(401);
    await expiredApp.close();
  });

  it('persists events across a clean process-style restart and replays identical idempotent requests', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-restart-')); dirs.push(dir);
    let app = await buildApp({ dataDir: dir, secureCookies: false });
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: { origin: 'http://localhost' }, payload: { username: 'owner', password: 'another synthetic password' } });
    const cookie = cookieOf(setup); const csrf = setup.json().csrfToken;
    const headers = { cookie, 'x-csrf-token': csrf, origin: 'http://localhost', 'idempotency-key': 'persist-create' };
    const payload = { id: 'evt_persisted', eventType: 'sleep_duration', localDate: '2025-05-01', timezone: 'UTC', durationMinutes: 390 };
    const first = await app.inject({ method: 'POST', url: '/api/v1/events', headers, payload });
    const replay = await app.inject({ method: 'POST', url: '/api/v1/events', headers, payload });
    expect(replay.statusCode).toBe(201); expect(replay.body).toBe(first.body);
    await app.close();

    app = await buildApp({ dataDir: dir, secureCookies: false });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { origin: 'http://localhost' }, payload: { username: 'owner', password: 'another synthetic password' } });
    const read = await app.inject({ method: 'GET', url: '/api/v1/events/evt_persisted', headers: { cookie: cookieOf(login) } });
    expect(read.statusCode).toBe(200); expect(read.json().durationMinutes).toBe(390);
    await app.close();
  });

  it('allows exactly one concurrent first-owner setup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-concurrent-setup-')); dirs.push(dir);
    const app = await buildApp({ dataDir: dir, secureCookies: false });
    const results = await Promise.all([1, 2].map(index => app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: { origin: 'http://localhost' }, payload: { username: `owner-${index}`, password: 'a synthetic long password' } })));
    expect(results.map(result => result.statusCode).sort()).toEqual([201, 409]);
    expect((app.db.prepare('SELECT count(*) AS n FROM owners').get() as {n:number}).n).toBe(1);
    await app.close();
  });
});
