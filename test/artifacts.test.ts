import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';

import { compileArtifactPolicy, validateArtifactPolicy } from '../src/artifacts.ts';
import { captureBaseline, inspectRun } from '../src/git.ts';
import { compileScope } from '../src/paths.ts';
import { runVerification } from '../src/verification.ts';
import { makeTempRepo } from './helpers.ts';

const task = {
  id: 'BACK-2',
  title: 'artifacts',
  acceptanceCriteria: [],
  allowedScope: ['allowed.txt'],
  verificationCommands: ['true'],
};

test('matching untracked artifacts are excluded from scope, content digest, and verification mutation checks', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('allowed.txt', 'initial\n');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['allowed.txt']);
    const artifactPolicy = await compileArtifactPolicy(repo.root, ['**/__pycache__/**']);
    const baseline = await captureBaseline(repo.root, scope, artifactPolicy);

    const before = await inspectRun(baseline, scope, {}, artifactPolicy);
    await repo.write('__pycache__/module.pyc', 'cache\n');
    const after = await inspectRun(baseline, scope, {}, artifactPolicy);
    assert.equal(after.scopeOk, true);
    assert.deepEqual(after.changedPaths, []);
    assert.equal(after.contentDigest, before.contentDigest);

    const result = await runVerification({
      baseline,
      task: { ...task, verificationCommands: ['mkdir -p __pycache__ && printf cache > __pycache__/check.pyc'] },
      scope,
      artifactPolicy,
      shell: '/bin/bash',
      timeoutMs: 2000,
    });
    assert.equal(result.passed, true);
    assert.deepEqual(result.changedPaths, []);
  } finally {
    await repo.cleanup();
  }
});

test('unmatched untracked files still fail scope checks', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('allowed.txt', 'initial\n');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['allowed.txt']);
    const artifactPolicy = await compileArtifactPolicy(repo.root, ['**/__pycache__/**']);
    const baseline = await captureBaseline(repo.root, scope, artifactPolicy);

    await repo.write('.pytest_cache/state', 'cache\n');
    const inspection = await inspectRun(baseline, scope, {}, artifactPolicy);
    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /out-of-scope: \.pytest_cache\/state/);
  } finally {
    await repo.cleanup();
  }
});

test('tracked and staged matching artifacts are not exempt', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('allowed.txt', 'initial\n');
    await repo.write('__pycache__/tracked.pyc', 'old\n');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['allowed.txt']);
    const artifactPolicy = await compileArtifactPolicy(repo.root, ['**/__pycache__/**']);
    const baseline = await captureBaseline(repo.root, scope, artifactPolicy);

    await repo.write('__pycache__/tracked.pyc', 'new\n');
    let inspection = await inspectRun(baseline, scope, {}, artifactPolicy);
    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /out-of-scope: __pycache__\/tracked\.pyc/);

    await repo.git(['checkout', '--', '__pycache__/tracked.pyc']);
    await repo.write('__pycache__/staged.pyc', 'new\n');
    await repo.git(['add', '__pycache__/staged.pyc']);
    inspection = await inspectRun(baseline, scope, {}, artifactPolicy);
    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /staged change is not allowed: __pycache__\/staged\.pyc/);
    assert.deepEqual(inspection.stagedPaths, ['__pycache__/staged.pyc']);
  } finally {
    await repo.cleanup();
  }
});

test('artifact policy uses path safety rules and refuses symlink escapes', async () => {
  const repo = await makeTempRepo();
  const outside = path.join(repo.root, '..', `artifact-outside-${Date.now()}`);
  try {
    await repo.write('allowed.txt', 'initial\n');
    await repo.commitAll();
    await assert.rejects(() => compileArtifactPolicy(repo.root, ['../cache/**']), /traversal/);
    await assert.rejects(() => compileArtifactPolicy(repo.root, ['.git/**']), /git metadata/);

    await mkdir(outside, { recursive: true });
    await repo.symlink(outside, 'cache-link');
    await assert.rejects(() => compileArtifactPolicy(repo.root, ['cache-link/**']), /symlink escapes|outside repository/);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await repo.cleanup();
  }
});

test('matching symlink artifacts are not ignored when the link target is unsafe or outside the policy', async () => {
  const repo = await makeTempRepo();
  const outside = path.join(repo.root, '..', `artifact-link-outside-${Date.now()}`);
  try {
    await repo.write('allowed.txt', 'initial\n');
    await repo.write('target/secret.txt', 'secret\n');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['allowed.txt']);
    const artifactPolicy = await compileArtifactPolicy(repo.root, ['**/__pycache__/**']);
    const baseline = await captureBaseline(repo.root, scope, artifactPolicy);

    await mkdir(outside, { recursive: true });
    await repo.symlink(outside, '__pycache__/escape');
    let inspection = await inspectRun(baseline, scope, {}, artifactPolicy);
    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /symlink-escape: __pycache__\/escape/);

    await rm(path.join(repo.root, '__pycache__/escape'));
    await repo.symlink('../target/secret.txt', '__pycache__/link');
    inspection = await inspectRun(baseline, scope, {}, artifactPolicy);
    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /out-of-scope-target: __pycache__\/link -> target\/secret\.txt/);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await repo.cleanup();
  }
});

test('compiled artifact policy is restorable and malformed policies are rejected', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('allowed.txt', 'initial\n');
    await repo.commitAll();
    const policy = await compileArtifactPolicy(repo.root, ['**/__pycache__/**']);
    const restored = JSON.parse(JSON.stringify(policy));
    assert.doesNotThrow(() => validateArtifactPolicy(restored));
    assert.throws(() => validateArtifactPolicy({ untrackedArtifacts: [{ text: '../x', kind: 'glob', pattern: '../x' }] }), /Invalid artifact policy/);
    for (const pattern of ['cache/[', '{../cache,safe}/**', '{.git,cache}/**']) {
      assert.throws(() => validateArtifactPolicy({ untrackedArtifacts: [{ text: pattern, kind: 'glob', pattern }] }), /Invalid artifact policy/);
    }
    assert.throws(() => validateArtifactPolicy({ untrackedArtifacts: [{ text: '**/__pycache__/**', kind: 'glob', pattern: '**/__pycache__/**' }, { extra: true }] }), /Invalid artifact policy/);
  } finally {
    await repo.cleanup();
  }
});
