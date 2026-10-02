import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { contractSchemas } from '../../src/shared/api-contract.js';

const dirs: string[] = [];
const headersOf = (response: any) => ({ cookie: String(response.headers['set-cookie']).split(';')[0], origin: 'http://localhost', 'x-csrf-token': response.json().csrfToken });
const check = (schema: { safeParse: (value: unknown) => { success: boolean; error?: unknown } }, response: any) => { const parsed = schema.safeParse(response.json()); expect(parsed.success, JSON.stringify(parsed.error)).toBe(true); };
afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('shared Zod/API response contracts', () => {
  it('validates actual JSON for every representative operation and documented shapes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-contract-')); dirs.push(dir); const app = await buildApp({ dataDir: dir, secureCookies: false });
    try {
      check(contractSchemas.AuthStatus, await app.inject({ method: 'GET', url: '/api/v1/auth/status' }));
      const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: { origin: 'http://localhost' }, payload: { username: 'owner', password: 'contract test password' } }); check(contractSchemas.AuthResponse, setup); const owner = headersOf(setup);
      check(contractSchemas.AuthStatus, await app.inject({ method: 'GET', url: '/api/v1/auth/status', headers: owner }));
      const eventPayload = { id: 'contract-event', eventType: 'sleep_duration', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 420, source: 'user_report', confidence: null };
      const created = await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: eventPayload }); check(contractSchemas.Event, created);
      check(contractSchemas.EventList, await app.inject({ method: 'GET', url: '/api/v1/events', headers: owner })); check(contractSchemas.Event, await app.inject({ method: 'GET', url: '/api/v1/events/contract-event', headers: owner }));
      const edited = await app.inject({ method: 'PUT', url: '/api/v1/events/contract-event', headers: owner, payload: { expectedRevision: 1, durationMinutes: 430, correctionReason: 'contract correction' } }); check(contractSchemas.Event, edited); check(contractSchemas.EventHistory, await app.inject({ method: 'GET', url: '/api/v1/events/contract-event/history', headers: owner }));
      const session = await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: owner, payload: { id: 'contract-session', kind: 'overnight', localDate: '2026-09-28', timezone: 'UTC', events: [{ id: 'contract-event', expectedRevision: 2 }] } }); check(contractSchemas.SessionCreate, session); check(contractSchemas.SessionList, await app.inject({ method: 'GET', url: '/api/v1/sessions', headers: owner })); check(contractSchemas.SessionHistory, await app.inject({ method: 'GET', url: '/api/v1/sessions/contract-session/history', headers: owner }));
      const sessionEdit = await app.inject({ method: 'PUT', url: '/api/v1/sessions/contract-session', headers: owner, payload: { expectedRevision: 1, kind: 'nap', reason: 'contract session edit' } }); check(contractSchemas.Session, sessionEdit);
      const note = await app.inject({ method: 'POST', url: '/api/v1/notes', headers: owner, payload: { body: 'contract note', sessionId: 'contract-session', rangeStart: '2026-09-28', rangeEnd: '2026-09-29' } }); check(contractSchemas.Note, note); const noteId = note.json().id;
      check(contractSchemas.NoteList, await app.inject({ method: 'GET', url: '/api/v1/notes', headers: owner })); check(contractSchemas.Note, await app.inject({ method: 'GET', url: `/api/v1/notes/${encodeURIComponent(noteId)}`, headers: owner })); check(contractSchemas.Note, await app.inject({ method: 'PUT', url: `/api/v1/notes/${encodeURIComponent(noteId)}`, headers: owner, payload: { expectedRevision: 1, body: 'contract note revised' } })); check(contractSchemas.NoteHistory, await app.inject({ method: 'GET', url: `/api/v1/notes/${encodeURIComponent(noteId)}/history`, headers: owner }));
      check(contractSchemas.Trend, await app.inject({ method: 'GET', url: '/api/v1/trends/7?timezone=UTC', headers: owner }));
      const credential = await app.inject({ method: 'POST', url: '/api/v1/credentials', headers: owner, payload: { name: 'contract', scopes: ['events:read'], expiresAt: new Date(Date.now() + 60_000).toISOString() } }); check(contractSchemas.CredentialCreate, credential); check(contractSchemas.CredentialList, await app.inject({ method: 'GET', url: '/api/v1/credentials', headers: owner })); expect((await app.inject({ method: 'DELETE', url: `/api/v1/credentials/${credential.json().id}`, headers: owner })).statusCode).toBe(204);
      const imported = await app.inject({ method: 'POST', url: '/api/v1/imports/legacy', headers: owner, payload: { files: [{ name: 'contract.md', content: '---\nid: contract-import\nevent_type: duration_report\nlocal_date: 2026-09-28\ntimezone: UTC\nduration_minutes: 10\n---\n' }] } }); check(contractSchemas.ImportResult, imported);
      const backup = await app.inject({ method: 'POST', url: '/api/v1/admin/backups', headers: owner, payload: { label: 'contract' } }); check(contractSchemas.BackupResponse, backup);
      const exported = await app.inject({ method: 'GET', url: '/api/v1/exports/json', headers: owner }); check(contractSchemas.Export, exported); const csv = await app.inject({ method: 'GET', url: '/api/v1/exports/csv', headers: owner }); expect(csv.headers['content-type']).toMatch(/text\/csv/); expect(csv.body).toContain('eventType');
      const document = await app.inject({ method: 'GET', url: '/api/v1/openapi.json' }); check(contractSchemas.OpenApiDocument, document);
      for (const [path, item] of Object.entries(document.json().paths)) for (const [method, operation] of Object.entries(item as Record<string, any>)) { if (!['get', 'post', 'put', 'delete'].includes(method)) continue; const op = operation as any; for (const match of path.matchAll(/\{([^}]+)\}/g)) expect(op.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ in: 'path', name: match[1], required: true })])); for (const [status, result] of Object.entries(op.responses)) if (/^2/.test(status) && status !== '204') expect((result as any).content).toBeDefined(); if (!['/health', '/openapi.json'].includes(path)) expect(op.responses['400']?.content?.['application/json']?.schema).toBeDefined(); }
      const requiredScopes: Record<string, Record<string, string[]>> = { '/events': { get: ['events:read'], post: ['events:write'] }, '/events/{id}': { get: ['events:read'], put: ['events:write'] }, '/events/{id}/history': { get: ['events:read'] }, '/sessions': { get: ['events:read'], post: ['events:write'] }, '/sessions/{id}': { put: ['events:write'] }, '/sessions/{id}/history': { get: ['events:read'] }, '/notes': { get: ['notes:read'], post: ['notes:write'] }, '/notes/{id}': { get: ['notes:read'], put: ['notes:write'] }, '/notes/{id}/history': { get: ['notes:read'] }, '/trends/{days}': { get: ['trends:read'] }, '/exports/{format}': { get: ['events:read', 'notes:read'] } };
      for (const [path, methods] of Object.entries(requiredScopes)) for (const [method, scopes] of Object.entries(methods)) expect((document.json().paths[path] as any)[method]['x-required-scopes']).toEqual(scopes);
      expect(Object.keys(document.json().paths).sort()).toEqual(['/admin/backups', '/auth/login', '/auth/logout', '/auth/setup', '/auth/status', '/credentials', '/credentials/{id}', '/events', '/events/{id}', '/events/{id}/history', '/exports/{format}', '/health', '/imports/legacy', '/notes', '/notes/{id}', '/notes/{id}/history', '/openapi.json', '/sessions', '/sessions/{id}', '/sessions/{id}/history', '/trends/{days}'].sort());
      expect((document.json().paths['/imports/legacy'] as any).post.parameters.some((parameter: any) => parameter.name.toLowerCase() === 'idempotency-key')).toBe(false);
      expect((document.json().paths['/events'] as any).post.parameters.find((parameter: any) => parameter.name === 'Origin')).toMatchObject({ required: false });
    } finally { await app.close(); }
  });

  it('rejects malformed required fields in every nonempty export collection', () => {
    const invalid = (value: any, collection: string, field: string) => { const copy = structuredClone(value); delete copy[collection][0][field]; return copy; };
    const row = {
      formatVersion: 1, schemaVersion: 6, exportedAtUtc: '2026-09-29T12:00:00.000Z',
      sessions: [{ id: 'session', kind: 'overnight', local_date: '2026-09-28', timezone: 'UTC', provenance: 'explicit', created_at_utc: '2026-09-29T12:00:00.000Z', current_revision: 1, updated_at_utc: '2026-09-29T12:00:00.000Z', actor_id: 'owner' }],
      sessionRevisions: [{ sessionId: 'session', revision: 1, snapshot: { id: 'session', kind: 'overnight', localDate: '2026-09-28', timezone: 'UTC', provenance: 'explicit', currentRevision: 1, createdAtUtc: '2026-09-29T12:00:00.000Z', updatedAtUtc: '2026-09-29T12:00:00.000Z', actorId: 'owner' }, actorId: 'owner', reason: 'created', createdAtUtc: '2026-09-29T12:00:00.000Z' }],
      events: [{ id: 'event', eventType: 'sleep_duration', startAtLocal: null, endAtLocal: null, localDate: '2026-09-28', timezone: 'UTC', localOffset: null, endLocalOffset: null, durationMinutes: 420, numericValue: null, reportedAtUtc: null, source: 'user_report', confidence: null, notes: null, sourceMessageId: null, sourceReference: null, supersedesEventId: null, createdAtUtc: '2026-09-29T12:00:00.000Z', sessionId: null, pairingProvenance: null, uncertainty: null, metricOverrides: null, currentRevision: 1, actorId: 'owner', updatedAtUtc: '2026-09-29T12:00:00.000Z' }],
      eventRevisions: [{ eventId: 'event', revision: 1, snapshot: {}, actorId: 'owner', reason: null, createdAtUtc: '2026-09-29T12:00:00.000Z' }],
      notes: [{ id: 'note', body: 'note', session_id: null, range_start: null, range_end: null, current_revision: 1, created_at_utc: '2026-09-29T12:00:00.000Z', updated_at_utc: '2026-09-29T12:00:00.000Z', actor_id: 'owner' }],
      noteRevisions: [{ noteId: 'note', revision: 1, snapshot: {}, actorId: 'owner', createdAtUtc: '2026-09-29T12:00:00.000Z' }],
      legacyImportFiles: [{ eventId: 'event', name: 'synthetic.md', sha256: 'a'.repeat(64), importedAtUtc: '2026-09-29T12:00:00.000Z', importerVersion: '1' }],
      metricOverrides: [{ eventId: 'event', value: { durationMinutes: { value: 420, basis: 'explicit_user_correction' } } }], summaryDefinitions: [7], notice: 'synthetic'
    };
    const requiredFields: Array<[string, string]> = [['sessions', 'id'], ['sessionRevisions', 'sessionId'], ['events', 'id'], ['eventRevisions', 'eventId'], ['notes', 'id'], ['noteRevisions', 'noteId'], ['legacyImportFiles', 'name'], ['metricOverrides', 'eventId']];
    for (const [collection, field] of requiredFields) expect(contractSchemas.Export.safeParse(invalid(row, collection, field)).success, `${collection}.${field} was accepted`).toBe(false);
  });
});
