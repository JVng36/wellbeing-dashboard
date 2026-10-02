import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';

const artifactDir = await mkdtemp(join(tmpdir(), 'wellbeing-e2e-artifacts-'));
let child;
let exitPromise;
let stopping = false;
let cancelled = false;
let signalCleanup;

function reservePort() { const probe=createServer(); return new Promise((resolve,reject)=>{ const fail=e=>{probe.close(()=>{});reject(e)}; probe.once('error',fail); probe.listen(0,'127.0.0.1',()=>{const address=probe.address();if(!address||typeof address==='string')return fail(new Error('failed to reserve ephemeral port'));const selected=address.port;probe.close(error=>error?reject(error):resolve(selected));}); }); }
function waitForExit(processRef, timeoutMs) { return new Promise(resolve=>{ let settled=false; const done=code=>{if(!settled){settled=true;if(timer)clearTimeout(timer);resolve(code??1)}}; const timer=timeoutMs===undefined?undefined:setTimeout(()=>{if(!settled){settled=true;resolve(null)}},timeoutMs); processRef.once('exit',done); processRef.once('error',()=>done(1)); }); }
async function stopProcess() { if(!child || stopping)return; stopping=true; if(child.exitCode===null){ child.kill('SIGTERM'); const graceful=await waitForExit(child,5000); if(graceful===null && child.exitCode===null){ child.kill('SIGKILL'); await waitForExit(child,2000); } } child=undefined; exitPromise=undefined; stopping=false; }
const stopOnSignal=()=>{ cancelled=true; signalCleanup ??= stopProcess(); };
process.once('SIGINT',stopOnSignal); process.once('SIGTERM',stopOnSignal);
try {
  const cli=join(process.cwd(),'node_modules','@playwright','test','cli.js');
  const correctionTitles = ['manual event edit saves current revision and exposes full history attribution','stale browser event edit retains draft and offers refresh or reconcile','journal date filters are independently available','trend detail independently shows boundaries, per-metric coverage, gaps, and freshness','add, edit, event history, and note history dialogs contain Tab focus and restore focus on Escape','note ambiguous transport retry commits once with the same idempotency key','note pending guard prevents delayed double-submit duplicates','event ambiguous transport retry commits once with one stable key','session grouping ambiguous retry commits one group with one stable key','mixed uncertain corrected nap and note data renders at both viewport widths'];
  const cases = [{ suite: 'tests/e2e/dashboard.spec.ts', grep: null }, ...correctionTitles.map((title) => ({ suite: 'tests/e2e/supervisor-corrections.spec.ts', grep: `${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$` }))];
  for (let index = 0; index < cases.length; index += 1) { if (cancelled) break; const testCase=cases[index]; const dataDir=await mkdtemp(join(tmpdir(), `wellbeing-e2e-${testCase.grep?'correction':'baseline'}-`)); const caseArtifacts=await mkdtemp(join(artifactDir, `${String(index).padStart(2, '0')}-`)); const port=await reservePort(); if (cancelled) { await rm(dataDir,{recursive:true,force:true}); break; } const args=[cli,'test',testCase.suite,...(testCase.grep?['--grep',testCase.grep]:[])]; child=spawn(process.execPath,args,{stdio:'inherit',env:{...process.env,WELLBEING_E2E_PORT:String(port),WELLBEING_E2E_DATA_DIR:dataDir,WELLBEING_E2E_ARTIFACT_DIR:caseArtifacts}}); exitPromise=waitForExit(child,120000); const code=await exitPromise; await stopProcess(); await rm(dataDir,{recursive:true,force:true}); console.log(`E2E artifacts for case ${index + 1}/${cases.length}: ${caseArtifacts}`); if(code===null){console.error(`Playwright supervisor run exceeded 120 seconds for ${testCase.suite}${testCase.grep?` / ${testCase.grep}`:''}`);process.exitCode=1;} else if(code!==0)process.exitCode=code; if (cancelled) break; }
} finally { if (signalCleanup) await signalCleanup; await stopProcess(); process.removeListener('SIGINT',stopOnSignal); process.removeListener('SIGTERM',stopOnSignal); process.stdout.write(`Synthetic E2E artifacts retained at ${artifactDir}${cancelled ? ' (cancelled; no further cases launched)' : ''}\n`); }
