import { DateTime, IANAZone } from 'luxon';

function offsetText(minutes: number): string {
  const sign = minutes >= 0 ? '+' : '-';
  const absolute = Math.abs(minutes);
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}:${String(absolute % 60).padStart(2, '0')}`;
}

function possibleInstants(local: string, zone: string): DateTime[] {
  const fields = DateTime.fromISO(local, { zone: 'UTC' }).toObject();
  if (!fields.year || !fields.month || !fields.day || fields.hour == null || fields.minute == null) return [];
  const localMillis = Date.UTC(fields.year, fields.month - 1, fields.day, fields.hour, fields.minute, fields.second ?? 0, fields.millisecond ?? 0);
  const iana = IANAZone.create(zone);
  const candidates = new Map<number, DateTime>();
  for (let delta = -18 * 60; delta <= 18 * 60; delta += 15) {
    const instant = localMillis - delta * 60_000;
    if (iana.offset(instant) !== delta) continue;
    const rendered = DateTime.fromMillis(instant, { zone }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
    const normalized = DateTime.fromISO(local, { zone: 'UTC' }).toFormat("yyyy-MM-dd'T'HH:mm:ss");
    if (rendered === normalized) candidates.set(instant, DateTime.fromMillis(instant, { zone }));
  }
  return [...candidates.values()].sort((a, b) => a.toMillis() - b.toMillis());
}

export function validateLocalTime(local: string, zone: string, requiredOffset?: string | null): { utc: string; offset: string } {
  if (!IANAZone.isValidZone(zone)) throw new Error(`Unknown IANA timezone: ${zone}`);
  const candidates = possibleInstants(local, zone);
  if (!candidates.length) throw new Error(`Nonexistent local time in ${zone}: ${local}`);
  if (candidates.length > 1 && !requiredOffset) throw new Error(`Ambiguous local time requires explicit localOffset: ${local}`);
  const selected = requiredOffset ? candidates.find((d) => offsetText(d.offset) === requiredOffset) : candidates[0];
  if (!selected) throw new Error(`localOffset ${requiredOffset} does not match ${local} in ${zone}`);
  return { utc: selected.toUTC().toISO()!, offset: offsetText(selected.offset) };
}

export function elapsedMinutes(start: string | null, end: string | null, zone: string, startOffset: string | null, endOffset: string | null): number | null {
  if (!start || !end) return null;
  const a = validateLocalTime(start, zone, startOffset).utc;
  const b = validateLocalTime(end, zone, endOffset ?? startOffset).utc;
  const minutes = Math.round((DateTime.fromISO(b).toMillis() - DateTime.fromISO(a).toMillis()) / 60_000);
  if (minutes < 0) throw new Error('end time precedes start time');
  return minutes;
}
