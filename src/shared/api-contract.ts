import { z } from 'zod';
import { credentialInputSchema, eventInputSchema, eventPatchSchema, metricOverrideSchema, noteInputSchema, sessionInputSchema, uncertaintySchema } from './domain.js';

const nullableText = z.string().nullable();
const dateTime = z.string().datetime({ offset: true });
const date = z.string().date();

export const setupRequestSchema = z.object({ username: z.string().min(1).max(100), password: z.string().min(12).max(500) }).strict();
export const loginRequestSchema = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(500) }).strict();
export const emptyRequestSchema = z.object({}).strict();
export const legacyImportRequestSchema = z.object({ files: z.array(z.object({ name: z.string().min(1).max(120), content: z.string() }).strict()).min(1) }).strict();
export const backupRequestSchema = z.object({ label: z.string().max(50).optional() }).strict();

const eventFields = {
  id: z.string(), eventType: z.string(), startAtLocal: nullableText, endAtLocal: nullableText, localDate: date.nullable(), timezone: nullableText,
  localOffset: nullableText, endLocalOffset: nullableText, durationMinutes: z.number().int().min(0).max(10080).nullable(), numericValue: z.number().finite().nullable(),
  reportedAtUtc: dateTime.nullable(), source: nullableText, confidence: z.enum(['high', 'medium', 'low']).nullable(), notes: nullableText,
  sourceMessageId: nullableText, sourceReference: nullableText, supersedesEventId: nullableText, createdAtUtc: dateTime.nullable(), sessionId: nullableText,
  pairingProvenance: z.enum(['explicit_session', 'bounded_16h_pair', 'legacy_unpaired']).nullable(), uncertainty: uncertaintySchema, metricOverrides: metricOverrideSchema
};
export const eventResponseSchema = z.object({ ...eventFields, currentRevision: z.number().int().positive(), actorId: z.string(), updatedAtUtc: dateTime }).passthrough();
export const eventListResponseSchema = z.array(eventResponseSchema);
export const eventHistoryResponseSchema = z.array(z.object({ revision: z.number().int().positive(), actorId: z.string(), reason: nullableText, createdAtUtc: dateTime, snapshot: eventResponseSchema }).strict());

export const sessionCreateResponseSchema = z.object({ id: z.string(), kind: z.enum(['overnight', 'nap']), localDate: date.nullable().optional(), timezone: z.string(), events: z.array(z.object({ id: z.string(), expectedRevision: z.number().int().positive() }).strict()), provenance: z.string(), currentRevision: z.number().int().positive(), actorId: z.string() }).passthrough();
export const sessionResponseSchema = z.object({ id: z.string(), kind: z.enum(['overnight', 'nap']), localDate: date.nullable(), timezone: z.string(), provenance: z.string(), currentRevision: z.number().int().positive(), createdAtUtc: dateTime, updatedAtUtc: dateTime, actorId: z.string() }).passthrough();
export const sessionListResponseSchema = z.array(sessionResponseSchema);
export const sessionHistoryResponseSchema = z.array(z.object({ revision: z.number().int().positive(), actorId: z.string(), reason: nullableText, createdAtUtc: dateTime, snapshot: sessionResponseSchema }).strict());

export const noteResponseSchema = z.object({ id: z.string(), body: z.string(), session_id: nullableText, range_start: date.nullable(), range_end: date.nullable(), current_revision: z.number().int().positive(), created_at_utc: dateTime, updated_at_utc: dateTime, actor_id: nullableText }).passthrough();
export const noteListResponseSchema = z.array(noteResponseSchema);
export const noteHistoryResponseSchema = z.array(z.object({ revision: z.number().int().positive(), actorId: z.string(), createdAtUtc: dateTime, snapshot: noteResponseSchema }).strict());

const sourceRevisionRefSchema = z.union([
  z.object({ eventId: z.string(), revision: z.number().int().positive(), actorId: z.string(), source: nullableText, basis: z.string() }).strict(),
  z.object({ sessionId: z.string(), revision: z.number().int().positive(), actorId: z.string() }).strict(),
  z.object({ noteId: z.string(), revision: z.number().int().positive(), actorId: nullableText }).strict()
]);
const trendSeriesSchema = z.object({ date, durationMinutes: z.number().nullable(), elapsedWindowMinutes: z.number().nullable(), restedness: z.number().nullable(), napCount: z.number().int().nonnegative().nullable(), onsetLocal: nullableText, wakeLocal: nullableText, timingProvenance: z.array(z.string()).nullable() }).strict();
const selectedMetricSchema = z.object({ metric: z.enum(['durationMinutes', 'restedness']), value: z.number().nullable(), basis: z.string(), eventId: z.string(), sessionId: nullableText, anchorDate: date.nullable(), actorId: z.string(), revision: z.number().int().positive(), source: nullableText, disagreement: z.boolean(), provenance: z.array(z.object({ eventId: z.string(), value: z.number().nullable(), basis: z.string(), actorId: z.string(), revision: z.number().int().positive(), source: nullableText }).strict()) }).strict();
const elapsedWindowSchema = z.object({ eventId: z.string(), localDate: date, elapsedMinutes: z.number().nullable(), disagreement: z.boolean().optional(), kind: z.enum(['overnight', 'nap']), onsetLocal: nullableText.optional(), wakeLocal: nullableText.optional(), provenance: z.array(z.string()).optional() }).strict();
export const trendResponseSchema = z.object({
  id: z.string(), windowDays: z.union([z.literal(7), z.literal(30), z.literal(90)]), windowStart: date, windowEnd: date, timezone: z.string(), generatedAtUtc: dateTime,
  coverage: z.object({ daysWithRecords: z.number().int().nonnegative(), totalDays: z.number().int().positive(), percent: z.number().min(0).max(100), byMetric: z.object({ reportedDurationDays: z.number().int().nonnegative(), restednessDays: z.number().int().nonnegative(), elapsedWindowDays: z.number().int().nonnegative(), napDays: z.number().int().nonnegative() }).strict() }).strict(),
  totalReportedSleepMinutes: z.number().nullable(), averageReportedDurationMinutes: z.number().nullable(), elapsedWindows: z.array(elapsedWindowSchema), series: z.array(trendSeriesSchema), napCount: z.number().int().nonnegative(), selectedMetrics: z.array(selectedMetricSchema), sourceRevisionRefs: z.array(sourceRevisionRefSchema), disagreements: z.array(z.string()), latestRecordDate: date.nullable(), stale: z.boolean(), caveat: z.string()
}).passthrough();

export const authStatusResponseSchema = z.object({ setupRequired: z.boolean(), authenticated: z.boolean(), actor: z.enum(['owner', 'assistant']).optional(), csrfToken: nullableText.optional() }).strict();
export const authResponseSchema = z.object({ authenticated: z.literal(true), csrfToken: z.string(), expiresAt: dateTime }).strict();
export const healthResponseSchema = z.object({ ok: z.literal(true) }).strict();
export const credentialListResponseSchema = z.array(z.object({ id: z.string(), name: z.string(), scopes: z.array(z.string()), expiresAt: dateTime, revokedAt: dateTime.nullable(), createdAt: dateTime, lastUsedAt: dateTime.nullable() }).strict());
export const credentialCreateResponseSchema = z.object({ id: z.string(), name: z.string(), scopes: z.array(z.string()), expiresAt: dateTime, token: z.string() }).strict();
export const importResultSchema = z.object({ imported: z.number().int().nonnegative(), unchanged: z.number().int().nonnegative() }).strict();
export const backupResponseSchema = z.object({ file: z.string(), createdAtUtc: dateTime }).strict();
export const problemSchema = z.object({ error: z.string(), code: z.string(), details: z.unknown().optional() }).strict();
const exportSessionRowSchema = z.object({ id: z.string(), kind: z.enum(['overnight', 'nap']), local_date: date.nullable(), timezone: z.string(), provenance: z.enum(['explicit', 'bounded_16h_pair']), created_at_utc: dateTime, current_revision: z.number().int().positive(), updated_at_utc: dateTime.nullable(), actor_id: nullableText }).strict();
const exportEventRowSchema = eventResponseSchema.extend({ eventType: nullableText });
const exportNoteRowSchema = z.object({ id: z.string(), body: z.string(), session_id: nullableText, range_start: date.nullable(), range_end: date.nullable(), current_revision: z.number().int().positive(), created_at_utc: dateTime, updated_at_utc: dateTime, actor_id: nullableText }).strict();
const exportSessionRevisionSchema = z.object({ sessionId: z.string(), revision: z.number().int().positive(), snapshot: sessionResponseSchema, actorId: z.string(), reason: nullableText, createdAtUtc: dateTime }).strict();
const exportEventRevisionSchema = z.object({ eventId: z.string(), revision: z.number().int().positive(), snapshot: exportEventRowSchema, actorId: z.string(), reason: nullableText, createdAtUtc: dateTime }).strict();
const exportNoteRevisionSchema = z.object({ noteId: z.string(), revision: z.number().int().positive(), snapshot: exportNoteRowSchema, actorId: z.string(), createdAtUtc: dateTime }).strict();
const exportLegacyImportFileSchema = z.object({ eventId: nullableText, name: z.string().min(1), sha256: z.string().regex(/^[a-f0-9]{64}$/), importedAtUtc: dateTime, importerVersion: nullableText }).strict();
const exportMetricOverrideSchema = z.object({ eventId: z.string(), value: z.record(z.string(), z.object({ value: z.number().finite().nullable(), basis: z.enum(['explicit_user_correction', 'wearable_estimate', 'user_report', 'unknown', 'assistant_inference']), note: z.string().max(2_000).nullable().optional() }).strict()) }).strict();
export const exportResponseSchema = z.object({ formatVersion: z.number().int(), schemaVersion: z.number().int(), exportedAtUtc: dateTime, sessions: z.array(exportSessionRowSchema), sessionRevisions: z.array(exportSessionRevisionSchema), events: z.array(exportEventRowSchema), eventRevisions: z.array(exportEventRevisionSchema), notes: z.array(exportNoteRowSchema), noteRevisions: z.array(exportNoteRevisionSchema), legacyImportFiles: z.array(exportLegacyImportFileSchema), metricOverrides: z.array(exportMetricOverrideSchema), summaryDefinitions: z.array(z.union([z.literal(7), z.literal(30), z.literal(90)])), notice: z.string() }).strict();
export const openApiDocumentSchema = z.object({ openapi: z.literal('3.1.0'), info: z.record(z.string(), z.unknown()), paths: z.record(z.string(), z.unknown()), components: z.record(z.string(), z.unknown()) }).passthrough();
export const notePatchSchema = noteInputSchema.partial().extend({ expectedRevision: z.number().int().positive() }).strict();
const membershipRevisionSchema = z.object({ id: z.string().min(1), expectedRevision: z.number().int().positive() }).strict();
export const sessionPatchSchema = sessionInputSchema.partial().extend({ expectedRevision: z.number().int().positive(), reason: z.string().max(2000).nullable().optional(), removedEvents: z.array(membershipRevisionSchema).optional() }).strict().superRefine((value, ctx) => {
  if (value.events !== undefined && value.removedEvents === undefined) ctx.addIssue({ code: 'custom', path: ['removedEvents'], message: 'removedEvents is required when replacing membership' });
  if (value.events === undefined && value.removedEvents !== undefined) ctx.addIssue({ code: 'custom', path: ['removedEvents'], message: 'removedEvents is only allowed when replacing membership' });
  const removed = value.removedEvents ?? [];
  if (new Set(removed.map((event) => event.id)).size !== removed.length) ctx.addIssue({ code: 'custom', path: ['removedEvents'], message: 'duplicate removed event IDs are not allowed' });
  if (value.events && removed.some((removedEvent) => value.events!.some((event) => event.id === removedEvent.id))) ctx.addIssue({ code: 'custom', path: ['removedEvents'], message: 'removedEvents must not overlap events' });
});

export { credentialInputSchema, eventInputSchema, eventPatchSchema, noteInputSchema, sessionInputSchema };

export const contractSchemas = {
  EventInput: eventInputSchema, EventPatch: eventPatchSchema, NoteInput: noteInputSchema, NotePatch: notePatchSchema, SessionInput: sessionInputSchema,
  SessionPatch: sessionPatchSchema, CredentialInput: credentialInputSchema,
  SetupRequest: setupRequestSchema, LoginRequest: loginRequestSchema, EmptyRequest: emptyRequestSchema, LegacyImportRequest: legacyImportRequestSchema, BackupRequest: backupRequestSchema,
  Health: healthResponseSchema, AuthStatus: authStatusResponseSchema, AuthResponse: authResponseSchema, Event: eventResponseSchema, EventList: eventListResponseSchema, EventHistory: eventHistoryResponseSchema,
  SessionCreate: sessionCreateResponseSchema, Session: sessionResponseSchema, SessionList: sessionListResponseSchema, SessionHistory: sessionHistoryResponseSchema, Note: noteResponseSchema, NoteList: noteListResponseSchema, NoteHistory: noteHistoryResponseSchema,
  Trend: trendResponseSchema, CredentialList: credentialListResponseSchema, CredentialCreate: credentialCreateResponseSchema, ImportResult: importResultSchema, BackupResponse: backupResponseSchema, Export: exportResponseSchema, Problem: problemSchema, OpenApiDocument: openApiDocumentSchema
} as const;

export type EventResponse = z.infer<typeof eventResponseSchema>;
export type TrendResponse = z.infer<typeof trendResponseSchema>;
export type SessionResponse = z.infer<typeof sessionResponseSchema>;
export type NoteResponse = z.infer<typeof noteResponseSchema>;
export type AuthStatusResponse = z.infer<typeof authStatusResponseSchema>;
