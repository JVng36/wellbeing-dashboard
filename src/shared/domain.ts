import { z } from 'zod';
import { IANAZone } from 'luxon';

export const knownEventTypes = [
  'tracking_started', 'bedtime_intent', 'sleep_onset', 'estimated_sleep_onset',
  'night_awakening', 'early_wake', 'final_wake', 'nap', 'nap_start', 'nap_end',
  'nap_intent', 'restedness', 'duration_report', 'sleep_duration', 'wake_report', 'correction'
] as const;

const nullableText = z.string().max(20_000).nullable().optional();
const localDateTime = z.string().regex(/^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,9})?)?$/, 'use a local ISO timestamp without a zone').nullable().optional();
const localDate = z.string().regex(/^\d{4}-\d\d-\d\d$/).superRefine((value, ctx) => { const d = new Date(`${value}T00:00:00Z`); if (Number.isNaN(d.valueOf()) || d.toISOString().slice(0, 10) !== value) ctx.addIssue({ code: 'custom', message: 'invalid calendar date' }); });

export const uncertaintySchema = z.object({
  earliestLocal: localDateTime,
  earliestOffset: z.string().regex(/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  latestLocal: localDateTime,
  latestOffset: z.string().regex(/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  prose: nullableText
}).strict().superRefine((value, ctx) => {
  if (value.earliestLocal && !value.earliestOffset) ctx.addIssue({ code: 'custom', path: ['earliestOffset'], message: 'earliestOffset is required with earliestLocal' });
  if (value.latestLocal && !value.latestOffset) ctx.addIssue({ code: 'custom', path: ['latestOffset'], message: 'latestOffset is required with latestLocal' });
}).nullable().optional();

const metricOverrideValue = z.object({
  value: z.unknown(),
  basis: z.enum(['explicit_user_correction', 'wearable_estimate', 'user_report', 'unknown', 'assistant_inference']),
  note: z.string().max(2_000).nullable().optional()
}).strict();
export const metricOverrideSchema = z.record(z.string(), metricOverrideValue).nullable().optional().superRefine((value, ctx) => {
  if (!value) return;
  for (const [key, entry] of Object.entries(value)) {
    const n = entry.value;
    if (n !== null && typeof n !== 'number') { ctx.addIssue({ code: 'custom', path: [key, 'value'], message: 'override must be finite numeric or null' }); continue; }
    if (typeof n === 'number' && !Number.isFinite(n)) ctx.addIssue({ code: 'custom', path: [key, 'value'], message: 'override must be finite' });
    if (key === 'durationMinutes' && n !== null && (!Number.isInteger(n) || n < 0 || n > 10080)) ctx.addIssue({ code: 'custom', path: [key, 'value'], message: 'durationMinutes must be an integer from 0 through 10080' });
    if (key === 'restedness' && n !== null && (!Number.isInteger(n) || n < 1 || n > 10)) ctx.addIssue({ code: 'custom', path: [key, 'value'], message: 'restedness must be an integer from 1 through 10' });
    if (!['durationMinutes', 'restedness'].includes(key)) ctx.addIssue({ code: 'custom', path: [key], message: 'unknown metric override' });
  }
});

export const eventInputSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  eventType: z.string().min(1).max(120),
  startAtLocal: localDateTime,
  endAtLocal: localDateTime,
  localDate: localDate.nullable().optional(),
  timezone: z.string().min(1).max(120).nullable().optional(),
  localOffset: z.string().regex(/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  endLocalOffset: z.string().regex(/^[+-](?:0\d|1\d|2[0-3]):[0-5]\d$/).nullable().optional(),
  durationMinutes: z.number().int().nonnegative().max(7 * 24 * 60).nullable().optional(),
  numericValue: z.number().finite().nullable().optional(),
  reportedAtUtc: z.string().datetime({ offset: true }).nullable().optional(),
  source: z.string().min(1).max(120).nullable().optional(),
  confidence: z.enum(['high', 'medium', 'low']).nullable().optional(),
  notes: nullableText,
  sourceMessageId: z.string().max(500).nullable().optional(),
  sourceReference: z.string().max(500).nullable().optional(),
  supersedesEventId: z.string().max(200).nullable().optional(),
  createdAtUtc: z.string().datetime({ offset: true }).nullable().optional(),
  sessionId: z.string().max(200).nullable().optional(),
  pairingProvenance: z.enum(['explicit_session', 'bounded_16h_pair', 'legacy_unpaired']).nullable().optional(),
  uncertainty: uncertaintySchema,
  metricOverrides: metricOverrideSchema
}).strict().superRefine((value, ctx) => {
  if (value.timezone && !IANAZone.isValidZone(value.timezone)) ctx.addIssue({ code: 'custom', path: ['timezone'], message: 'timezone must be a valid IANA zone' });
  if ((value.startAtLocal || value.endAtLocal || value.uncertainty?.earliestLocal || value.uncertainty?.latestLocal) && !value.timezone) ctx.addIssue({ code: 'custom', path: ['timezone'], message: 'timezone is required when a local time is supplied' });
  if (value.eventType === 'restedness' && value.numericValue != null && (value.numericValue < 1 || value.numericValue > 10)) {
    ctx.addIssue({ code: 'custom', path: ['numericValue'], message: 'restedness must be from 1 through 10' });
  }
  if (value.startAtLocal && !value.localOffset) {
    ctx.addIssue({ code: 'custom', path: ['localOffset'], message: 'localOffset is required when a local time is supplied' });
  }
  if (value.endAtLocal && !value.endLocalOffset) ctx.addIssue({ code: 'custom', path: ['endLocalOffset'], message: 'endLocalOffset is required when an end time is supplied' });
  if (value.eventType === 'correction' && !value.supersedesEventId) {
    ctx.addIssue({ code: 'custom', path: ['supersedesEventId'], message: 'correction records must link to the superseded event' });
  }
  if (value.eventType !== 'tracking_started' && !value.startAtLocal && !value.endAtLocal && !value.localDate && value.durationMinutes == null && value.numericValue == null && !value.notes && !value.supersedesEventId && !value.metricOverrides) {
    ctx.addIssue({ code: 'custom', path: [], message: 'at least one meaningful observation field is required' });
  }
});

export const eventPatchSchema = eventInputSchema.partial().omit({ id: true, createdAtUtc: true }).extend({
  expectedRevision: z.number().int().positive(),
  correctionReason: z.string().max(2_000).nullable().optional()
}).strict();

export const noteInputSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(100_000),
  sessionId: z.string().max(200).nullable().optional(),
  rangeStart: localDate.nullable().optional(),
  rangeEnd: localDate.nullable().optional()
}).strict().superRefine((value, ctx) => {
  if (value.rangeStart && value.rangeEnd && value.rangeStart > value.rangeEnd) ctx.addIssue({ code: 'custom', path: ['rangeEnd'], message: 'rangeEnd must not precede rangeStart' });
});

export const sessionInputSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  kind: z.enum(['overnight', 'nap']),
  localDate: localDate.nullable().optional(),
  timezone: z.string().min(1).max(120).refine((value) => IANAZone.isValidZone(value), 'timezone must be a valid IANA zone'),
  events: z.array(z.object({ id: z.string().min(1), expectedRevision: z.number().int().positive() }).strict()).min(1)
}).strict().superRefine((value, ctx) => {
  if (new Set(value.events.map((event) => event.id)).size !== value.events.length) ctx.addIssue({ code: 'custom', path: ['events'], message: 'duplicate event IDs are not allowed' });
});

export const credentialInputSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(z.enum(['events:read', 'events:write', 'notes:read', 'notes:write', 'trends:read'])).min(1),
  expiresAt: z.string().datetime({ offset: true })
}).strict();

export type EventInput = z.infer<typeof eventInputSchema>;
export type EventPatch = z.infer<typeof eventPatchSchema>;

export const metricPriority: Record<string, number> = {
  unknown: 0,
  assistant_inference: 1,
  user_report: 2,
  wearable_estimate: 3,
  explicit_user_correction: 4
};
