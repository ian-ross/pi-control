import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { nextPlanPath, planSlug } from '../src/plans.js';

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'control-plans-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('slugifies descriptions and rejects empty slugs', () => {
  assert.equal(planSlug(' Add USER profile page! '), 'add-user-profile-page');
  assert.equal(planSlug('Café: settings / profile_v2'), 'cafe-settings-profile-v2');
  assert.equal(planSlug('../../A\nB; $(echo test)'), 'a-b-echo-test');
  for (const text of ['', '  ', '!!!', '📝']) assert.throws(() => planSlug(text), /Usage: \/plan/);
});

test('starts at 001, creates missing directories, but does not create or reserve a file', async t => {
  const root = await fixture(t);
  assert.equal(await nextPlanPath(root, root, 'docs/plans', 'new-page'), 'docs/plans/001-new-page.md');
  assert.deepEqual(await readdir(join(root, 'docs/plans')), []);
  assert.equal(await nextPlanPath(root, root, 'docs/plans', 'new-page'), 'docs/plans/001-new-page.md');
});

test('uses highest numbered Markdown plan, skips gaps and unrelated entries', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'plans'));
  for (const name of ['001-first.md', '004-last.md', 'README.md', '999-note.txt', '999.md']) {
    await writeFile(join(root, 'plans', name), 'existing');
  }
  await mkdir(join(root, 'plans/999-directory.md'));
  assert.equal(await nextPlanPath(root, root, 'plans', 'add-user-profile-page'), 'plans/005-add-user-profile-page.md');
  await writeFile(join(root, 'plans/999-last.md'), 'existing');
  assert.equal(await nextPlanPath(root, root, 'plans', 'next'), 'plans/1000-next.md');
});

test('resolves the configured directory from root and returns a cwd-relative path', async t => {
  const root = await fixture(t);
  const cwd = join(root, 'src');
  await mkdir(cwd);
  assert.equal(await nextPlanPath(root, cwd, 'design plans', 'next'), '../design plans/001-next.md');
});

test('rejects directory errors and symlink escapes without writing outside the repository', async t => {
  const root = await fixture(t);
  const outside = await fixture(t);
  await writeFile(join(root, 'file'), 'not a directory');
  await assert.rejects(() => nextPlanPath(root, root, 'file', 'next'));
  await symlink(outside, join(root, 'plans'));
  await assert.rejects(() => nextPlanPath(root, root, 'plans/nested', 'next'), /outside repository/);
  assert.deepEqual(await readdir(outside), []);
});

test('does not select an occupied directory or dangling symlink path', async t => {
  const root = await fixture(t);
  await mkdir(join(root, 'plans/001-next.md'), { recursive: true });
  await assert.rejects(() => nextPlanPath(root, root, 'plans', 'next'), /already exists/);
  await symlink('missing', join(root, 'plans/004-next.md'));
  assert.equal(await nextPlanPath(root, root, 'plans', 'next'), 'plans/005-next.md');
});
