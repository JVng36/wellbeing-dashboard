import { describe, expect, it } from 'vitest';
import { validateLocalTime, elapsedMinutes } from '../../src/shared/time.js';

describe('local time integrity', () => {
  it('rejects nonexistent DST time and requires ambiguous disambiguation', () => {
    expect(() => validateLocalTime('2025-01-01T01:00', 'Not/AZone')).toThrow(/Unknown IANA timezone/);
    expect(() => validateLocalTime('2025-03-09T02:30', 'America/New_York')).toThrow(/nonexistent/i);
    expect(() => validateLocalTime('2025-11-02T01:30', 'America/New_York')).toThrow(/ambiguous/i);
    expect(validateLocalTime('2025-11-02T01:30', 'America/New_York', '-04:00').offset).toBe('-04:00');
    expect(validateLocalTime('2025-11-02T01:30', 'America/New_York', '-05:00').utc).not.toBe(validateLocalTime('2025-11-02T01:30', 'America/New_York', '-04:00').utc);
  });

  it('handles cross-midnight elapsed time and preserves unknown duration', () => {
    expect(elapsedMinutes('2025-02-01T23:30', '2025-02-02T07:00', 'UTC', '+00:00', '+00:00')).toBe(450);
    expect(elapsedMinutes(null, '2025-02-02T07:00', 'UTC', null, '+00:00')).toBeNull();
    expect(elapsedMinutes('2025-11-02T01:30', '2025-11-02T01:30', 'America/New_York', '-04:00', '-05:00')).toBe(60);
  });
});
