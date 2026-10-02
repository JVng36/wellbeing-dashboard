import http from 'node:http';

if (!process.env.WELLBEING_CORRECTIONS_BASE_URL) throw new Error('WELLBEING_CORRECTIONS_BASE_URL is required; use the supervisor runner to provide an ephemeral loopback URL');
const base = new URL(process.env.WELLBEING_CORRECTIONS_BASE_URL);
if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '::1'].includes(base.hostname) || !base.port) throw new Error('WELLBEING_CORRECTIONS_BASE_URL must be an explicit http loopback URL with a port');
const password = 'synthetic supervisor correction password';

function request(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const target = new URL(path, base);
    const req = http.request({ hostname: base.hostname, port: base.port, path: target.pathname + target.search, method, headers: { ...(payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {}), ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => { const text = Buffer.concat(chunks).toString('utf8'); let parsed = text; try { parsed = JSON.parse(text); } catch {} resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed }); });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function assert(condition, message) { if (!condition) throw new Error(message); }
const trusted = { host: base.host, origin: base.origin };

const missingSetupOrigin = await request('/api/v1/auth/setup', { method: 'POST', headers: { host: base.host }, body: { username: 'owner', password } });
assert(missingSetupOrigin.status === 403, `missing-origin setup accepted: ${missingSetupOrigin.status}`);
const hostileSetup = await request('/api/v1/auth/setup', { method: 'POST', headers: { host: 'attacker.invalid', origin: 'http://attacker.invalid' }, body: { username: 'owner', password } });
assert(hostileSetup.status === 403, `hostile Host/origin setup accepted: ${hostileSetup.status}`);
const setup = await request('/api/v1/auth/setup', { method: 'POST', headers: trusted, body: { username: 'owner', password } });
assert(setup.status === 201, `trusted setup failed: ${setup.status}`);
const cookie = String(setup.headers['set-cookie'] ?? '').split(';')[0];
const csrf = setup.body.csrfToken;

const missingLoginOrigin = await request('/api/v1/auth/login', { method: 'POST', headers: { host: base.host }, body: { username: 'owner', password } });
assert(missingLoginOrigin.status === 403, `missing-origin login accepted: ${missingLoginOrigin.status}`);
const wrongLoginOrigin = await request('/api/v1/auth/login', { method: 'POST', headers: { host: base.host, origin: 'http://attacker.invalid' }, body: { username: 'owner', password } });
assert(wrongLoginOrigin.status === 403, `wrong-origin login accepted: ${wrongLoginOrigin.status}`);

const event = { id: 'supervisor-origin-event', eventType: 'sleep_duration', localDate: '2026-09-28', timezone: 'UTC', durationMinutes: 20 };
const missingMutationOrigin = await request('/api/v1/events', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf }, body: event });
assert(missingMutationOrigin.status === 403, `missing-origin mutation accepted: ${missingMutationOrigin.status}`);
const wrongMutationOrigin = await request('/api/v1/events', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, ...trusted, origin: 'http://attacker.invalid' }, body: event });
assert(wrongMutationOrigin.status === 403, `wrong-origin mutation accepted: ${wrongMutationOrigin.status}`);
const forwardedHeaders = { ...trusted, 'x-forwarded-host': 'attacker.invalid', 'x-forwarded-proto': 'https' };
const created = await request('/api/v1/events', { method: 'POST', headers: { cookie, 'x-csrf-token': csrf, ...forwardedHeaders }, body: event });
assert(created.status === 201, `trusted mutation changed by forwarded headers: ${created.status}`);

console.log('supervisor corrections HTTP assertions passed: explicit loopback, missing/wrong Host-Origin, trusted path, forwarded-header non-authority');
