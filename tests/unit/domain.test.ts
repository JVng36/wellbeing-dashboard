import { describe, expect, it } from 'vitest';
import { eventInputSchema } from '../../src/shared/domain.js';

describe('event domain', () => {
  it('keeps unknown legacy values but validates restedness', () => {
    expect(eventInputSchema.parse({ eventType: 'future_legacy_kind', timezone: 'UTC', notes: 'preserved evidence' }).eventType).toBe('future_legacy_kind');
    expect(() => eventInputSchema.parse({ eventType: 'restedness', timezone: 'UTC', numericValue: 11 })).toThrow();
    expect(() => eventInputSchema.parse({ eventType: 'nap', timezone: 'UTC' })).toThrow(/meaningful/i);
    expect(() => eventInputSchema.parse({ eventType: 'sleep_onset', timezone: 'America/New_York', startAtLocal: '2025-11-02T01:30' })).toThrow(/localOffset/i);
    expect(() => eventInputSchema.parse({ eventType: 'nap', timezone: 'UTC', localDate: '2025-01-01', uncertainty: { earliestLocal: '2025-01-01T01:00', latestLocal: '2025-01-01T02:00', prose: 'about then' } })).toThrow(/Offset/i);
  });
});
