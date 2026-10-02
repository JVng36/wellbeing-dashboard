import type { AppDatabase } from './db.js';
import { eventInputSchema, metricPriority, type EventInput, type EventPatch } from '../shared/domain.js';
import { elapsedMinutes, validateLocalTime } from '../shared/time.js';
import { DateTime } from 'luxon';
import { HttpError, now, opaqueId } from './util.js';

type Row = Record<string, unknown>;

const fields: Array<[keyof EventInput, string]> = [
  ['eventType', 'event_type'], ['startAtLocal', 'start_at_local'], ['endAtLocal', 'end_at_local'], ['localDate', 'local_date'],
  ['timezone', 'timezone'], ['localOffset', 'local_offset'], ['endLocalOffset', 'end_local_offset'], ['durationMinutes', 'duration_minutes'],
  ['numericValue', 'numeric_value'], ['reportedAtUtc', 'reported_at_utc'], ['source', 'source'], ['confidence', 'confidence'], ['notes', 'notes'],
  ['sourceMessageId', 'source_message_id'], ['sourceReference', 'source_reference'], ['supersedesEventId', 'supersedes_event_id'], ['createdAtUtc', 'created_at_utc'],
  ['sessionId', 'session_id'], ['pairingProvenance', 'pairing_provenance'], ['uncertainty', 'uncertainty_json'], ['metricOverrides', 'metric_overrides_json']
];

function encoded(key: string, value: unknown): unknown {
  return key.endsWith('_json') && value != null ? JSON.stringify(value) : value ?? null;
}

export function rowToEvent(row: Row): Record<string, unknown> {
  const event: Record<string, unknown> = {
    id: row.id, currentRevision: row.current_revision, actorId: row.actor_id, updatedAtUtc: row.updated_at_utc,
    rawLegacy: row.raw_legacy ?? undefined,
    rawLegacySha256: row.raw_legacy_sha256 ?? undefined,
    legacyUnknown: row.legacy_unknown_json ? JSON.parse(String(row.legacy_unknown_json)) : undefined
  };
  for (const [camel, snake] of fields) {
    const raw = row[snake];
    event[camel] = snake.endsWith('_json') && raw ? JSON.parse(String(raw)) : raw ?? null;
  }
  return event;
}

function validateTimes(input: Partial<EventInput>) {
  if ((input.startAtLocal || input.endAtLocal || input.uncertainty?.earliestLocal || input.uncertainty?.latestLocal) && !input.timezone) throw new HttpError(422, 'timezone is required when a local time is supplied', 'time_integrity_error');
  if (input.startAtLocal && !input.localOffset) throw new HttpError(422, 'localOffset is required with startAtLocal', 'time_integrity_error');
  if (input.endAtLocal && !input.endLocalOffset) throw new HttpError(422, 'endLocalOffset is required with endAtLocal', 'time_integrity_error');
  if (input.startAtLocal) validateLocalTime(input.startAtLocal, input.timezone!, input.localOffset);
  if (input.endAtLocal) validateLocalTime(input.endAtLocal, input.timezone!, input.endLocalOffset ?? input.localOffset);
  if (input.startAtLocal && input.endAtLocal) {
    const window = elapsedMinutes(input.startAtLocal, input.endAtLocal, input.timezone!, input.localOffset ?? null, input.endLocalOffset ?? input.localOffset ?? null);
    if (window != null && window > 16 * 60 && input.pairingProvenance === 'bounded_16h_pair') throw new HttpError(422, 'bounded pairing cannot exceed 16 hours', 'invalid_pairing');
  }
  if (input.uncertainty?.earliestLocal) validateLocalTime(input.uncertainty.earliestLocal, input.timezone!, input.uncertainty.earliestOffset ?? null);
  if (input.uncertainty?.latestLocal) validateLocalTime(input.uncertainty.latestLocal, input.timezone!, input.uncertainty.latestOffset ?? null);
  if (input.uncertainty?.earliestLocal && input.uncertainty.latestLocal) {
    const range = elapsedMinutes(input.uncertainty.earliestLocal, input.uncertainty.latestLocal, input.timezone!, input.uncertainty.earliestOffset ?? null, input.uncertainty.latestOffset ?? null);
    if (range != null && range < 0) throw new HttpError(422, 'uncertainty interval is reversed');
  }
}

function snapshot(db: AppDatabase, id: string): Record<string, unknown> {
  const row = db.prepare('SELECT * FROM events WHERE id=?').get(id) as Row | undefined;
  if (!row) throw new HttpError(404, 'event not found', 'not_found');
  return rowToEvent(row);
}

function validateCorrectionLink(db: AppDatabase, id: string, target?: string | null) {
  if (!target) return;
  if (target === id) throw new HttpError(422, 'correction cannot supersede itself', 'correction_cycle');
  let cursor: string | null = target; const seen = new Set([id]);
  while (cursor) {
    if (seen.has(cursor)) throw new HttpError(422, 'correction link would create a cycle', 'correction_cycle');
    seen.add(cursor);
    const row = db.prepare('SELECT supersedes_event_id FROM events WHERE id=?').get(cursor) as { supersedes_event_id: string | null } | undefined;
    if (!row) throw new HttpError(422, `dangling correction link to ${cursor}`, 'dangling_correction');
    cursor = row.supersedes_event_id;
  }
}

export function createEvent(db: AppDatabase, input: EventInput, actorId: string): Record<string, unknown> {
  input = eventInputSchema.parse(input);
  validateTimes(input);
  const id = input.id ?? opaqueId('evt');
  validateCorrectionLink(db, id, input.supersedesEventId);
  const timestamp = now();
  const storedInput = { ...input, createdAtUtc: timestamp };
  const columns = fields.map(([, c]) => c);
  const values = fields.map(([k, c]) => encoded(c, storedInput[k])) as any[];
  db.exec('SAVEPOINT event_mutation');
  try {
    if (db.prepare('SELECT 1 FROM events WHERE id=?').get(id)) throw new HttpError(409, 'event id already exists', 'id_conflict');
    db.prepare(`INSERT INTO events(id,${columns.join(',')},updated_at_utc,current_revision,actor_id) VALUES(?,${columns.map(() => '?').join(',')},?,1,?)`).run(id, ...values, timestamp, actorId);
    const result = snapshot(db, id);
    db.prepare('INSERT INTO event_revisions(event_id,revision,snapshot_json,actor_id,reason,created_at_utc) VALUES(?,1,?,?,?,?)').run(id, JSON.stringify(result), actorId, null, timestamp);
    db.prepare('UPDATE summaries SET stale_at_utc=? WHERE stale_at_utc IS NULL').run(timestamp);
    db.exec('RELEASE event_mutation');
    return result;
  } catch (error) { db.exec('ROLLBACK TO event_mutation'); db.exec('RELEASE event_mutation'); throw error; }
}

export function updateEvent(db: AppDatabase, id: string, patch: EventPatch, actorId: string): Record<string, unknown> {
  db.exec('SAVEPOINT event_mutation');
  try {
    const current = snapshot(db, id);
    if (current.currentRevision !== patch.expectedRevision) throw new HttpError(409, 'stale revision', 'revision_conflict', { currentRevision: current.currentRevision });
    const base = Object.fromEntries(fields.map(([key]) => [key, current[key as string]]));
    const { expectedRevision: _expectedRevision, correctionReason: _correctionReason, ...editablePatch } = patch;
    const merged = { ...base, ...editablePatch } as unknown as EventInput;
    if (patch.metricOverrides) {
      const previous = (current.metricOverrides ?? {}) as Record<string, { basis: string }>;
      for (const [field, proposed] of Object.entries(patch.metricOverrides)) {
        const prior = previous[field];
        if (prior && metricPriority[proposed.basis] < metricPriority[prior.basis]) throw new HttpError(422, `lower-priority ${proposed.basis} cannot replace ${prior.basis} for ${field}`, 'metric_priority_conflict');
      }
    }
    if (patch.metricOverrides === null && current.metricOverrides) throw new HttpError(422, 'metric override authority cannot be cleared wholesale', 'metric_priority_conflict');
    if (patch.metricOverrides && current.metricOverrides) merged.metricOverrides = { ...(current.metricOverrides as Record<string, unknown>), ...patch.metricOverrides } as EventInput['metricOverrides'];
    const validated = eventInputSchema.parse(merged);
    validateTimes(validated);
    validateCorrectionLink(db, id, merged.supersedesEventId);
    const changed = fields.filter(([key]) => Object.prototype.hasOwnProperty.call(patch, key) && key !== 'createdAtUtc');
    const revision = Number(current.currentRevision) + 1;
    if (changed.length) {
      const assignments = changed.map(([, column]) => `${column}=?`).join(',');
      const values = changed.map(([key, column]) => encoded(column, merged[key as keyof EventInput])) as any[];
      db.prepare(`UPDATE events SET ${assignments},current_revision=?,updated_at_utc=?,actor_id=? WHERE id=?`).run(...values, revision, now(), actorId, id);
    } else {
      db.prepare('UPDATE events SET current_revision=?,updated_at_utc=?,actor_id=? WHERE id=?').run(revision, now(), actorId, id);
    }
    const result = snapshot(db, id);
    db.prepare('INSERT INTO event_revisions(event_id,revision,snapshot_json,actor_id,reason,created_at_utc) VALUES(?,?,?,?,?,?)').run(id, revision, JSON.stringify(result), actorId, patch.correctionReason ?? null, now());
    db.prepare('UPDATE summaries SET stale_at_utc=? WHERE stale_at_utc IS NULL').run(now());
    db.exec('RELEASE event_mutation');
    return result;
  } catch (error) { db.exec('ROLLBACK TO event_mutation'); db.exec('RELEASE event_mutation'); throw error; }
}

export function listEvents(db: AppDatabase, filters: { q?: string; type?: string; from?: string; to?: string } = {}): Record<string, unknown>[] {
  const where = ['NOT EXISTS (SELECT 1 FROM events newer WHERE newer.supersedes_event_id=events.id)'];
  const args: any[] = [];
  if (filters.q) { where.push('(notes LIKE ? OR event_type LIKE ?)'); args.push(`%${filters.q}%`, `%${filters.q}%`); }
  if (filters.type) { where.push('event_type=?'); args.push(filters.type); }
  if (filters.from) { where.push('local_date>=?'); args.push(filters.from); }
  if (filters.to) { where.push('local_date<=?'); args.push(filters.to); }
  return (db.prepare(`SELECT * FROM events WHERE ${where.join(' AND ')} ORDER BY COALESCE(local_date,created_at_utc) DESC, created_at_utc DESC`).all(...args) as Row[]).map(rowToEvent);
}

export function getEvent(db: AppDatabase, id: string) { return snapshot(db, id); }
export function getHistory(db: AppDatabase, id: string): unknown[] {
  if (!db.prepare('SELECT 1 FROM events WHERE id=?').get(id)) throw new HttpError(404, 'event not found', 'not_found');
  return (db.prepare('SELECT revision,snapshot_json,actor_id,reason,created_at_utc FROM event_revisions WHERE event_id=? ORDER BY revision DESC').all(id) as Row[]).map((r) => ({ revision: r.revision, actorId: r.actor_id, reason: r.reason, createdAtUtc: r.created_at_utc, snapshot: JSON.parse(String(r.snapshot_json)) }));
}

export function invalidateSummaries(db: AppDatabase) { db.prepare('UPDATE summaries SET stale_at_utc=? WHERE stale_at_utc IS NULL').run(now()); }

type MetricCandidate = { event: Record<string, unknown>; value: number | null; basis: string; rank: number; explicit: boolean };
type SelectedMetric = MetricCandidate & { disagreement: boolean; candidates: MetricCandidate[] };
type TrendSession = { id: string; kind: string; local_date: string | null; timezone: string; current_revision: number; actor_id: string };
type TrendWindow = { eventId: string; localDate: string; elapsedMinutes: number | null; disagreement?: boolean; kind: 'overnight' | 'nap'; onsetLocal?: string | null; wakeLocal?: string | null; provenance?: string[] };

function metricBasis(event: Record<string, unknown>, override?: { basis: string }): string {
  if (override?.basis) return override.basis;
  switch (event.source) {
    case 'explicit_user_correction': return 'explicit_user_correction';
    case 'wearable_estimate': return 'wearable_estimate';
    case 'user_reported':
    case 'user_report': return 'user_report';
    case 'assistant_inference': return 'assistant_inference';
    default: return 'unknown';
  }
}

function selectMetric(events: Record<string, unknown>[], key: string, fallback: (event: Record<string, unknown>) => unknown): SelectedMetric | null {
  if (!events.length) return null;
  const candidates = events.map((event) => {
    const override = (event.metricOverrides as Record<string, { value: unknown; basis: string }> | null | undefined)?.[key];
    const raw = override ? override.value : fallback(event);
    const value = raw == null ? null : Number(raw);
    const basis = metricBasis(event, override);
    return { event, value: Number.isFinite(value) ? value : null, basis, rank: metricPriority[basis] ?? 0, explicit: !!override };
  });
  candidates.sort((a, b) => b.rank - a.rank || Number(b.event.currentRevision ?? 0) - Number(a.event.currentRevision ?? 0) || String(a.event.id).localeCompare(String(b.event.id)));
  const topRank = candidates[0].rank;
  const top = candidates.filter((candidate) => candidate.rank === topRank);
  const known = top.filter((candidate) => candidate.value != null);
  const distinct = new Set(known.map((candidate) => String(candidate.value)));
  const explicitNull = top.some((candidate) => candidate.explicit && candidate.value == null);
  const disagreement = distinct.size > 1 || (explicitNull && known.length > 0);
  const chosen = known[0] ?? top[0];
  return { ...chosen, value: disagreement ? null : chosen.value, disagreement, candidates: top };
}

function datesBetween(from: string, to: string, timezone: string): string[] {
  const dates: string[] = []; let cursor = DateTime.fromISO(from, { zone: timezone }); const end = DateTime.fromISO(to, { zone: timezone });
  while (cursor.isValid && cursor <= end) { dates.push(cursor.toISODate()!); cursor = cursor.plus({ days: 1 }); }
  return dates;
}

function currentRevisionRefs(events: Record<string, unknown>[], sessions: TrendSession[], notes: Array<{ id: string; current_revision: number; actor_id: string | null }>): Record<string, unknown>[] {
  const refs = new Map<string, Record<string, unknown>>();
  for (const event of events) refs.set(`event:${String(event.id)}`, { eventId: event.id, revision: event.currentRevision, actorId: event.actorId, source: event.source ?? null, basis: metricBasis(event) });
  for (const session of sessions) refs.set(`session:${session.id}`, { sessionId: session.id, revision: session.current_revision, actorId: session.actor_id });
  for (const note of notes) refs.set(`note:${note.id}`, { noteId: note.id, revision: note.current_revision, actorId: note.actor_id });
  return [...refs.values()];
}

export function trends(db: AppDatabase, days: 7 | 30 | 90, asOf = new Date(), timezone = 'UTC') {
  const localEnd = DateTime.fromJSDate(asOf, { zone: timezone });
  if (!localEnd.isValid) throw new HttpError(422, 'invalid trends timezone', 'invalid_timezone');
  const endDate = localEnd.toISODate()!; const startDate = localEnd.minus({ days: days - 1 }).toISODate()!;
  const all = listEvents(db);
  const sessions = db.prepare('SELECT id,kind,local_date,timezone,current_revision,actor_id FROM sessions').all() as TrendSession[];
  const sessionMap = new Map(sessions.map((session) => [session.id, session]));
  const anchorDate = (event: Record<string, unknown>): string | null => {
    const session = event.sessionId ? sessionMap.get(String(event.sessionId)) : undefined;
    return session?.local_date ?? (typeof event.localDate === 'string' ? event.localDate : null);
  };
  const inWindow = (date: string | null): date is string => !!date && date >= startDate && date <= endDate;
  const anchoredSessions = sessions.filter((session) => inWindow(session.local_date));
  const relevant = all.filter((event) => inWindow(anchorDate(event)));
  const rows = relevant.filter((event) => event.durationMinutes != null || event.numericValue != null || event.startAtLocal != null || event.endAtLocal != null || event.notes != null || event.metricOverrides != null);
  const durationRows = rows.filter((event) => ['sleep_duration', 'duration_report', 'nap'].includes(String(event.eventType)) || Object.prototype.hasOwnProperty.call((event.metricOverrides as Record<string, unknown> | null) ?? {}, 'durationMinutes'));
  const groups = new Map<string, Record<string, unknown>[]>();
  for (const event of durationRows) { const key = event.sessionId ? `session:${event.sessionId}` : `event:${event.id}`; groups.set(key, [...(groups.get(key) ?? []), event]); }
  const selectedDurations = [...groups.values()].map((group) => selectMetric(group, 'durationMinutes', (event) => event.durationMinutes)).filter((value): value is SelectedMetric => value !== null);
  const numericDuration = selectedDurations.filter((value) => value.value != null && inWindow(anchorDate(value.event)));
  const restednessGroups = new Map<string, Record<string, unknown>[]>();
  for (const event of rows.filter((candidate) => candidate.eventType === 'restedness' || Object.prototype.hasOwnProperty.call((candidate.metricOverrides as Record<string, unknown> | null) ?? {}, 'restedness'))) { const key = event.sessionId ? `session:${event.sessionId}` : `event:${event.id}`; restednessGroups.set(key, [...(restednessGroups.get(key) ?? []), event]); }
  const selectedRestedness = [...restednessGroups.values()].map((group) => selectMetric(group, 'restedness', (event) => event.numericValue)).filter((value): value is SelectedMetric => value !== null);
  const numericRestedness = selectedRestedness.filter((value) => value.value != null && inWindow(anchorDate(value.event)));
  const durationMinutes = numericDuration.reduce((sum, selected) => sum + Number(selected.value), 0);
  const contributingEvents: Record<string, unknown>[] = [];
  const contributingSessions = new Map<string, TrendSession>();
  const addContribution = (event: Record<string, unknown>) => { contributingEvents.push(event); if (event.sessionId) { const session = sessionMap.get(String(event.sessionId)); if (session) contributingSessions.set(session.id, session); } };
  for (const selected of selectedDurations) for (const candidate of selected.candidates) addContribution(candidate.event);
  for (const selected of selectedRestedness) for (const candidate of selected.candidates) addContribution(candidate.event);

  const windows: TrendWindow[] = [];
  const completedNaps = new Map<string, { localDate: string; window: TrendWindow }>();
  for (const event of rows.filter((candidate) => ['nap', 'sleep_onset', 'estimated_sleep_onset'].includes(String(candidate.eventType)) && candidate.startAtLocal && candidate.endAtLocal && !candidate.sessionId)) {
    const date = anchorDate(event); if (!date || !inWindow(date)) continue;
    try {
      const value = elapsedMinutes(String(event.startAtLocal), String(event.endAtLocal), String(event.timezone), event.localOffset as string | null, event.endLocalOffset as string | null);
      const kind = event.eventType === 'nap' ? 'nap' : 'overnight'; const provenance = event.eventType === 'nap' ? ['direct_completed_nap'] : [String(event.eventType), 'direct_actual_interval'];
      const window: TrendWindow = { eventId: String(event.id), localDate: date, elapsedMinutes: value, kind, onsetLocal: String(event.startAtLocal), wakeLocal: String(event.endAtLocal), provenance };
      windows.push(window); if (kind === 'nap') completedNaps.set(`event:${event.id}`, { localDate: date, window }); addContribution(event);
    } catch { windows.push({ eventId: String(event.id), localDate: date, elapsedMinutes: null, disagreement: true, kind: event.eventType === 'nap' ? 'nap' : 'overnight', provenance: ['invalid_actual_interval'] }); addContribution(event); }
  }
  for (const session of anchoredSessions) {
    const members = all.filter((event) => event.sessionId === session.id);
    const timezoneMismatch = members.some((event) => !event.timezone || event.timezone !== session.timezone);
    const starts = members.filter((event) => session.kind === 'nap' ? event.eventType === 'nap_start' && event.startAtLocal : ['sleep_onset', 'estimated_sleep_onset'].includes(String(event.eventType)) && event.startAtLocal);
    const ends = members.filter((event) => session.kind === 'nap' ? event.eventType === 'nap_end' && event.endAtLocal : event.eventType === 'final_wake' && event.endAtLocal);
    const provenance = session.kind === 'nap' ? ['grouped_completed_nap'] : [starts[0]?.eventType === 'estimated_sleep_onset' ? 'estimated_sleep_onset' : 'sleep_onset', 'final_wake'];
    if (starts.length === 1 && ends.length === 1 && !timezoneMismatch) {
      try {
        const value = elapsedMinutes(String(starts[0].startAtLocal), String(ends[0].endAtLocal), session.timezone, starts[0].localOffset as string | null, ends[0].endLocalOffset as string | null);
        const window: TrendWindow = { eventId: session.id, localDate: session.local_date!, elapsedMinutes: value, kind: session.kind === 'nap' ? 'nap' : 'overnight', onsetLocal: String(starts[0].startAtLocal), wakeLocal: String(ends[0].endAtLocal), provenance };
        windows.push(window); addContribution(starts[0]); addContribution(ends[0]); contributingSessions.set(session.id, session);
        if (session.kind === 'nap') completedNaps.set(`session:${session.id}`, { localDate: session.local_date!, window });
      } catch { windows.push({ eventId: session.id, localDate: session.local_date!, elapsedMinutes: null, disagreement: true, kind: session.kind === 'nap' ? 'nap' : 'overnight', provenance: ['invalid_or_ambiguous_pair'] }); for (const event of [...starts, ...ends]) addContribution(event); contributingSessions.set(session.id, session); }
    } else if (starts.length || ends.length) {
      windows.push({ eventId: session.id, localDate: session.local_date!, elapsedMinutes: null, disagreement: true, kind: session.kind === 'nap' ? 'nap' : 'overnight', provenance: timezoneMismatch ? ['timezone_disagreement'] : ['ambiguous_or_incomplete_pair'] });
      for (const event of [...starts, ...ends]) addContribution(event); contributingSessions.set(session.id, session);
    }
  }
  for (const selected of numericDuration) {
    const session = selected.event.sessionId ? sessionMap.get(String(selected.event.sessionId)) : undefined;
    if (selected.event.eventType === 'nap' || session?.kind === 'nap') {
      const date = anchorDate(selected.event); if (date && inWindow(date)) completedNaps.set(selected.event.sessionId ? `session:${selected.event.sessionId}` : `event:${selected.event.id}`, { localDate: date, window: { eventId: String(selected.event.id), localDate: date, elapsedMinutes: null, kind: 'nap', onsetLocal: null, wakeLocal: null, provenance: ['reported_nap_duration'] } });
    }
  }

  const noteRows = db.prepare('SELECT id,session_id,range_start,range_end,current_revision,actor_id,updated_at_utc FROM notes').all() as Array<{ id: string; session_id: string | null; range_start: string | null; range_end: string | null; current_revision: number; actor_id: string | null; updated_at_utc: string }>;
  const windowDates = datesBetween(startDate, endDate, timezone); const noteDates = new Set<string>(); const contributingNotes: Array<{ id: string; current_revision: number; actor_id: string | null }> = [];
  for (const note of noteRows) {
    const linkedDate = note.session_id ? sessionMap.get(note.session_id)?.local_date ?? null : null;
    const from = note.range_start ?? note.range_end ?? linkedDate; const to = note.range_end ?? note.range_start ?? linkedDate;
    if (!from || !to) continue;
    const overlapStart = from > startDate ? from : startDate; const overlapEnd = to < endDate ? to : endDate;
    if (overlapStart > overlapEnd) continue;
    for (const date of datesBetween(overlapStart, overlapEnd, timezone)) if (inWindow(date)) noteDates.add(date);
    contributingNotes.push({ id: note.id, current_revision: note.current_revision, actor_id: note.actor_id });
    if (note.session_id) { const session = sessionMap.get(note.session_id); if (session) contributingSessions.set(session.id, session); }
  }
  const durationDates = new Set(numericDuration.map((selected) => anchorDate(selected.event)).filter((date): date is string => inWindow(date)));
  const restednessDates = new Set(numericRestedness.map((selected) => anchorDate(selected.event)).filter((date): date is string => inWindow(date)));
  const validWindowDates = new Set(windows.filter((window) => window.elapsedMinutes != null && !window.disagreement).map((window) => window.localDate));
  const recordDates = new Set<string>([...selectedDurations, ...selectedRestedness].map((selected) => anchorDate(selected.event)).filter((date): date is string => inWindow(date)));
  for (const window of windows) if (inWindow(window.localDate)) recordDates.add(window.localDate); for (const date of noteDates) recordDates.add(date);
  const refs = currentRevisionRefs(contributingEvents, [...contributingSessions.values()], contributingNotes);
  const series = windowDates.map((date) => {
    const dailyDuration = numericDuration.filter((selected) => anchorDate(selected.event) === date).reduce((sum, selected) => sum + Number(selected.value), 0);
    const dailyWindows = windows.filter((window) => window.localDate === date);
    const dailyNaps = [...completedNaps.values()].filter((nap) => nap.localDate === date).map((nap) => nap.window);
    const dailyRestedness = numericRestedness.filter((selected) => anchorDate(selected.event) === date).map((selected) => Number(selected.value));
    const timing = dailyWindows.find((window) => window.onsetLocal || window.wakeLocal);
    return { date, durationMinutes: numericDuration.some((selected) => anchorDate(selected.event) === date) ? dailyDuration : null, elapsedWindowMinutes: dailyWindows.length && dailyWindows.every((window) => window.elapsedMinutes != null && !window.disagreement) ? dailyWindows.reduce((sum, window) => sum + Number(window.elapsedMinutes), 0) : null, restedness: dailyRestedness.length ? dailyRestedness.reduce((sum, value) => sum + value, 0) / dailyRestedness.length : null, napCount: dailyNaps.length || null, onsetLocal: timing?.onsetLocal ?? null, wakeLocal: timing?.wakeLocal ?? null, timingProvenance: timing?.provenance ?? null };
  });
  const selectedMetrics = [...selectedDurations.map((selected) => ({ metric: 'durationMinutes', value: selected.value, basis: selected.basis, eventId: selected.event.id, sessionId: selected.event.sessionId ?? null, anchorDate: anchorDate(selected.event), actorId: selected.event.actorId, revision: selected.event.currentRevision, source: selected.event.source ?? null, disagreement: selected.disagreement, provenance: selected.candidates.map((candidate) => ({ eventId: candidate.event.id, value: candidate.value, basis: candidate.basis, actorId: candidate.event.actorId, revision: candidate.event.currentRevision, source: candidate.event.source ?? null })) })), ...selectedRestedness.map((selected) => ({ metric: 'restedness', value: selected.value, basis: selected.basis, eventId: selected.event.id, sessionId: selected.event.sessionId ?? null, anchorDate: anchorDate(selected.event), actorId: selected.event.actorId, revision: selected.event.currentRevision, source: selected.event.source ?? null, disagreement: selected.disagreement, provenance: selected.candidates.map((candidate) => ({ eventId: candidate.event.id, value: candidate.value, basis: candidate.basis, actorId: candidate.event.actorId, revision: candidate.event.currentRevision, source: candidate.event.source ?? null })) }))];
  const generatedAtUtc = now(); const payload = { windowDays: days, windowStart: startDate, windowEnd: endDate, timezone, generatedAtUtc, coverage: { daysWithRecords: Math.min(days, recordDates.size), totalDays: days, percent: Math.min(100, Math.round(recordDates.size / days * 100)), byMetric: { reportedDurationDays: durationDates.size, restednessDays: restednessDates.size, elapsedWindowDays: validWindowDates.size, napDays: new Set([...completedNaps.values()].map((nap) => nap.localDate)).size } }, totalReportedSleepMinutes: numericDuration.length ? durationMinutes : null, averageReportedDurationMinutes: numericDuration.length ? Math.round(durationMinutes / numericDuration.length) : null, elapsedWindows: windows, series, napCount: completedNaps.size, selectedMetrics, disagreements: [...selectedDurations, ...selectedRestedness].filter((selected) => selected.disagreement).flatMap((selected) => selected.candidates.map((candidate) => candidate.event.id)), latestRecordDate: [...recordDates].sort().at(-1) ?? null, caveat: 'Reported duration, completed naps, and elapsed windows are selected independently; missing or disputed values remain unknown.' };
  const existing = db.prepare('SELECT id FROM summaries WHERE window_days=? ORDER BY generated_at_utc DESC LIMIT 1').get(days) as { id: string } | undefined; const id = existing?.id ?? opaqueId('sum');
  if (existing) { db.prepare('DELETE FROM summaries WHERE window_days=? AND id<>?').run(days, id); db.prepare('UPDATE summaries SET generated_at_utc=?,payload_json=?,source_revision_refs_json=?,stale_at_utc=NULL WHERE id=?').run(generatedAtUtc, JSON.stringify(payload), JSON.stringify(refs), id); } else db.prepare('INSERT INTO summaries(id,window_days,generated_at_utc,payload_json,source_revision_refs_json) VALUES(?,?,?,?,?)').run(id, days, generatedAtUtc, JSON.stringify(payload), JSON.stringify(refs));
  const freshness = db.prepare('SELECT stale_at_utc FROM summaries WHERE id=?').get(id) as { stale_at_utc: string | null };
  return { id, ...payload, sourceRevisionRefs: refs, stale: freshness.stale_at_utc !== null };
}
