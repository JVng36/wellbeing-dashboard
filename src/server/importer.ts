import { parseDocument } from 'yaml';
import { DateTime, IANAZone } from 'luxon';
import type { AppDatabase } from './db.js';
import { HttpError, now, sha256 } from './util.js';
import { rowToEvent } from './events.js';
import { metricOverrideSchema } from '../shared/domain.js';
import { elapsedMinutes, validateLocalTime } from '../shared/time.js';

type Legacy = Record<string, unknown>;
export interface LegacyFile { name: string; content: string }
const known = new Set(['id','event_id','event_type','start_at_local','end_at_local','local_date','timezone','start_local_offset','local_offset','end_local_offset','duration_minutes','numeric_value','reported_at_utc','source','source_kind','confidence','notes','source_message_id','source_reference','supersedes_event_id','created_at_utc','uncertainty','metric_overrides']);

function bodySections(content: string, frontmatterEnd: number): { body: string; observation: string | null; provenance: string | null } {
  const body = content.slice(frontmatterEnd).replace(/^\r?\n/, '');
  const sections = new Map<string, string>();
  const matches = [...body.matchAll(/^##\s+(Observation|Provenance)\s*\r?\n([\s\S]*?)(?=^##\s+|(?![\s\S]))/gim)];
  for (const match of matches) sections.set(match[1].toLowerCase(), match[2].trim());
  return { body, observation: sections.get('observation') ?? null, provenance: sections.get('provenance') ?? null };
}

function parseFile(file: LegacyFile) {
  const match = file.content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) importError(file, 'missing YAML frontmatter', 'frontmatter');
  let doc: any;
  try { doc = parseDocument(match[1], { schema: 'failsafe', uniqueKeys: true }); } catch { importError(file, 'invalid YAML frontmatter', 'frontmatter'); }
  if (doc.errors.length) importError(file, 'invalid YAML frontmatter', 'frontmatter');
  const data = doc.toJS() as Legacy;
  if (!data || typeof data !== 'object') importError(file, 'frontmatter must be a mapping', 'frontmatter');
  const sourceId = data.id ?? data.event_id;
  if (data.id != null && data.event_id != null && data.id !== data.event_id) importError(file, 'id and event_id disagree', 'id');
  if (typeof sourceId !== 'string' || !sourceId.trim()) importError(file, 'id or event_id must be a non-empty string', 'id');
  if (typeof data.event_type !== 'string' || !data.event_type) importError(file, 'event_type must be a string', 'event_type');
  const supersedes = nullable(data.supersedes_event_id);
  if (data.event_type === 'correction' && !supersedes) importError(file, 'dangling correction link requires supersedes_event_id', 'supersedes_event_id');
  const sections = bodySections(file.content, match[0].length);
  const mapped = { ...data };
  const bodyKeys = ['event_type','start_at_local','end_at_local','local_date','timezone','duration_minutes','numeric_value','reported_at_utc','source','source_reference','confidence','notes','supersedes_event_id'];
  for (const [key, value] of Object.entries(parseBodyFields(sections.observation))) if (bodyKeys.includes(key) && nullable(mapped[key]) == null) mapped[key] = value;
  for (const [key, value] of Object.entries(parseBodyFields(sections.provenance))) if (['source','source_reference','confidence','reported_at_utc'].includes(key) && nullable(mapped[key]) == null) mapped[key] = value;
  return { file, data: mapped, id: sourceId, supersedes: nullable(mapped.supersedes_event_id), hash: sha256(file.content), sections };
}

function parseBodyFields(section: string | null): Record<string, string> {
  if (!section) return {};
  const result: Record<string, string> = {};
  for (const line of section.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:[-*]\s*)?([a-z][a-z0-9_]*):\s*(.*?)\s*$/i);
    if (match && match[2] !== '') result[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
  return result;
}

function nullable(value: unknown): unknown {
  if (value === null || value === undefined || value === 'null' || value === '~') return null;
  return value;
}
function numberOrNull(value: unknown, name: string): number | null {
  const clean = nullable(value); if (clean == null) return null;
  let n: number;
  if (typeof clean === 'number') n = clean;
  else if (typeof clean === 'string' && /^[+-]?(?:(?:\d+(?:\.\d*)?)|(?:\.\d+))(?:[eE][+-]?\d+)?$/.test(clean.trim())) n = Number(clean);
  else throw new HttpError(422, `${name} must be numeric or null`, 'import_validation_failed', { field: name });
  if (!Number.isFinite(n)) throw new HttpError(422, `${name} must be numeric or null`, 'import_validation_failed', { field: name }); return n;
}

function validOffsetTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(value)) return false;
  return DateTime.fromISO(value, { setZone: true }).isValid;
}

function embeddedLocalOffset(value: unknown): { local: string; offset: string } | null {
  if (typeof value !== 'string') return null;
  const match = value.match(/^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)(Z|[+-]\d\d:\d\d)$/);
  if (!match) return null;
  const suffix = match[2];
  // The recognizer is RANGE-SAFE: a syntactically well-formed but out-of-range
  // offset such as -06:60 or +24:00 is not treated as an embedded offset at all,
  // so the whole value stays naive and is rejected by the normal local-time
  // validation instead of being stripped and silently reinterpreted.
  if (suffix !== 'Z' && !/^([+-])(?:0\d|1\d|2[0-3]):[0-5]\d$/.test(suffix)) return null;
  // The offset is stored in CANONICAL form: `Z` and `-00:00` both become
  // `+00:00`, which is what the zone validation and the persisted column expect.
  // A negative-zero offset is the same instant as positive zero, so it must not
  // be persisted as `-00:00` and then rejected as invalid for the zone.
  return { local: match[1], offset: normalizeOffset(suffix) };
}

// Canonical form of an offset, so that equivalent spellings (`Z`, `+00:00`,
// `-00:00`, and zero-padded variants) compare equal. ONLY syntactically valid,
// in-range offsets are normalized: a malformed value such as `-06:60` is
// returned unchanged, so it can never be silently re-read as a different valid
// offset (`-07:00`). Unrecognised text is likewise returned trimmed and
// unchanged so genuine conflicts still surface.
const OFFSET_CANONICAL = /^([+-])(?:0\d|1\d|2[0-3]):[0-5]\d$/;
function normalizeOffset(value: unknown): string {
  const text = String(value).trim();
  if (text === 'Z' || text === 'z') return '+00:00';
  if (!OFFSET_CANONICAL.test(text)) return text;
  // Already canonical: zero-padded, in range, minutes 0-59. Canonicalize only
  // the sign so that `-00:00` and `+00:00` compare equal.
  return text[0] === '-' && /^[-+]00:00$/.test(text) ? '+00:00' : text;
}

function normalizedOverrideValue(value: unknown): unknown { const clean = nullable(value); if (clean == null) return null; if (typeof clean === 'number') return clean; if (typeof clean !== 'string') return clean; if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(clean.trim())) return Number(clean); return clean; }
function normalizedOverrides(value: unknown, file: LegacyFile): unknown {
  let source: unknown;
  try { source = typeof value === 'string' ? parseDocument(value, { schema: 'failsafe', uniqueKeys: true }).toJS() : value; } catch { importError(file, 'invalid metric_overrides mapping', 'metric_overrides'); }
  if (!source || typeof source !== 'object' || Array.isArray(source)) importError(file, 'metric_overrides must be a mapping', 'metric_overrides');
  const normalized = Object.fromEntries(Object.entries(source as Record<string, unknown>).map(([key, raw]) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) importError(file, `metric override ${key} must be a mapping`, `metric_overrides.${key}`);
    const entry = raw as Record<string, unknown>; return [key, { ...entry, value: normalizedOverrideValue(entry.value) }];
  }));
  try { return metricOverrideSchema.parse(normalized); } catch { importError(file, 'invalid metric override value', 'metric_overrides'); }
}
function importError(file: LegacyFile, message: string, field?: string): never { const safeName = file.name.split(/[\\/]/).at(-1)?.slice(0, 120) ?? 'import'; throw new HttpError(422, `${safeName}: ${message}`, 'import_validation_failed', field ? { field } : undefined); }

export function importLegacyFiles(db: AppDatabase, files: LegacyFile[], actorId = 'local-import:cli'): { imported: number; unchanged: number } {
  const parsed = files.map(parseFile);
  for (const item of parsed) {
    const d = item.data;
    let duration: number | null; let numeric: number | null;
    try { duration = numberOrNull(d.duration_minutes, 'duration_minutes'); numeric = numberOrNull(d.numeric_value, 'numeric_value'); } catch (error) { if (error instanceof HttpError) throw new HttpError(error.statusCode, `${item.file.name.split(/[\\/]/).at(-1)?.slice(0, 120) ?? 'import'}: ${error.message}`, error.code, error.details); throw error; }
    const timezone = nullable(d.timezone); const rawStart = nullable(d.start_at_local); const rawEnd = nullable(d.end_at_local); const uncertainty = nullable(d.uncertainty);
    const localDate = nullable(d.local_date); if (localDate != null) { const dateText = String(localDate); const date = new Date(`${dateText}T00:00:00Z`); if (!/^\d{4}-\d\d-\d\d$/.test(dateText) || Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== dateText) importError(item.file, 'invalid local_date', 'local_date'); }
    if (timezone != null && typeof timezone !== 'string') importError(item.file, 'timezone must be text', 'timezone');
    if (timezone && !IANAZone.isValidZone(String(timezone))) importError(item.file, 'unknown timezone', 'timezone');
    let startOffset = nullable(d.start_local_offset ?? d.local_offset); let endOffset = nullable(d.end_local_offset);
    if (rawStart != null && typeof rawStart !== 'string') importError(item.file, 'start_at_local must be text', 'start_at_local');
    if (rawEnd != null && typeof rawEnd !== 'string') importError(item.file, 'end_at_local must be text', 'end_at_local');
    if (startOffset != null && typeof startOffset !== 'string') importError(item.file, 'local_offset must be text', 'local_offset');
    if (endOffset != null && typeof endOffset !== 'string') importError(item.file, 'end_local_offset must be text', 'end_local_offset');
    let start = rawStart as string | null; let end = rawEnd as string | null;
    const embeddedStart = embeddedLocalOffset(start); const embeddedEnd = embeddedLocalOffset(end);
    // Offset conflict detection compares NORMALIZED offsets on BOTH sides, not
    // raw strings: `Z`, `+00:00` and `-00:00` denote the same offset, so a
    // lexical comparison would accept one spelling while falsely rejecting an
    // equivalent one. A malformed separate value is returned unchanged by
    // normalizeOffset and therefore surfaces as a conflict rather than being
    // silently coerced into a different valid offset.
    if (embeddedStart) {
      for (const separate of [nullable(d.start_local_offset), nullable(d.local_offset)]) {
        if (separate != null && normalizeOffset(separate) !== normalizeOffset(embeddedStart.offset)) importError(item.file, 'start_local_offset conflicts with embedded start_at_local offset', 'start_local_offset');
      }
      start = embeddedStart.local; startOffset = embeddedStart.offset;
      d.start_at_local = start; d.start_local_offset = startOffset;
    }
    if (embeddedEnd) {
      const separate = nullable(d.end_local_offset);
      if (separate != null && normalizeOffset(separate) !== normalizeOffset(embeddedEnd.offset)) importError(item.file, 'end_local_offset conflicts with embedded end_at_local offset', 'end_local_offset');
      end = embeddedEnd.local; endOffset = embeddedEnd.offset;
      d.end_at_local = end; d.end_local_offset = endOffset;
    }
    if (start == null && startOffset != null) importError(item.file, 'local_offset requires start_at_local', 'local_offset');
    if (end == null && endOffset != null) importError(item.file, 'end_local_offset requires end_at_local', 'end_local_offset');
    if ((start || end) && !timezone) importError(item.file, 'timezone is required for exact local times', 'timezone');
    if (start && !startOffset && timezone !== 'UTC') importError(item.file, 'local_offset is required with start_at_local', 'local_offset');
    if (end && !endOffset && timezone !== 'UTC') importError(item.file, 'end_local_offset is required with end_at_local', 'end_local_offset');
    try {
      if (timezone && start) validateLocalTime(start.replace(' ', 'T'), String(timezone), startOffset as string | null);
      if (timezone && end) validateLocalTime(end.replace(' ', 'T'), String(timezone), endOffset as string | null);
      if (timezone && start && end) elapsedMinutes(start.replace(' ', 'T'), end.replace(' ', 'T'), String(timezone), startOffset as string | null, (endOffset ?? startOffset) as string | null);
    } catch (error) { importError(item.file, 'invalid local time or interval', 'local_time'); }
    let normalizedUncertainty: Record<string, unknown> | null = null;
    if (uncertainty != null) {
      let raw: unknown; try { raw = typeof uncertainty === 'string' ? parseDocument(uncertainty, { schema: 'failsafe', uniqueKeys: true }).toJS() : uncertainty; } catch { importError(item.file, 'invalid uncertainty mapping', 'uncertainty'); }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) importError(item.file, 'uncertainty must be a mapping', 'uncertainty');
      const value = raw as Record<string, unknown>; const allowed = new Set(['earliestLocal','earliestOffset','latestLocal','latestOffset','prose']);
      if (Object.keys(value).some((key) => !allowed.has(key))) importError(item.file, 'unknown uncertainty field', 'uncertainty');
      normalizedUncertainty = { prose: nullable(value.prose) == null ? null : String(value.prose), earliestLocal: nullable(value.earliestLocal), earliestOffset: nullable(value.earliestOffset), latestLocal: nullable(value.latestLocal), latestOffset: nullable(value.latestOffset) };
      for (const [localKey, offsetKey] of [['earliestLocal','earliestOffset'],['latestLocal','latestOffset']] as const) {
        const local = normalizedUncertainty[localKey]; const offset = normalizedUncertainty[offsetKey];
        if (local != null && typeof local !== 'string') importError(item.file, `${localKey} must be text`, `uncertainty.${localKey}`);
        if (offset != null && typeof offset !== 'string') importError(item.file, `${offsetKey} must be text`, `uncertainty.${offsetKey}`);
        if (local != null) { if (!timezone || !offset) importError(item.file, `${offsetKey} is required with ${localKey}`, `uncertainty.${offsetKey}`); try { validateLocalTime(String(local), String(timezone), String(offset)); } catch { importError(item.file, 'invalid uncertainty local time', `uncertainty.${localKey}`); } }
        else if (offset != null) importError(item.file, `${offsetKey} requires ${localKey}`, `uncertainty.${offsetKey}`);
      }
      if (normalizedUncertainty.earliestLocal && normalizedUncertainty.latestLocal && timezone && normalizedUncertainty.earliestOffset && normalizedUncertainty.latestOffset) {
        const earliestUtc = validateLocalTime(String(normalizedUncertainty.earliestLocal), String(timezone), String(normalizedUncertainty.earliestOffset)).utc;
        const latestUtc = validateLocalTime(String(normalizedUncertainty.latestLocal), String(timezone), String(normalizedUncertainty.latestOffset)).utc;
        if (Date.parse(latestUtc) < Date.parse(earliestUtc)) importError(item.file, 'uncertainty interval is reversed', 'uncertainty');
      }
      item.data.uncertainty = normalizedUncertainty;
    }
    if (duration != null && (!Number.isInteger(duration) || duration < 0 || duration > 10080)) importError(item.file, 'duration_minutes out of range', 'duration_minutes');
    if (String(d.event_type) === 'restedness' && numeric != null && (!Number.isInteger(numeric) || numeric < 1 || numeric > 10)) importError(item.file, 'restedness out of range', 'numeric_value');
    if (d.confidence != null && !['high','medium','low','null','~'].includes(String(d.confidence))) importError(item.file, 'invalid confidence', 'confidence');
    for (const key of ['reported_at_utc','created_at_utc']) if (nullable(d[key]) != null && !validOffsetTimestamp(nullable(d[key]))) importError(item.file, `invalid ${key}`, key);
    for (const key of ['source','source_kind','notes','source_message_id','source_reference']) if (d[key] != null && nullable(d[key] as unknown) != null && (typeof d[key] !== 'string' || String(d[key]).length > (key === 'notes' ? 20000 : 500))) importError(item.file, `${key} must be bounded text`, key);
    const overrides = nullable(d.metric_overrides);
    if (overrides != null) {
      item.data.metric_overrides = normalizedOverrides(overrides, item.file);
    }
  }
  if (new Set(parsed.map((x) => x.id)).size !== parsed.length) throw new HttpError(409, 'import contains conflicting duplicate IDs', 'import_conflict');
  let unchanged = 0;
  const pending = parsed.filter((item) => {
    const prior = db.prepare('SELECT raw_legacy_sha256 FROM events WHERE id=?').get(item.id) as { raw_legacy_sha256?: string } | undefined;
    if (!prior) return true;
    if (prior.raw_legacy_sha256 === item.hash) { unchanged++; return false; }
    throw new HttpError(409, `conflict for imported ID ${String(item.id).slice(0, 120)}`, 'import_conflict');
  });
  const allIds = new Set((db.prepare('SELECT id FROM events').all() as { id: string }[]).map((x) => x.id));
  pending.forEach((x) => allIds.add(x.id));
  for (const item of pending) if (item.supersedes && !allIds.has(String(item.supersedes))) importError(item.file, 'dangling correction link', 'supersedes_event_id');
  const links = new Map<string, string>();
  for (const row of db.prepare('SELECT id,supersedes_event_id FROM events WHERE supersedes_event_id IS NOT NULL').all() as { id: string; supersedes_event_id: string }[]) links.set(row.id, row.supersedes_event_id);
  for (const item of pending) if (item.supersedes) links.set(item.id, String(item.supersedes));
  for (const id of links.keys()) {
    const seen = new Set<string>(); let cursor: string | undefined = id;
    while (cursor && links.has(cursor)) { if (seen.has(cursor)) throw new HttpError(422, 'correction cycle in imported links', 'import_validation_failed', { field: 'supersedes_event_id' }); seen.add(cursor); cursor = links.get(cursor); }
  }
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const item of pending) {
      const d = item.data; const timestamp = String(nullable(d.created_at_utc) ?? now());
      const unknown = { ...Object.fromEntries(Object.entries(d).filter(([key]) => !known.has(key))), legacyIdKey: Object.hasOwn(d, 'event_id') ? 'event_id' : 'id', markdownBody: item.sections.body, observationBody: item.sections.observation, provenanceBody: item.sections.provenance };
      const uncertainty = nullable(d.uncertainty); const overrides = nullable(d.metric_overrides);
      db.prepare(`INSERT INTO events(id,event_type,start_at_local,end_at_local,local_date,timezone,local_offset,end_local_offset,duration_minutes,numeric_value,reported_at_utc,source,confidence,notes,source_message_id,source_reference,supersedes_event_id,created_at_utc,updated_at_utc,pairing_provenance,uncertainty_json,metric_overrides_json,legacy_unknown_json,raw_legacy,raw_legacy_sha256,current_revision,actor_id)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, ?,NULL,?,?,?,?,?,?,?,?,1,?)`).run(
        item.id, nullable(d.event_type) as any, nullable(d.start_at_local) as any, nullable(d.end_at_local) as any, nullable(d.local_date) as any, nullable(d.timezone) as any,
        nullable(d.start_local_offset ?? d.local_offset) as any, nullable(d.end_local_offset) as any, numberOrNull(d.duration_minutes, 'duration_minutes'), numberOrNull(d.numeric_value, 'numeric_value'), nullable(d.reported_at_utc) as any, nullable(d.source_kind ?? d.source) as any, nullable(d.confidence) as any, nullable(d.notes) as any,
        nullable(d.source_message_id) == null ? null : String(d.source_message_id), nullable(d.source_reference) == null ? null : String(d.source_reference), timestamp, timestamp, 'legacy_unpaired', uncertainty == null ? null : JSON.stringify(uncertainty), overrides == null ? null : JSON.stringify(overrides), JSON.stringify(unknown), item.file.content, item.hash, actorId
      );
    }
    for (const item of pending) if (item.supersedes) db.prepare('UPDATE events SET supersedes_event_id=? WHERE id=?').run(String(item.supersedes), item.id);
    for (const item of pending) {
      const row = db.prepare('SELECT * FROM events WHERE id=?').get(item.id) as Record<string, unknown>;
      db.prepare('INSERT INTO event_revisions(event_id,revision,snapshot_json,actor_id,reason,created_at_utc) VALUES(?,1,?,?,?,?)').run(item.id, JSON.stringify(rowToEvent(row)), actorId, 'immutable legacy import', now());
      db.prepare('INSERT INTO legacy_import_files(name,sha256,imported_at_utc,event_id,importer_version) VALUES(?,?,?,?,?)').run(item.file.name, item.hash, now(), item.id, '1');
    }
    invalidateImportSummary(db);
    db.exec('COMMIT');
    return { imported: pending.length, unchanged };
  } catch (error) { db.exec('ROLLBACK'); throw error; }
}

function invalidateImportSummary(db: AppDatabase) { db.prepare('UPDATE summaries SET stale_at_utc=? WHERE stale_at_utc IS NULL').run(now()); }
