import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { eventInputSchema, metricOverrideSchema } from '../../src/shared/domain.js';
import { validateLocalTime } from '../../src/shared/time.js';

const override = (metric: string, value: unknown) => ({ [metric]: { value, basis: 'explicit_user_correction' } });

describe('correction regression contracts', () => {
  it('rejects negative duration overrides', () => expect(() => metricOverrideSchema.parse(override('durationMinutes', -1))).toThrow());
  it('rejects fractional duration overrides', () => expect(() => metricOverrideSchema.parse(override('durationMinutes', 1.5))).toThrow());
  it('rejects duration overrides above seven days', () => expect(() => metricOverrideSchema.parse(override('durationMinutes', 10081))).toThrow());
  it('rejects restedness below one', () => expect(() => metricOverrideSchema.parse(override('restedness', 0))).toThrow());
  it('rejects restedness above ten', () => expect(() => metricOverrideSchema.parse(override('restedness', 11))).toThrow());
  it('rejects unknown override metrics', () => expect(() => metricOverrideSchema.parse(override('unknownMetric', 1))).toThrow());
  it('preserves explicit null as an override value', () => {
    expect(metricOverrideSchema.parse(override('durationMinutes', null))).toEqual({ durationMinutes: { value: null, basis: 'explicit_user_correction' } });
  });

  it('rejects impossible calendar dates at the event boundary', () => {
    expect(() => eventInputSchema.parse({ eventType: 'sleep_duration', localDate: '2026-99-99', timezone: 'UTC', durationMinutes: 20 })).toThrow();
  });
  it('rejects unknown IANA zones at the event boundary', () => {
    expect(() => eventInputSchema.parse({ eventType: 'sleep_duration', localDate: '2026-01-01', timezone: 'Not/AZone', durationMinutes: 20 })).toThrow();
  });
  it('accepts a valid one-sided UTC uncertainty endpoint', () => {
    expect(eventInputSchema.parse({ eventType: 'sleep_duration', localDate: '2026-01-01', timezone: 'UTC', durationMinutes: 20, uncertainty: { earliestLocal: '2026-01-01T01:00', earliestOffset: '+00:00' } }).uncertainty?.earliestLocal).toBe('2026-01-01T01:00');
  });
  it('accepts a valid one-sided UTC latest endpoint', () => {
    expect(eventInputSchema.parse({ eventType: 'sleep_duration', localDate: '2026-01-01', timezone: 'UTC', durationMinutes: 20, uncertainty: { latestLocal: '2026-01-01T02:00', latestOffset: '+00:00' } }).uncertainty?.latestLocal).toBe('2026-01-01T02:00');
  });
  it('rejects a supplied one-sided nonexistent local endpoint', () => {
    expect(() => validateLocalTime('2026-03-08T02:30', 'America/New_York', '-05:00')).toThrow(/nonexistent/i);
  });

  it('parses every documented JSON example and validates it with the shared schema', () => {
    const source = readFileSync('docs/api-examples.md', 'utf8');
    const examples = [...source.matchAll(/```json\s*([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]));
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) expect(() => eventInputSchema.parse(example)).not.toThrow();
  });
});
