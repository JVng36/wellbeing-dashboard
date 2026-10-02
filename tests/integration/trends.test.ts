import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase } from '../../src/server/db.js';
import { createEvent, trends } from '../../src/server/events.js';

describe('deterministic coverage-aware trends', () => {
  const dirs: string[] = [];
  afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
  it('separates duration and DST windows, preserves gaps, applies override priority, and counts a nap session once', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-trends-')); dirs.push(dir); const db = openDatabase(dir);
    const stamp = '2025-11-04T12:00:00.000Z';
    db.prepare("INSERT INTO sessions(id,kind,local_date,timezone,provenance,created_at_utc,updated_at_utc,actor_id) VALUES('duration-session','overnight','2025-11-02','America/New_York','explicit',?,?,?)").run(stamp, stamp, 'test');
    db.prepare("INSERT INTO sessions(id,kind,local_date,timezone,provenance,created_at_utc,updated_at_utc,actor_id) VALUES('nap-session','nap','2025-11-03','UTC','explicit',?,?,?)").run(stamp, stamp, 'test');
    createEvent(db, { id: 'duration-user', eventType: 'sleep_duration', localDate: '2025-11-02', timezone: 'America/New_York', durationMinutes: 100, sessionId: 'duration-session', metricOverrides: { durationMinutes: { value: 100, basis: 'user_report' } } }, 'test');
    createEvent(db, { id: 'duration-correction', eventType: 'duration_report', localDate: '2025-11-02', timezone: 'America/New_York', durationMinutes: 999, sessionId: 'duration-session', metricOverrides: { durationMinutes: { value: 200, basis: 'explicit_user_correction' } } }, 'test');
    createEvent(db, { id: 'dst-window', eventType: 'sleep_onset', localDate: '2025-11-02', timezone: 'America/New_York', startAtLocal: '2025-11-02T01:30', endAtLocal: '2025-11-02T01:30', localOffset: '-04:00', endLocalOffset: '-05:00' }, 'test');
    createEvent(db, { id: 'nap-start', eventType: 'nap_start', localDate: '2025-11-03', timezone: 'UTC', sessionId: 'nap-session', startAtLocal: '2025-11-03T13:00', localOffset: '+00:00' }, 'test');
    createEvent(db, { id: 'nap-end', eventType: 'nap_end', localDate: '2025-11-03', timezone: 'UTC', sessionId: 'nap-session', endAtLocal: '2025-11-03T13:30', endLocalOffset: '+00:00' }, 'test');
    db.prepare("INSERT INTO notes(id,body,range_start,range_end,created_at_utc,updated_at_utc,actor_id) VALUES('note-only','synthetic','2025-11-01','2025-11-01',?,?,?)").run(stamp, stamp, 'test');
    const result = trends(db, 7, new Date(stamp));
    expect(result.totalReportedSleepMinutes).toBe(200);
    expect(result.napCount).toBe(1);
    expect(result.elapsedWindows.find((row: any) => row.eventId === 'dst-window').elapsedMinutes).toBe(60);
    expect(result.coverage.daysWithRecords).toBeGreaterThanOrEqual(3);
    expect(result.series).toHaveLength(7);
    expect(result.series.some((row: any) => row.date === '2025-10-29' && row.durationMinutes === null)).toBe(true);
    db.close();
  });
});
