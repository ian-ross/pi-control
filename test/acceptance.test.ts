import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildAcceptanceRequest, validateAcceptanceAssessment, acceptedReviewCurrent } from '../src/acceptance.js';
import { createRun } from '../src/state.js';
import type { ControlTask } from '../src/backlog.js';
import type { Baseline } from '../src/git.js';

const baseline: Baseline = {
  root: '/repo',
  head: 'a'.repeat(40),
  dirty: {},
  tracked: {},
  index: {},
};

const task: ControlTask = {
  id: 'TASK-1',
  title: 'Acceptance',
  acceptanceCriteria: ['First works', 'Second works'],
  acceptanceCriteriaState: [
    { id: 'ac-one', index: 1, text: 'First works', checked: false },
    { id: 'ac-two', index: 2, text: 'Second works', checked: true },
  ],
  allowedScope: ['src/'],
  verificationCommands: ['true'],
};

function request() {
  const run = createRun(structuredClone(task), baseline, [{ text: 'src/', kind: 'directory', pattern: 'src/' }], 0);
  run.latest = {
    digest: 'b'.repeat(64),
    scopeOk: true,
    checksOk: true,
    passed: true,
    scopeErrors: [],
    errors: [],
    commands: [{ command: 'true', code: 0, durationMs: 1, stdout: '', stderr: '', timedOut: false, cancelled: false }],
    timestamp: new Date().toISOString(),
    changedPaths: ['src/a.ts'],
  };
  return { run, request: buildAcceptanceRequest(run) };
}

test('review receives captured command evidence rather than rerunning shell checks', () => {
  const { run } = request();
  run.task.description = 'Task context';
  run.task.implementationPlan = 'Saved implementation steps';
  run.latest!.commands[0].stdout = 'one test passed';
  const req = buildAcceptanceRequest(run);
  assert.equal(req.taskDescription, 'Task context');
  assert.equal(req.implementationPlan, 'Saved implementation steps');
  assert.equal(req.verificationResults[0].stdout, 'one test passed');
  run.latest!.commands[0].stdout = 'later mutation';
  assert.equal(req.verificationResults[0].stdout, 'one test passed');
});

test('acceptance review validates satisfied results and binds task and code digests', () => {
  const { run, request: req } = request();
  const review = validateAcceptanceAssessment({
    taskId: req.taskId,
    taskDigest: req.taskDigest,
    codeDigest: req.codeDigest,
    summary: 'Criteria are met.',
    criteria: req.criteria.map(criterion => ({ id: criterion.id, status: 'satisfied', evidence: [`checked ${criterion.text}`] })),
  }, req, () => new Date('2026-01-01T00:00:00Z'));
  run.acceptanceReview = review;
  assert.equal(review.accepted, true);
  assert.equal(acceptedReviewCurrent(run), true);
});

test('unsatisfied and uncertain acceptance results block completion', () => {
  const { request: req } = request();
  for (const status of ['unsatisfied', 'uncertain'] as const) {
    const review = validateAcceptanceAssessment({
      taskId: req.taskId,
      taskDigest: req.taskDigest,
      codeDigest: req.codeDigest,
      summary: 'Blocked.',
      criteria: req.criteria.map((criterion, index) => ({ id: criterion.id, status: index === 0 ? status : 'satisfied', evidence: ['specific evidence'] })),
    }, req);
    assert.equal(review.accepted, false);
  }
});

test('malformed, stale, duplicate, and incomplete acceptance results fail closed', () => {
  const { request: req } = request();
  const valid = {
    taskId: req.taskId,
    taskDigest: req.taskDigest,
    codeDigest: req.codeDigest,
    summary: 'ok',
    criteria: req.criteria.map(criterion => ({ id: criterion.id, status: 'satisfied', evidence: ['evidence'] })),
  };
  for (const bad of [
    { ...valid, taskDigest: 'c'.repeat(64) },
    { ...valid, codeDigest: 'd'.repeat(64) },
    { ...valid, criteria: [valid.criteria[0]] },
    { ...valid, criteria: [valid.criteria[0], valid.criteria[0]] },
    { ...valid, criteria: [{ id: 'missing', status: 'satisfied', evidence: ['x'] }, valid.criteria[1]] },
    { ...valid, criteria: req.criteria.map(criterion => ({ id: criterion.id, status: 'satisfied', evidence: [] })) },
    { ...valid, extra: true },
  ]) {
    assert.throws(() => validateAcceptanceAssessment(bad, req));
  }
});

test('acceptance review rejects excessive persisted evidence', () => {
  const { request: req } = request();
  const base = {
    taskId: req.taskId,
    taskDigest: req.taskDigest,
    codeDigest: req.codeDigest,
    summary: 'ok',
    criteria: req.criteria.map(criterion => ({ id: criterion.id, status: 'satisfied', evidence: ['evidence'] })),
  };
  assert.throws(() => validateAcceptanceAssessment({ ...base, summary: 'x'.repeat(4001) }, req));
  assert.throws(() => validateAcceptanceAssessment({ ...base, criteria: req.criteria.map(criterion => ({ id: criterion.id, status: 'satisfied', evidence: ['x'.repeat(2001)] })) }, req));
  assert.throws(() => validateAcceptanceAssessment({ ...base, criteria: req.criteria.map(criterion => ({ id: criterion.id, status: 'satisfied', evidence: Array.from({ length: 9 }, (_, index) => `evidence ${index}`) })) }, req));
});

test('stale stored acceptance is not current after code digest changes', () => {
  const { run, request: req } = request();
  run.acceptanceReview = validateAcceptanceAssessment({
    taskId: req.taskId,
    taskDigest: req.taskDigest,
    codeDigest: req.codeDigest,
    summary: 'ok',
    criteria: req.criteria.map(criterion => ({ id: criterion.id, status: 'satisfied', evidence: ['evidence'] })),
  }, req);
  run.latest!.digest = 'e'.repeat(64);
  assert.equal(acceptedReviewCurrent(run), false);
});
