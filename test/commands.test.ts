import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerControl } from '../src/index.js';
import type { ControlTask } from '../src/backlog.js';
const exec = promisify(execFile);

async function setup(t: TestContext, check = 'true') {
  const root = await mkdtemp(join(tmpdir(), 'control-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function git(...args: string[]) { return (await exec('git', args, { cwd: root })).stdout; }
  await git('init', '-q'); await git('config', 'user.email', 'test@example.test'); await git('config', 'user.name', 'Test');
  await writeFile(join(root, 'allowed'), 'base'); await writeFile(join(root, 'outside'), 'base');
  await git('add', '--', 'allowed', 'outside'); await git('commit', '-qm', 'baseline');
  const task: ControlTask = { id: 'TASK-1', title: 'Fixture', description: 'Only this task', acceptanceCriteria: ['Works'], allowedScope: ['allowed', 'new file', '-dash', 'delete me'], verificationCommands: [check] };
  const messages: string[] = [], notices: string[] = [], confirmations: string[] = [];
  const entries: { type: string; customType: string; data: unknown }[] = [];
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const events = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => Promise<unknown>>();
  let confirm = true;
  const ctx = { cwd: root, hasUI: true, isIdle: () => true, isProjectTrusted: () => true,
    ui: { notify: (s: string) => notices.push(s), confirm: async (title: string, s: string) => { confirmations.push(title + '\n' + s); return confirm; } },
    sessionManager: { getBranch: () => entries },
  } as unknown as ExtensionCommandContext;
  const calls: string[][] = [];
  const pi = {
    registerCommand: (name: string, def: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => commands.set(name, def.handler),
    on: (name: string, handler: (event: unknown, ctx: ExtensionCommandContext) => Promise<unknown>) => events.set(name, handler),
    appendEntry: (customType: string, data: unknown) => entries.push({ type: 'custom', customType, data: structuredClone(data) }),
    sendUserMessage: (text: string) => messages.push(text),
    getCommands: () => [],
    events: { on: () => () => {} },
    exec: async (cmd: string, args: string[], options: { cwd?: string }) => {
      calls.push([cmd, ...args]);
      try { const r = await exec(cmd, args, { cwd: options.cwd ?? root }); return { ...r, code: 0, killed: false }; }
      catch (e) { const error = e as { stdout: string; stderr: string; code: number }; return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1, killed: false }; }
    },
  } as unknown as ExtensionAPI;
  const controller = registerControl(pi, { taskLoader: async () => structuredClone(task) });
  await events.get('session_start')!({}, ctx);
  const command = async (name: string, args = '') => commands.get(name)!(args, ctx);
  const settled = async () => events.get('agent_settled')!({}, ctx);
  return { root, git, task, ctx, pi, controller, command, settled, messages, notices, confirmations, entries, events, calls, deny: () => { confirm = false; } };
}

test('implementation persists before one prompt, succeeds on settle, unrelated settles do nothing', async t => {
  const h = await setup(t);
  await h.command('implement', 'TASK-1');
  assert.equal(h.controller.run?.phase, 'IMPLEMENTING');
  assert.equal(h.messages.length, 1);
  assert.ok(h.entries.length);
  await writeFile(join(h.root, 'allowed'), 'change');
  await h.settled();
  assert.equal(h.controller.run?.phase, 'VERIFIED');
  await h.settled();
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0], /Only this task/);
});

test('failure permits exactly two repairs and manual verification never repairs', async t => {
  const h = await setup(t, 'false');
  await h.command('implement', 'TASK-1');
  await h.settled(); await h.settled(); await h.settled(); await h.settled();
  assert.equal(h.messages.length, 3);
  assert.equal(h.controller.run?.phase, 'FAILED');
  await h.command('verify');
  assert.equal(h.messages.length, 3);
  await h.command('implement-resume');
  assert.equal(h.controller.run?.repairs, 0);
  assert.equal(h.messages.length, 4);
});

test('tool gate blocks outside edits and resolves inside writes against root', async t => {
  const h = await setup(t);
  await h.command('implement', 'TASK-1');
  const gate = h.events.get('tool_call')!;
  assert.equal((await gate({ toolName: 'edit', input: { path: 'outside' } }, h.ctx) as { block: boolean }).block, true);
  const event = { toolName: 'write', input: { path: 'new file' } };
  assert.equal(await gate(event, h.ctx), undefined);
  assert.equal(event.input.path, join(h.root, 'new file'));
  assert.equal(await gate({ toolName: 'read', input: { path: 'outside' } }, h.ctx), undefined);
  await h.settled();
  await gate({ toolName: 'write', input: { path: 'allowed' } }, h.ctx);
  assert.equal(h.controller.run?.phase, 'STALE');
});

test('scope addition and abort require confirmation, never register LLM tools', async t => {
  const h = await setup(t);
  await h.command('implement', 'TASK-1'); await h.settled();
  h.ctx.hasUI = false;
  await h.command('scope-add', 'outside');
  assert.equal(h.controller.run?.additions.length, 0);
  await h.command('control-abort');
  assert.equal(h.controller.run?.phase, 'VERIFIED');
  h.ctx.hasUI = true;
  await h.command('scope-add', '../bad');
  assert.equal(h.controller.run?.additions.length, 0);
  await h.command('scope-add', 'outside');
  assert.equal(h.controller.run?.phase, 'STALE');
  assert.equal(h.controller.run?.additions[0].source, 'user');
  await h.command('control-abort');
  assert.equal(h.controller.run?.phase, 'ABORTED');
  assert.equal(await readFile(join(h.root, 'allowed'), 'utf8'), 'base');
});

test('command waiver requires failed current checks and becomes stale on content change', async t => {
  const h = await setup(t, 'false');
  await h.command('implement', 'TASK-1');
  await h.command('verify-waive', 'TASK-1 reason');
  assert.notEqual(h.controller.run?.phase, 'WAIVED');
  await h.command('verify');
  await h.command('verify-waive', 'TASK-1');
  assert.equal(h.controller.run?.phase, 'FAILED');
  await h.command('verify-waive', 'TASK-1 known failure');
  assert.equal(h.controller.run?.phase, 'WAIVED');
  await writeFile(join(h.root, 'allowed'), 'later');
  await h.command('control-status');
  assert.equal(h.controller.run?.phase, 'STALE');
});

test('scope failures cannot be waived; restored runs do not prompt and can resume', async t => {
  const h = await setup(t, 'false');
  await h.command('implement', 'TASK-1');
  await writeFile(join(h.root, 'outside'), 'bad');
  await h.command('verify'); await h.command('verify-waive', 'TASK-1 bypass');
  assert.equal(h.controller.run?.phase, 'FAILED');
  await writeFile(join(h.root, 'outside'), 'base');
  const n = h.messages.length;
  await h.events.get('session_start')!({}, h.ctx); await h.settled();
  assert.equal(h.messages.length, n);
  await h.command('implement-resume');
  assert.equal(h.messages.length, n + 1);
});

test('commit stages only actual changed paths, unusual names and messages stay literal', async t => {
  const h = await setup(t);
  await writeFile(join(h.root, 'delete me'), 'delete'); await h.git('add', '--', 'delete me'); await h.git('commit', '-qm', 'extra baseline');
  await writeFile(join(h.root, 'outside'), 'preexisting dirty');
  await h.command('implement', 'TASK-1');
  await writeFile(join(h.root, '-dash'), 'new'); await unlink(join(h.root, 'delete me'));
  await h.command('verify');
  assert.equal(h.controller.run?.phase, 'VERIFIED');
  await h.command('commit', 'OTHER nope');
  assert.equal(h.controller.run?.phase, 'VERIFIED');
  await h.command('commit', 'TASK-1 literal "quotes" $(touch unwanted)');
  assert.equal(h.controller.run?.phase, 'COMMITTED');
  assert.match(await h.git('log', '-1', '--format=%B'), /literal "quotes" \$\(touch unwanted\)/);
  assert.match(await h.git('status', '--porcelain'), /outside/);
  assert.ok(h.controller.run?.commitSha);
  assert.ok(h.calls.some(c => c[0] === 'git' && c.includes('commit')));
  assert.ok(!h.calls.some(c => c.includes('push')));
});

test('stale or staged outside content prevents commit; hook failure remains recoverable', async t => {
  const h = await setup(t);
  await h.command('implement', 'TASK-1'); await writeFile(join(h.root, 'allowed'), 'work'); await h.command('verify');
  await writeFile(join(h.root, 'outside'), 'bad'); await h.git('add', '--', 'outside');
  await h.command('commit', 'TASK-1');
  assert.notEqual(h.controller.run?.phase, 'COMMITTED');
  // A separate run tests hook failure without destructive recovery commands.
  const k = await setup(t);
  await k.command('implement', 'TASK-1'); await writeFile(join(k.root, 'allowed'), 'work'); await k.command('verify');
  await writeFile(join(k.root, '.git/hooks/pre-commit'), '#!/bin/sh\necho hook-rejected >&2\nexit 1\n', { mode: 0o755 });
  await k.command('commit', 'TASK-1');
  assert.notEqual(k.controller.run?.phase, 'COMMITTED');
  assert.match(k.notices.join('\n'), /hook-rejected/);
  await unlink(join(k.root, '.git/hooks/pre-commit'));
  await k.command('commit', 'TASK-1');
  assert.equal(k.controller.run?.phase, 'COMMITTED');
});

test('waived commit confirmation includes reason and fails closed without UI', async t => {
  const h = await setup(t, 'false');
  await h.command('implement', 'TASK-1'); await writeFile(join(h.root, 'allowed'), 'work'); await h.command('verify');
  await h.command('verify-waive', 'TASK-1 upstream is down');
  h.ctx.hasUI = false; await h.command('commit', 'TASK-1');
  assert.equal(h.controller.run?.phase, 'WAIVED');
  h.ctx.hasUI = true; await h.command('commit', 'TASK-1');
  assert.equal(h.controller.run?.phase, 'COMMITTED');
  assert.match(h.confirmations.at(-1)!, /WAIVED/);
  assert.match(h.confirmations.at(-1)!, /upstream is down/);
});

test('confirmation-time changes invalidate commit and scope expansion', async t => {
  const h = await setup(t);
  await h.command('implement', 'TASK-1'); await writeFile(join(h.root, 'allowed'), 'work'); await h.command('verify');
  h.ctx.ui.confirm = async () => { await writeFile(join(h.root, 'allowed'), 'raced'); return true; };
  await h.command('commit', 'TASK-1');
  assert.equal(h.controller.run?.phase, 'STALE');
  assert.equal(h.calls.some(c => c.includes('add')), false);
  h.ctx.ui.confirm = async () => { await writeFile(join(h.root, 'allowed'), 'raced again'); return true; };
  await h.command('scope-add', 'outside');
  assert.equal(h.controller.run?.additions.length, 0);
});

test('changed HEAD or task definition blocks resume without recapturing baseline', async t => {
  const h = await setup(t, 'false');
  await h.command('implement', 'TASK-1'); await h.command('verify');
  const baseline = structuredClone(h.controller.run!.baseline);
  h.task.verificationCommands = ['true'];
  await h.command('implement-resume');
  assert.equal(h.messages.length, 1);
  h.task.verificationCommands = ['false'];
  await h.git('commit', '--allow-empty', '-qm', 'external');
  await h.command('implement-resume');
  assert.equal(h.messages.length, 1);
  assert.deepEqual(structuredClone(h.controller.run!.baseline), baseline);
});

test('restores every workflow phase without scheduling agent work', async t => {
  const h = await setup(t);
  await h.command('implement', 'TASK-1'); await h.command('verify');
  const pass = structuredClone(h.controller.run!);
  h.task.verificationCommands = ['false'];
  const failure = structuredClone(pass);
  failure.task = structuredClone(h.task);
  failure.latest!.passed = false; failure.latest!.checksOk = false;
  failure.latest!.commands[0].command = 'false'; failure.latest!.commands[0].code = 1;
  for (const phase of ['IMPLEMENTING', 'VERIFYING', 'REPAIRING', 'FAILED', 'VERIFIED', 'WAIVED', 'STALE', 'COMMITTED', 'ABORTED'] as const) {
    const run = structuredClone(['REPAIRING', 'FAILED', 'WAIVED'].includes(phase) ? failure : pass);
    run.phase = phase; run.pendingAutomatic = phase === 'IMPLEMENTING' || phase === 'REPAIRING';
    if (phase === 'REPAIRING') run.repairs = 1;
    if (phase === 'WAIVED') run.waiver = { reason: 'accepted', timestamp: new Date().toISOString(), digest: run.latest!.digest, failedCommands: ['false'] };
    if (phase === 'COMMITTED') run.commitSha = 'c'.repeat(40);
    h.pi.appendEntry('pi-control:state', { schemaVersion: 1, run });
    const count = h.messages.length;
    await h.events.get('session_start')!({}, h.ctx);
    assert.equal(h.controller.run?.phase, phase, h.notices.join('\n'));
    await h.settled();
    assert.equal(h.messages.length, count);
    assert.equal(h.controller.run?.pendingAutomatic, false);
  }
});

test('invalid restored state disables enforcement with a recovery diagnostic', async t => {
  const h = await setup(t);
  h.pi.appendEntry('pi-control:state', { schemaVersion: 99, run: {} });
  await h.events.get('session_start')!({}, h.ctx);
  assert.equal(h.controller.run, null);
  assert.match(h.notices.join('\n'), /enforcement is disabled/);
  await h.command('implement', 'TASK-1');
  assert.equal(h.messages.length, 0);
});

test('mismatched IDs and denied confirmations do not change workflow state', async t => {
  const h = await setup(t, 'false');
  await h.command('implement', 'TASK-1 extra'); assert.equal(h.messages.length, 0);
  await h.command('implement', 'TASK-1');
  await h.command('implement', 'TASK-2'); assert.equal(h.messages.length, 1);
  await h.command('verify', 'TASK-2'); assert.equal(h.controller.run?.phase, 'IMPLEMENTING');
  await h.command('implement-resume', 'TASK-2'); assert.equal(h.messages.length, 1);
  await h.command('verify'); h.deny();
  await h.command('verify-waive', 'TASK-1 reason'); assert.equal(h.controller.run?.phase, 'FAILED');
  await h.command('scope-add', 'outside'); assert.equal(h.controller.run?.additions.length, 0);
  await h.command('control-abort'); assert.equal(h.controller.run?.phase, 'FAILED');
});

test('successful hooks cannot commit changed verified content or outside paths', async t => {
  for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg']) {
    const h = await setup(t);
    await h.command('implement', 'TASK-1'); await writeFile(join(h.root, 'allowed'), 'work'); await h.command('verify');
    const before = await h.git('rev-parse', 'HEAD');
    await writeFile(join(h.root, `.git/hooks/${hook}`), '#!/bin/sh\nprintf modified > allowed\ngit add -- allowed\nexit 0\n', { mode: 0o755 });
    await h.command('commit', 'TASK-1');
    assert.equal(await h.git('rev-parse', 'HEAD'), before, hook);
    assert.equal(h.controller.run?.phase, 'STALE', h.notices.join('\n'));
    assert.match(h.notices.join('\n'), /hook changed/);
  }
  const h = await setup(t);
  await h.command('implement', 'TASK-1'); await writeFile(join(h.root, 'allowed'), 'work'); await h.command('verify');
  const before = await h.git('rev-parse', 'HEAD');
  await writeFile(join(h.root, '.git/hooks/pre-commit'), '#!/bin/sh\nprintf outside > outside\ngit add -- outside\n', { mode: 0o755 });
  await h.command('commit', 'TASK-1');
  assert.equal(await h.git('rev-parse', 'HEAD'), before);
  assert.equal(h.controller.run?.phase, 'STALE');
});

test('failing hooks that mutate worktree invalidate verification immediately', async t => {
  const h = await setup(t);
  await h.command('implement', 'TASK-1'); await writeFile(join(h.root, 'allowed'), 'work'); await h.command('verify');
  await writeFile(join(h.root, '.git/hooks/pre-commit'), '#!/bin/sh\nprintf changed > allowed\nexit 1\n', { mode: 0o755 });
  await h.command('commit', 'TASK-1');
  assert.equal(h.controller.run?.phase, 'STALE');
});
