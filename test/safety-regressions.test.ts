import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeTempRepo } from './helpers.js';
import { captureBaseline, inspectRun } from '../src/git.js';
import { compileScope } from '../src/paths.js';
import { stableDigest } from '../src/digest.js';
import { normalizeTask } from '../src/backlog.js';
import { readFile } from 'node:fs/promises';

test('prototype-like filenames remain distinct in snapshots and serialized baselines', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('base', 'base'); await repo.git(['add', '--', 'base']); await repo.git(['commit', '-qm', 'base']);
    await repo.write('__proto__', 'outside');
    const scope = await compileScope(repo.root, ['allowed']);
    const baseline = await captureBaseline(repo.root, scope);
    assert.ok(Object.hasOwn(baseline.dirty, '__proto__'));
    const restored = JSON.parse(JSON.stringify(baseline));
    assert.equal((await inspectRun(restored, scope)).scopeOk, true);
    await repo.write('__proto__', 'changed');
    const changed = await inspectRun(restored, scope);
    assert.equal(changed.scopeOk, false);
    assert.ok(changed.changedPaths.includes('__proto__'));
    assert.notEqual(stableDigest(JSON.parse('{"__proto__":1}')), stableDigest({}));
  } finally { await repo.cleanup(); }
});

test('Backlog normalization preserves first scope text and supports subtask IDs', async () => {
  const raw = JSON.parse(await readFile(new URL('./fixtures/backlog-1.52.0-task-view-valid.json', import.meta.url), 'utf8'));
  raw.task.id = 'BACK-1.2';
  raw.task.modifiedFiles = ['src\\a.ts', 'src/a.ts', 'new', 'new/'];
  const normalized = normalizeTask(raw);
  assert.equal(normalized.id, 'BACK-1.2');
  assert.deepEqual(normalized.allowedScope, ['src\\a.ts', 'new', 'new/']);
});
