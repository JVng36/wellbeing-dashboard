import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../../src/server/db.js';
import { importLegacyFiles } from '../../src/server/importer.js';
import { HttpError } from '../../src/server/util.js';

// Added in response to the independent gpt-5.6-terra review (CHANGES_REQUESTED,
// 2026-09-30), which required these cases to be regression-tested. All data below
// is fabricated inline; no real note content is used.
describe('legacy import embedded local offsets, reviewer-required cases', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function database() {
    const dir = await mkdtemp(join(tmpdir(), 'wellbeing-review-cases-'));
    dirs.push(dir);
    return openDatabase(dir);
  }

  // --- 1. UTC offset SPELLING equivalence, BOTH directions ------------------
  it.each([
    { name: 'embedded Z with separate +00:00', id: 'fab-equiv-a', stamp: '2032-06-05T21:45:00Z', separate: '+00:00' },
    { name: 'embedded +00:00 with separate Z', id: 'fab-equiv-b', stamp: '2032-06-05T21:45:00+00:00', separate: 'Z' },
    { name: 'embedded Z with separate lowercase z', id: 'fab-equiv-c', stamp: '2032-06-05T21:45:00Z', separate: 'z' },
  ])('accepts equivalent UTC spellings: $name', async ({ id, stamp, separate }) => {
    // NOTE: the embedded suffix accepts uppercase `Z` only (embeddedLocalOffset
    // matches `Z|[+-]HH:MM`); a lowercase embedded `z` is NOT accepted and is
    // covered by the malformed-suffix cases below. Lowercase `z` in a SEPARATE
    // offset field IS accepted and is what this row exercises. The STORED offset
    // is always canonical `+00:00`.
    const db = await database();
    const raw = `---\nid: ${id}\nevent_type: sleep_onset\nstart_at_local: ${stamp}\nlocal_offset: ${separate}\ntimezone: UTC\n---\n`;

    expect(importLegacyFiles(db, [{ name: `${id}.md`, content: raw }])).toEqual({ imported: 1, unchanged: 0 });
    expect(db.prepare('SELECT start_at_local,local_offset FROM events WHERE id=?').get(id))
      .toEqual({ start_at_local: '2032-06-05T21:45:00', local_offset: '+00:00' });
    db.close();
  });

  it('still rejects a genuinely different separate offset spelled equivalently-but-not-equal', async () => {
    const db = await database();
    const raw = '---\nid: fab-equiv-conflict\nevent_type: sleep_onset\nstart_at_local: 2032-06-05T21:45:00Z\nlocal_offset: +01:00\ntimezone: UTC\n---\n';
    expect(() => importLegacyFiles(db, [{ name: 'conflict.md', content: raw }]))
      .toThrow(/conflicts with embedded/i);
    db.close();
  });

  // -00:00 is the same instant as +00:00 and must NOT be a conflict.
  it('accepts embedded -00:00 with a separate +00:00', async () => {
    const db = await database();
    const raw = '---\nid: fab-negative-zero\nevent_type: sleep_onset\nstart_at_local: 2032-06-05T21:45:00-00:00\nlocal_offset: +00:00\ntimezone: UTC\n---\n';
    expect(importLegacyFiles(db, [{ name: 'negzero.md', content: raw }])).toEqual({ imported: 1, unchanged: 0 });
    expect(db.prepare('SELECT start_at_local,local_offset FROM events WHERE id=?').get('fab-negative-zero'))
      .toEqual({ start_at_local: '2032-06-05T21:45:00', local_offset: '+00:00' });
    db.close();
  });

  // An out-of-range minute must not be normalized into a DIFFERENT valid offset
  // and silently accepted beside an embedded -07:00.
  it('rejects an out-of-range separate offset instead of renormalizing it', async () => {
    const db = await database();
    const raw = '---\nid: fab-minute-overflow\nevent_type: sleep_onset\nstart_at_local: 2032-05-01T22:00:00-07:00\nlocal_offset: -06:60\ntimezone: America/Los_Angeles\n---\n';
    expect(() => importLegacyFiles(db, [{ name: 'overflow.md', content: raw }])).toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 });
    db.close();
  });

  // --- 2. fractional seconds and a positive non-UTC offset ------------------
  it('imports fractional seconds with an embedded offset', async () => {
    const db = await database();
    const raw = '---\nid: fab-fractional\nevent_type: sleep_onset\nstart_at_local: 2032-02-10T22:15:30.250-08:00\ntimezone: America/Los_Angeles\n---\n';
    expect(importLegacyFiles(db, [{ name: 'fractional.md', content: raw }])).toEqual({ imported: 1, unchanged: 0 });
    expect(db.prepare('SELECT start_at_local,local_offset FROM events WHERE id=?').get('fab-fractional'))
      .toEqual({ start_at_local: '2032-02-10T22:15:30.250', local_offset: '-08:00' });
    db.close();
  });

  it('imports a positive half-hour offset (+05:30)', async () => {
    const db = await database();
    const raw = '---\nid: fab-positive\nevent_type: sleep_onset\nstart_at_local: 2032-03-01T23:00:00+05:30\ntimezone: Asia/Kolkata\n---\n';
    expect(importLegacyFiles(db, [{ name: 'positive.md', content: raw }])).toEqual({ imported: 1, unchanged: 0 });
    expect(db.prepare('SELECT start_at_local,local_offset FROM events WHERE id=?').get('fab-positive'))
      .toEqual({ start_at_local: '2032-03-01T23:00:00', local_offset: '+05:30' });
    db.close();
  });

  // --- 3. malformed / partial suffixes must not be silently stripped -------
  it.each([
    { name: 'two-digit-only suffix', stamp: '2032-02-10T22:15:00-08' },
    { name: 'single-digit hour', stamp: '2032-02-10T22:15:00+8:00' },
    { name: 'compact offset', stamp: '2032-02-10T22:15:00-0800' },
    { name: 'trailing junk after suffix', stamp: '2032-02-10T22:15:00-08:00extra' },
  ])('does not accept a malformed offset suffix: $name', async ({ stamp }) => {
    const db = await database();
    const raw = `---\nid: fab-malformed\nevent_type: sleep_onset\nstart_at_local: ${stamp}\ntimezone: America/Los_Angeles\n---\n`;
    expect(() => importLegacyFiles(db, [{ name: 'malformed.md', content: raw }])).toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 });
    db.close();
  });

  // --- 4. genuine fall-back overlap: both candidates are valid -------------
  // 2032-11-07 01:30 local occurs twice in America/Los_Angeles (DST ends on
  // the FIRST Sunday of November; 2032-11-01 is not a transition date).
  it.each([
    { name: 'first (DST) pass', offset: '-07:00' },
    { name: 'second (standard) pass', offset: '-08:00' },
  ])('accepts a valid fall-back overlap candidate: $name', async ({ offset }) => {
    const db = await database();
    const raw = `---\nid: fab-overlap-${offset.replace(':', '')}\nevent_type: sleep_onset\nstart_at_local: 2032-11-07T01:30:00${offset}\ntimezone: America/Los_Angeles\n---\n`;
    expect(importLegacyFiles(db, [{ name: 'overlap.md', content: raw }])).toEqual({ imported: 1, unchanged: 0 });
    expect(db.prepare('SELECT start_at_local,local_offset FROM events WHERE id=?').get(`fab-overlap-${offset.replace(':', '')}`))
      .toEqual({ start_at_local: '2032-11-07T01:30:00', local_offset: offset });
    db.close();
  });

  // --- 5a. pre-transaction rejection commits nothing ----------------------
  it('commits nothing when a later file in the batch has an offset conflict', async () => {
    const db = await database();
    const good = '---\nid: fab-atomic-first\nevent_type: sleep_onset\nstart_at_local: 2032-04-01T22:00:00-07:00\ntimezone: America/Los_Angeles\n---\n';
    const conflicting = '---\nid: fab-atomic-second\nevent_type: sleep_session\nstart_at_local: 2032-04-02T23:00:00-07:00\nstart_local_offset: -08:00\ntimezone: America/Los_Angeles\n---\n';

    expect(() => importLegacyFiles(db, [
      { name: 'first.md', content: good },
      { name: 'second.md', content: conflicting },
    ])).toThrow(/conflicts with embedded/i);

    for (const table of ['events', 'event_revisions', 'legacy_import_files']) {
      const { n } = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
      expect(n, `${table} must be empty after an aborted batch`).toBe(0);
    }
    db.close();
  });

  // --- 5b. REAL rollback: failure AFTER at least one write has happened ----
  // Case 5a is rejected during PRE-transaction validation, so it would still
  // pass if the transaction and its ROLLBACK were removed. This test forces a
  // failure INSIDE the write block: a test-only trigger aborts the insert of
  // the second event. The first event has already been INSERTed by then, so
  // only a working ROLLBACK can leave the database clean.
  it('rolls back an earlier write when a later file fails inside the transaction', async () => {
    const db = await database();
    const first = '---\nid: fab-rollback-first\nevent_type: sleep_onset\nstart_at_local: 2032-04-01T22:00:00-07:00\ntimezone: America/Los_Angeles\n---\n';
    const second = '---\nid: fab-rollback-second\nevent_type: sleep_onset\nstart_at_local: 2032-04-02T22:00:00-07:00\ntimezone: America/Los_Angeles\n---\n';

    db.exec(`
      CREATE TRIGGER test_abort_second BEFORE INSERT ON events
      WHEN NEW.id = 'fab-rollback-second'
      BEGIN SELECT RAISE(ABORT, 'induced mid-transaction failure'); END;
    `);

    expect(() => importLegacyFiles(db, [
      { name: 'first.md', content: first },
      { name: 'second.md', content: second },
    ])).toThrow(/induced mid-transaction failure/);

    // The first event WAS written before the failure, so these assertions hold
    // only if ROLLBACK actually undid it.
    for (const table of ['events', 'event_revisions', 'legacy_import_files']) {
      const { n } = db.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
      expect(n, `${table} must be empty after ROLLBACK`).toBe(0);
    }
    db.close();
  });

  // Malformed but well-FORMED out-of-range EMBEDDED offsets must be rejected
  // outright, not stripped and reinterpreted. The recognizer is range-safe, so
  // the value stays naive and fails the normal local-time validation.
  it.each([
    { name: 'minute overflow', stamp: '2032-05-01T22:00:00-06:60' },
    { name: 'hour overflow', stamp: '2032-05-01T22:00:00+24:00' },
    { name: 'minute 60 positive', stamp: '2032-05-01T22:00:00+05:60' },
  ])('rejects an out-of-range embedded offset: $name', async ({ stamp }) => {
    const db = await database();
    // A non-UTC zone is required: the range-safe recognizer leaves the value
    // NAIVE, and a naive timestamp in a UTC zone is legitimately allowed by
    // pre-existing importer behaviour, so only a real zone makes this a
    // meaningful rejection.
    const raw = `---\nid: fab-embedded-range\nevent_type: sleep_onset\nstart_at_local: ${stamp}\ntimezone: America/Los_Angeles\n---\n`;
    expect(() => importLegacyFiles(db, [{ name: 'embedded-range.md', content: raw }])).toThrow();
    expect(db.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 0 });
    db.close();
  });

  // --- 6. exact-byte provenance holds for the equivalence path too --------
  it('still stores the exact input bytes on the equivalence path', async () => {
    const db = await database();
    const raw = '---\r\nid: fab-equiv-bytes\r\nevent_type: sleep_onset\r\nstart_at_local: 2032-06-05T21:45:00Z\r\nlocal_offset: +00:00\r\ntimezone: UTC\r\n---\r\n';
    importLegacyFiles(db, [{ name: 'equiv-bytes.md', content: raw }]);
    const row = db.prepare('SELECT raw_legacy,raw_legacy_sha256 FROM events WHERE id=?').get('fab-equiv-bytes') as Record<string, string>;
    expect(row.raw_legacy).toBe(raw);
    expect(row.raw_legacy_sha256).toBe(createHash('sha256').update(Buffer.from(raw, 'utf8')).digest('hex'));
    db.close();
  });

  // --- 7. re-import of unchanged content stays idempotent -----------------
  it('is idempotent on the embedded-offset path', async () => {
    const db = await database();
    const raw = '---\nid: fab-idempotent\nevent_type: sleep_session\nstart_at_local: 2032-04-05T23:10:00-07:00\nend_at_local: 2032-04-06T06:25:00-07:00\ntimezone: America/Los_Angeles\n---\n';
    expect(importLegacyFiles(db, [{ name: 'idem.md', content: raw }])).toEqual({ imported: 1, unchanged: 0 });
    expect(importLegacyFiles(db, [{ name: 'idem.md', content: raw }])).toEqual({ imported: 0, unchanged: 1 });
    db.close();
  });
});
