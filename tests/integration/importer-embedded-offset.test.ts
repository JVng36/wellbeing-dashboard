import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/server/db.js';
import { importLegacyFiles } from '../../src/server/importer.js';
import { HttpError } from '../../src/server/util.js';

describe('legacy import embedded local offsets', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function database() {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-embedded-offset-'));
    dirs.push(dir);
    return openDatabase(dir);
  }

  it('imports embedded start and end offsets while preserving the exact source bytes', async () => {
    const db = await database();
    const raw = '---\r\nid: fabricated-embedded-range\r\nevent_type: sleep_session\r\nstart_at_local: 2032-01-15T23:10:00-08:00\r\nend_at_local: 2032-01-16T06:25:00-08:00\r\ntimezone: America/Los_Angeles\r\nnotes: entirely synthetic\r\n---\r\nSynthetic body with CRLF.\r\n';

    expect(importLegacyFiles(db, [{ name: 'embedded-range.md', content: raw }])).toEqual({ imported: 1, unchanged: 0 });

    const row = db.prepare('SELECT start_at_local,end_at_local,local_offset,end_local_offset,raw_legacy,raw_legacy_sha256 FROM events WHERE id=?').get('fabricated-embedded-range') as Record<string, string>;
    expect(row).toMatchObject({
      start_at_local: '2032-01-15T23:10:00',
      end_at_local: '2032-01-16T06:25:00',
      local_offset: '-08:00',
      end_local_offset: '-08:00',
      raw_legacy: raw,
      raw_legacy_sha256: createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex'),
    });
    db.close();
  });

  it('normalizes an embedded Z offset to +00:00', async () => {
    const db = await database();
    const raw = `---\nid: fabricated-zulu\nevent_type: sleep_onset\nstart_at_local: 2032-06-05T21:45:00Z\ntimezone: UTC\n---\n`;

    expect(importLegacyFiles(db, [{ name: 'zulu.md', content: raw }])).toEqual({ imported: 1, unchanged: 0 });
    expect(db.prepare('SELECT start_at_local,local_offset FROM events WHERE id=?').get('fabricated-zulu')).toEqual({ start_at_local: '2032-06-05T21:45:00', local_offset: '+00:00' });
    db.close();
  });

  it('accepts separate offsets that match embedded offsets', async () => {
    const db = await database();
    const raw = `---\nid: fabricated-matching-offsets\nevent_type: sleep_session\nstart_at_local: 2032-02-20T22:00:00-05:00\nlocal_offset: -05:00\nend_at_local: 2032-02-21T06:00:00-05:00\nend_local_offset: -05:00\ntimezone: America/New_York\n---\n`;

    expect(importLegacyFiles(db, [{ name: 'matching.md', content: raw }])).toEqual({ imported: 1, unchanged: 0 });
    expect(db.prepare('SELECT start_at_local,end_at_local,local_offset,end_local_offset FROM events WHERE id=?').get('fabricated-matching-offsets')).toEqual({
      start_at_local: '2032-02-20T22:00:00',
      end_at_local: '2032-02-21T06:00:00',
      local_offset: '-05:00',
      end_local_offset: '-05:00',
    });
    db.close();
  });

  it.each([
    {
      name: 'start',
      id: 'fabricated-conflicting-start',
      fields: 'start_at_local: 2032-01-10T20:00:00-05:00\nstart_local_offset: -04:00',
      field: 'start_local_offset',
    },
    {
      name: 'end',
      id: 'fabricated-conflicting-end',
      fields: 'end_at_local: 2032-01-11T06:00:00-05:00\nend_local_offset: -04:00',
      field: 'end_local_offset',
    },
  ])('rejects a conflicting separate $name offset with the correct field', async ({ id, fields, field }) => {
    const db = await database();
    const raw = `---\nid: ${id}\nevent_type: sleep_session\n${fields}\ntimezone: America/New_York\n---\n`;

    let thrown: unknown;
    try {
      importLegacyFiles(db, [{ name: 'conflict.md', content: raw }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toMatchObject({ statusCode: 422, code: 'import_validation_failed', details: { field } });
    db.close();
  });

  it('rejects a nonexistent local time carrying an embedded offset', async () => {
    const db = await database();
    const raw = `---\nid: fabricated-spring-gap\nevent_type: sleep_onset\nstart_at_local: 2032-03-14T02:30:00-08:00\ntimezone: America/Los_Angeles\n---\n`;

    expect(() => importLegacyFiles(db, [{ name: 'spring-gap.md', content: raw }])).toThrow(/invalid local time/i);
    db.close();
  });

  it('rejects an embedded offset that is not valid for the zone at that local time', async () => {
    const db = await database();
    const raw = `---\nid: fabricated-zone-offset-mismatch\nevent_type: sleep_onset\nstart_at_local: 2032-01-10T20:00:00-04:00\ntimezone: America/New_York\n---\n`;

    expect(() => importLegacyFiles(db, [{ name: 'zone-offset-mismatch.md', content: raw }])).toThrow(/invalid local time/i);
    db.close();
  });

  it('continues to import records with omitted or null times', async () => {
    const db = await database();
    const omitted = `---\nid: fabricated-no-times\nevent_type: duration_report\nlocal_date: 2032-04-02\ntimezone: America/Denver\nduration_minutes: 420\n---\n`;
    const explicitNull = `---\nid: fabricated-null-times\nevent_type: duration_report\nstart_at_local: null\nend_at_local: ~\nlocal_date: 2032-04-03\ntimezone: America/Denver\nduration_minutes: 390\n---\n`;

    expect(importLegacyFiles(db, [{ name: 'no-times.md', content: omitted }, { name: 'null-times.md', content: explicitNull }])).toEqual({ imported: 2, unchanged: 0 });
    expect(db.prepare('SELECT start_at_local,end_at_local,local_offset,end_local_offset FROM events WHERE id=?').get('fabricated-no-times')).toEqual({ start_at_local: null, end_at_local: null, local_offset: null, end_local_offset: null });
    expect(db.prepare('SELECT start_at_local,end_at_local,local_offset,end_local_offset FROM events WHERE id=?').get('fabricated-null-times')).toEqual({ start_at_local: null, end_at_local: null, local_offset: null, end_local_offset: null });
    db.close();
  });

  it('continues to reject a naive non-UTC timestamp with no offset', async () => {
    const db = await database();
    const raw = `---\nid: fabricated-naive-no-offset\nevent_type: sleep_onset\nstart_at_local: 2032-05-03T22:15:00\ntimezone: America/Chicago\n---\n`;

    let thrown: unknown;
    try {
      importLegacyFiles(db, [{ name: 'naive.md', content: raw }]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toMatchObject({ statusCode: 422, code: 'import_validation_failed', details: { field: 'local_offset' } });
    db.close();
  });
});
