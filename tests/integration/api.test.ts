import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.js';

describe('HTTP vertical slice and security', () => {
  let dir: string;
  let app: Awaited<ReturnType<typeof buildApp>>;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'wellbeing-api-')); app = await buildApp({ dataDir: dir, secureCookies: false }); });
  afterEach(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });

  it('setup, assistant read, correction history, stale edit and controls', async () => {
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: { origin: 'http://localhost' }, payload: { username: 'owner', password: 'correct horse battery staple' } });
    expect(setup.statusCode).toBe(201);
    const cookie = String(setup.headers['set-cookie']).split(';')[0];
    const csrf = setup.json().csrfToken;
    const secureHeaders = { cookie, 'x-csrf-token': csrf, origin: 'http://localhost' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/events', payload: {} })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/v1/events', headers: { cookie, origin: 'http://localhost' }, payload: {} })).statusCode).toBe(403);
    const created = await app.inject({ method: 'POST', url: '/api/v1/events', headers: secureHeaders, payload: { id: 'evt_synthetic_1', eventType: 'sleep_duration', localDate: '2025-02-02', timezone: 'UTC', durationMinutes: 420, localOffset: '+00:00', notes: 'Synthetic fixture', actorId: 'spoof' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().actorId).not.toBe('spoof');
    const idemPayload = { id: 'evt_idem', eventType: 'sleep_duration', timezone: 'UTC', localDate: '2025-02-03', durationMinutes: 0 };
    const idemHeaders = { ...secureHeaders, 'idempotency-key': 'canonical-replay' };
    const idemFirst = await app.inject({ method: 'POST', url: '/api/v1/events', headers: idemHeaders, payload: idemPayload });
    const idemReplay = await app.inject({ method: 'POST', url: '/api/v1/events', headers: idemHeaders, payload: { durationMinutes: 0, localDate: '2025-02-03', timezone: 'UTC', eventType: 'sleep_duration', id: 'evt_idem' } });
    expect(idemReplay.statusCode).toBe(201); expect(idemReplay.body).toBe(idemFirst.body);
    expect((app.db.prepare("SELECT count(*) AS n FROM event_revisions WHERE event_id='evt_idem'").get() as {n:number}).n).toBe(1);
    const token = await app.inject({ method: 'POST', url: '/api/v1/credentials', headers: secureHeaders, payload: { name: 'test client', scopes: ['events:read', 'events:write'], expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    expect(token.statusCode).toBe(201);
    const auth = { authorization: `Bearer ${token.json().token}`, 'idempotency-key': 'same-op' };
    const read = await app.inject({ method: 'GET', url: '/api/v1/events/evt_synthetic_1', headers: auth });
    expect(read.statusCode).toBe(200);
    const correction = await app.inject({ method: 'PUT', url: '/api/v1/events/evt_synthetic_1', headers: auth, payload: { expectedRevision: 1, durationMinutes: 435, correctionReason: 'Synthetic correction' } });
    expect(correction.statusCode).toBe(200);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/events/evt_synthetic_1', headers: { ...auth, 'idempotency-key': 'stale' }, payload: { expectedRevision: 1, durationMinutes: 440 } })).statusCode).toBe(409);
    expect((await app.inject({ method: 'PUT', url: '/api/v1/events/evt_synthetic_1', headers: auth, payload: { expectedRevision: 2, durationMinutes: 1 } })).statusCode).toBe(409);
    const history = await app.inject({ method: 'GET', url: '/api/v1/events/evt_synthetic_1/history', headers: { cookie } });
    expect(history.json()).toHaveLength(2);
    await app.inject({ method: 'DELETE', url: `/api/v1/credentials/${token.json().id}`, headers: secureHeaders });
    expect((await app.inject({ method: 'GET', url: '/api/v1/events', headers: auth })).statusCode).toBe(401);
  });

  it('rejects semantic edits, preserves audit timestamps, groups sessions atomically, and scopes exports', async () => {
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: { origin: 'http://localhost' }, payload: { username: 'owner', password: 'correct horse battery staple' } });
    const cookie = String(setup.headers['set-cookie']).split(';')[0]; const csrf = setup.json().csrfToken; const owner = { cookie, 'x-csrf-token': csrf, origin: 'http://localhost' };
    const created = await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: { id: 'semantic-event', eventType: 'sleep_duration', localDate: '2025-01-01', timezone: 'UTC', durationMinutes: 420, sourceReference: '00042' } });
    expect(created.statusCode).toBe(201); expect(created.json().createdAtUtc).toBeTruthy(); expect(created.json().sourceReference).toBe('00042');
    const audit = created.json().createdAtUtc;
    const invalid = await app.inject({ method: 'PUT', url: '/api/v1/events/semantic-event', headers: owner, payload: { expectedRevision: 1, eventType: 'restedness', numericValue: 99 } });
    expect(invalid.statusCode).toBe(400); expect((await app.inject({ method: 'GET', url: '/api/v1/events/semantic-event', headers: { cookie } })).json().currentRevision).toBe(1);
    const grouped = await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: owner, payload: { kind: 'overnight', localDate: '2025-01-01', timezone: 'UTC', events: [{ id: 'semantic-event', expectedRevision: 1 }] } });
    expect(grouped.statusCode).toBe(201); const sessionId = grouped.json().id;
    const sessionHistory = await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/history`, headers: { cookie } }); expect(sessionHistory.statusCode).toBe(200); expect(sessionHistory.json()).toHaveLength(1);
    expect(() => app.db.prepare("UPDATE event_revisions SET reason='tampered' WHERE event_id='semantic-event' AND revision=1").run()).toThrow(/append-only/);
    expect(() => app.db.prepare('DELETE FROM session_revisions WHERE session_id=?').run(sessionId)).toThrow(/append-only/);
    const stale = await app.inject({ method: 'PUT', url: `/api/v1/sessions/${sessionId}`, headers: owner, payload: { expectedRevision: 1, kind: 'nap', events: [{ id: 'semantic-event', expectedRevision: 1 }], removedEvents: [] } });
    expect(stale.statusCode).toBe(409); expect((await app.inject({ method: 'GET', url: `/api/v1/sessions/${sessionId}/history`, headers: { cookie } })).json()).toHaveLength(1);
    const event = (await app.inject({ method: 'GET', url: '/api/v1/events/semantic-event', headers: { cookie } })).json(); expect(event.createdAtUtc).toBe(audit); expect(event.currentRevision).toBe(2);
    const readOnly = await app.inject({ method: 'POST', url: '/api/v1/credentials', headers: owner, payload: { name: 'read', scopes: ['events:read'], expiresAt: new Date(Date.now()+60000).toISOString() } });
    const exportDenied = await app.inject({ method: 'GET', url: '/api/v1/exports/json', headers: { authorization: `Bearer ${readOnly.json().token}` } }); expect(exportDenied.statusCode).toBe(403);
  });

  it('scopes idempotency by actor and operation, replays note edits, and rolls back cache failures', async () => {
    const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: { origin: 'http://localhost' }, payload: { username: 'owner', password: 'correct horse battery staple' } });
    const cookie = String(setup.headers['set-cookie']).split(';')[0]; const csrf = setup.json().csrfToken; const owner = { cookie, 'x-csrf-token': csrf, origin: 'http://localhost' };
    const baseEvent = (id: string) => ({ id, eventType: 'sleep_duration', timezone: 'UTC', localDate: '2025-01-01', durationMinutes: 100 });
    expect((await app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...owner, 'idempotency-key': 'shared-key' }, payload: baseEvent('owner-event') })).statusCode).toBe(201);
    const credential = await app.inject({ method: 'POST', url: '/api/v1/credentials', headers: owner, payload: { name: 'writer', scopes: ['events:write', 'notes:write'], expiresAt: new Date(Date.now() + 60_000).toISOString() } });
    const assistant = { authorization: `Bearer ${credential.json().token}`, 'idempotency-key': 'shared-key' };
    expect((await app.inject({ method: 'POST', url: '/api/v1/events', headers: assistant, payload: baseEvent('assistant-event') })).statusCode).toBe(201);
    const note = await app.inject({ method: 'POST', url: '/api/v1/notes', headers: { ...owner, 'idempotency-key': 'shared-key' }, payload: { body: 'first note' } }); expect(note.statusCode).toBe(201);
    const noteId = note.json().id; const editHeaders = { ...owner, 'idempotency-key': 'note-edit' }; const editPayload = { expectedRevision: 1, body: 'second note' };
    const edit = await app.inject({ method: 'PUT', url: `/api/v1/notes/${noteId}`, headers: editHeaders, payload: editPayload }); const replay = await app.inject({ method: 'PUT', url: `/api/v1/notes/${noteId}`, headers: editHeaders, payload: editPayload });
    expect(edit.statusCode).toBe(200); expect(replay.statusCode).toBe(200); expect(replay.body).toBe(edit.body); expect((app.db.prepare('SELECT count(*) AS n FROM note_revisions WHERE note_id=?').get(noteId) as {n:number}).n).toBe(2);
    app.db.exec("CREATE TRIGGER forced_idempotency_failure BEFORE INSERT ON idempotency BEGIN SELECT RAISE(ABORT, 'forced synthetic cache failure'); END");
    const failed = await app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...owner, 'idempotency-key': 'forced-failure' }, payload: baseEvent('rolled-back-event') });
    expect(failed.statusCode).toBe(500); expect((app.db.prepare("SELECT count(*) AS n FROM events WHERE id='rolled-back-event'").get() as {n:number}).n).toBe(0); expect((app.db.prepare("SELECT count(*) AS n FROM event_revisions WHERE event_id='rolled-back-event'").get() as {n:number}).n).toBe(0); app.db.exec('DROP TRIGGER forced_idempotency_failure');
  });
});
