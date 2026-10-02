import { z } from 'zod';
import { contractSchemas } from '../shared/api-contract.js';

type Schema = Record<string, unknown>;
const ref = (name: string): Schema => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: z.ZodType): Schema => z.toJSONSchema(schema, { target: 'draft-2020-12' }) as Schema;
const body = (name: string, required = true) => ({ required, content: { 'application/json': { schema: ref(name) } } });
const response = (description: string, schema?: string, contentType = 'application/json') => ({ description, ...(schema ? { content: { [contentType]: { schema: ref(schema) } } } : {}) });
const errors = (extra: Record<string, unknown> = {}) => ({ '400': response('Request validation failed', 'Problem'), '401': response('Authentication required', 'Problem'), '403': response('Scope, CSRF, origin, or owner policy denied', 'Problem'), '409': response('Revision, ID, or idempotency conflict', 'Problem'), '422': response('Domain validation failed', 'Problem'), ...extra });
const header = (name: string, required = false, description?: string) => ({ in: 'header', name, required, ...(description ? { description } : {}), schema: { type: 'string' } });
const origin = header('Origin', false, 'Required when the request uses the owner cookie; bearer-authenticated requests do not require this header.');
const id = { in: 'path', name: 'id', required: true, schema: { type: 'string', minLength: 1 } };
const readSecurity = [{ ownerCookie: [] }, { assistantBearer: [] }];
const writeSecurity = [{ ownerCookie: [], csrf: [] }, { assistantBearer: [] }];
const ownerReadSecurity = [{ ownerCookie: [] }];
const ownerWriteSecurity = [{ ownerCookie: [], csrf: [] }];

const paths: Record<string, Record<string, unknown>> = {
  '/health': { get: { summary: 'Health check', responses: { '200': response('Healthy', 'Health'), ...errors() } } },
  '/openapi.json': { get: { summary: 'This checked OpenAPI document', responses: { '200': response('OpenAPI document', 'OpenApiDocument') } } },
  '/auth/status': { get: { summary: 'Setup and authentication state', responses: { '200': response('Authentication status', 'AuthStatus'), ...errors() } } },
  '/auth/setup': { post: { summary: 'One-time owner setup', parameters: [origin], requestBody: body('SetupRequest'), responses: { '201': response('Owner session created', 'AuthResponse'), ...errors({ '409': response('Owner already configured', 'Problem') }) } } },
  '/auth/login': { post: { summary: 'Owner login', parameters: [origin], requestBody: body('LoginRequest'), responses: { '200': response('Owner session created', 'AuthResponse'), ...errors() } } },
  '/auth/logout': { post: { summary: 'End owner session', security: ownerWriteSecurity, requestBody: body('EmptyRequest', false), responses: { '204': response('Logged out'), ...errors() } } },
  '/events': {
    get: { summary: 'List active events', security: readSecurity, parameters: [{ in: 'query', name: 'q', schema: { type: 'string' } }, { in: 'query', name: 'type', schema: { type: 'string' } }, { in: 'query', name: 'from', schema: { type: 'string', format: 'date' } }, { in: 'query', name: 'to', schema: { type: 'string', format: 'date' } }], responses: { '200': response('Events', 'EventList'), ...errors() } },
    post: { summary: 'Create event', security: writeSecurity, parameters: [header('Idempotency-Key'), origin, header('x-csrf-token')], requestBody: body('EventInput'), responses: { '201': response('Created event', 'Event'), ...errors({ '503': response('Idempotency retention capacity reached', 'Problem') }) } }
  },
  '/events/{id}': {
    get: { summary: 'Read event', security: readSecurity, parameters: [id], responses: { '200': response('Event', 'Event'), ...errors({ '404': response('Event not found', 'Problem') }) } },
    put: { summary: 'Edit event with expected revision', security: writeSecurity, parameters: [id, header('Idempotency-Key'), origin, header('x-csrf-token')], requestBody: body('EventPatch'), responses: { '200': response('Revised event', 'Event'), ...errors({ '404': response('Event not found', 'Problem'), '503': response('Idempotency retention capacity reached', 'Problem') }) } }
  },
  '/events/{id}/history': { get: { summary: 'Immutable event history', security: readSecurity, parameters: [id], responses: { '200': response('Event history', 'EventHistory'), ...errors({ '404': response('Event not found', 'Problem') }) } } },
  '/sessions': {
    get: { summary: 'List explicit sessions', security: readSecurity, responses: { '200': response('Sessions', 'SessionList'), ...errors() } },
    post: { summary: 'Create explicit session grouping', security: writeSecurity, parameters: [header('Idempotency-Key'), origin, header('x-csrf-token')], requestBody: body('SessionInput'), responses: { '201': response('Created session', 'SessionCreate'), ...errors({ '503': response('Idempotency retention capacity reached', 'Problem') }) } }
  },
  '/sessions/{id}': { put: { summary: 'Edit session grouping with expected revision', security: writeSecurity, parameters: [id, header('Idempotency-Key'), origin, header('x-csrf-token')], requestBody: body('SessionPatch'), responses: { '200': response('Revised session', 'Session'), ...errors({ '404': response('Session not found', 'Problem'), '503': response('Idempotency retention capacity reached', 'Problem') }) } } },
  '/sessions/{id}/history': { get: { summary: 'Immutable session history', security: readSecurity, parameters: [id], responses: { '200': response('Session history', 'SessionHistory'), ...errors({ '404': response('Session not found', 'Problem') }) } } },
  '/notes': {
    get: { summary: 'List notes', security: readSecurity, responses: { '200': response('Notes', 'NoteList'), ...errors() } },
    post: { summary: 'Create note', security: writeSecurity, parameters: [header('Idempotency-Key'), origin, header('x-csrf-token')], requestBody: body('NoteInput'), responses: { '201': response('Created note', 'Note'), ...errors({ '503': response('Idempotency retention capacity reached', 'Problem') }) } }
  },
  '/notes/{id}': {
    get: { summary: 'Read note', security: readSecurity, parameters: [id], responses: { '200': response('Note', 'Note'), ...errors({ '404': response('Note not found', 'Problem') }) } },
    put: { summary: 'Edit note with expected revision', security: writeSecurity, parameters: [id, header('Idempotency-Key'), origin, header('x-csrf-token')], requestBody: body('NotePatch'), responses: { '200': response('Revised note', 'Note'), ...errors({ '404': response('Note not found', 'Problem'), '503': response('Idempotency retention capacity reached', 'Problem') }) } }
  },
  '/notes/{id}/history': { get: { summary: 'Immutable note history', security: readSecurity, parameters: [id], responses: { '200': response('Note history', 'NoteHistory'), ...errors({ '404': response('Note not found', 'Problem') }) } } },
  '/trends/{days}': { get: { summary: 'Coverage-aware trend summary', security: readSecurity, parameters: [{ in: 'path', name: 'days', required: true, schema: { type: 'integer', enum: [7, 30, 90] } }, { in: 'query', name: 'timezone', schema: { type: 'string', description: 'IANA timezone' } }], responses: { '200': response('Trend summary', 'Trend'), ...errors({ '404': response('Trend not found', 'Problem') }) } } },
  '/credentials': {
    get: { summary: 'List owner-managed credentials', security: ownerReadSecurity, responses: { '200': response('Credentials without tokens', 'CredentialList'), ...errors() } },
    post: { summary: 'Mint owner-managed credential', security: ownerWriteSecurity, parameters: [origin, header('x-csrf-token')], requestBody: body('CredentialInput'), responses: { '201': response('Credential token, shown once', 'CredentialCreate'), ...errors() } }
  },
  '/credentials/{id}': { delete: { summary: 'Revoke credential', security: ownerWriteSecurity, parameters: [id, origin, header('x-csrf-token')], responses: { '204': response('Revoked'), ...errors({ '404': response('Credential not found', 'Problem') }) } } },
  '/exports/{format}': { get: { summary: 'Export journal data', security: readSecurity, parameters: [{ in: 'path', name: 'format', required: true, schema: { type: 'string', enum: ['json', 'csv'] } }], responses: { '200': { description: 'JSON or CSV export', content: { 'application/json': { schema: ref('Export') }, 'text/csv': { schema: { type: 'string' } } } }, ...errors() } } },
  '/imports/legacy': { post: { summary: 'Atomic owner-only legacy import; identical event-ID/content-hash replay is unchanged', security: ownerWriteSecurity, parameters: [origin, header('x-csrf-token')], requestBody: body('LegacyImportRequest'), responses: { '200': response('Import result', 'ImportResult'), ...errors() } } },
  '/admin/backups': { post: { summary: 'Create owner-only backup snapshot', security: ownerWriteSecurity, parameters: [origin, header('x-csrf-token')], requestBody: body('BackupRequest', false), responses: { '201': response('Backup metadata', 'BackupResponse'), ...errors() } } }
};

const requiredScopes: Record<string, Record<string, string[]>> = {
  '/events': { get: ['events:read'], post: ['events:write'] }, '/events/{id}': { get: ['events:read'], put: ['events:write'] }, '/events/{id}/history': { get: ['events:read'] },
  '/sessions': { get: ['events:read'], post: ['events:write'] }, '/sessions/{id}': { put: ['events:write'] }, '/sessions/{id}/history': { get: ['events:read'] },
  '/notes': { get: ['notes:read'], post: ['notes:write'] }, '/notes/{id}': { get: ['notes:read'], put: ['notes:write'] }, '/notes/{id}/history': { get: ['notes:read'] },
  '/trends/{days}': { get: ['trends:read'] }, '/exports/{format}': { get: ['events:read', 'notes:read'] }
};
for (const [path, methods] of Object.entries(requiredScopes)) for (const [method, scopes] of Object.entries(methods)) (paths[path][method] as Record<string, unknown>)['x-required-scopes'] = scopes;

const schemas: Record<string, Schema> = {};
for (const [name, schema] of Object.entries(contractSchemas)) schemas[name] = json(schema);
schemas.OpenApiDocument = { type: 'object', required: ['openapi', 'info', 'paths', 'components'], properties: { openapi: { const: '3.1.0' }, info: { type: 'object' }, paths: { type: 'object' }, components: { type: 'object' } }, additionalProperties: true };

export const openapi = {
  openapi: '3.1.0', info: { title: 'Local Wellbeing Dashboard API', version: '1.0.0', description: 'Validated local manual journal API. This API does not provide medical advice.' }, servers: [{ url: '/api/v1' }],
  components: { securitySchemes: { ownerCookie: { type: 'apiKey', in: 'cookie', name: 'wellbeing_session' }, assistantBearer: { type: 'http', scheme: 'bearer', bearerFormat: 'opaque' }, csrf: { type: 'apiKey', in: 'header', name: 'x-csrf-token' } }, schemas }, paths
};
