import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../../src/server/app.js';
import { openDatabase } from '../../src/server/db.js';
import { createEvent, trends } from '../../src/server/events.js';
import { importLegacyFiles } from '../../src/server/importer.js';

const dirs: string[] = [];
const cookieOf = (response: { headers: Record<string, unknown> }) => String(response.headers['set-cookie']).split(';')[0];
const eventBody = (extra: Record<string, unknown> = {}) => ({ eventType: 'sleep_duration', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 20, ...extra });
const legacyFile = (id: string, fields: string, body = '', eventType = 'duration_report', includeDefaults = true) => `---\nid: ${id}\nevent_type: ${eventType}\n${includeDefaults ? 'local_date: 2026-09-28\ntimezone: UTC\n' : ''}${fields}---\n${body}`;

async function ownerApp() {
  const dir = await mkdtemp(join(tmpdir(), 'wellbeing-corrections-'));
  dirs.push(dir);
  const app = await buildApp({ dataDir: dir, secureCookies: false });
  const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: { origin: 'http://localhost', host: 'localhost' }, payload: { username: 'owner', password: 'synthetic correction password' } });
  return { app, dir, owner: { cookie: cookieOf(setup), origin: 'http://localhost', host: 'localhost', 'x-csrf-token': setup.json().csrfToken } };
}

afterEach(async () => { await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });

describe('R02 override validation and precedence', () => {
  it.each([
    ['negative duration', { durationMinutes: { value: -1, basis: 'explicit_user_correction' } }],
    ['fractional duration', { durationMinutes: { value: 1.5, basis: 'explicit_user_correction' } }],
    ['duration above seven days', { durationMinutes: { value: 10081, basis: 'explicit_user_correction' } }],
    ['restedness below one', { restedness: { value: 0, basis: 'explicit_user_correction' } }],
    ['restedness above ten', { restedness: { value: 11, basis: 'explicit_user_correction' } }],
    ['unknown metric key', { sleepQuality: { value: 4, basis: 'explicit_user_correction' } }],
  ])('rejects %s before persistence', async (_label, metricOverrides) => {
    const { app, owner } = await ownerApp();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: eventBody({ id: `invalid-${String(_label).replaceAll(' ', '-')}`, metricOverrides }) });
      expect([400, 422]).toContain(response.statusCode);
      expect((app.db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n).toBe(0);
    } finally { await app.close(); }
  });

  it('preserves an unrelated higher-priority field during a partial patch', async () => {
    const { app, owner } = await ownerApp();
    try {
      const created = await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: eventBody({ id: 'partial-high', metricOverrides: { restedness: { value: 9, basis: 'explicit_user_correction' } } }) });
      expect(created.statusCode).toBe(201);
      const edited = await app.inject({ method: 'PUT', url: '/api/v1/events/partial-high', headers: owner, payload: { expectedRevision: 1, metricOverrides: { durationMinutes: { value: 45, basis: 'user_report' } } } });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().metricOverrides).toMatchObject({ durationMinutes: { value: 45, basis: 'user_report' }, restedness: { value: 9, basis: 'explicit_user_correction' } });
    } finally { await app.close(); }
  });

  it('rejects a lower-priority replacement of the same higher-priority metric', async () => {
    const { app, owner } = await ownerApp();
    try {
      const created = await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: eventBody({ id: 'priority-conflict', metricOverrides: { durationMinutes: { value: 400, basis: 'explicit_user_correction' }, restedness: { value: 9, basis: 'explicit_user_correction' } } }) });
      expect(created.statusCode).toBe(201);
      const edited = await app.inject({ method: 'PUT', url: '/api/v1/events/priority-conflict', headers: owner, payload: { expectedRevision: 1, metricOverrides: { durationMinutes: { value: 300, basis: 'user_report' } } } });
      expect(edited.statusCode).toBe(422);
      const current = await app.inject({ method: 'GET', url: '/api/v1/events/priority-conflict', headers: owner });
      expect(current.json().metricOverrides).toMatchObject({ durationMinutes: { value: 400 }, restedness: { value: 9 } });
    } finally { await app.close(); }
  });

  it('keeps explicit null from revealing a lower-priority number', async () => {
    const { app, owner } = await ownerApp();
    try {
      const created = await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: eventBody({ id: 'null-override', metricOverrides: { durationMinutes: { value: 50, basis: 'user_report' } } }) });
      expect(created.statusCode).toBe(201);
      const edited = await app.inject({ method: 'PUT', url: '/api/v1/events/null-override', headers: owner, payload: { expectedRevision: 1, metricOverrides: { durationMinutes: { value: null, basis: 'explicit_user_correction' } } } });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().metricOverrides.durationMinutes.value).toBeNull();
      const result = trends(app.db, 7, new Date('2026-09-29T12:00:00.000Z'));
      expect(result.totalReportedSleepMinutes).toBeNull();
    } finally { await app.close(); }
  });
});

describe('R03 and R08 trend selection, dates, naps, notes, and grouping', () => {
  it('rejects session rehoming and requires explicit removal revisions', async () => {
    const { app, owner } = await ownerApp();
    try {
      const first = await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: eventBody({ id: 'membership-a' }) });
      const second = await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: eventBody({ id: 'membership-b' }) });
      const grouped = await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: owner, payload: { id: 'membership-session', kind: 'overnight', timezone: 'UTC', events: [{ id: 'membership-a', expectedRevision: 1 }, { id: 'membership-b', expectedRevision: 1 }] } });
      expect(first.statusCode).toBe(201); expect(second.statusCode).toBe(201); expect(grouped.statusCode).toBe(201);
      expect((await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: eventBody({ id: 'direct-session-bypass', sessionId: 'membership-session' }) })).statusCode).toBe(409);
      const rehome = await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: owner, payload: { id: 'other-session', kind: 'nap', timezone: 'UTC', events: [{ id: 'membership-a', expectedRevision: 2 }] } });
      expect(rehome.statusCode).toBe(409);
      expect((await app.inject({ method: 'PUT', url: '/api/v1/events/membership-a', headers: owner, payload: { expectedRevision: 2, sessionId: null } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: owner, payload: { id: 'duplicate-session', kind: 'nap', timezone: 'UTC', events: [{ id: 'membership-a', expectedRevision: 2 }, { id: 'membership-a', expectedRevision: 2 }] } })).statusCode).toBe(400);
      const missingProof = await app.inject({ method: 'PUT', url: '/api/v1/sessions/membership-session', headers: owner, payload: { expectedRevision: 1, events: [{ id: 'membership-a', expectedRevision: 2 }] } });
      expect(missingProof.statusCode).toBe(400);
      const changedRemoved = await app.inject({ method: 'PUT', url: '/api/v1/events/membership-b', headers: owner, payload: { expectedRevision: 2, durationMinutes: 21 } });
      expect(changedRemoved.statusCode).toBe(200);
      const staleRemoved = await app.inject({ method: 'PUT', url: '/api/v1/sessions/membership-session', headers: owner, payload: { expectedRevision: 1, events: [{ id: 'membership-a', expectedRevision: 2 }], removedEvents: [{ id: 'membership-b', expectedRevision: 2 }] } });
      expect(staleRemoved.statusCode).toBe(409);
      expect((await app.inject({ method: 'GET', url: '/api/v1/sessions/membership-session/history', headers: owner })).json()).toHaveLength(1);
      const removed = await app.inject({ method: 'PUT', url: '/api/v1/sessions/membership-session', headers: owner, payload: { expectedRevision: 1, events: [{ id: 'membership-a', expectedRevision: 2 }], removedEvents: [{ id: 'membership-b', expectedRevision: 3 }] } });
      expect(removed.statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/api/v1/events/membership-b', headers: owner })).json().sessionId).toBeNull();
      const history = (await app.inject({ method: 'GET', url: '/api/v1/sessions/membership-session/history', headers: owner })).json();
      expect(history[0].snapshot.events).toEqual([{ id: 'membership-a', revision: 2 }]);
    } finally { await app.close(); }
  });
  it.each([
    ['a supplied removal proof', [{ id: 'root-a', expectedRevision: 2 }]],
    ['an empty removal proof', []],
  ])('rejects metadata-only %s and leaves export/history unchanged', async (_label, removedEvents) => {
    const { app, owner } = await ownerApp();
    try {
      const event = await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: eventBody({ id: 'root-a' }) });
      const grouped = await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: owner, payload: { id: 'root-one', kind: 'overnight', timezone: 'UTC', events: [{ id: 'root-a', expectedRevision: 1 }] } });
      expect(event.statusCode).toBe(201); expect(grouped.statusCode).toBe(201);
      const beforeHistory = (await app.inject({ method: 'GET', url: '/api/v1/sessions/root-one/history', headers: owner })).json();
      const beforeExport = (await app.inject({ method: 'GET', url: '/api/v1/exports/json', headers: owner })).json();
      const rejected = await app.inject({ method: 'PUT', url: '/api/v1/sessions/root-one', headers: owner, payload: { expectedRevision: 1, removedEvents } });
      const afterHistory = (await app.inject({ method: 'GET', url: '/api/v1/sessions/root-one/history', headers: owner })).json();
      const afterExport = (await app.inject({ method: 'GET', url: '/api/v1/exports/json', headers: owner })).json();
      expect(rejected.statusCode).toBe(400);
      expect(afterHistory).toEqual(beforeHistory);
      expect({ ...afterExport, exportedAtUtc: undefined }).toEqual({ ...beforeExport, exportedAtUtc: undefined });
    } finally { await app.close(); }
  });
  it('keeps an explicit null duration selected over a lower-priority session value and retains nap duration', () => {
    const dir = join(tmpdir(), `wellbeing-null-selection-${Date.now()}`); dirs.push(dir); const db = openDatabase(dir); const stamp = '2026-09-29T12:00:00.000Z';
    db.prepare("INSERT INTO sessions(id,kind,local_date,timezone,provenance,created_at_utc,updated_at_utc,actor_id) VALUES('selection-session','overnight','2026-09-28','UTC','explicit',?,?,?)").run(stamp, stamp, 'test');
    createEvent(db, { id: 'low-duration', eventType: 'duration_report', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 300, sessionId: 'selection-session', metricOverrides: { durationMinutes: { value: 300, basis: 'user_report' } } }, 'test');
    createEvent(db, { id: 'authoritative-null', eventType: 'duration_report', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: null, sessionId: 'selection-session', metricOverrides: { durationMinutes: { value: null, basis: 'explicit_user_correction' } } }, 'test');
    createEvent(db, { id: 'nap-duration', eventType: 'nap', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 30 }, 'test');
    const result = trends(db, 7, new Date(stamp));
    expect(result.totalReportedSleepMinutes).toBe(30);
    expect(result.coverage.byMetric.reportedDurationDays).toBe(1);
    expect(result.napCount).toBe(1); db.close();
  });

  it('does not guess conflicting or orphan nap endpoint pairings', () => {
    const dir = join(tmpdir(), `wellbeing-nap-pairing-${Date.now()}`); dirs.push(dir); const db = openDatabase(dir); const stamp = '2026-09-29T12:00:00.000Z';
    db.prepare("INSERT INTO sessions(id,kind,local_date,timezone,provenance,created_at_utc,updated_at_utc,actor_id) VALUES('orphan-session','nap','2026-09-28','UTC','explicit',?,?,?)").run(stamp, stamp, 'test');
    createEvent(db, { id: 'orphan-start', eventType: 'nap_start', localDate: '2026-09-28', timezone: 'UTC', startAtLocal: '2026-09-28T13:00', localOffset: '+00:00', sessionId: 'orphan-session' }, 'test');
    createEvent(db, { id: 'ambiguous-end', eventType: 'nap_end', localDate: '2026-09-28', timezone: 'UTC', endAtLocal: '2026-09-28T14:00', endLocalOffset: '+00:00', sessionId: 'orphan-session' }, 'test');
    createEvent(db, { id: 'second-end', eventType: 'nap_end', localDate: '2026-09-28', timezone: 'UTC', endAtLocal: '2026-09-28T15:00', endLocalOffset: '+00:00', sessionId: 'orphan-session' }, 'test');
    const result = trends(db, 7, new Date(stamp));
    expect(result.napCount).toBe(0); expect(result.elapsedWindows.every((window: any) => window.elapsedMinutes == null)).toBe(true); db.close();
  });

  it('uses local calendar windows and clamps spanning note coverage', () => {
    const dir = join(tmpdir(), `wellbeing-local-window-${Date.now()}`); dirs.push(dir); const db = openDatabase(dir);
    db.prepare("INSERT INTO notes(id,body,range_start,range_end,created_at_utc,updated_at_utc,actor_id) VALUES('wide-note','synthetic','2026-09-01','2026-12-31',?,?,?)").run('2026-09-29T12:00:00.000Z','2026-09-29T12:00:00.000Z','test');
    const result = trends(db, 7, new Date('2026-09-29T23:30:00.000Z'), 'America/Los_Angeles');
    expect(result.windowEnd).toBe('2026-09-29'); expect(result.coverage.daysWithRecords).toBeLessThanOrEqual(7); expect(result.latestRecordDate).toBe('2026-09-29'); db.close();
  });
  it('accepts a valid one-sided UTC uncertainty range through the API', async () => {
    const { app, owner } = await ownerApp();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: eventBody({ id: 'uncertainty-one-sided-valid', uncertainty: { earliestLocal: '2026-09-28T01:00', earliestOffset: '+00:00' } }) });
      expect(response.statusCode).toBe(201);
    } finally { await app.close(); }
  });

  it('rejects a supplied one-sided nonexistent New York uncertainty endpoint', async () => {
    const { app, owner } = await ownerApp();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: eventBody({ id: 'uncertainty-one-sided-gap', timezone: 'America/New_York', uncertainty: { earliestLocal: '2026-03-08T02:30', earliestOffset: '-05:00' } }) });
      expect(response.statusCode).toBe(422);
    } finally { await app.close(); }
  });

  it('uses one selected duration for aggregate and daily series and filters dated naps', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-trend-corrections-')); dirs.push(dir);
    const db = openDatabase(dir); const stamp = '2026-09-29T12:00:00.000Z';
    db.prepare("INSERT INTO sessions(id,kind,local_date,timezone,provenance,created_at_utc,updated_at_utc,actor_id) VALUES('old-nap','nap','2000-01-01','UTC','explicit',?,?,?)").run(stamp, stamp, 'test');
    db.prepare("INSERT INTO sessions(id,kind,local_date,timezone,provenance,created_at_utc,updated_at_utc,actor_id) VALUES('current-nap','nap','2026-09-28','UTC','explicit',?,?,?)").run(stamp, stamp, 'test');
    createEvent(db, { id: 'duration-user', eventType: 'sleep_duration', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 100, sessionId: 'current-nap', metricOverrides: { durationMinutes: { value: 100, basis: 'user_report' } } }, 'test');
    createEvent(db, { id: 'duration-correction', eventType: 'duration_report', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 200, sessionId: 'current-nap', metricOverrides: { durationMinutes: { value: 200, basis: 'explicit_user_correction' } } }, 'test');
    createEvent(db, { id: 'old-nap-event', eventType: 'nap', localDate: '2000-01-01', timezone: 'UTC', durationMinutes: 20, sessionId: 'old-nap' }, 'test');
    createEvent(db, { id: 'current-nap-event', eventType: 'nap', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 20, sessionId: 'current-nap' }, 'test');
    const result = trends(db, 7, new Date(stamp));
    expect(result.totalReportedSleepMinutes).toBe(200);
    expect(result.series.find((row) => row.date === '2026-09-28')?.durationMinutes).toBe(200);
    expect(result.napCount).toBe(1);
    db.close();
  });

  it('derives an explicit grouped onset-to-wake elapsed window from separate members', async () => {
    const { app, owner } = await ownerApp();
    try {
      for (const event of [
        { id: 'onset-member', eventType: 'sleep_onset', startAtLocal: '2026-09-28T23:00', localOffset: '+00:00' },
        { id: 'wake-member', eventType: 'final_wake', endAtLocal: '2026-09-29T07:00', endLocalOffset: '+00:00' },
      ]) {
        const response = await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: eventBody({ ...event, localDate: '2026-09-28' }) });
        expect(response.statusCode).toBe(201);
      }
      const grouped = await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: owner, payload: { kind: 'overnight', localDate: '2026-09-28', timezone: 'UTC', events: [{ id: 'onset-member', expectedRevision: 1 }, { id: 'wake-member', expectedRevision: 1 }] } });
      expect(grouped.statusCode).toBe(201);
      const result = trends(app.db, 7, new Date('2026-09-29T12:00:00.000Z'));
      expect(result.elapsedWindows).toEqual(expect.arrayContaining([expect.objectContaining({ elapsedMinutes: 480 })]));
    } finally { await app.close(); }
  });

  it('counts a note range that spans the entire trend window', () => {
    const dir = join(tmpdir(), `wellbeing-note-overlap-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir);
    const db = openDatabase(dir); const stamp = '2026-09-29T12:00:00.000Z';
    db.prepare("INSERT INTO notes(id,body,range_start,range_end,created_at_utc,updated_at_utc,actor_id) VALUES('spanning-note','synthetic','2026-01-01','2026-12-31',?,?,?)").run(stamp, stamp, 'test');
    expect(trends(db, 7, new Date(stamp)).coverage.daysWithRecords).toBeGreaterThan(0);
    db.close();
  });
});

describe('R04, R09, R10, and R11 importer regressions', () => {
  it('rejects exact imported times without timezone or offset and accepts normalized nested overrides', () => {
    const dir = join(tmpdir(), `wellbeing-import-normalize-${Date.now()}`); dirs.push(dir); const db = openDatabase(dir);
    expect(() => importLegacyFiles(db, [{ name: 'missing-zone.md', content: legacyFile('missing-zone', 'start_at_local: 2026-09-28T01:00\nlocal_offset: +00:00\n', '', 'sleep_onset', false) }])).toThrow(/timezone/i);
    const valid = legacyFile('nested-override', 'metric_overrides: { durationMinutes: { value: 45, basis: explicit_user_correction }, restedness: { value: null, basis: explicit_user_correction } }\n');
    expect(importLegacyFiles(db, [{ name: 'nested.md', content: valid }])).toEqual({ imported: 1, unchanged: 0 });
    const row = db.prepare('SELECT metric_overrides_json FROM events WHERE id=?').get('nested-override') as { metric_overrides_json: string }; expect(JSON.parse(row.metric_overrides_json).durationMinutes.value).toBe(45); expect(JSON.parse(row.metric_overrides_json).restedness.value).toBeNull(); db.close();
  });
  it('rejects a negative imported duration atomically', () => {
    const dir = join(tmpdir(), `wellbeing-import-negative-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir);
    expect(() => importLegacyFiles(db, [{ name: 'bad.md', content: legacyFile('bad-negative', 'duration_minutes: -1\n') }])).toThrow();
    expect((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n).toBe(0); db.close();
  });
  it('rejects a fractional imported duration atomically', () => {
    const dir = join(tmpdir(), `wellbeing-import-fraction-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir);
    expect(() => importLegacyFiles(db, [{ name: 'bad.md', content: legacyFile('bad-fraction', 'duration_minutes: 1.5\n') }])).toThrow(); db.close();
  });
  it('rejects an out-of-range imported restedness value', () => {
    const dir = join(tmpdir(), `wellbeing-import-rested-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir);
    expect(() => importLegacyFiles(db, [{ name: 'bad.md', content: legacyFile('bad-rested', 'numeric_value: 11\n', '', 'restedness') }])).toThrow(); db.close();
  });
  it('rejects invalid imported dates and zones before commit', () => {
    const dir = join(tmpdir(), `wellbeing-import-date-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir);
    expect(() => importLegacyFiles(db, [{ name: 'bad-date.md', content: legacyFile('bad-date', 'local_date: 2026-99-99\ntimezone: UTC\n', '', 'duration_report', false) }])).toThrow();
    expect(() => importLegacyFiles(db, [{ name: 'bad-zone.md', content: legacyFile('bad-zone', 'local_date: 2026-09-28\ntimezone: Not/AZone\n', '', 'duration_report', false) }])).toThrow(); db.close();
  });
  it('rejects imported nonexistent local times and malformed overrides', () => {
    const dir = join(tmpdir(), `wellbeing-import-time-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir);
    expect(() => importLegacyFiles(db, [{ name: 'bad-time.md', content: legacyFile('bad-time', 'local_date: 2026-03-08\ntimezone: America/New_York\nstart_at_local: 2026-03-08T02:30\nlocal_offset: -05:00\n', '', 'sleep_onset', false) }])).toThrow();
    expect(() => importLegacyFiles(db, [{ name: 'bad-override.md', content: legacyFile('bad-override', 'metric_overrides: { durationMinutes: { value: -2, basis: explicit_user_correction } }\n') }])).toThrow(); db.close();
  });

  it('accepts valid offset-less UTC exact times for legacy compatibility', () => {
    const dir = join(tmpdir(), `wellbeing-import-utc-exact-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir);
    const content = legacyFile('utc-exact', 'start_at_local: 2026-02-28T10:00\nend_at_local: 2026-02-28T11:00\n', '', 'sleep_onset');
    expect(importLegacyFiles(db, [{ name: 'utc-exact.md', content }])).toEqual({ imported: 1, unchanged: 0 });
    expect((db.prepare('SELECT start_at_local,end_at_local,raw_legacy FROM events WHERE id=?').get('utc-exact') as Record<string, unknown>)).toMatchObject({ start_at_local: '2026-02-28T10:00', end_at_local: '2026-02-28T11:00', raw_legacy: content }); db.close();
  });

  it.each([
    ['invalid UTC calendar start', 'start_at_local: 2026-02-30T10:00\n'],
    ['invalid UTC calendar end', 'end_at_local: 2026-02-30T10:00\n'],
    ['reversed UTC interval', 'start_at_local: 2026-02-28T11:00\nend_at_local: 2026-02-28T10:00\n'],
    ['start offset without start', 'local_offset: +00:00\n'],
    ['end offset without end', 'end_local_offset: +00:00\n'],
    ['invalid reported timestamp calendar', 'reported_at_utc: 2026-02-30T10:00:00Z\n'],
    ['invalid created timestamp calendar', 'created_at_utc: 2026-02-30T10:00:00Z\n'],
  ])('rejects %s without coercing or persisting', (_label, fields) => {
    const dir = join(tmpdir(), `wellbeing-import-time-integrity-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir);
    expect(() => importLegacyFiles(db, [{ name: `${String(_label)}.md`, content: legacyFile(`bad-${String(_label)}`, fields, '', 'sleep_onset') }])).toThrow();
    expect((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n).toBe(0); db.close();
  });

  it.each([
    ['empty duration', 'duration_minutes: ""\n'],
    ['whitespace duration', 'duration_minutes: "   "\n'],
    ['array duration', 'duration_minutes: []\n'],
    ['mapping duration', 'duration_minutes: { nested: 1 }\n'],
  ])('rejects %s rather than converting it to zero', (_label, fields) => {
    const dir = join(tmpdir(), `wellbeing-import-number-integrity-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir);
    expect(() => importLegacyFiles(db, [{ name: `${String(_label)}.md`, content: legacyFile(`bad-number-${String(_label)}`, fields) }])).toThrow(/numeric|duration/i);
    expect((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n).toBe(0); db.close();
  });

  it('rolls back a mixed valid UTC exact and invalid timestamp batch atomically', () => {
    const dir = join(tmpdir(), `wellbeing-import-time-rollback-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir);
    const valid = legacyFile('good-utc-exact', 'start_at_local: 2026-02-28T10:00\nend_at_local: 2026-02-28T11:00\n', '', 'sleep_onset');
    const invalid = legacyFile('bad-timestamp', 'reported_at_utc: 2026-02-30T10:00:00Z\n');
    expect(() => importLegacyFiles(db, [{ name: 'good.md', content: valid }, { name: 'bad.md', content: invalid }])).toThrow();
    expect((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n).toBe(0); expect((db.prepare('SELECT count(*) AS n FROM event_revisions').get() as { n: number }).n).toBe(0); db.close();
  });
  it('preserves exact raw, lexical, leading-zero, and unknown imported values', () => {
    const dir = join(tmpdir(), `wellbeing-import-raw-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir);
    const raw = legacyFile('raw-preserved', 'duration_minutes: null\nsource_reference: "0007"\nunknown_field: 2026-09-28\n', 'Body text.\n');
    expect(importLegacyFiles(db, [{ name: 'raw.md', content: raw }])).toEqual({ imported: 1, unchanged: 0 });
    const row = db.prepare('SELECT raw_legacy,source_reference,legacy_unknown_json,duration_minutes FROM events WHERE id=?').get('raw-preserved') as Record<string, unknown>;
    expect(row.raw_legacy).toBe(raw); expect(row.source_reference).toBe('0007'); expect(row.legacy_unknown_json).toContain('unknown_field'); expect(row.duration_minutes).toBeNull(); db.close();
  });
  it('rolls back every member of a mixed valid-invalid import batch', () => {
    const dir = join(tmpdir(), `wellbeing-import-rollback-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir);
    const good = legacyFile('good-batch', 'duration_minutes: 30\n'); const bad = legacyFile('bad-batch', 'duration_minutes: -1\n');
    expect(() => importLegacyFiles(db, [{ name: 'good.md', content: good }, { name: 'bad.md', content: bad }])).toThrow();
    expect((db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n).toBe(0); db.close();
  });
  it('maps a null frontmatter sentinel before body fallback', () => {
    const dir = join(tmpdir(), `wellbeing-import-null-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir);
    const content = legacyFile('null-body', 'duration_minutes: null\n', '## Observation\nduration_minutes: 345\n');
    expect(importLegacyFiles(db, [{ name: 'null-body.md', content }])).toEqual({ imported: 1, unchanged: 0 });
    expect((db.prepare('SELECT duration_minutes FROM events WHERE id=?').get('null-body') as { duration_minutes: number }).duration_minutes).toBe(345); db.close();
  });

  it('returns the authenticated actor separately from legacy source attribution', async () => {
    const { app, owner } = await ownerApp();
    try {
      const imported = await app.inject({ method: 'POST', url: '/api/v1/imports/legacy', headers: owner, payload: { files: [{ name: 'actor.md', content: legacyFile('actor-import', 'duration_minutes: 20\nsource: legacy_file\n') }] } });
      expect(imported.statusCode).toBe(200);
      const event = await app.inject({ method: 'GET', url: '/api/v1/events/actor-import', headers: owner });
      expect(event.json().actorId).toMatch(/^owner:/);
      expect(event.json().source).toBe('legacy_file');
    } finally { await app.close(); }
  });

  it('returns a structured sanitized error for malformed imports and leaves counts unchanged', async () => {
    const { app, owner } = await ownerApp();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/v1/imports/legacy', headers: owner, payload: { files: [{ name: 'safe-name.md', content: 'not frontmatter' }] } });
      expect([400, 422]).toContain(response.statusCode); expect(response.json()).toHaveProperty('code'); expect(response.body).not.toContain('not frontmatter');
      expect((app.db.prepare('SELECT count(*) AS n FROM events').get() as { n: number }).n).toBe(0);
    } finally { await app.close(); }
  });
});

describe('R05, R12, R15, and R16 persistence/privacy regressions', () => {
  it('reports summary freshness through generation, invalidation, and refresh', () => {
    const dir = join(tmpdir(), `wellbeing-summary-freshness-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir);
    expect(trends(db, 7, new Date('2026-09-29T12:00:00.000Z')).stale).toBe(false);
    db.prepare('UPDATE summaries SET stale_at_utc=?').run('2026-09-29T12:01:00.000Z');
    expect((db.prepare('SELECT stale_at_utc FROM summaries WHERE window_days=7').get() as { stale_at_utc: string | null }).stale_at_utc).not.toBeNull();
    expect(trends(db, 7, new Date('2026-09-29T12:00:00.000Z')).stale).toBe(false);
    expect((db.prepare('SELECT stale_at_utc FROM summaries WHERE window_days=7').get() as { stale_at_utc: string | null }).stale_at_utc).toBeNull(); db.close();
  });

  it('uses current revisions and only contributing source records in summaries', () => {
    const dir = join(tmpdir(), `wellbeing-summary-refs-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir);
    const stamp = '2026-09-29T12:00:00.000Z';
    db.prepare("INSERT INTO sessions(id,kind,local_date,timezone,provenance,created_at_utc,updated_at_utc,actor_id) VALUES('ref-session','overnight','2026-09-28','UTC','explicit',?,?,?)").run(stamp, stamp, 'test');
    createEvent(db, { id: 'ref-event', eventType: 'sleep_duration', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 30, sessionId: 'ref-session' }, 'test');
    db.prepare('UPDATE sessions SET current_revision=4 WHERE id=?').run('ref-session');
    db.prepare("INSERT INTO notes(id,body,range_start,range_end,current_revision,created_at_utc,updated_at_utc,actor_id) VALUES('contributing-note','note','2026-09-28','2026-09-29',3,?,?,?)").run(stamp, stamp, 'test');
    db.prepare("INSERT INTO notes(id,body,range_start,range_end,current_revision,created_at_utc,updated_at_utc,actor_id) VALUES('outside-note','note','2020-01-01','2020-01-02',8,?,?,?)").run(stamp, stamp, 'test');
    const refs = trends(db, 7, new Date(stamp)).sourceRevisionRefs;
    expect(refs).toEqual(expect.arrayContaining([expect.objectContaining({ sessionId: 'ref-session', revision: 4 }), expect.objectContaining({ noteId: 'contributing-note', revision: 3 })]));
    expect(refs).not.toEqual(expect.arrayContaining([expect.objectContaining({ noteId: 'outside-note', revision: 8 }), expect.objectContaining({ noteId: 'contributing-note', revision: 1 }), expect.objectContaining({ sessionId: 'ref-session', revision: 1 })])); db.close();
  });

  it('does not turn an undated note into dated trend coverage and uses one-sided dates literally', () => {
    const dir = join(tmpdir(), `wellbeing-note-date-semantics-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir); const stamp = '2026-09-29T12:00:00.000Z';
    db.prepare("INSERT INTO notes(id,body,current_revision,created_at_utc,updated_at_utc,actor_id) VALUES('undated-note','undated',1,?,?,?)").run(stamp, stamp, 'test');
    db.prepare("INSERT INTO notes(id,body,range_start,current_revision,created_at_utc,updated_at_utc,actor_id) VALUES('one-sided-start','start only','2026-09-27',1,?,?,?)").run(stamp, stamp, 'test');
    db.prepare("INSERT INTO notes(id,body,range_end,current_revision,created_at_utc,updated_at_utc,actor_id) VALUES('one-sided-end','end only','2026-09-29',1,?,?,?)").run(stamp, stamp, 'test');
    const result = trends(db, 7, new Date(stamp));
    expect(result.coverage.daysWithRecords).toBe(2); expect(result.latestRecordDate).toBe('2026-09-29');
    expect(result.sourceRevisionRefs).toEqual(expect.arrayContaining([expect.objectContaining({ noteId: 'one-sided-start' }), expect.objectContaining({ noteId: 'one-sided-end' })]));
    expect(result.sourceRevisionRefs).not.toEqual(expect.arrayContaining([expect.objectContaining({ noteId: 'undated-note' })])); db.close();
  });

  it('retains restedness disagreement contributors and does not count a null-selected nap duration', () => {
    const dir = join(tmpdir(), `wellbeing-restedness-nap-selection-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir); const stamp = '2026-09-29T12:00:00.000Z';
    db.prepare("INSERT INTO sessions(id,kind,local_date,timezone,provenance,created_at_utc,updated_at_utc,actor_id) VALUES('rested-session','overnight','2026-09-28','UTC','explicit',?,?,?)").run(stamp, stamp, 'test');
    createEvent(db, { id: 'rested-a', eventType: 'restedness', localDate: '2026-09-28', timezone: 'UTC', numericValue: 5, source: 'user_report', sessionId: 'rested-session' }, 'test');
    createEvent(db, { id: 'rested-b', eventType: 'restedness', localDate: '2026-09-28', timezone: 'UTC', numericValue: 7, source: 'user_report', sessionId: 'rested-session' }, 'test');
    createEvent(db, { id: 'null-selected-nap', eventType: 'nap', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 25, metricOverrides: { durationMinutes: { value: null, basis: 'explicit_user_correction' } } }, 'test');
    const result = trends(db, 7, new Date(stamp)); const rested = result.selectedMetrics.find((item: any) => item.metric === 'restedness');
    expect(rested).toMatchObject({ value: null, disagreement: true }); expect(rested.provenance.map((item: any) => item.eventId)).toEqual(expect.arrayContaining(['rested-a', 'rested-b'])); expect(result.disagreements).toEqual(expect.arrayContaining(['rested-a', 'rested-b'])); expect(result.napCount).toBe(0); db.close();
  });

  it('retains both active endpoints in ambiguous grouped-window provenance', () => {
    const dir = join(tmpdir(), `wellbeing-window-provenance-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir); const stamp = '2026-09-29T12:00:00.000Z';
    db.prepare("INSERT INTO sessions(id,kind,local_date,timezone,provenance,created_at_utc,updated_at_utc,actor_id) VALUES('ambiguous-window','overnight','2026-09-28','UTC','explicit',?,?,?)").run(stamp, stamp, 'test');
    createEvent(db, { id: 'window-start', eventType: 'sleep_onset', localDate: '2026-09-28', timezone: 'UTC', startAtLocal: '2026-09-28T23:00', localOffset: '+00:00', sessionId: 'ambiguous-window' }, 'test');
    createEvent(db, { id: 'window-end', eventType: 'final_wake', localDate: '2026-09-29', timezone: 'UTC', endAtLocal: '2026-09-29T07:00', endLocalOffset: '+00:00', sessionId: 'ambiguous-window' }, 'test');
    db.prepare("UPDATE events SET end_local_offset='-01:00' WHERE id='window-end'").run();
    const result = trends(db, 7, new Date(stamp));
    expect(result.elapsedWindows).toEqual(expect.arrayContaining([expect.objectContaining({ eventId: 'ambiguous-window', disagreement: true })])); expect(result.sourceRevisionRefs).toEqual(expect.arrayContaining([expect.objectContaining({ eventId: 'window-start' }), expect.objectContaining({ eventId: 'window-end' })])); db.close();
  });

  it('anchors grouped and override-only duration to the session date for all aggregates', () => {
    const dir = join(tmpdir(), `wellbeing-anchor-selection-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir); const stamp = '2026-09-29T12:00:00.000Z';
    db.prepare("INSERT INTO sessions(id,kind,local_date,timezone,provenance,created_at_utc,updated_at_utc,actor_id) VALUES('in-window','overnight','2026-09-28','UTC','explicit',?,?,?)").run(stamp, stamp, 'test');
    db.prepare("INSERT INTO sessions(id,kind,local_date,timezone,provenance,created_at_utc,updated_at_utc,actor_id) VALUES('out-window','overnight','2020-01-01','UTC','explicit',?,?,?)").run(stamp, stamp, 'test');
    createEvent(db, { id: 'cross-midnight-member', eventType: 'duration_report', localDate: '2026-09-27', timezone: 'UTC', durationMinutes: null, sessionId: 'in-window', metricOverrides: { durationMinutes: { value: 80, basis: 'wearable_estimate' } } }, 'test');
    createEvent(db, { id: 'out-window-member', eventType: 'duration_report', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 900, sessionId: 'out-window' }, 'test');
    const result = trends(db, 7, new Date(stamp));
    expect(result.totalReportedSleepMinutes).toBe(80); expect(result.averageReportedDurationMinutes).toBe(80); expect(result.series.find((row) => row.date === '2026-09-28')?.durationMinutes).toBe(80); expect(result.series.find((row) => row.date === '2026-09-27')?.durationMinutes).toBeNull(); expect(result.coverage.byMetric.reportedDurationDays).toBe(1); db.close();
  });

  it('treats equal-priority disagreement as unknown and maps non-user bases', () => {
    const dir = join(tmpdir(), `wellbeing-metric-tie-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir); const stamp = '2026-09-29T12:00:00.000Z';
    db.prepare("INSERT INTO sessions(id,kind,local_date,timezone,provenance,created_at_utc,updated_at_utc,actor_id) VALUES('tie-session','overnight','2026-09-28','UTC','explicit',?,?,?)").run(stamp, stamp, 'test');
    createEvent(db, { id: 'wearable-value', eventType: 'duration_report', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 60, source: 'wearable_estimate', sessionId: 'tie-session' }, 'test');
    createEvent(db, { id: 'user-value', eventType: 'duration_report', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 40, source: 'user_report', sessionId: 'tie-session' }, 'test');
    const one = trends(db, 7, new Date(stamp)); expect(one.totalReportedSleepMinutes).toBe(60); expect(one.selectedMetrics).toEqual(expect.arrayContaining([expect.objectContaining({ value: 60, basis: 'wearable_estimate' })]));
    createEvent(db, { id: 'wearable-disagreement', eventType: 'duration_report', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 70, source: 'wearable_estimate', sessionId: 'tie-session' }, 'test');
    const two = trends(db, 7, new Date(stamp)); expect(two.totalReportedSleepMinutes).toBeNull(); expect(two.disagreements).toContain('wearable-value'); db.close();
  });

  it('does not let an absent base value hide a known value at the same priority', () => {
    const dir = join(tmpdir(), `wellbeing-metric-null-base-${Date.now()}`); dirs.push(dir); const db = openDatabase(dir); const stamp = '2026-09-29T12:00:00.000Z';
    db.prepare("INSERT INTO sessions(id,kind,local_date,timezone,provenance,created_at_utc,updated_at_utc,actor_id) VALUES('null-base-session','overnight','2026-09-28','UTC','explicit',?,?,?)").run(stamp, stamp, 'test');
    createEvent(db, { id: 'absent-base', eventType: 'duration_report', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: null, notes: 'unknown', source: 'user_report', sessionId: 'null-base-session' }, 'test');
    createEvent(db, { id: 'known-base', eventType: 'duration_report', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 45, source: 'user_report', sessionId: 'null-base-session' }, 'test');
    expect(trends(db, 7, new Date(stamp)).totalReportedSleepMinutes).toBe(45); db.close();
  });

  it('counts only supported completed windows and emits nap/timing null gaps', () => {
    const dir = join(tmpdir(), `wellbeing-window-semantics-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir); const stamp = '2026-09-29T12:00:00.000Z';
    createEvent(db, { id: 'bedtime-intention', eventType: 'bedtime_intent', localDate: '2026-09-28', timezone: 'UTC', startAtLocal: '2026-09-28T22:00', endAtLocal: '2026-09-28T22:30', localOffset: '+00:00', endLocalOffset: '+00:00' }, 'test');
    db.prepare("INSERT INTO sessions(id,kind,local_date,timezone,provenance,created_at_utc,updated_at_utc,actor_id) VALUES('completed-nap','nap','2026-09-28','UTC','explicit',?,?,?)").run(stamp, stamp, 'test');
    createEvent(db, { id: 'nap-start', eventType: 'nap_start', localDate: '2026-09-28', timezone: 'UTC', startAtLocal: '2026-09-28T13:00', localOffset: '+00:00', sessionId: 'completed-nap' }, 'test');
    createEvent(db, { id: 'nap-end', eventType: 'nap_end', localDate: '2026-09-28', timezone: 'UTC', endAtLocal: '2026-09-28T14:00', endLocalOffset: '+00:00', sessionId: 'completed-nap' }, 'test');
    const result = trends(db, 7, new Date(stamp)); const day = result.series.find((row) => row.date === '2026-09-28');
    expect(result.napCount).toBe(1); expect(result.elapsedWindows).toEqual(expect.arrayContaining([expect.objectContaining({ eventId: 'completed-nap', elapsedMinutes: 60 })])); expect(result.elapsedWindows).not.toEqual(expect.arrayContaining([expect.objectContaining({ eventId: 'bedtime-intention' })])); expect(day).toMatchObject({ napCount: 1 }); expect(day).toHaveProperty('onsetLocal', '2026-09-28T13:00'); db.close();
  });

  it('normalizes nullable importer values, allows prose-only unknown time, and rejects reversed uncertainty', () => {
    const dir = join(tmpdir(), `wellbeing-import-uncertainty-${Date.now()}`); dirs.push(dir); const db = openDatabase(dir);
    const prose = legacyFile('prose-uncertainty', 'local_date: null\nuncertainty: { prose: "around bedtime" }\n', '', 'duration_report', false);
    expect(importLegacyFiles(db, [{ name: 'prose.md', content: prose }])).toEqual({ imported: 1, unchanged: 0 });
    const reversed = legacyFile('reversed-uncertainty', 'timezone: UTC\nuncertainty: { earliestLocal: "2026-09-29T10:00", earliestOffset: "+00:00", latestLocal: "2026-09-28T10:00", latestOffset: "+00:00" }\n', '', 'duration_report', false);
    expect(() => importLegacyFiles(db, [{ name: 'reversed.md', content: reversed }])).toThrow(/uncertainty/i); expect((db.prepare('SELECT local_date,timezone FROM events WHERE id=?').get('prose-uncertainty') as Record<string, unknown>)).toMatchObject({ local_date: null, timezone: null }); db.close();
  });

  it('rolls back imported data if summary invalidation fails inside the transaction', () => {
    const dir = join(tmpdir(), `wellbeing-import-summary-rollback-${Date.now()}`); dirs.push(dir); const db = openDatabase(dir);
    trends(db, 7, new Date('2026-09-29T12:00:00.000Z')); db.exec("CREATE TRIGGER fail_import_summary BEFORE UPDATE OF stale_at_utc ON summaries BEGIN SELECT RAISE(ABORT, 'synthetic summary failure'); END");
    expect(() => importLegacyFiles(db, [{ name: 'rollback.md', content: legacyFile('rollback-import', 'duration_minutes: 20\n') }])).toThrow(); expect((db.prepare("SELECT count(*) AS n FROM events WHERE id='rollback-import'").get() as { n: number }).n).toBe(0); expect((db.prepare("SELECT count(*) AS n FROM legacy_import_files WHERE event_id='rollback-import'").get() as { n: number }).n).toBe(0); db.close();
  });

  it('rejects arbitrary default authorities rather than matching a loopback prefix', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-authority-port-')); dirs.push(dir); const app = await buildApp({ dataDir: dir, secureCookies: false });
    try { const response = await app.inject({ method: 'GET', url: '/api/v1/health', headers: { host: 'localhost:9999' } }); expect(response.statusCode).toBe(403); } finally { await app.close(); }
  });

  it('rejects trusted Origin paired with an untrusted Host for reads and mutations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-host-authority-')); dirs.push(dir); const app = await buildApp({ dataDir: dir, secureCookies: false, allowedOrigin: 'http://localhost:8787' });
    try { const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: { origin: 'http://localhost:8787', host: 'evil.invalid' }, payload: { username: 'owner', password: 'synthetic correction password' } }); expect(setup.statusCode).toBe(403); } finally { await app.close(); }
  });

  it('validates note and session dates/zones through shared schemas', async () => {
    const { app, owner } = await ownerApp();
    try {
      expect((await app.inject({ method: 'POST', url: '/api/v1/notes', headers: owner, payload: { body: 'bad', rangeStart: '2026-02-30' } })).statusCode).toBe(400);
      const event = await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: eventBody({ id: 'schema-session-event' }) });
      expect((await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: owner, payload: { kind: 'nap', localDate: '2026-02-30', timezone: 'Not/AZone', events: [{ id: 'schema-session-event', expectedRevision: 1 }] } })).statusCode).toBe(400); expect(event.statusCode).toBe(201);
    } finally { await app.close(); }
  });

  it('invalidates summaries from note create and edit', async () => {
    const { app, owner } = await ownerApp();
    try { await app.inject({ method: 'GET', url: '/api/v1/trends/7', headers: owner }); const created = await app.inject({ method: 'POST', url: '/api/v1/notes', headers: owner, payload: { body: 'coverage note' } }); expect(created.statusCode).toBe(201); expect((app.db.prepare('SELECT count(*) AS n FROM summaries WHERE stale_at_utc IS NOT NULL').get() as {n:number}).n).toBeGreaterThan(0); } finally { await app.close(); }
  });
  it('rejects hostile Host/origin setup before an owner exists', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-origin-')); dirs.push(dir); const app = await buildApp({ dataDir: dir, secureCookies: false });
    try { expect((await app.inject({ method: 'POST', url: '/api/v1/auth/setup', headers: { host: 'attacker.invalid', origin: 'http://attacker.invalid' }, payload: { username: 'owner', password: 'synthetic correction password' } })).statusCode).toBe(403); } finally { await app.close(); }
  });
  it('marks authenticated journal reads no-store', async () => {
    const { app, owner } = await ownerApp();
    try { expect((await app.inject({ method: 'GET', url: '/api/v1/events', headers: owner })).headers['cache-control']).toMatch(/no-store/i); } finally { await app.close(); }
  });
  it('invalidates summaries when an import changes domain data', async () => {
    const { app, owner } = await ownerApp();
    try { await app.inject({ method: 'GET', url: '/api/v1/trends/7', headers: owner }); await app.inject({ method: 'POST', url: '/api/v1/imports/legacy', headers: owner, payload: { files: [{ name: 'summary.md', content: legacyFile('summary-import', 'duration_minutes: 20\n') }] } }); expect((app.db.prepare('SELECT count(*) AS n FROM summaries WHERE stale_at_utc IS NOT NULL').get() as { n: number }).n).toBeGreaterThan(0); } finally { await app.close(); }
  });
  it('invalidates summaries when a session edit changes grouping', async () => {
    const { app, owner } = await ownerApp();
    try {
      const created = await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: eventBody({ id: 'session-edit-event' }) });
      const grouped = await app.inject({ method: 'POST', url: '/api/v1/sessions', headers: owner, payload: { kind: 'overnight', localDate: '2026-09-28', timezone: 'UTC', events: [{ id: 'session-edit-event', expectedRevision: 1 }] } });
      await app.inject({ method: 'GET', url: '/api/v1/trends/7', headers: owner });
      const session = grouped.json(); const edited = await app.inject({ method: 'PUT', url: `/api/v1/sessions/${session.id}`, headers: owner, payload: { expectedRevision: 1, kind: 'nap', reason: 'synthetic edit' } });
      expect(created.statusCode).toBe(201); expect(edited.statusCode).toBe(200); expect((app.db.prepare('SELECT count(*) AS n FROM summaries WHERE stale_at_utc IS NOT NULL').get() as { n: number }).n).toBeGreaterThan(0);
    } finally { await app.close(); }
  });
  it('bounds repeated summary persistence for repeated reads', () => {
    const dir = join(tmpdir(), `wellbeing-summary-bound-${Date.now()}-${Math.random().toString(16).slice(2)}`); dirs.push(dir); const db = openDatabase(dir);
    trends(db, 7, new Date('2026-09-29T12:00:00.000Z')); trends(db, 7, new Date('2026-09-29T12:00:00.000Z')); trends(db, 7, new Date('2026-09-29T12:00:00.000Z'));
    expect((db.prepare('SELECT count(*) AS n FROM summaries WHERE window_days=7').get() as { n: number }).n).toBeLessThanOrEqual(1); db.close();
  });
  it('expires an old idempotency record instead of replaying it forever', async () => {
    const { app, owner } = await ownerApp();
    try {
      const first = await app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...owner, 'idempotency-key': 'expired-key' }, payload: eventBody({ id: 'expired-one' }) });
      expect(first.statusCode).toBe(201); app.db.prepare("UPDATE idempotency SET created_at_utc='2000-01-01T00:00:00.000Z'").run();
      const retry = await app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...owner, 'idempotency-key': 'expired-key' }, payload: eventBody({ id: 'expired-two' }) });
      expect(retry.statusCode).toBe(201); expect(retry.json().id).toBe('expired-two');
    } finally { await app.close(); }
  });
  it('retains idempotency responses inside 24 hours and reclaims them after expiry', async () => {
    const { app, owner } = await ownerApp();
    try {
      const headers = { ...owner, 'idempotency-key': 'retention-boundary' }; const first = await app.inject({ method: 'POST', url: '/api/v1/events', headers, payload: eventBody({ id: 'retained-boundary' }) }); expect(first.statusCode).toBe(201);
      app.db.prepare("UPDATE idempotency SET created_at_utc=?").run(new Date(Date.now() - 24 * 60 * 60 * 1000 + 1000).toISOString()); const replay = await app.inject({ method: 'POST', url: '/api/v1/events', headers, payload: eventBody({ id: 'retained-boundary' }) }); expect(replay.json().id).toBe('retained-boundary');
      app.db.prepare("UPDATE idempotency SET created_at_utc=?").run(new Date(Date.now() - 24 * 60 * 60 * 1000 - 1000).toISOString()); const expired = await app.inject({ method: 'POST', url: '/api/v1/events', headers, payload: eventBody({ id: 'after-boundary' }) }); expect(expired.statusCode).toBe(201); expect(expired.json().id).toBe('after-boundary');
    } finally { await app.close(); }
  });
  it('does not evict valid idempotency responses at capacity and allows their replay', async () => {
    const { app, owner } = await ownerApp();
    try {
      const payload = eventBody({ id: 'capacity-replay' }); const replayHeaders = { ...owner, 'idempotency-key': 'capacity-replay-key' };
      expect((await app.inject({ method: 'POST', url: '/api/v1/events', headers: replayHeaders, payload })).statusCode).toBe(201);
      const actorId = (app.db.prepare('SELECT actor_id FROM idempotency LIMIT 1').get() as { actor_id: string }).actor_id;
      const fill = app.db.prepare('INSERT INTO idempotency(actor_id,operation,key,payload_hash,status_code,response_json,created_at_utc) VALUES(?,?,?,?,?,?,?)');
      app.db.exec('BEGIN'); for (let index = 0; index < 9_999; index++) fill.run(actorId, `fill:${index}`, `fill-key:${index}`, `hash:${index}`, 201, '{}', new Date().toISOString()); app.db.exec('COMMIT');
      expect((await app.inject({ method: 'POST', url: '/api/v1/events', headers: replayHeaders, payload })).statusCode).toBe(201);
      const blocked = await app.inject({ method: 'POST', url: '/api/v1/events', headers: { ...owner, 'idempotency-key': 'capacity-new' }, payload: eventBody({ id: 'capacity-blocked' }) });
      expect(blocked.statusCode).toBe(503); expect((app.db.prepare("SELECT count(*) AS n FROM events WHERE id='capacity-blocked'").get() as { n: number }).n).toBe(0);
    } finally { await app.close(); }
  });
  it('checks OpenAPI templated paths, mutation bodies, security, and full patch fields', async () => {
    const { app, owner } = await ownerApp();
    try {
      const document = (await app.inject({ method: 'GET', url: '/api/v1/openapi.json' })).json();
      for (const [path, item] of Object.entries(document.paths)) for (const [method, operation] of Object.entries(item as Record<string, any>)) {
        if (!['get', 'post', 'put', 'delete'].includes(method)) continue;
        const op = operation as Record<string, any>;
        for (const name of path.matchAll(/\{([^}]+)\}/g)) expect(op.parameters).toEqual(expect.arrayContaining([expect.objectContaining({ in: 'path', name: name[1], required: true })]));
        if (['/events', '/events/{id}', '/sessions', '/sessions/{id}', '/notes', '/notes/{id}', '/credentials', '/imports/legacy', '/admin/backups'].includes(path) && ['post', 'put'].includes(method)) expect(op.requestBody?.content?.['application/json']?.schema).toBeDefined();
        if (!['/health', '/openapi.json', '/auth/status', '/auth/setup', '/auth/login'].includes(path)) expect(op.security).toBeDefined();
      }
      expect(document.components.schemas.EventPatch.properties.durationMinutes).toBeDefined();
      expect(document.components.schemas.EventPatch.properties.metricOverrides).toBeDefined();
      const confidence = document.components.schemas.EventInput.properties.confidence; expect(confidence.enum?.includes(null) || confidence.anyOf?.some((schema: { type?: string }) => schema.type === 'null')).toBe(true);
      const actual = await app.inject({ method: 'POST', url: '/api/v1/events', headers: owner, payload: eventBody({ id: 'contract-sample', sourceReference: 'synthetic-ref', confidence: null }) });
      expect(actual.statusCode).toBe(201); const sample = actual.json(); for (const field of ['id','eventType','timezone','durationMinutes','currentRevision','actorId']) expect(sample).toHaveProperty(field);
    } finally { await app.close(); }
  });
});
