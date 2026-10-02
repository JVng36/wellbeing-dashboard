import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import secureSession from '@fastify/secure-session';
import fastifyStatic from '@fastify/static';
import { hash, verify } from '@node-rs/argon2';
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, openSync, closeSync, readFileSync as readFileSyncRaw } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { credentialInputSchema, eventInputSchema, eventPatchSchema, noteInputSchema, sessionInputSchema } from '../shared/domain.js';
import { openDatabase, type AppDatabase } from './db.js';
import { createEvent, getEvent, getHistory, invalidateSummaries, listEvents, rowToEvent, trends, updateEvent } from './events.js';
import { createSnapshot } from './backup.js';
import { importLegacyFiles } from './importer.js';
import { canonicalJson, HttpError, now, opaqueId, randomToken, sha256 } from './util.js';
import { openapi } from './openapi.js';
import { validateExternalDataDir } from './config.js';
import { backupRequestSchema, emptyRequestSchema, legacyImportRequestSchema, loginRequestSchema, notePatchSchema, setupRequestSchema, sessionPatchSchema } from '../shared/api-contract.js';

export interface AppOptions { dataDir: string; secureCookies?: boolean; allowedOrigin?: string; trustedAuthorities?: string[]; staticDir?: string; sessionSeconds?: number }
type Actor = { id: string; kind: 'owner' | 'assistant'; scopes: string[] };

function bodyObject(request: FastifyRequest): Record<string, unknown> { return (request.body ?? {}) as Record<string, unknown>; }
const defaultTrustedAuthorities = new Set(['localhost', 'localhost:80', '127.0.0.1', '127.0.0.1:80', '[::1]', '[::1]:80']);
function requestOriginAllowed(request: FastifyRequest, configured?: string, authorities = defaultTrustedAuthorities): boolean {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    if (configured) {
      const allowed = new URL(configured); if (origin !== configured) return false;
      return String(request.headers.host ?? '') === allowed.host;
    }
    const host = String(request.headers.host ?? '');
    return [...authorities].some((authority) => {
      if (host !== authority) return false;
      const originAuthority = authority.endsWith(':80') ? authority.slice(0, -3) : authority;
      return origin === `http://${originAuthority}` || origin === `http://${authority}`;
    });
  } catch { return false; }
}
function requestAuthorityAllowed(request: FastifyRequest, configured?: string, authorities = defaultTrustedAuthorities): boolean {
  const host = String(request.headers.host ?? ''); if (configured) { try { return host === new URL(configured).host; } catch { return false; } }
  return authorities.has(host);
}
function errorStatusCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('statusCode' in error)) return undefined;
  const statusCode = error.statusCode;
  return typeof statusCode === 'number' ? statusCode : undefined;
}
function errorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error !== 'object' || error === null || !('message' in error)) return undefined;
  const message = error.message;
  return typeof message === 'string' ? message : undefined;
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance & { db: AppDatabase }> {
  const dataDir = validateExternalDataDir(resolve(options.dataDir));
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const activeMarker = join(dataDir, 'service.active');
  if (existsSync(activeMarker)) {
    try {
      const pid = Number(JSON.parse(readFileSyncRaw(activeMarker, 'utf8')).pid);
      process.kill(pid, 0);
      throw new Error(`data directory is already served by process ${pid}; stop it before opening another instance`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH' && !(error instanceof SyntaxError)) throw error;
      unlinkSync(activeMarker);
    }
  }
  const markerFd = openSync(activeMarker, 'wx', 0o600);
  writeFileSync(markerFd, JSON.stringify({ pid: process.pid, startedAtUtc: now() })); closeSync(markerFd);
  const keyPath = join(dataDir, 'session.key');
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const app = Fastify({ logger: false, trustProxy: false }) as unknown as FastifyInstance & { db: AppDatabase };
  app.db = openDatabase(dataDir);
  const trustedAuthorities = new Set(options.trustedAuthorities ?? [...defaultTrustedAuthorities]);
  const cleanupIdempotency = () => {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    // julianday parses both the current ISO form and older SQLite space-separated timestamps.
    app.db.prepare("DELETE FROM idempotency WHERE julianday(created_at_utc) <= julianday(?) OR julianday(created_at_utc) IS NULL").run(cutoff);
  };
  cleanupIdempotency();
  let setupGate: Promise<void> | null = null;
  await app.register(secureSession, {
    key: readFileSync(keyPath), cookieName: 'wellbeing_session', expiry: options.sessionSeconds ?? 8 * 60 * 60,
    cookie: { path: '/', httpOnly: true, secure: options.secureCookies ?? process.env.NODE_ENV === 'production', sameSite: 'strict' }
  });

  app.addHook('onClose', async () => { app.db.close(); try { if (Number(JSON.parse(readFileSync(activeMarker, 'utf8')).pid) === process.pid) unlinkSync(activeMarker); } catch { /* best-effort cleanup */ } });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError) return reply.code(400).send({ error: 'validation failed', code: 'validation_error', details: error.issues });
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message, code: error.code, details: error.details });
    const frameworkStatus = errorStatusCode(error) ?? 0;
    if (frameworkStatus >= 400 && frameworkStatus < 500) return reply.code(frameworkStatus).send({ error: 'invalid request', code: 'invalid_request' });
    const message = errorMessage(error);
    if (message && /Nonexistent|Ambiguous|localOffset|timezone|precedes/.test(message)) return reply.code(422).send({ error: message, code: 'time_integrity_error' });
    if (message && /UNIQUE constraint/.test(message)) return reply.code(409).send({ error: 'record conflicts with existing data', code: 'conflict' });
    return reply.code(500).send({ error: 'internal error', code: 'internal_error' });
  });
  app.addHook('onSend', async (request, reply) => { if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store'); });
  app.addHook('onRequest', async (request) => { if (!requestAuthorityAllowed(request, options.allowedOrigin, trustedAuthorities)) throw new HttpError(403, 'request authority denied', 'authority_denied'); });

  async function actor(request: FastifyRequest, requiredScope?: string): Promise<Actor> {
    const authorization = request.headers.authorization;
    if (authorization?.startsWith('Bearer ')) {
      const token = authorization.slice(7);
      const row = app.db.prepare('SELECT * FROM assistant_credentials WHERE token_hash=?').get(sha256(token)) as Record<string, unknown> | undefined;
      if (!row || row.revoked_at_utc || Date.parse(String(row.expires_at_utc)) <= Date.now()) throw new HttpError(401, 'invalid, expired, or revoked credential', 'credential_denied');
      const scopes = JSON.parse(String(row.scopes_json)) as string[];
      if (requiredScope && !scopes.includes(requiredScope)) throw new HttpError(403, `missing scope ${requiredScope}`, 'scope_denied');
      app.db.prepare('UPDATE assistant_credentials SET last_used_at_utc=? WHERE id=?').run(now(), String(row.id));
      return { id: `assistant:${row.id}`, kind: 'assistant', scopes };
    }
    const session = request.session as unknown as { get(k: string): unknown; set(k: string, v: unknown): void; delete(): void };
    const ownerId = session.get('ownerId'); const expiresAt = Number(session.get('expiresAt'));
    if (!ownerId || !expiresAt || expiresAt <= Date.now()) { if (ownerId) session.delete(); throw new HttpError(401, 'login required or session expired', 'session_denied'); }
    return { id: `owner:${ownerId}`, kind: 'owner', scopes: ['*'] };
  }
  async function ownerOnly(request: FastifyRequest) { const a = await actor(request); if (a.kind !== 'owner') throw new HttpError(403, 'owner access required', 'owner_only'); return a; }
  function protectMutation(request: FastifyRequest, a: Actor) {
    if (a.kind !== 'owner') return;
    if (!requestOriginAllowed(request, options.allowedOrigin, trustedAuthorities)) throw new HttpError(403, 'origin denied', 'origin_denied');
    const session = request.session as unknown as { get(k: string): unknown };
    if (!request.headers['x-csrf-token'] || request.headers['x-csrf-token'] !== session.get('csrf')) throw new HttpError(403, 'CSRF token denied', 'csrf_denied');
  }
  function requireInitialOrigin(request: FastifyRequest) { if (!requestOriginAllowed(request, options.allowedOrigin, trustedAuthorities)) throw new HttpError(403, 'origin denied', 'origin_denied'); }
  async function idempotent<T>(request: FastifyRequest, a: Actor, operation: string, work: () => { status: number; value: T }): Promise<{ status: number; value: T }> {
    cleanupIdempotency(); const key = request.headers['idempotency-key']; if (!key) return work();
    if (Array.isArray(key) || !/^[\x21-\x7e]{1,200}$/.test(key)) throw new HttpError(400, 'invalid idempotency key', 'invalid_idempotency_key');
    const payloadHash = sha256(canonicalJson(request.body ?? null));
    const prior = app.db.prepare('SELECT * FROM idempotency WHERE actor_id=? AND operation=? AND key=?').get(a.id, operation, key) as Record<string, unknown> | undefined;
    if (prior) {
      if (prior.payload_hash !== payloadHash) throw new HttpError(409, 'idempotency key reused with different payload', 'idempotency_conflict');
      return { status: Number(prior.status_code), value: JSON.parse(String(prior.response_json)) as T };
    }
    if (Number((app.db.prepare('SELECT count(*) AS n FROM idempotency').get() as { n: number }).n) >= 10000) throw new HttpError(503, 'idempotency retention capacity reached', 'idempotency_capacity');
    app.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      app.db.prepare('INSERT INTO idempotency(actor_id,operation,key,payload_hash,status_code,response_json,created_at_utc) VALUES(?,?,?,?,?,?,?)').run(a.id, operation, key, payloadHash, result.status, JSON.stringify(result.value), now());
      app.db.exec('COMMIT');
      return result;
    } catch (error) { app.db.exec('ROLLBACK'); throw error; }
  }

  app.get('/api/v1/health', async () => ({ ok: true }));
  app.get('/api/v1/openapi.json', async () => openapi);
  app.get('/api/v1/auth/status', async (request) => {
    const setupRequired = !(app.db.prepare('SELECT 1 FROM owners LIMIT 1').get());
    try { const a = await actor(request); return { setupRequired, authenticated: true, actor: a.kind, csrfToken: (request.session as any).get?.('csrf') ?? null }; } catch { return { setupRequired, authenticated: false }; }
  });
  app.post('/api/v1/auth/setup', async (request, reply) => {
    requireInitialOrigin(request);
    const input = setupRequestSchema.parse(request.body);
    const id = opaqueId('owner');
    const previousGate = setupGate; let releaseGate!: () => void; const gate = setupGate = new Promise<void>(resolveGate => { releaseGate = resolveGate; });
    try {
      if (previousGate) await previousGate;
      app.db.exec('BEGIN IMMEDIATE');
      if (app.db.prepare('SELECT 1 FROM owners LIMIT 1').get()) throw new HttpError(409, 'owner already configured', 'setup_closed');
      app.db.prepare('INSERT INTO owners(id,username,password_hash,created_at_utc) VALUES(?,?,?,?)').run(id, input.username, await hash(input.password), now());
      app.db.exec('COMMIT');
    } catch (error) { app.db.exec('ROLLBACK'); throw error; }
    finally { releaseGate(); if (setupGate === gate) setupGate = null; }
    const csrf = randomToken(); const expiresAt = Date.now() + (options.sessionSeconds ?? 8 * 60 * 60) * 1_000;
    (request.session as any).set('ownerId', id); (request.session as any).set('expiresAt', expiresAt); (request.session as any).set('csrf', csrf);
    return reply.code(201).send({ authenticated: true, csrfToken: csrf, expiresAt: new Date(expiresAt).toISOString() });
  });
  app.post('/api/v1/auth/login', async (request) => {
    requireInitialOrigin(request);
    const input = loginRequestSchema.parse(request.body);
    const owner = app.db.prepare('SELECT * FROM owners WHERE username=?').get(input.username) as Record<string, unknown> | undefined;
    if (!owner || !(await verify(String(owner.password_hash), input.password))) throw new HttpError(401, 'invalid login', 'login_denied');
    const csrf = randomToken(); const expiresAt = Date.now() + (options.sessionSeconds ?? 8 * 60 * 60) * 1_000;
    (request.session as any).set('ownerId', owner.id); (request.session as any).set('expiresAt', expiresAt); (request.session as any).set('csrf', csrf);
    return { authenticated: true, csrfToken: csrf, expiresAt: new Date(expiresAt).toISOString() };
  });
  app.post('/api/v1/auth/logout', async (request, reply) => { const a = await ownerOnly(request); protectMutation(request, a); emptyRequestSchema.parse(request.body ?? {}); (request.session as any).delete(); return reply.code(204).send(); });

  app.get('/api/v1/events', async (request) => { await actor(request, 'events:read'); return listEvents(app.db, request.query as Record<string, string>); });
  app.get('/api/v1/events/:id', async (request) => { await actor(request, 'events:read'); return getEvent(app.db, (request.params as { id: string }).id); });
  app.get('/api/v1/events/:id/history', async (request) => { await actor(request, 'events:read'); return getHistory(app.db, (request.params as { id: string }).id); });
  app.post('/api/v1/events', async (request, reply) => {
    const a = await actor(request, 'events:write'); protectMutation(request, a);
    const raw = { ...bodyObject(request) }; delete raw.actorId; delete raw.actor_id; delete raw.createdAtUtc; delete raw.created_at_utc;
    const input = eventInputSchema.parse(raw);
    if (input.sessionId) throw new HttpError(409, 'direct event creation cannot change session membership', 'membership_change_unsupported');
    const result = await idempotent(request, a, 'events:create', () => ({ status: 201, value: createEvent(app.db, input, a.id) }));
    return reply.code(result.status).send(result.value);
  });
  app.put('/api/v1/events/:id', async (request, reply) => {
    const a = await actor(request, 'events:write'); protectMutation(request, a); const input = eventPatchSchema.parse(request.body); const id = (request.params as { id: string }).id;
    if (Object.hasOwn(input, 'sessionId')) { const current = app.db.prepare('SELECT session_id FROM events WHERE id=?').get(id) as { session_id: string | null } | undefined; if (current && input.sessionId !== current.session_id) throw new HttpError(409, 'direct event update cannot change session membership', 'membership_change_unsupported'); }
    const result = await idempotent(request, a, `events:update:${id}`, () => ({ status: 200, value: updateEvent(app.db, id, input, a.id) }));
    return reply.code(result.status).send(result.value);
  });

  app.post('/api/v1/sessions', async (request, reply) => {
    const a = await actor(request, 'events:write'); protectMutation(request, a);
    const input = sessionInputSchema.parse(request.body);
    const result = await idempotent(request, a, 'sessions:create', () => {
      const id = input.id ?? opaqueId('ses'); const timestamp = now(); app.db.exec('SAVEPOINT session_mutation');
      try {
        const current = input.events.map((event) => { const row=app.db.prepare('SELECT * FROM events WHERE id=?').get(event.id) as Record<string,unknown>|undefined; if(!row)throw new HttpError(422,`unknown event ${event.id}`);if(row.session_id)throw new HttpError(409,`event ${event.id} already belongs to session ${row.session_id}`,'session_rehoming_conflict');if(row.current_revision!==event.expectedRevision)throw new HttpError(409,`stale revision for ${event.id}`,'revision_conflict');return row; });
        app.db.prepare('INSERT INTO sessions(id,kind,local_date,timezone,provenance,created_at_utc,updated_at_utc,actor_id) VALUES(?,?,?,?,?,?,?,?)').run(id, input.kind, input.localDate ?? null, input.timezone, 'explicit', timestamp, timestamp, a.id);
        for (const row of current) { const revision=Number(row.current_revision)+1;app.db.prepare("UPDATE events SET session_id=?,pairing_provenance='explicit_session',current_revision=?,updated_at_utc=?,actor_id=? WHERE id=?").run(id,revision,timestamp,a.id,String(row.id));const revised=app.db.prepare('SELECT * FROM events WHERE id=?').get(String(row.id));app.db.prepare('INSERT INTO event_revisions(event_id,revision,snapshot_json,actor_id,reason,created_at_utc) VALUES(?,?,?,?,?,?)').run(String(row.id),revision,JSON.stringify(rowToEvent(revised as Record<string,unknown>)),a.id,`grouped into explicit ${input.kind} session`,timestamp);}
        const session = app.db.prepare('SELECT id,kind,local_date AS localDate,timezone,provenance,current_revision AS currentRevision,created_at_utc AS createdAtUtc,updated_at_utc AS updatedAtUtc,actor_id AS actorId FROM sessions WHERE id=?').get(id) as Record<string,unknown>;
        const members = app.db.prepare('SELECT id,current_revision AS revision FROM events WHERE session_id=? ORDER BY id').all(id);
        app.db.prepare('INSERT INTO session_revisions(session_id,revision,snapshot_json,actor_id,reason,created_at_utc) VALUES(?,1,?,?,?,?)').run(id, JSON.stringify({ ...session, events: members }), a.id, 'created', timestamp);
        app.db.prepare('UPDATE summaries SET stale_at_utc=? WHERE stale_at_utc IS NULL').run(timestamp); app.db.exec('RELEASE session_mutation'); return {status:201,value:{ id, ...input, provenance: 'explicit', currentRevision: 1, actorId: a.id }};
      } catch (e) { app.db.exec('ROLLBACK TO session_mutation'); app.db.exec('RELEASE session_mutation'); throw e; }
    });
    return reply.code(result.status).send(result.value);
  });
  app.get('/api/v1/sessions', async (request) => { await actor(request, 'events:read'); return app.db.prepare('SELECT id,kind,local_date AS localDate,timezone,provenance,current_revision AS currentRevision,created_at_utc AS createdAtUtc,updated_at_utc AS updatedAtUtc,actor_id AS actorId FROM sessions ORDER BY COALESCE(local_date,created_at_utc) DESC').all(); });
  app.get('/api/v1/sessions/:id/history', async (request) => { await actor(request, 'events:read'); const id=(request.params as {id:string}).id; if(!app.db.prepare('SELECT 1 FROM sessions WHERE id=?').get(id)) throw new HttpError(404,'session not found','not_found'); return app.db.prepare('SELECT revision,snapshot_json,actor_id AS actorId,reason,created_at_utc AS createdAtUtc FROM session_revisions WHERE session_id=? ORDER BY revision DESC').all(id).map((r:any)=>({ revision: r.revision, actorId: r.actorId, reason: r.reason, createdAtUtc: r.createdAtUtc, snapshot: JSON.parse(r.snapshot_json) })); });
  app.put('/api/v1/sessions/:id', async (request, reply) => {
    const a=await actor(request,'events:write'); protectMutation(request,a); const id=(request.params as {id:string}).id;
    const input=sessionPatchSchema.parse(request.body);
    const result = await idempotent(request, a, `sessions:update:${id}`, () => { app.db.exec('SAVEPOINT session_edit'); try {
      const current=app.db.prepare('SELECT * FROM sessions WHERE id=?').get(id) as Record<string,unknown>|undefined; if(!current) throw new HttpError(404,'session not found','not_found'); if(current.current_revision!==input.expectedRevision) throw new HttpError(409,'stale session revision','revision_conflict',{currentRevision:current.current_revision});
      const existing = app.db.prepare('SELECT * FROM events WHERE session_id=?').all(id) as Record<string,unknown>[];
      const desired = input.events ? new Map(input.events.map(member => [member.id, member])) : new Map(existing.map(row => [String(row.id), { id: String(row.id), expectedRevision: Number(row.current_revision) }]));
      const removed = input.removedEvents ?? [];
      const expectedRemoved = existing.map((row) => String(row.id)).filter((eventId) => !desired.has(eventId)).sort();
      if (input.events && JSON.stringify([...removed.map((event) => event.id)].sort()) !== JSON.stringify(expectedRemoved)) throw new HttpError(400, 'removedEvents must exactly match removed members', 'membership_removal_mismatch');
      for(const member of desired.values()) { const row=app.db.prepare('SELECT session_id,current_revision FROM events WHERE id=?').get(member.id) as {session_id:string|null;current_revision:number}|undefined; if(!row) throw new HttpError(422,`unknown event ${member.id}`); if(row.session_id && row.session_id !== id) throw new HttpError(409,`event ${member.id} already belongs to session ${row.session_id}`,'session_rehoming_conflict'); if(row.current_revision!==member.expectedRevision) throw new HttpError(409,`stale revision for ${member.id}`,'revision_conflict'); }
      for(const member of removed) { const row=app.db.prepare('SELECT session_id,current_revision FROM events WHERE id=?').get(member.id) as {session_id:string|null;current_revision:number}|undefined; if(!row || row.session_id !== id) throw new HttpError(400,`event ${member.id} is not a member of this session`,'membership_removal_mismatch'); if(row.current_revision!==member.expectedRevision) throw new HttpError(409,`stale revision for removed event ${member.id}`,'revision_conflict'); }
      const changedMembers = [...new Set([...existing.map(row=>String(row.id)), ...desired.keys()])].filter(eventId => existing.some(row=>String(row.id)===eventId) !== desired.has(eventId) || (!existing.some(row=>String(row.id)===eventId) && desired.has(eventId)));
      for (const eventId of changedMembers) { const row=app.db.prepare('SELECT * FROM events WHERE id=?').get(eventId) as Record<string,unknown>; const nextSession=desired.has(eventId)?id:null; const eventRevision=Number(row.current_revision)+1; app.db.prepare("UPDATE events SET session_id=?,pairing_provenance=?,current_revision=?,updated_at_utc=?,actor_id=? WHERE id=?").run(nextSession,nextSession?'explicit_session':null,eventRevision,now(),a.id,eventId); const revised=app.db.prepare('SELECT * FROM events WHERE id=?').get(eventId); app.db.prepare('INSERT INTO event_revisions(event_id,revision,snapshot_json,actor_id,reason,created_at_utc) VALUES(?,?,?,?,?,?)').run(eventId,eventRevision,JSON.stringify(rowToEvent(revised as Record<string,unknown>)),a.id,'session regrouped',now()); }
      const revision=Number(current.current_revision)+1, updated=now(); app.db.prepare('UPDATE sessions SET kind=?,local_date=?,timezone=?,current_revision=?,updated_at_utc=?,actor_id=? WHERE id=?').run((input.kind ?? current.kind) as any,(input.localDate===undefined?current.local_date:input.localDate) as any,(input.timezone ?? current.timezone) as any,revision,updated,a.id,id); app.db.prepare('UPDATE summaries SET stale_at_utc=? WHERE stale_at_utc IS NULL').run(updated);
      const snapshot=app.db.prepare('SELECT id,kind,local_date AS localDate,timezone,provenance,current_revision AS currentRevision,created_at_utc AS createdAtUtc,updated_at_utc AS updatedAtUtc,actor_id AS actorId FROM sessions WHERE id=?').get(id) as Record<string,unknown>; const members = app.db.prepare('SELECT id,current_revision AS revision FROM events WHERE session_id=? ORDER BY id').all(id); const completeSnapshot = { ...snapshot, events: members }; app.db.prepare('INSERT INTO session_revisions(session_id,revision,snapshot_json,actor_id,reason,created_at_utc) VALUES(?,?,?,?,?,?)').run(id,revision,JSON.stringify(completeSnapshot),a.id,input.reason ?? 'session regrouped',updated); app.db.exec('RELEASE session_edit'); return { status: 200, value: snapshot };
    } catch(e) { app.db.exec('ROLLBACK TO session_edit'); app.db.exec('RELEASE session_edit'); throw e; } });
    return reply.code(result.status).send(result.value);
  });

  app.get('/api/v1/notes', async (request) => { await actor(request, 'notes:read'); return app.db.prepare('SELECT * FROM notes ORDER BY updated_at_utc DESC').all(); });
  app.get('/api/v1/notes/:id', async (request) => { await actor(request, 'notes:read'); const row=app.db.prepare('SELECT * FROM notes WHERE id=?').get((request.params as {id:string}).id); if(!row)throw new HttpError(404,'note not found','not_found'); return row; });
  app.post('/api/v1/notes', async (request, reply) => {
    const a = await actor(request, 'notes:write'); protectMutation(request, a); const input = noteInputSchema.parse(request.body); const id = input.id ?? opaqueId('note'); const timestamp = now();
    const completed=await idempotent(request,a,'notes:create',()=>{app.db.exec('SAVEPOINT note_mutation'); try { app.db.prepare('INSERT INTO notes(id,body,session_id,range_start,range_end,created_at_utc,updated_at_utc,actor_id) VALUES(?,?,?,?,?,?,?,?)').run(id,input.body,input.sessionId ?? null,input.rangeStart ?? null,input.rangeEnd ?? null,timestamp,timestamp,a.id); const result=app.db.prepare('SELECT * FROM notes WHERE id=?').get(id); app.db.prepare('INSERT INTO note_revisions(note_id,revision,snapshot_json,actor_id,created_at_utc) VALUES(?,1,?,?,?)').run(id,JSON.stringify(result),a.id,timestamp); invalidateSummaries(app.db); app.db.exec('RELEASE note_mutation'); return {status:201,value:result}; } catch(e) { app.db.exec('ROLLBACK TO note_mutation'); app.db.exec('RELEASE note_mutation'); throw e; }}); return reply.code(completed.status).send(completed.value);
  });
  app.put('/api/v1/notes/:id', async (request,reply) => {
    const a = await actor(request, 'notes:write'); protectMutation(request, a); const input = notePatchSchema.parse(request.body); const id=(request.params as {id:string}).id;
    const completed=await idempotent(request,a,`notes:update:${id}`,()=>{const current=app.db.prepare('SELECT * FROM notes WHERE id=?').get(id) as Record<string,unknown>|undefined; if(!current) throw new HttpError(404,'note not found','not_found'); if(current.current_revision!==input.expectedRevision) throw new HttpError(409,'stale revision','revision_conflict',{currentRevision:current.current_revision}); const revision=Number(current.current_revision)+1; app.db.exec('SAVEPOINT note_mutation'); try { const nextBody=String(input.body ?? current.body); const nextStart=input.rangeStart===undefined?(current.range_start as any):input.rangeStart; const nextEnd=input.rangeEnd===undefined?(current.range_end as any):input.rangeEnd; if(nextStart && nextEnd && nextStart > nextEnd) throw new HttpError(422,'rangeEnd must not precede rangeStart','validation_error'); app.db.prepare('UPDATE notes SET body=?,session_id=?,range_start=?,range_end=?,current_revision=?,updated_at_utc=?,actor_id=? WHERE id=?').run(nextBody,input.sessionId===undefined?(current.session_id as any):input.sessionId,nextStart,nextEnd,revision,now(),a.id,id); const result=app.db.prepare('SELECT * FROM notes WHERE id=?').get(id); app.db.prepare('INSERT INTO note_revisions(note_id,revision,snapshot_json,actor_id,created_at_utc) VALUES(?,?,?,?,?)').run(id,revision,JSON.stringify(result),a.id,now()); invalidateSummaries(app.db); app.db.exec('RELEASE note_mutation'); return {status:200,value:result}; } catch(e){app.db.exec('ROLLBACK TO note_mutation');app.db.exec('RELEASE note_mutation');throw e;}}); return reply.code(completed.status).send(completed.value);
  });
  app.get('/api/v1/notes/:id/history', async (request) => { await actor(request,'notes:read');const id=(request.params as {id:string}).id;if(!app.db.prepare('SELECT 1 FROM notes WHERE id=?').get(id))throw new HttpError(404,'note not found','not_found');return app.db.prepare('SELECT revision,snapshot_json AS snapshot,actor_id AS actorId,created_at_utc AS createdAtUtc FROM note_revisions WHERE note_id=? ORDER BY revision DESC').all(id).map((row:any)=>({...row,snapshot:JSON.parse(row.snapshot)})); });

  app.get('/api/v1/trends/:days', async (request) => { await actor(request, 'trends:read'); const days=z.coerce.number().refine((n) => [7,30,90].includes(n)).parse((request.params as {days:string}).days) as 7|30|90; const timezone=z.string().optional().parse((request.query as {timezone?:string}).timezone); return trends(app.db, days, new Date(), timezone ?? 'UTC'); });

  app.get('/api/v1/credentials', async (request) => { await ownerOnly(request); return app.db.prepare('SELECT id,name,scopes_json AS scopes,expires_at_utc AS expiresAt,revoked_at_utc AS revokedAt,created_at_utc AS createdAt,last_used_at_utc AS lastUsedAt FROM assistant_credentials ORDER BY created_at_utc DESC').all().map((r:any)=>({...r,scopes:JSON.parse(r.scopes)})); });
  app.post('/api/v1/credentials', async (request, reply) => { const a=await ownerOnly(request); protectMutation(request,a); const input=credentialInputSchema.parse(request.body); if(Date.parse(input.expiresAt)<=Date.now()) throw new HttpError(422,'credential expiry must be in the future'); const id=opaqueId('cred'), token=randomToken(); app.db.prepare('INSERT INTO assistant_credentials(id,owner_id,name,token_hash,scopes_json,expires_at_utc,created_at_utc) VALUES(?,?,?,?,?,?,?)').run(id,a.id.slice(6),input.name,sha256(token),JSON.stringify(input.scopes),input.expiresAt,now()); return reply.code(201).send({id,name:input.name,scopes:input.scopes,expiresAt:input.expiresAt,token}); });
  app.delete('/api/v1/credentials/:id', async (request,reply)=>{const a=await ownerOnly(request);protectMutation(request,a);const result=app.db.prepare('UPDATE assistant_credentials SET revoked_at_utc=? WHERE id=? AND revoked_at_utc IS NULL').run(now(),(request.params as {id:string}).id);if(!result.changes)throw new HttpError(404,'credential not found','not_found');return reply.code(204).send();});

  app.get('/api/v1/exports/:format', async (request, reply) => {
    const a=await actor(request,'events:read'); if (a.kind === 'assistant' && !a.scopes.includes('notes:read')) throw new HttpError(403,'notes:read scope required for lossless export','scope_denied'); const format=z.enum(['json','csv']).parse((request.params as {format:string}).format); const events=(app.db.prepare('SELECT * FROM events ORDER BY created_at_utc,id').all() as Record<string,unknown>[]).map(rowToEvent);
    reply.header('cache-control','no-store').header('content-disposition',`attachment; filename="wellbeing-export.${format}"`);
    if(format==='json')return reply.type('application/json').send({formatVersion:1,schemaVersion:Number((app.db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as {v:number}).v),exportedAtUtc:now(),sessions:app.db.prepare('SELECT * FROM sessions ORDER BY id').all(),sessionRevisions:app.db.prepare('SELECT session_id AS sessionId,revision,snapshot_json AS snapshot,actor_id AS actorId,reason,created_at_utc AS createdAtUtc FROM session_revisions ORDER BY session_id,revision').all().map((r:any)=>({...r,snapshot:JSON.parse(r.snapshot)})),events,eventRevisions:app.db.prepare('SELECT event_id AS eventId,revision,snapshot_json AS snapshot,actor_id AS actorId,reason,created_at_utc AS createdAtUtc FROM event_revisions ORDER BY event_id,revision').all().map((r:any)=>({...r,snapshot:JSON.parse(r.snapshot)})),notes:app.db.prepare('SELECT * FROM notes ORDER BY id').all(),noteRevisions:app.db.prepare('SELECT note_id AS noteId,revision,snapshot_json AS snapshot,actor_id AS actorId,created_at_utc AS createdAtUtc FROM note_revisions ORDER BY note_id,revision').all().map((r:any)=>({...r,snapshot:JSON.parse(r.snapshot)})),legacyImportFiles:app.db.prepare('SELECT event_id AS eventId,name,sha256,imported_at_utc AS importedAtUtc,importer_version AS importerVersion FROM legacy_import_files ORDER BY event_id').all(),metricOverrides:events.flatMap((e:any)=>e.metricOverrides ? [{eventId:e.id,value:e.metricOverrides}] : []),summaryDefinitions:[7,30,90],notice:'No credentials, owner authentication data, session cookies, CSRF material, or idempotency cache are included.'});
    const keys=['id','eventType','startAtLocal','endAtLocal','localDate','timezone','localOffset','endLocalOffset','durationMinutes','numericValue','reportedAtUtc','source','confidence','notes','sourceMessageId','sourceReference','supersedesEventId','createdAtUtc','sessionId','currentRevision','rawLegacySha256']; const quote=(v:unknown)=>{if(v==null)return ''; const text=String(v); const safe=/^[=+\-@]/.test(text)?`'${text}`:text; return `"${safe.replaceAll('"','""')}"`;}; return reply.type('text/csv; charset=utf-8').send('# Null cells are empty; leading apostrophes prevent spreadsheet formulas.\n'+keys.join(',')+'\n'+events.map(e=>keys.map(k=>quote(e[k])).join(',')).join('\n'));
  });
  app.post('/api/v1/imports/legacy', async (request) => { const a=await ownerOnly(request);protectMutation(request,a);const input = legacyImportRequestSchema.parse(request.body); try { return importLegacyFiles(app.db,input.files,a.id); } catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(422, 'legacy import validation failed', 'import_validation_failed'); } });
  app.post('/api/v1/admin/backups', async (request,reply)=>{const a=await ownerOnly(request);protectMutation(request,a);const input=backupRequestSchema.parse(request.body??{});const path=await createSnapshot(app.db,dataDir,input.label);return reply.code(201).send({file:join('backups',path.split('/').at(-1)!),createdAtUtc:now()});});

  const staticDir = options.staticDir ?? resolve(process.cwd(), 'dist');
  if (existsSync(staticDir)) {
    await app.register(fastifyStatic, { root: staticDir, wildcard: false });
    app.setNotFoundHandler(async (request, reply) => request.url.startsWith('/api/') ? reply.code(404).send({error:'API route not found',code:'not_found'}) : reply.sendFile('index.html'));
  }
  return app;
}
