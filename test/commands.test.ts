import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test, type TestContext } from 'node:test';
import type { ExtensionAPI, ExtensionCommandContext } from '@earendil-works/pi-coding-agent';
import { registerControl } from '../src/index.js';
import type { ControlTask } from '../src/backlog.js';
const exec = promisify(execFile);

async function setup(t: TestContext, check = 'true', trackTask = true) {
  const root = await mkdtemp(join(tmpdir(), 'control-command-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  async function git(...args: string[]) { return (await exec('git', args, { cwd: root })).stdout; }
  await git('init', '-q'); await git('config', 'user.email', 'test@example.test'); await git('config', 'user.name', 'Test');
  await writeFile(join(root, 'allowed'), 'base'); await writeFile(join(root, 'outside'), 'base');
  const task: ControlTask = { id: 'TASK-1', title: 'Fixture', description: 'Only this task', implementationPlan: '1. Update allowed without changing outside.\n2. Check the task behavior and edge cases.', acceptanceCriteria: ['Works'], allowedScope: ['allowed', 'new file', '-dash', 'delete me'], verificationCommands: [check], lifecycle: { path: 'backlog/tasks/task-1.md', status: 'To Do', assignees: [] } };
  await mkdir(join(root, 'backlog/tasks'), { recursive: true });
  const saveTask = () => writeFile(join(root, task.lifecycle!.path), JSON.stringify(task));
  await saveTask();
  await git('add', '--', 'allowed', 'outside', ...(trackTask ? [task.lifecycle!.path] : [])); await git('commit', '-qm', 'baseline');
  const messages: string[] = [], notices: string[] = [], confirmations: string[] = [];
  const entries: { type: string; customType: string; data: unknown }[] = [];
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const events = new Map<string, (event: unknown, ctx: ExtensionCommandContext) => Promise<unknown>>();
  let confirm = true;
  let autoCommit = 'false\n';
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
      if (cmd === 'backlog' && args.join(' ') === 'config get autoCommit') return { stdout: autoCommit, stderr: '', code: 0, killed: false };
      if (cmd === 'backlog' && args[0] === 'task') {
        if (args[1] === 'edit') {
          task.lifecycle!.status = args[args.indexOf('--status') + 1];
          task.lifecycle!.assignees = [args[args.indexOf('--assignee') + 1]];
          await saveTask();
          return { stdout: 'Updated task TASK-1', stderr: '', code: 0, killed: false };
        }
        return { stdout: JSON.stringify({ schemaVersion: 1, kind: 'task-view', task: {
          ...task, ...task.lifecycle, modifiedFiles: task.allowedScope,
          acceptanceCriteria: task.acceptanceCriteria.map((text, i) => ({ index: i + 1, text, checked: false })),
          definitionOfDone: task.verificationCommands.map((c, i) => ({ index: i + 1, text: `Verification: ${c}`, checked: false })),
        } }), stderr: '', code: 0, killed: false };
      }
      try { const r = await exec(cmd, args, { cwd: options.cwd ?? root }); return { ...r, code: 0, killed: false }; }
      catch (e) { const error = e as { stdout: string; stderr: string; code: number }; return { stdout: error.stdout ?? '', stderr: error.stderr ?? '', code: error.code ?? 1, killed: false }; }
    },
  } as unknown as ExtensionAPI;
  const controller = registerControl(pi, { taskLoader: async () => structuredClone(task) });
  await events.get('session_start')!({}, ctx);
  const command = async (name: string, args = '') => commands.get(name)!(args, ctx);
  const settled = async () => events.get('agent_settled')!({}, ctx);
  return { root, git, task, saveTask, ctx, pi, controller, command, settled, messages, notices, confirmations, entries, events, calls, setAutoCommit: (value: string) => { autoCommit = value; }, deny: () => { confirm = false; } };
}

test('implementation refuses enabled or unreadable Backlog auto-commit before starting a run', async t => {
  const h = await setup(t);
  const head = await h.git('rev-parse', 'HEAD');
  for (const value of ['true\n', '']) {
    h.setAutoCommit(value);
    await h.command('implement', 'TASK-1');
    assert.equal(h.controller.run, null);
    assert.equal(h.messages.length, 0);
    assert.equal(h.entries.length, 0);
    assert.match(h.notices.at(-1)!, /backlog config set autoCommit false/);
  }
  assert.equal(await h.git('rev-parse', 'HEAD'), head);
  assert.ok(h.calls.every(c => c.join(' ') === 'backlog config get autoCommit'));
  h.setAutoCommit('false\n');
  await h.command('implement', 'TASK-1');
  assert.equal(h.controller.run?.phase, 'IMPLEMENTING');
});

test('auto-commit is rechecked for verification, resume, and commit without blocking abort', async t => {
  const h = await setup(t, 'printf ran > allowed');
  await h.command('implement', 'TASK-1');
  h.setAutoCommit('true\n');
  await h.settled();
  assert.equal(await readFile(join(h.root, 'allowed'), 'utf8'), 'base');
  assert.equal(h.controller.run?.phase, 'FAILED');
  await h.command('implement-resume');
  await h.command('verify');
  assert.equal(h.messages.length, 1);
  assert.equal(await readFile(join(h.root, 'allowed'), 'utf8'), 'base');
  await h.command('control-abort');
  assert.equal(h.controller.run?.phase, 'ABORTED');

  const k = await setup(t);
  await k.command('implement', 'TASK-1');
  await writeFile(join(k.root, 'allowed'), 'work');
  await k.command('verify');
  const head = await k.git('rev-parse', 'HEAD');
  k.setAutoCommit('true\n');
  await k.command('commit', 'TASK-1');
  assert.equal(k.controller.run?.phase, 'STALE');
  assert.equal(await k.git('rev-parse', 'HEAD'), head);
  assert.equal(k.confirmations.length, 0);
  assert.ok(!k.calls.some(c => c[0] === 'git'));
});

test('enabling auto-commit during verification prevents both success and automatic repair', async t => {
  for (const check of ['true', 'false']) {
    const h = await setup(t, check);
    await h.command('implement', 'TASK-1');
    const execute = h.pi.exec.bind(h.pi);
    let reads = 0;
    h.pi.exec = async (command, args, options) => {
      if (command === 'backlog' && args.join(' ') === 'config get autoCommit' && ++reads === 2) h.setAutoCommit('true\n');
      return execute(command, args, options);
    };
    await h.settled();
    assert.equal(h.controller.run?.phase, 'FAILED');
    assert.equal(h.controller.run?.pendingAutomatic, false);
    assert.equal(h.messages.length, 1);
    assert.match(h.notices.at(-1)!, /backlog config set autoCommit false/);
  }
});

test('enabling auto-commit during confirmation prevents staging or commit', async t => {
  const h = await setup(t);
  await h.command('implement', 'TASK-1');
  await writeFile(join(h.root, 'allowed'), 'work');
  await h.command('verify');
  h.ctx.ui.confirm = async () => { h.setAutoCommit('true\n'); return true; };
  await h.command('commit', 'TASK-1');
  assert.equal(h.controller.run?.phase, 'STALE');
  assert.ok(!h.calls.some(c => c[0] === 'git'));
  assert.match(h.notices.at(-1)!, /backlog config set autoCommit false/);
});

test('implement claims and records the task before prompting without moving HEAD', async t => {
  const h = await setup(t);
  const head = (await h.git('rev-parse', 'HEAD')).trim();
  const send = h.pi.sendUserMessage.bind(h.pi);
  h.pi.sendUserMessage = (text, options) => {
    assert.equal(h.task.lifecycle!.status, 'In Progress');
    assert.deepEqual(h.task.lifecycle!.assignees, ['@pi-control']);
    assert.equal(h.controller.run?.claimPending, false);
    assert.ok(h.controller.run?.managedFiles?.[h.task.lifecycle!.path]);
    assert.ok(h.entries.length >= 2);
    send(text, options);
  };
  await h.command('implement', 'TASK-1');
  assert.equal(h.messages.length, 1, h.notices.join('\n'));
  assert.equal((await h.git('rev-parse', 'HEAD')).trim(), head);
  assert.equal(h.controller.run?.baseline.head, head);
  assert.ok(h.calls.some(c => c.join(' ') === 'backlog task edit TASK-1 --status In Progress --assignee @pi-control'));
});

test('claim identity and status names can be configured without taking over another owner', async t => {
  const h = await setup(t);
  await mkdir(join(h.root, '.pi'));
  await writeFile(join(h.root, '.pi/pi-control.json'), JSON.stringify({ claimAssignee: 'alice', readyStatus: 'Ready', inProgressStatus: 'Doing' }));
  h.task.lifecycle!.status = 'Ready';
  h.task.lifecycle!.assignees = ['@alice'];
  await h.command('implement', 'TASK-1');
  assert.equal(h.controller.run?.phase, 'IMPLEMENTING', h.notices.join('\n'));
  assert.deepEqual(h.task.lifecycle!.assignees, ['@alice']);
  assert.equal(h.task.lifecycle!.status, 'Doing');
});

test('restoration refuses forged metadata exemptions and malformed claim state', async t => {
  const h = await setup(t);
  await h.command('implement', 'TASK-1');
  const saved = structuredClone(h.entries.at(-1)!.data) as { run: { managedFiles: Record<string, unknown>; claimPending: unknown } };
  for (const change of [
    (data: typeof saved) => { data.run.managedFiles.outside = data.run.managedFiles[h.task.lifecycle!.path]; },
    (data: typeof saved) => { data.run.managedFiles[h.task.lifecycle!.path] = { kind: 'directory' }; },
    (data: typeof saved) => { data.run.claimPending = true; },
  ]) {
    const data = structuredClone(saved); change(data);
    h.pi.appendEntry('pi-control:state', data);
    await h.events.get('session_start')!({}, h.ctx);
    assert.equal(h.controller.run, null);
    assert.match(h.notices.at(-1)!, /recovery failed/);
  }
});

test('staged or in-scope dirty changes prevent claiming', async t => {
  for (const staged of [false, true]) {
    const h = await setup(t);
    await writeFile(join(h.root, 'allowed'), 'preexisting');
    if (staged) await h.git('add', '--', 'allowed');
    await h.command('implement', 'TASK-1');
    assert.equal(h.messages.length, 0);
    assert.equal(h.task.lifecycle!.status, 'To Do');
    assert.ok(!h.calls.some(c => c[0] === 'backlog' && c[2] === 'edit'));
  }
});

test('claiming refuses other owners and terminal tasks', async t => {
  for (const lifecycle of [{ status: 'To Do', assignees: ['@someone-else'] }, { status: 'Done', assignees: [] }]) {
    const h = await setup(t);
    Object.assign(h.task.lifecycle!, lifecycle);
    await h.command('implement', 'TASK-1');
    assert.equal(h.controller.run, null);
    assert.equal(h.messages.length, 0);
    assert.ok(!h.calls.some(c => c[0] === 'backlog' && c[2] === 'edit'));
  }
});

test('a partial claim failure stays paused and cannot be bypassed by resume', async t => {
  const h = await setup(t);
  const execute = h.pi.exec.bind(h.pi);
  h.pi.exec = async (command, args, options) => {
    const result = await execute(command, args, options);
    return command === 'backlog' && args[1] === 'edit' ? { ...result, code: 1, stderr: 'claim-write-failed' } : result;
  };
  await h.command('implement', 'TASK-1');
  assert.equal(h.controller.run?.phase, 'FAILED');
  assert.equal(h.controller.run?.claimPending, true);
  assert.match(h.notices.at(-1)!, /claim-write-failed/);
  await h.command('implement-resume');
  await h.command('verify');
  assert.equal(h.messages.length, 0);
  await h.command('control-abort');
  assert.equal(h.controller.run?.phase, 'ABORTED');
  assert.equal(h.task.lifecycle!.status, 'In Progress');
});

test('claim metadata is frozen even under broad product scope and cannot be waived', async t => {
  const h = await setup(t, 'false');
  h.task.allowedScope.push('backlog/');
  await h.command('implement', 'TASK-1');
  const path = h.task.lifecycle!.path;
  const blocked = await h.controller.gate({ toolName: 'write', input: { path } });
  assert.equal(blocked?.block, true);
  assert.match(blocked!.reason, /controller-managed/);
  await writeFile(join(h.root, path), 'external metadata change');
  await h.command('verify');
  assert.equal(h.controller.run?.latest?.scopeOk, false);
  assert.match(h.controller.run!.latest!.scopeErrors.join('\n'), /managed-file-changed/);
  await h.command('verify-waive', 'TASK-1 skip metadata');
  assert.notEqual(h.controller.run?.phase, 'WAIVED');
});

test('commit includes the exact claimed task file and preserves other dirty Backlog files', async t => {
  for (const tracked of [true, false]) {
    const h = await setup(t, 'true', tracked);
    h.task.description = 'Pre-existing task detail to preserve';
    await h.saveTask();
    await writeFile(join(h.root, 'backlog/other.md'), 'unrelated task');
    await h.command('implement', 'TASK-1');
    await writeFile(join(h.root, 'allowed'), 'work');
    await h.command('verify');
    assert.equal(h.controller.run?.phase, 'VERIFIED', h.notices.join('\n'));
    assert.deepEqual(h.controller.run?.latest?.changedPaths.sort(), ['allowed', h.task.lifecycle!.path].sort());
    await h.command('commit', 'TASK-1');
    assert.equal(h.controller.run?.phase, 'COMMITTED', h.notices.join('\n'));
    assert.match(await h.git('show', `HEAD:${h.task.lifecycle!.path}`), /Pre-existing task detail to preserve/);
    assert.match(await h.git('status', '--porcelain'), /backlog\/other.md/);
    assert.doesNotMatch(await h.git('diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'), /other.md/);
    assert.match(h.confirmations.at(-1)!, /already uncommitted/);
  }
});

test('resume and restoration retain the claim without reassigning the task', async t => {
  const h = await setup(t, 'false');
  await h.command('implement', 'TASK-1');
  const owned = structuredClone(h.controller.run!.managedFiles);
  await h.command('verify');
  await h.events.get('session_start')!({}, h.ctx);
  await h.command('implement-resume');
  assert.equal(h.calls.filter(c => c[0] === 'backlog' && c[2] === 'edit').length, 1);
  assert.deepEqual(h.controller.run?.managedFiles, owned);
  assert.equal(h.messages.length, 2, h.notices.join('\n'));
});

test('claiming cannot authorize concurrent code changes or changes to other files', async t => {
  for (const path of ['allowed', 'outside']) {
    const h = await setup(t);
    const execute = h.pi.exec.bind(h.pi);
    h.pi.exec = async (command, args, options) => {
      const result = await execute(command, args, options);
      if (command === 'backlog' && args[1] === 'edit') await writeFile(join(h.root, path), 'unexpected');
      return result;
    };
    await h.command('implement', 'TASK-1');
    assert.equal(h.messages.length, 0);
    assert.equal(h.controller.run?.claimPending, true);
    assert.match(h.notices.at(-1)!, /Repository changed unexpectedly/);
  }
});

test('unexpected HEAD changes during claim prevent implementation', async t => {
  const h = await setup(t);
  const execute = h.pi.exec.bind(h.pi);
  h.pi.exec = async (command, args, options) => {
    const result = await execute(command, args, options);
    if (command === 'backlog' && args[1] === 'edit') await h.git('commit', '--allow-empty', '-qm', 'unexpected');
    return result;
  };
  await h.command('implement', 'TASK-1');
  assert.equal(h.messages.length, 0);
  assert.equal(h.controller.run?.phase, 'FAILED');
  assert.match(h.notices.at(-1)!, /head-changed/);
});

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
  assert.ok(h.messages[0].includes(h.task.implementationPlan!));
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

test('implement refuses missing plans through the real task adapter before capturing a run', async t => {
  const h = await setup(t);
  const stdout = await readFile(new URL('./fixtures/backlog-1.52.0-task-view-missing-plan.json', import.meta.url), 'utf8');
  const execute = h.pi.exec.bind(h.pi);
  h.pi.exec = async (command, args, options) => command === 'backlog' && args[0] === 'task'
    ? { stdout, stderr: '', code: 0, killed: false }
    : execute(command, args, options);
  const controller = registerControl(h.pi);
  await h.events.get('session_start')!({}, h.ctx);
  await h.command('implement', 'BACK-1');
  assert.equal(controller.run, null);
  assert.equal(h.entries.length, 0);
  assert.equal(h.messages.length, 0);
  assert.match(h.notices.at(-1)!, /implementationPlan.*--plan/);
});

test('task plans survive restoration and appear in resume and repair prompts', async t => {
  const h = await setup(t, 'false');
  await h.command('implement', 'TASK-1');
  await h.settled();
  assert.equal(h.messages.length, 2);
  assert.ok(h.messages[1].includes(h.task.implementationPlan!));
  await h.events.get('session_start')!({}, h.ctx);
  assert.equal(h.controller.run?.task.implementationPlan, h.task.implementationPlan);
  assert.equal(h.controller.run?.pendingAutomatic, false);
  await h.command('implement-resume');
  assert.equal(h.messages.length, 3);
  assert.ok(h.messages[2].includes(h.task.implementationPlan!));
});

test('a changed task plan invalidates verification and blocks commits', async t => {
  const h = await setup(t);
  await h.command('implement', 'TASK-1');
  await writeFile(join(h.root, 'allowed'), 'work');
  await h.command('verify');
  h.task.implementationPlan = '1. A different implementation approach.';
  await h.command('commit', 'TASK-1');
  assert.equal(h.controller.run?.phase, 'STALE');
  assert.match(h.notices.at(-1)!, /task definition changed/);
  assert.ok(!h.calls.some(c => c[0] === 'git'));
});

test('restoration rejects malformed task plans but keeps legacy runs paused under enforcement', async t => {
  const h = await setup(t);
  await h.command('implement', 'TASK-1');
  const saved = structuredClone(h.entries.at(-1)!.data) as { run: { task: Record<string, unknown> } };
  for (const plan of [42, null, '', ' \n ']) {
    const data = structuredClone(saved);
    data.run.task.implementationPlan = plan;
    h.pi.appendEntry('pi-control:state', data);
    await h.events.get('session_start')!({}, h.ctx);
    assert.equal(h.controller.run, null);
    assert.match(h.notices.at(-1)!, /recovery failed/);
  }
  delete saved.run.task.implementationPlan;
  h.pi.appendEntry('pi-control:state', saved);
  await h.events.get('session_start')!({}, h.ctx);
  assert.equal(h.controller.run?.phase, 'IMPLEMENTING');
  assert.equal(h.controller.run?.pendingAutomatic, false);
  await h.command('implement-resume');
  assert.equal(h.messages.length, 1);
  assert.match(h.notices.at(-1)!, /task definition changed/);
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
