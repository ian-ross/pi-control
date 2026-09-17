import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseConfig } from '../src/config.js';

test('conservative defaults and explicit valid overrides', () => {
  assert.deepEqual(parseConfig({}), { maxRepairAttempts: 2, verificationTimeoutMs: 120000, shell: '/bin/bash', autoPlanHandoff: true });
  assert.equal(parseConfig({ maxRepairAttempts: 0 }).maxRepairAttempts, 0);
});
test('invalid config is rejected rather than coerced', () => {
  for (const config of [null, [], { extra: true }, { maxRepairAttempts: -1 }, { maxRepairAttempts: 1.5 }, { maxRepairAttempts: '2' }, { verificationTimeoutMs: 0 }, { shell: '' }, { shell: 'bash' }, { autoPlanHandoff: 'false' }]) assert.throws(() => parseConfig(config));
});
