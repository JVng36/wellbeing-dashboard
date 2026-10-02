import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const now = () => new Date().toISOString();
export const opaqueId = (prefix: string) => `${prefix}_${randomUUID()}`;
export const randomToken = () => randomBytes(32).toString('base64url');
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

export function jsonValue<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  return JSON.parse(value) as T;
}

export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public code = 'request_error', public details?: unknown) { super(message); }
}
