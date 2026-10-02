import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

const cases = [
  'manual event edit saves current revision and exposes full history attribution',
  'stale browser event edit retains draft and offers refresh or reconcile',
  'journal date filters are independently available',
  'trend detail independently shows boundaries, per-metric coverage, gaps, and freshness',
  'add, edit, event history, and note history dialogs contain Tab focus and restore focus on Escape',
  'note ambiguous transport retry commits once with the same idempotency key',
  'note pending guard prevents delayed double-submit duplicates',
  'event ambiguous transport retry commits once with one stable key',
  'session grouping ambiguous retry commits one group with one stable key',
  'mixed uncertain corrected nap and note data renders at both viewport widths'
];
const owned = new Set();
let stopping = false;

function reservePort() {
  const probe = createServer();
  return new Promise((resolve, reject) => {
    const fail = (error) => { probe.close(() => {}); reject(error); };
    probe.once('error', fail);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') return fail(new Error('failed to reserve ephemeral port'));
      const port = address.port;
      probe.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error(`child exceeded ${timeoutMs}ms`)); } }, timeoutMs);
    const done = (code, signal) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ code: code ?? 1, signal }); } };
    child.once('exit', done);
    child.once('error', (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } });
  });
}

async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  const signalGroup = (signal) => {
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* already gone */ } }
  };
  signalGroup('SIGTERM');
  try { await waitForExit(child, 5_000); } catch { signalGroup('SIGKILL'); try { await waitForExit(child, 2_000); } catch { /* bounded cleanup */ } }
}

async function runCase(title, index) {
  const dataDir = await mkdtemp(join(tmpdir(), `wellbeing-corrections-e2e-${index}-`));
  const artifactDir = await mkdtemp(join(tmpdir(), `wellbeing-corrections-artifacts-${index}-`));
  const port = await reservePort();
  const cli = join(process.cwd(), 'node_modules', '@playwright', 'test', 'cli.js');
  const child = spawn(process.execPath, [cli, 'test', 'tests/e2e/supervisor-corrections.spec.ts', '--grep', `${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`], {
    detached: true,
    stdio: 'inherit',
    env: { ...process.env, WELLBEING_E2E_PORT: String(port), WELLBEING_E2E_DATA_DIR: dataDir, WELLBEING_E2E_ARTIFACT_DIR: artifactDir }
  });
  owned.add(child);
  try {
    const result = await waitForExit(child, 120_000);
    if (result.code !== 0) throw new Error(`browser case failed: ${title} (exit ${result.code}, signal ${result.signal ?? 'none'})`);
  } finally {
    await terminate(child);
    owned.delete(child);
    await rm(dataDir, { recursive: true, force: true });
    process.stdout.write(`Synthetic case artifacts retained at ${artifactDir}\n`);
  }
}

async function stopAll() {
  if (stopping) return;
  stopping = true;
  await Promise.all([...owned].map(terminate));
}

const onSignal = (signal) => { void stopAll().finally(() => { process.exitCode = signal === 'SIGINT' ? 130 : 143; }); };
process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);

const results = [];
try {
  for (const [index, title] of cases.entries()) {
    if (stopping) break;
    try { await runCase(title, index); results.push({ title, ok: true }); }
    catch (error) { const message = error instanceof Error ? error.message : String(error); results.push({ title, ok: false, error: message }); process.stderr.write(`Synthetic browser case failed: ${title}\n${message}\n`); }
  }
  process.stdout.write(`Synthetic browser case summary: ${results.filter((result) => result.ok).length} passed, ${results.filter((result) => !result.ok).length} failed\n`);
  if (results.some((result) => !result.ok)) process.exitCode = 1;
} finally {
  await stopAll();
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
}
