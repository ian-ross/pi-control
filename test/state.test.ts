import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createRun, beginVerification, finishVerification, resumeRun, staleRun, addScope, waiveRun, restoreState, serializeState, isActive } from '../src/state.js';
import type { Baseline } from '../src/git.js';
import type { VerificationResult } from '../src/verification.js';

const baseline = { root: '/tmp/repo', head: 'a'.repeat(40), dirty: {}, index: {} } as unknown as Baseline;
const task = { id: 'TASK-1', title: 'Test', description: 'Test task', acceptanceCriteria: ['Works'], allowedScope: ['src/'], verificationCommands: ['true'] };
const scope = [{ text: 'src/', kind: 'directory' as const, pattern: 'src' }];
function result(passed: boolean): VerificationResult {
  return { digest: 'b'.repeat(64), scopeOk: true, checksOk: passed, passed, scopeErrors: [], errors: [], commands: [{ command: 'true', code: passed ? 0 : 1, stdout: '', stderr: '', durationMs: 1, timedOut: false, cancelled: false }], timestamp: new Date().toISOString(), changedPaths: [] };
}
const makeRun = () => createRun(task, baseline, scope, 2);

test('scope changes discard unsatisfied assessments as well as accepted ones', () => {
  const run = makeRun();
  run.phase = 'FAILED';
  run.acceptanceReview = { taskId: task.id, taskDigest: 'a'.repeat(64), codeDigest: 'b'.repeat(64), summary: 'Needs evidence', criteria: [{ id: '1', status: 'uncertain', evidence: ['Behavior not demonstrated.'] }], timestamp: new Date().toISOString(), accepted: false };
  addScope(run, { text: 'test/', kind: 'directory', pattern: 'test' });
  assert.equal(run.acceptanceReview, undefined);
  assert.equal(run.phase, 'FAILED');
});

test('initial implementation and bounded repairs require explicit pending state', () => {
  const run = makeRun();
  assert.equal(run.phase, 'IMPLEMENTING');
  assert.equal(run.repairs, 0);
  for (let i = 0; i < 3; i++) {
    beginVerification(run);
    assert.equal(run.phase, 'VERIFYING');
    assert.equal(finishVerification(run, result(false), true), i < 2 ? 'repair' : 'stop');
    assert.equal(run.repairs, Math.min(i + 1, 2));
  }
  assert.equal(run.phase, 'FAILED');
  assert.equal(run.pendingAutomatic, false);
});

test('success and manual failure stop automatic work', () => {
  const run = makeRun();
  beginVerification(run);
  assert.equal(finishVerification(run, result(true), true), 'stop');
  assert.equal(run.phase, 'VERIFIED');
  assert.equal(run.pendingAutomatic, false);
  beginVerification(run);
  assert.equal(finishVerification(run, result(false), false), 'stop');
  assert.equal(run.repairs, 0);
  resumeRun(run);
  assert.equal(run.phase, 'IMPLEMENTING');
  assert.equal(run.pendingAutomatic, true);
  assert.equal(run.repairs, 0);
  assert.throws(() => resumeRun(run));
});

test('waivers bind failed commands and cannot waive invariant failures', () => {
  const run = makeRun();
  assert.throws(() => waiveRun(run, 'reason', 'b'.repeat(64)));
  finishVerification(run, result(false), false);
  assert.throws(() => waiveRun(run, '', run.latest!.digest));
  assert.throws(() => waiveRun(run, 'reason', 'c'.repeat(64)));
  run.latest!.scopeOk = false;
  assert.throws(() => waiveRun(run, 'reason', run.latest!.digest));
  run.latest!.scopeOk = true;
  waiveRun(run, 'Known upstream failure', run.latest!.digest);
  assert.equal(run.phase, 'WAIVED');
  assert.deepEqual(run.waiver!.failedCommands, ['true']);
  staleRun(run);
  assert.equal(run.phase, 'STALE');
});

test('scope additions invalidate a pass and preserve source', () => {
  const run = makeRun();
  finishVerification(run, result(true), false);
  addScope(run, { text: 'test/', kind: 'directory', pattern: 'test' });
  assert.equal(run.phase, 'STALE');
  assert.equal(run.additions[0].source, 'user');
});

test('restoration validates schema and never schedules work', () => {
  assert.throws(() => restoreState({ schemaVersion: 2, run: null }));
  assert.throws(() => restoreState({ schemaVersion: 1, run: { phase: 'VERIFIED' } }));
  assert.equal(restoreState({ schemaVersion: 1, run: null }), null);
  // Full baseline validation is tested with real Git snapshots in integration tests.
  const run = makeRun();
  assert.equal(serializeState(run).schemaVersion, 1);
  assert.equal(isActive(run), true);
  run.phase = 'COMMITTED';
  assert.equal(isActive(run), false);
  run.phase = 'ABORTED';
  assert.equal(isActive(run), false);
});

test('cancelled verification and worktree-mutating checks cannot be waived', () => {
  const run = makeRun();
  const cancelled = result(false);
  cancelled.commands[0].cancelled = true;
  cancelled.errors = ['verification-cancelled'];
  finishVerification(run, cancelled, false);
  assert.throws(() => waiveRun(run, 'skip it', cancelled.digest));
  const mutated = result(false);
  mutated.errors = ['verification-mutated-worktree'];
  finishVerification(run, mutated, false);
  assert.throws(() => waiveRun(run, 'skip it', mutated.digest));
});
