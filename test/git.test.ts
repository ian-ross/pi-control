import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

import { compileScope } from '../src/paths.ts';
import { captureBaseline, findRoot, fingerprintPath, git, inspectRun, validateBaseline, validateManagedFiles } from '../src/git.ts';
import { makeTempRepo } from './helpers.ts';

test('findRoot locates the repository root and git helper rejects mutations', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.mkdir('a/b');
    assert.equal(await findRoot(`${repo.root}/a/b`), repo.root);
    await assert.rejects(() => git(repo.root, ['commit', '-m', 'no']), /read-only/);
  } finally {
    await repo.cleanup();
  }
});

test('clean baseline permits later in-scope changes', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.commitAll();

    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);
    await repo.write('src/a.txt', 'two');
    await repo.write('src/new.txt', 'new');

    const inspection = await inspectRun(baseline, scope);
    assert.equal(inspection.scopeOk, true);
    assert.deepEqual(inspection.errors, []);
    assert.deepEqual(inspection.changedPaths.sort(), ['src/a.txt', 'src/new.txt']);
    assert.equal(inspection.fingerprints['src/a.txt'].kind, 'file');
  } finally {
    await repo.cleanup();
  }
});

test('captureBaseline refuses staged changes and dirty files inside scope', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);

    await repo.write('other.txt', 'staged');
    await repo.git(['add', 'other.txt']);
    await assert.rejects(() => captureBaseline(repo.root, scope), /staged/i);
    await repo.git(['reset', '--', 'other.txt']);

    await repo.write('src/a.txt', 'dirty');
    await assert.rejects(() => captureBaseline(repo.root, scope), /dirty.*inside scope/i);
  } finally {
    await repo.cleanup();
  }
});

test('pre-existing outside-scope dirty paths are allowed only while unchanged', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.write('notes.txt', 'draft1');
    await repo.commitAll();
    await repo.write('notes.txt', 'draft2');

    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);
    let inspection = await inspectRun(baseline, scope);
    assert.equal(inspection.scopeOk, true);

    await repo.write('notes.txt', 'draft3');
    inspection = await inspectRun(baseline, scope);
    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /baseline-dirty-changed: notes\.txt/);
  } finally {
    await repo.cleanup();
  }
});

test('new out-of-scope tracked and untracked paths are reported together', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.write('tracked.txt', 'old');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await repo.write('tracked.txt', 'new');
    await repo.write('untracked.txt', 'new');
    const inspection = await inspectRun(baseline, scope);

    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /out-of-scope: tracked\.txt/);
    assert.match(inspection.errors.join('\n'), /out-of-scope: untracked\.txt/);
  } finally {
    await repo.cleanup();
  }
});

test('rename across the scope boundary reports both sides where applicable', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await repo.mkdir('outside');
    await repo.git(['mv', 'src/a.txt', 'outside/a.txt']);
    await repo.git(['reset']);

    const inspection = await inspectRun(baseline, scope);
    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /out-of-scope: outside\/a\.txt/);
    assert(inspection.changedPaths.includes('src/a.txt'));
    assert(inspection.changedPaths.includes('outside/a.txt'));
  } finally {
    await repo.cleanup();
  }
});

test('deletion and executable mode changes are fingerprinted', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/delete.txt', 'bye');
    await repo.write('src/run.sh', '#!/bin/sh\nexit 0\n');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await rm(`${repo.root}/src/delete.txt`);
    await repo.chmod('src/run.sh', 0o755);

    const inspection = await inspectRun(baseline, scope);
    assert.equal(inspection.scopeOk, true);
    assert.equal(inspection.fingerprints['src/delete.txt'].kind, 'absent');
    const runFingerprint = inspection.fingerprints['src/run.sh'];
    assert.equal(runFingerprint.kind, 'file');
    assert.equal(runFingerprint.executable, true);
    assert.equal(runFingerprint.mode, 0o755);
  } finally {
    await repo.cleanup();
  }
});

test('deleting a tracked directory does not break path authorization', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/nested/a.txt', 'one');
    await repo.write('src/nested/b.txt', 'two');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await rm(`${repo.root}/src/nested`, { recursive: true, force: true });
    const inspection = await inspectRun(baseline, scope);

    assert.equal(inspection.scopeOk, true);
    assert.equal(inspection.fingerprints['src/nested/a.txt'].kind, 'absent');
    assert.equal(inspection.fingerprints['src/nested/b.txt'].kind, 'absent');
  } finally {
    await repo.cleanup();
  }
});

test('symlink escapes are reported even when the symlink path is in scope', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await repo.symlink('../../outside-target', 'src/link-out');
    const inspection = await inspectRun(baseline, scope);

    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /symlink-escape: src\/link-out/);
  } finally {
    await repo.cleanup();
  }
});

test('changed HEAD invalidates the run', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.commitAll('one');
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await repo.write('src/b.txt', 'two');
    await repo.commitAll('two');
    const inspection = await inspectRun(baseline, scope);

    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /head-changed/);
  } finally {
    await repo.cleanup();
  }
});

test('staging an in-scope changed path is allowed and keeps the content digest stable', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await repo.write('src/a.txt', 'two');
    const beforeStage = await inspectRun(baseline, scope);
    await repo.git(['add', 'src/a.txt']);
    const afterStage = await inspectRun(baseline, scope);

    assert.equal(beforeStage.contentDigest, afterStage.contentDigest);
    assert.deepEqual(afterStage.stagedPaths, ['src/a.txt']);
    assert.deepEqual(afterStage.errors, []);
    assert.equal(afterStage.scopeOk, true);
  } finally {
    await repo.cleanup();
  }
});

test('staged out-of-scope and baseline-dirty index changes are refused', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.write('notes.txt', 'draft1');
    await repo.write('outside.txt', 'old');
    await repo.commitAll();
    await repo.write('notes.txt', 'draft2');
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await repo.write('outside.txt', 'new');
    await repo.git(['add', 'outside.txt']);
    let inspection = await inspectRun(baseline, scope);
    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /staged change is not allowed: outside\.txt/);

    await repo.git(['reset', '--', 'outside.txt']);
    await repo.git(['add', 'notes.txt']);
    inspection = await inspectRun(baseline, scope);
    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /baseline-dirty-index-changed: notes\.txt/);
  } finally {
    await repo.cleanup();
  }
});

test('tracked baseline fingerprints detect mode changes when core.filemode is false', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/run.sh', '#!/bin/sh\nexit 0\n');
    await repo.commitAll();
    await repo.git(['config', 'core.filemode', 'false']);
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await repo.chmod('src/run.sh', 0o755);
    const inspection = await inspectRun(baseline, scope);
    assert.equal(inspection.scopeOk, true);
    assert.deepEqual(inspection.changedPaths, ['src/run.sh']);
    assert.equal(inspection.fingerprints['src/run.sh'].kind, 'file');
    if (inspection.fingerprints['src/run.sh'].kind === 'file') {
      assert.equal(inspection.fingerprints['src/run.sh'].executable, true);
      assert.equal(inspection.fingerprints['src/run.sh'].mode, 0o755);
    }
  } finally {
    await repo.cleanup();
  }
});

test('captureBaseline refuses a pre-existing executable mismatch inside scope when core.filemode is false', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/run.sh', '#!/bin/sh\nexit 0\n');
    await repo.commitAll();
    await repo.git(['config', 'core.filemode', 'false']);
    await repo.chmod('src/run.sh', 0o755);

    const scope = await compileScope(repo.root, ['src/']);
    await assert.rejects(() => captureBaseline(repo.root, scope), /dirty paths inside scope.*src\/run\.sh/);
  } finally {
    await repo.cleanup();
  }
});

test('outside-scope permission-only changes are detected', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.write('outside.txt', 'old');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await repo.chmod('outside.txt', 0o600);
    const inspection = await inspectRun(baseline, scope);

    assert.equal(inspection.scopeOk, false);
    assert.deepEqual(inspection.changedPaths, ['outside.txt']);
    assert.match(inspection.errors.join('\n'), /out-of-scope: outside\.txt/);
    assert.equal(inspection.fingerprints['outside.txt'].kind, 'file');
    if (inspection.fingerprints['outside.txt'].kind === 'file') {
      assert.equal(inspection.fingerprints['outside.txt'].mode, 0o600);
    }
  } finally {
    await repo.cleanup();
  }
});

test('unsupported index flags, submodules, and literal backslash git paths fail closed', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);

    await repo.git(['update-index', '--assume-unchanged', 'src/a.txt']);
    await assert.rejects(() => captureBaseline(repo.root, scope), /assume-unchanged/);
    await repo.git(['update-index', '--no-assume-unchanged', 'src/a.txt']);

    await repo.git(['update-index', '--skip-worktree', 'src/a.txt']);
    await assert.rejects(() => captureBaseline(repo.root, scope), /skip-worktree/);
    await repo.git(['update-index', '--no-skip-worktree', 'src/a.txt']);

    await repo.git(['update-index', '--add', '--cacheinfo', '160000', '0123456789012345678901234567890123456789', 'vendor/sub']);
    await assert.rejects(() => captureBaseline(repo.root, scope), /unsupported-submodule: vendor\/sub/);
    await repo.git(['rm', '--cached', 'vendor/sub']);

    await repo.write('src/back\\slash.txt', 'bad');
    await repo.git(['add', 'src/back\\slash.txt']);
    await assert.rejects(() => captureBaseline(repo.root, scope), /literal backslash|backslash/);
  } finally {
    await repo.cleanup();
  }
});

test('chained symlink escapes are all reported and symlink targets need scope', async () => {
  const repo = await makeTempRepo();
  const outside = path.join(repo.root, '..', `outside-${Date.now()}`);
  try {
    await repo.write('src/a.txt', 'one');
    await repo.write('target/secret.txt', 'secret');
    await repo.commitAll();
    const broadScope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, broadScope);
    await mkdir(outside, { recursive: true });
    await repo.symlink(outside, 'src/outside-a');
    await repo.symlink('outside-a', 'src/outside-b');

    let inspection = await inspectRun(baseline, broadScope);
    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /symlink-escape: src\/outside-a/);
    assert.match(inspection.errors.join('\n'), /symlink-escape: src\/outside-b/);

    await rm(`${repo.root}/src/outside-a`, { force: true });
    await rm(`${repo.root}/src/outside-b`, { force: true });
    const linkOnlyScope = await compileScope(repo.root, ['src/link']);
    const linkBaseline = await captureBaseline(repo.root, linkOnlyScope);
    await repo.symlink('../target/secret.txt', 'src/link');
    inspection = await inspectRun(linkBaseline, linkOnlyScope);
    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /out-of-scope-target: src\/link -> target\/secret\.txt/);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await repo.cleanup();
  }
});

test('dangling symlink targets through escaping symlink parents are reported', async () => {
  const repo = await makeTempRepo();
  const outside = path.join(repo.root, '..', `outside-dangling-${Date.now()}`);
  try {
    await repo.write('src/a.txt', 'one');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await mkdir(outside, { recursive: true });
    await repo.symlink(outside, 'src/alias');
    await repo.symlink('alias/missing.txt', 'src/newlink');
    const inspection = await inspectRun(baseline, scope);

    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /symlink-escape: src\/alias/);
    assert.match(inspection.errors.join('\n'), /symlink-escape: src\/newlink/);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await repo.cleanup();
  }
});

test('managed file exact match permits outside-scope claim edits and fingerprints them', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.write('Backlog/tasks/task-1.md', 'claimed: false\n');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await repo.write('Backlog/tasks/task-1.md', 'claimed: true\n');
    const expected = await fingerprintPath(repo.root, 'Backlog/tasks/task-1.md');
    const inspection = await inspectRun(baseline, scope, { 'Backlog/tasks/task-1.md': expected });

    assert.equal(inspection.scopeOk, true);
    assert.deepEqual(inspection.errors, []);
    assert.deepEqual(inspection.changedPaths, ['Backlog/tasks/task-1.md']);
    assert.deepEqual(inspection.fingerprints['Backlog/tasks/task-1.md'], expected);
    assert.match(inspection.contentDigest, /^[a-f0-9]{64}$/);
  } finally {
    await repo.cleanup();
  }
});

test('managed files may start dirty or untracked at baseline and still move to the exact claim fingerprint', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.write('Backlog/tasks/tracked.md', 'draft\n');
    await repo.commitAll();
    await repo.write('Backlog/tasks/tracked.md', 'local draft\n');
    await repo.write('Backlog/tasks/untracked.md', 'local draft\n');

    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await repo.write('Backlog/tasks/tracked.md', 'claimed tracked\n');
    await repo.write('Backlog/tasks/untracked.md', 'claimed untracked\n');
    const trackedExpected = await fingerprintPath(repo.root, 'Backlog/tasks/tracked.md');
    const untrackedExpected = await fingerprintPath(repo.root, 'Backlog/tasks/untracked.md');
    const inspection = await inspectRun(baseline, scope, {
      'Backlog/tasks/tracked.md': trackedExpected,
      'Backlog/tasks/untracked.md': untrackedExpected,
    });

    assert.equal(inspection.scopeOk, true);
    assert.deepEqual(inspection.errors, []);
    assert.deepEqual(inspection.changedPaths, ['Backlog/tasks/tracked.md', 'Backlog/tasks/untracked.md']);
  } finally {
    await repo.cleanup();
  }
});

test('staging an exact managed file is allowed only when the file changed since baseline', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.write('Backlog/tasks/task-1.md', 'claimed: false\n');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await repo.write('Backlog/tasks/task-1.md', 'claimed: true\n');
    const expected = await fingerprintPath(repo.root, 'Backlog/tasks/task-1.md');
    const beforeStage = await inspectRun(baseline, scope, { 'Backlog/tasks/task-1.md': expected });
    await repo.git(['add', 'Backlog/tasks/task-1.md']);
    const afterStage = await inspectRun(baseline, scope, { 'Backlog/tasks/task-1.md': expected });

    assert.equal(afterStage.scopeOk, true);
    assert.deepEqual(afterStage.errors, []);
    assert.deepEqual(afterStage.stagedPaths, ['Backlog/tasks/task-1.md']);
    assert.equal(beforeStage.contentDigest, afterStage.contentDigest);
  } finally {
    await repo.cleanup();
  }
});

test('staging an unchanged managed baseline-dirty file is refused', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.write('Backlog/tasks/task-1.md', 'baseline\n');
    await repo.commitAll();
    await repo.write('Backlog/tasks/task-1.md', 'local draft\n');
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);
    const expected = await fingerprintPath(repo.root, 'Backlog/tasks/task-1.md');

    await repo.git(['add', 'Backlog/tasks/task-1.md']);
    const inspection = await inspectRun(baseline, scope, { 'Backlog/tasks/task-1.md': expected });

    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /staged change is not allowed: Backlog\/tasks\/task-1\.md/);
  } finally {
    await repo.cleanup();
  }
});

test('managed file mutation, deletion, and revert to baseline are refused', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/task.md', 'baseline\n');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await repo.write('src/task.md', 'claimed\n');
    const expected = await fingerprintPath(repo.root, 'src/task.md');

    await repo.write('src/task.md', 'mutated\n');
    let inspection = await inspectRun(baseline, scope, { 'src/task.md': expected });
    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /managed-file-changed: src\/task\.md/);

    await rm(`${repo.root}/src/task.md`);
    inspection = await inspectRun(baseline, scope, { 'src/task.md': expected });
    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /managed-file-changed: src\/task\.md/);

    await repo.write('src/task.md', 'baseline\n');
    inspection = await inspectRun(baseline, scope, { 'src/task.md': expected });
    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /managed-file-changed: src\/task\.md/);
  } finally {
    await repo.cleanup();
  }
});

test('managed file authorization does not exempt other Backlog files', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.write('Backlog/tasks/task-1.md', 'claimed: false\n');
    await repo.write('Backlog/tasks/task-2.md', 'claimed: false\n');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    await repo.write('Backlog/tasks/task-1.md', 'claimed: true\n');
    await repo.write('Backlog/tasks/task-2.md', 'claimed: true\n');
    const expected = await fingerprintPath(repo.root, 'Backlog/tasks/task-1.md');
    const inspection = await inspectRun(baseline, scope, { 'Backlog/tasks/task-1.md': expected });

    assert.equal(inspection.scopeOk, false);
    assert.match(inspection.errors.join('\n'), /out-of-scope: Backlog\/tasks\/task-2\.md/);
    assert.doesNotMatch(inspection.errors.join('\n'), /out-of-scope: Backlog\/tasks\/task-1\.md/);
  } finally {
    await repo.cleanup();
  }
});

test('managed metadata cannot be redirected through an internal directory symlink', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('backlog/tasks/task.md', 'before');
    await repo.write('other/task.md', 'claimed');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['**']);
    const baseline = await captureBaseline(repo.root, scope);
    await repo.write('backlog/tasks/task.md', 'claimed');
    const expected = await fingerprintPath(repo.root, 'backlog/tasks/task.md');
    await rm(path.join(repo.root, 'backlog/tasks'), { recursive: true });
    await repo.symlink('../other', 'backlog/tasks');
    const result = await inspectRun(baseline, scope, { 'backlog/tasks/task.md': expected });
    assert.equal(result.scopeOk, false);
    assert.match(result.errors.join('\n'), /managed-file-changed: backlog\/tasks\/task.md/);
  } finally { await repo.cleanup(); }
});

test('managed file maps reject malformed paths and non-file fingerprints', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);
    const fingerprint = await fingerprintPath(repo.root, 'src/a.txt');

    assert.doesNotThrow(() => validateManagedFiles({ 'src/a.txt': fingerprint }));
    assert.throws(() => validateManagedFiles({ '../src/a.txt': fingerprint }), /managed/i);
    assert.throws(() => validateManagedFiles({ './src/a.txt': fingerprint }), /managed/i);
    assert.throws(() => validateManagedFiles({ 'src/a.txt': { kind: 'absent' } }), /regular file/i);
    await assert.rejects(() => inspectRun(baseline, scope, { 'src/a.txt': { kind: 'absent' } }), /regular file/i);
  } finally {
    await repo.cleanup();
  }
});

test('validateBaseline enforces the persisted baseline schema', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.txt', 'one');
    await repo.commitAll();
    const scope = await compileScope(repo.root, ['src/']);
    const baseline = await captureBaseline(repo.root, scope);

    assert.doesNotThrow(() => validateBaseline(baseline));
    assert.throws(() => validateBaseline({ root: repo.root, head: baseline.head, dirty: {} }), /tracked.*index|expected root/);
    assert.throws(
      () => validateBaseline({ ...baseline, tracked: { '../x': { kind: 'absent' } } }),
      /tracked map/,
    );
    assert.throws(() => validateBaseline({ ...baseline, index: {} }), /tracked and index paths differ/);
    assert.throws(
      () => validateBaseline({ ...baseline, dirty: { 'src/a.txt': { kind: 'absent' } } }),
      /dirty tracked fingerprint differs/,
    );

    const fingerprint = baseline.tracked['src/a.txt'];
    assert.equal(fingerprint.kind, 'file');
    if (fingerprint.kind === 'file') {
      const withoutMode = {
        kind: fingerprint.kind,
        sha256: fingerprint.sha256,
        executable: fingerprint.executable,
        size: fingerprint.size,
      };
      assert.throws(
        () => validateBaseline({ ...baseline, tracked: { ...baseline.tracked, 'src/a.txt': withoutMode } }),
        /tracked map/,
      );
      assert.throws(
        () => validateBaseline({ ...baseline, tracked: { ...baseline.tracked, 'src/a.txt': { ...fingerprint, mode: 0o10000 } } }),
        /tracked map/,
      );
    }
  } finally {
    await repo.cleanup();
  }
});
