import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { persistStateMarker, restoreStateMarker } from '../src/state-storage.js';
import { serializeState, type ImplementationRun } from '../src/state.js';
import type { Baseline, IndexFingerprint, PathFingerprint } from '../src/git.js';

function largeRun(root: string): ImplementationRun {
  const tracked: Record<string, PathFingerprint> = {};
  const index: Record<string, IndexFingerprint> = {};
  for (let i = 0; i < 1500; i++) {
    const path = `src/file-${String(i).padStart(4, '0')}.ts`;
    tracked[path] = { kind: 'file', sha256: 'b'.repeat(64), executable: false, mode: 0o644, size: i };
    index[path] = { mode: '100644', object: 'c'.repeat(40), stage: '0' };
  }
  const baseline: Baseline = { root, head: 'a'.repeat(40), dirty: {}, tracked, index };
  return {
    task: { id: 'TASK-1', title: 'Large baseline', description: 'Test task', acceptanceCriteria: ['Works'], allowedScope: ['src/'], verificationCommands: ['true'] },
    baseline,
    originalScope: [{ text: 'src/', kind: 'directory', pattern: 'src' }],
    additions: [],
    phase: 'IMPLEMENTING',
    repairs: 0,
    maxRepairAttempts: 2,
    pendingAutomatic: true,
    restored: false,
    createdAt: new Date().toISOString(),
  };
}

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'control-state-'));
  return { root, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test('session state marker stays small and points at project .pi sidecar state', async t => {
  const repo = await tempRoot();
  t.after(repo.cleanup);
  const run = largeRun(repo.root);

  for (let i = 0; i < 4; i++) {
    const marker = persistStateMarker(run);
    const json = JSON.stringify(marker);
    assert.ok(json.length < 2000, json.length.toString());
    assert.equal(json.includes('baseline'), false);
    assert.equal(json.includes('tracked'), false);
    assert.equal(json.includes('index'), false);
    assert.equal(marker.run!.path, `.pi/pi-control/state/${marker.run!.digest}.json`);
  }
});

test('state marker restores from sidecar and fails closed on unsafe or stale data', async t => {
  const repo = await tempRoot();
  t.after(repo.cleanup);
  const run = largeRun(repo.root);
  const marker = persistStateMarker(run);

  const restored = restoreStateMarker(marker);
  assert.equal(restored?.task.id, 'TASK-1');
  assert.equal(Object.keys(restored!.baseline.tracked).length, 1500);

  const traversal = structuredClone(marker);
  traversal.run!.path = '../state.json';
  assert.throws(() => restoreStateMarker(traversal), /Invalid or unsupported/);

  const oldInlineState = serializeState(run);
  assert.throws(() => restoreStateMarker(oldInlineState), /Invalid or unsupported/);

  await writeFile(join(repo.root, marker.run!.path), JSON.stringify({ schemaVersion: 2, kind: 'pi-control-run-state', run: null }));
  assert.throws(() => restoreStateMarker(marker), /Invalid or unsupported/);

  const missing = persistStateMarker(run);
  await rm(join(repo.root, missing.run!.path));
  assert.throws(() => restoreStateMarker(missing), /Invalid or unsupported/);
});
