import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import http from 'node:http';

const dataDir = await mkdtemp(join(tmpdir(), 'wellbeing-corrections-http-'));
let server;
let probe;
let serverError;
let cleaning = false;

function reservePort() {
  const socket = createServer();
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => { const address = socket.address(); if (!address || typeof address === 'string') return reject(new Error('failed to reserve port')); const port = address.port; socket.close((error) => error ? reject(error) : resolve(port)); });
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error(`child exceeded ${timeoutMs}ms`)); } }, timeoutMs);
    child.once('exit', (code, signal) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code: code ?? 1, signal }); } });
    child.once('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
  });
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  const kill = (signal) => { try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch {} } };
  kill('SIGTERM');
  try { await waitForExit(child, 5_000); } catch { kill('SIGKILL'); try { await waitForExit(child, 2_000); } catch {} }
}

async function waitForHealth(url) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      if (server?.exitCode !== null) throw new Error(`compiled supervisor server exited with code ${server.exitCode}`);
      if (serverError) throw serverError;
      const response = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('compiled supervisor instance did not become healthy');
}

async function cleanup() {
  if (cleaning) return;
  cleaning = true;
  await stop(probe);
  await stop(server);
  await rm(dataDir, { recursive: true, force: true });
}

const onSignal = (signal) => { void cleanup().finally(() => { process.exitCode = signal === 'SIGINT' ? 130 : 143; }); };
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

try {
  const port = await reservePort();
  const base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ['dist-server/server/index.js'], { detached: true, stdio: 'inherit', env: { ...process.env, NODE_ENV: 'development', WELLBEING_HOST: '127.0.0.1', WELLBEING_PORT: String(port), WELLBEING_DATA_DIR: dataDir } });
  server.once('error', (error) => { serverError = error; });
  await waitForHealth(base);
  probe = spawn(process.execPath, ['scripts/supervisor-corrections-http.mjs'], { detached: true, stdio: 'inherit', env: { ...process.env, WELLBEING_CORRECTIONS_BASE_URL: base } });
  const result = await waitForExit(probe, 30_000);
  if (result.code !== 0) throw new Error(`HTTP corrections probe failed: exit ${result.code}, signal ${result.signal ?? 'none'}`);
  if (server.exitCode !== null) throw new Error(`compiled supervisor server exited unexpectedly with code ${server.exitCode}`);
} finally {
  await cleanup();
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
}
