import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';

test('conservative defaults and explicit valid overrides', () => {
  assert.deepEqual(parseConfig({}), {
    maxRepairAttempts: 2,
    verificationTimeoutMs: 120000,
    shell: '/bin/bash',
    autoPlanHandoff: true,
    claimAssignee: '@pi-control',
    readyStatus: 'To Do',
    inProgressStatus: 'In Progress',
  });
  assert.equal(parseConfig({ maxRepairAttempts: 0 }).maxRepairAttempts, 0);
});

test('claim settings canonicalize assignee and trim statuses', () => {
  assert.deepEqual(parseConfig({ claimAssignee: 'Pi.User-1', readyStatus: ' Ready ', inProgressStatus: ' doing ' }), {
    maxRepairAttempts: 2,
    verificationTimeoutMs: 120000,
    shell: '/bin/bash',
    autoPlanHandoff: true,
    claimAssignee: '@Pi.User-1',
    readyStatus: 'Ready',
    inProgressStatus: 'doing',
  });
});

test('invalid config is rejected rather than coerced', () => {
  for (const config of [
    null,
    [],
    { extra: true },
    { maxRepairAttempts: -1 },
    { maxRepairAttempts: 1.5 },
    { maxRepairAttempts: '2' },
    { verificationTimeoutMs: 0 },
    { shell: '' },
    { shell: 'bash' },
    { autoPlanHandoff: 'false' },
    { claimAssignee: '' },
    { claimAssignee: '@' },
    { claimAssignee: '@pi control' },
    { claimAssignee: '@pi,control' },
    { claimAssignee: '@pi\ncontrol' },
    { readyStatus: '' },
    { readyStatus: 'To\u0000Do' },
    { readyStatus: 'done', inProgressStatus: ' Done ' },
  ]) assert.throws(() => parseConfig(config));
});
