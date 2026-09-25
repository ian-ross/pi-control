import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { ControlController } from '../src/commands.js';
import { ensureAcceptanceCriteriaState } from '../src/backlog.js';
import { restoreState, serializeState } from '../src/state.js';
import { makeTempRepo } from './helpers.js';

const exec = promisify(execFile);
async function setup(t: TestContext, artifacts = false) {
  const repo = await makeTempRepo();
  t.after(() => repo.cleanup());
  const path = 'backlog/tasks/task-1.md';
  const task = ensureAcceptanceCriteriaState({ id: 'TASK-1', title: 'Finalize safely', description: 'Keep the task definition.', implementationPlan: 'Update allowed.', lifecycle: { path, status: 'To Do', assignees: [] }, acceptanceCriteria: ['Works', 'Human criterion'], acceptanceCriteriaState: [{ id: '1', index: 1, text: 'Works', checked: false }, { id: '2', index: 2, text: 'Human criterion', checked: true }], allowedScope: ['allowed', 'cache/**'], verificationCommands: [artifacts ? 'mkdir -p cache; printf disposable > cache/output' : 'true'] });
  const save = () => repo.write(path, `---\nid: TASK-1\ntitle: ${task.title}\nstatus: ${task.lifecycle!.status}\nassignee: ${JSON.stringify(task.lifecycle!.assignees)}\n---\n\n${task.description}\n\n## Acceptance Criteria\n<!-- AC:BEGIN -->\n${task.acceptanceCriteriaState!.map(c => `- [${c.checked ? 'x' : ' '}] #${c.index} ${c.text}`).join('\n')}\n<!-- AC:END -->\n\n## Implementation Plan\n${task.implementationPlan}\n${task.finalSummary === undefined ? '' : `\n## Final Summary\n\n<!-- SECTION:FINAL_SUMMARY:BEGIN -->\n${task.finalSummary}\n<!-- SECTION:FINAL_SUMMARY:END -->\n`}`);
  await save(); await repo.write('allowed', 'before'); await repo.write('outside', 'untouched');
  await repo.write('.pi/pi-control.json', JSON.stringify({ terminalStatus: 'Closed', untrackedArtifacts: artifacts ? ['cache/**'] : [] }));
  await repo.commitAll();
  const initialHead = (await repo.git(['rev-parse', 'HEAD'])).trim();
  const notices: string[] = [], confirmations: string[] = [], prompts: string[] = [];
  let finalEdits = 0;
  let failBefore = false, failAfter = false, extraTaskEdit = false, implementationReportFailure = false;
  const pi = {
    appendEntry: () => {}, sendUserMessage: (s: string) => prompts.push(s),
    exec: async (cmd: string, args: string[], options: { cwd?: string } = {}) => {
      if (cmd === 'backlog') {
        if (args[0] === 'config') return { code: 0, stdout: 'false\n', stderr: '', killed: false };
        if (args[1] === 'edit') {
          if (args.includes('--final-summary')) { finalEdits++; if (failBefore) return { code: 1, stdout: '', stderr: 'before failure', killed: false }; }
          if (args.includes('--status')) task.lifecycle!.status = args[args.indexOf('--status') + 1];
          if (args.includes('--assignee')) task.lifecycle!.assignees = [args[args.indexOf('--assignee') + 1]];
          if (args.includes('--final-summary')) {
            task.finalSummary = args[args.indexOf('--final-summary') + 1];
            for (let i = 0; i < args.length; i++) if (args[i] === '--check-ac') task.acceptanceCriteriaState!.find(c => c.index === Number(args[i + 1]))!.checked = true;
          }
          await save();
          if (extraTaskEdit && args.includes('--final-summary')) await repo.write(path, (await repo.read(path)) + '\nUnexpected hidden metadata\n');
          if (failAfter && args.includes('--final-summary')) return { code: 1, stdout: '', stderr: 'after failure', killed: false };
          return { code: 0, stdout: '', stderr: '', killed: false };
        }
        if (args[0] === 'task') return { code: 0, killed: false, stderr: '', stdout: JSON.stringify({ schemaVersion: 1, kind: 'task-view', task: { ...task, ...task.lifecycle, modifiedFiles: task.allowedScope, acceptanceCriteria: task.acceptanceCriteriaState, definitionOfDone: task.verificationCommands.map((c, i) => ({ index: i + 1, text: `Verification: ${c}`, checked: false })) } }) };
      }
      try {
        const result = await exec(cmd, args, { cwd: options.cwd ?? repo.root });
        if (implementationReportFailure && cmd === 'git' && args.includes('commit') && !args.some(a => a.includes('finalize Backlog metadata'))) return { ...result, code: 1, killed: true, stderr: 'post-commit timed out' };
        return { ...result, code: 0, killed: false };
      }
      catch (e) { const error = e as { stdout?: string; stderr?: string; code?: number }; return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1, killed: false }; }
    },
  } as unknown as ExtensionAPI;
  const ctx = { cwd: repo.root, hasUI: true, isIdle: () => true, isProjectTrusted: () => true, sessionManager: { getBranch: () => [] }, ui: { notify: (s: string) => notices.push(s), confirm: async (title: string, text: string) => { confirmations.push(`${title}\n${text}`); return true; } } } as unknown as ExtensionContext;
  const controller = new ControlController(pi, '.pi', { taskLoader: async () => structuredClone(task), acceptanceReviewer: async request => ({ taskId: request.taskId, taskDigest: request.taskDigest, codeDigest: request.codeDigest, summary: 'Updated allowed.', criteria: request.criteria.map(c => ({ id: c.id, status: 'satisfied', evidence: ['allowed contains after.'] })) }) });
  await controller.initialize(ctx); await controller.execute('implement', 'TASK-1', ctx);
  assert.equal(controller.run?.phase, 'IMPLEMENTING', notices.join('\n'));
  await repo.write('allowed', 'after'); await controller.execute('verify', '', ctx);
  assert.equal(controller.run?.phase, 'VERIFIED', notices.join('\n'));
  const commit = () => controller.execute('commit', 'TASK-1', ctx);
  const count = async () => Number((await repo.git(['rev-list', '--count', `${initialHead}..HEAD`])).trim());
  return { repo, task, save, path, controller, ctx, notices, confirmations, prompts, commit, count, edits: () => finalEdits, implementationReportFailure: () => { implementationReportFailure = true; }, failBefore: (value: boolean) => { failBefore = value; }, failAfter: (value: boolean) => { failAfter = value; }, extraTaskEdit: () => { extraTaskEdit = true; } };
}

test('frozen artifact policy survives restore and commit excludes matching cache even inside task scope', async t => {
  const h = await setup(t, true);
  const policy = structuredClone(h.controller.run!.artifactPolicy);
  assert.equal(h.task.acceptanceCriteriaState![0].checked, false);
  h.controller.config.untrackedArtifacts = [];
  h.controller.run = restoreState(serializeState(h.controller.run));
  assert.deepEqual(h.controller.run!.artifactPolicy, policy);
  await h.commit();
  assert.equal(h.controller.run!.phase, 'COMMITTED', h.notices.join('\n'));
  assert.equal(await h.count(), 2);
  assert.equal((await h.repo.git(['ls-files', 'cache'])).trim(), '');
  assert.deepEqual(h.task.acceptanceCriteriaState!.map(c => c.checked), [true, true]);
  assert.equal(h.task.lifecycle!.status, 'Closed');
  assert.match(h.confirmations[0], /Terminal status: Closed/);
  const forged = serializeState(h.controller.run);
  forged.run!.artifactPolicy = { untrackedArtifacts: [{ text: 'cache/[', kind: 'glob', pattern: 'cache/[' }] };
  assert.throws(() => restoreState(forged), /Invalid/);
});

test('metadata confirmation does not mention pre-existing task dirt', async t => {
  const h = await setup(t);
  await h.commit();
  assert.equal(h.controller.run!.phase, 'COMMITTED', h.notices.join('\n'));
  assert.doesNotMatch(h.confirmations[0], /already uncommitted at start/);
  assert.equal(await h.count(), 2);
});

test('failed implementation commit never writes completion metadata', async t => {
  const h = await setup(t);
  await h.repo.write('.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n'); await h.repo.chmod('.git/hooks/pre-commit', 0o755);
  await h.commit();
  assert.equal(await h.count(), 0); assert.equal(h.edits(), 0);
  assert.equal(h.task.lifecycle!.status, 'In Progress'); assert.equal(h.task.acceptanceCriteriaState![0].checked, false);
});

test('implementation post-commit failure records its SHA and defers task closure until retry', async t => {
  const h = await setup(t); h.implementationReportFailure(); await h.commit();
  assert.equal(await h.count(), 1); assert.equal(h.edits(), 0);
  assert.equal(h.controller.run!.phase, 'FINALIZING', h.notices.join('\n'));
  assert.equal(h.task.lifecycle!.status, 'In Progress');
  assert.match(h.controller.run!.finalization!.error!, /post-commit timed out/);
  // Simulate process loss after Git committed but before its SHA was persisted.
  const saved = serializeState(h.controller.run);
  delete saved.run!.implementationCommitSha; delete saved.run!.commitSha;
  saved.run!.phase = 'VERIFIED';
  h.controller.run = restoreState(saved);
  await h.commit();
  assert.equal(h.controller.run!.phase, 'COMMITTED', h.notices.join('\n'));
  assert.equal(await h.count(), 2);
});

test('a CLI failure after writing metadata restores and retries without another implementation commit', async t => {
  const h = await setup(t);
  h.failAfter(true); await h.commit();
  assert.equal(h.controller.run!.phase, 'FINALIZING'); assert.equal(await h.count(), 1);
  assert.match(h.controller.run!.finalization!.error!, /after failure/);
  h.controller.run = restoreState(serializeState(h.controller.run));
  const prompts = h.prompts.length;
  await h.controller.execute('implement-resume', '', h.ctx); await h.controller.execute('verify', '', h.ctx);
  assert.equal(h.prompts.length, prompts); assert.equal(h.controller.run!.phase, 'FINALIZING');
  h.failAfter(false); h.controller.config.terminalStatus = 'Something Else'; await h.commit();
  assert.equal(h.controller.run!.phase, 'COMMITTED', h.notices.join('\n')); assert.equal(await h.count(), 2);
  assert.equal(h.edits(), 1); assert.equal(h.task.lifecycle!.status, 'Closed');
});

test('unreported changes to the active task file are not a metadata exemption', async t => {
  const h = await setup(t); h.extraTaskEdit(); await h.commit();
  assert.equal(h.controller.run!.phase, 'FINALIZING'); assert.equal(await h.count(), 1);
  assert.match(h.notices.join('\n'), /outside the intended/);
  await h.commit(); assert.equal(await h.count(), 1);
});

test('changed HEAD and changed implementation content block finalization retry', async t => {
  const h = await setup(t); h.failBefore(true); await h.commit(); h.failBefore(false);
  await h.repo.write('allowed', 'post-commit mutation'); await h.commit();
  assert.equal(h.controller.run!.phase, 'FINALIZING'); assert.equal(await h.count(), 1);
  assert.match(h.notices.join('\n'), /Implementation content changed/);
  await h.repo.git(['add', '--', 'allowed']); await h.repo.git(['commit', '-qm', 'external commit']); await h.commit();
  assert.equal(await h.count(), 2); assert.equal(h.controller.run!.phase, 'FINALIZING');
  assert.match(h.notices.join('\n'), /HEAD changed/);
});

test('metadata pre-commit hooks cannot include other paths or alter the checked task', async t => {
  const h = await setup(t); h.failBefore(true); await h.commit(); h.failBefore(false);
  await h.repo.write('.git/hooks/pre-commit', '#!/bin/sh\nprintf bad > outside\ngit add outside\n'); await h.repo.chmod('.git/hooks/pre-commit', 0o755);
  await h.commit(); assert.equal(await h.count(), 1); assert.equal(h.controller.run!.phase, 'FINALIZING');
  assert.match(h.notices.join('\n'), /hook changed/);
});

test('retry recognizes a metadata commit that succeeded before a post-commit failure', async t => {
  const h = await setup(t); h.failBefore(true); await h.commit(); h.failBefore(false);
  await h.repo.write('.git/hooks/post-commit', '#!/bin/sh\nprintf changed > outside\n'); await h.repo.chmod('.git/hooks/post-commit', 0o755);
  await h.commit(); assert.equal(await h.count(), 2); assert.equal(h.controller.run!.phase, 'FINALIZING');
  h.controller.run = restoreState(serializeState(h.controller.run));
  await h.repo.write('outside', 'untouched'); await unlink(join(h.repo.root, '.git/hooks/post-commit'));
  await h.commit(); assert.equal(await h.count(), 2); assert.equal(h.controller.run!.phase, 'COMMITTED', h.notices.join('\n'));
});
