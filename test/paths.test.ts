import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, rm, writeFile } from 'node:fs/promises';

import { canonicalPath, compileScope, matchesScope } from '../src/paths.ts';
import { makeTempRepo } from './helpers.ts';

test('canonicalPath normalizes repository paths and unusual names', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('dir with spaces/tabs\t/--leading-å.txt', 'ok');

    assert.equal(
      await canonicalPath(repo.root, 'dir with spaces/tabs\t/--leading-å.txt'),
      'dir with spaces/tabs\t/--leading-å.txt',
    );
    assert.equal(await canonicalPath(repo.root, './new/file.txt'), 'new/file.txt');
    assert.equal(
      await canonicalPath(repo.root, path.join(repo.root, 'dir with spaces/tabs\t/--leading-å.txt')),
      'dir with spaces/tabs\t/--leading-å.txt',
    );
  } finally {
    await repo.cleanup();
  }
});

test('canonicalPath follows safe symlinks and rejects symlink escapes', async () => {
  const repo = await makeTempRepo();
  const outside = path.join(repo.root, '..', `outside-${Date.now()}`);
  try {
    await repo.mkdir('real');
    await repo.write('real/file.txt', 'ok');
    await repo.symlink('real', 'inside-link');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'secret.txt'), 'no');
    await repo.symlink(outside, 'escape-link');

    assert.equal(await canonicalPath(repo.root, 'inside-link/file.txt'), 'real/file.txt');
    await assert.rejects(() => canonicalPath(repo.root, 'escape-link/secret.txt'), /outside repository|symlink/i);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await repo.cleanup();
  }
});

test('canonicalPath rejects traversal, outside absolute paths, empty paths, and .git metadata', async () => {
  const repo = await makeTempRepo();
  try {
    await assert.rejects(() => canonicalPath(repo.root, '../x'), /traversal/i);
    await assert.rejects(() => canonicalPath(repo.root, path.dirname(repo.root)), /outside repository/i);
    await assert.rejects(() => canonicalPath(repo.root, ''), /empty/i);
    await assert.rejects(() => canonicalPath(repo.root, '.git/config'), /git metadata/i);
  } finally {
    await repo.cleanup();
  }
});

test('compileScope classifies exact files, directories, and globs', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.mkdir('src');
    await repo.write('README.md', 'readme');

    const scope = await compileScope(repo.root, [
      'README.md',
      'src',
      'docs/',
      'test/**/*.test.ts',
      'test/**/*.test.ts',
    ]);

    assert.deepEqual(scope, [
      { text: 'README.md', kind: 'file', pattern: 'README.md' },
      { text: 'src', kind: 'directory', pattern: 'src' },
      { text: 'docs/', kind: 'directory', pattern: 'docs' },
      { text: 'test/**/*.test.ts', kind: 'glob', pattern: 'test/**/*.test.ts' },
    ]);
  } finally {
    await repo.cleanup();
  }
});

test('compileScope rejects unsafe scope entries', async () => {
  const repo = await makeTempRepo();
  try {
    for (const entry of [path.join(repo.root, 'x'), '../x', '.git/config', 'src/[abc']) {
      await assert.rejects(() => compileScope(repo.root, [entry]), /absolute|traversal|git metadata|invalid glob/i);
    }
  } finally {
    await repo.cleanup();
  }
});

test('matchesScope handles exact, directory, and dotfile glob semantics', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.mkdir('src');
    const scope = await compileScope(repo.root, ['src/a.ts', 'lib/', 'config/**/*.json']);

    assert.equal(matchesScope('src/a.ts', scope), true);
    assert.equal(matchesScope('src/a.ts.bak', scope), false);
    assert.equal(matchesScope('lib/nested/file.ts', scope), true);
    assert.equal(matchesScope('library/file.ts', scope), false);
    assert.equal(matchesScope('config/.hidden/settings.json', scope), true);
    assert.equal(matchesScope('.git/config', scope), false);
  } finally {
    await repo.cleanup();
  }
});

test('compileScope requires picomatch semantics with extglob and strict unsafe rejects', async () => {
  const repo = await makeTempRepo();
  try {
    await repo.write('src/a.ts', 'one');
    await repo.write('src/foo.ts', 'two');
    const scope = await compileScope(repo.root, ['src/!(foo).ts']);

    assert.equal(matchesScope('src/a.ts', scope), true);
    assert.equal(matchesScope('src/foo.ts', scope), false);
    const normalized = await compileScope(repo.root, ['src\\a.ts', './**/*.ts']);
    assert.equal(normalized[0].text, 'src\\a.ts');
    assert.equal(normalized[0].pattern, 'src/a.ts');
    assert.equal(matchesScope('src/a.ts', normalized), true);
    assert.equal(matchesScope('src/foo.ts', normalized), true);

    for (const entry of ['!src/**', 'C:relative', 'C:/absolute', 'src/{../escape,ok}.ts', '{.git,src}/config', 'src/has\0nul', '{src,/tmp}/**', '@(../escape|src)/**']) {
      await assert.rejects(() => compileScope(repo.root, [entry]), /invalid glob|absolute|traversal|git metadata|backslash|NUL/i);
    }
  } finally {
    await repo.cleanup();
  }
});

test('glob static symlink prefixes are canonicalized and escaping prefixes are rejected', async () => {
  const repo = await makeTempRepo();
  const outside = path.join(repo.root, '..', `outside-${Date.now()}`);
  try {
    await repo.mkdir('real');
    await repo.symlink('real', 'safe-link');
    const scope = await compileScope(repo.root, ['safe-link/**/*.ts']);
    assert.deepEqual(scope, [{ text: 'safe-link/**/*.ts', kind: 'glob', pattern: 'real/**/*.ts' }]);

    await mkdir(outside, { recursive: true });
    await repo.symlink(outside, 'escape-link');
    await assert.rejects(() => compileScope(repo.root, ['escape-link/**/*.ts']), /symlink escapes|outside repository/i);
  } finally {
    await rm(outside, { recursive: true, force: true });
    await repo.cleanup();
  }
});
