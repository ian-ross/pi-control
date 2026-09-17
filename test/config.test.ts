import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { loadConfig, parseConfig } from '../src/config.js';

test('conservative defaults and explicit valid overrides', () => {
  assert.deepEqual(parseConfig({}), {
    maxRepairAttempts: 2,
    verificationTimeoutMs: 120000,
    shell: '/bin/bash',
    autoPlanHandoff: true,
    claimAssignee: '@pi-control',
    readyStatus: 'To Do',
    inProgressStatus: 'In Progress',
    terminalStatus: 'Done',
    untrackedArtifacts: [],
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
    terminalStatus: 'Done',
    untrackedArtifacts: [],
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
    { terminalStatus: '' },
    { terminalStatus: 'In Progress' },
    { terminalStatus: ' to do ' },
    { terminalStatus: 'Done\u0000' },
    { readyStatus: '' },
    { readyStatus: 'To\u0000Do' },
    { readyStatus: 'done', inProgressStatus: ' Done ' },
    { untrackedArtifacts: '**/__pycache__/**' },
    { untrackedArtifacts: [''] },
    { untrackedArtifacts: ['/tmp/cache/**'] },
    { untrackedArtifacts: ['../cache/**'] },
    { untrackedArtifacts: ['.git/**'] },
    { untrackedArtifacts: ['cache\\**'] },
    { untrackedArtifacts: ['!cache/**'] },
    { untrackedArtifacts: ['cache/['] },
    { untrackedArtifacts: ['{../cache,safe}/**'] },
    { untrackedArtifacts: ['{.git,cache}/**'] },
    { untrackedArtifacts: ['   '] },
  ]) assert.throws(() => parseConfig(config));
});

test('loadConfig combines user-global config with trusted project overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pi-control-config-root-'));
  const home = await mkdtemp(join(tmpdir(), 'pi-control-config-home-'));
  try {
    await mkdir(join(home, '.pi/agent'), { recursive: true });
    await mkdir(join(root, '.pi'), { recursive: true });
    await writeFile(join(home, '.pi/agent/pi-control.json'), JSON.stringify({
      maxRepairAttempts: 5,
      verificationTimeoutMs: 111,
      claimAssignee: 'global-user',
      readyStatus: 'Ready',
      terminalStatus: 'Closed',
      untrackedArtifacts: ['**/__pycache__/**'],
    }));
    await writeFile(join(root, '.pi/pi-control.json'), JSON.stringify({
      verificationTimeoutMs: 222,
      claimAssignee: 'project-user',
      untrackedArtifacts: ['**/.pytest_cache/**'],
    }));

    const config = await loadConfig(root, '.pi', true, { home });
    assert.equal(config.maxRepairAttempts, 5);
    assert.equal(config.verificationTimeoutMs, 222);
    assert.equal(config.claimAssignee, '@project-user');
    assert.equal(config.readyStatus, 'Ready');
    assert.equal(config.terminalStatus, 'Closed');
    assert.deepEqual(config.untrackedArtifacts, ['**/.pytest_cache/**']);
    await assert.rejects(() => loadConfig(root, '.pi', false, { home }), /Trust this project/);
    await writeFile(join(root, '.pi/pi-control.json'), JSON.stringify({ untrackedArtifacts: [] }));
    assert.deepEqual((await loadConfig(root, '.pi', true, { home })).untrackedArtifacts, []);
    await writeFile(join(root, '.pi/pi-control.json'), '{}');
    assert.deepEqual((await loadConfig(root, '.pi', true, { home })).untrackedArtifacts, ['**/__pycache__/**']);
    const explicitAgentDir = join(home, 'custom-agent');
    await mkdir(explicitAgentDir);
    await writeFile(join(explicitAgentDir, 'pi-control.json'), JSON.stringify({ terminalStatus: 'Archived' }));
    assert.equal((await loadConfig(root, '.pi', true, { agentDir: explicitAgentDir })).terminalStatus, 'Archived');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
