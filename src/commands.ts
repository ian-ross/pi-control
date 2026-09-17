import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loadTask, type ControlTask } from './backlog.js';
import { prepareCommitGuard } from './commit-guard.js';
import { defaults, loadConfig, type PiControlConfig } from './config.js';
import { findRoot, captureBaseline, inspectRun, git, type Inspection } from './git.js';
import { compileScope, canonicalPath, matchesScope } from './paths.js';
import { stableDigest, verificationDigest } from './digest.js';
import { runVerification } from './verification.js';
import { createRun, effectiveScope, isActive, beginVerification, finishVerification, resumeRun, staleRun, addScope, waiveRun, restoreState, serializeState, type ImplementationRun } from './state.js';
import { implementationPrompt, repairPrompt, verificationReport, recovery } from './prompts.js';

export const STATE_ENTRY = 'pi-control:state';
export interface ControlDependencies { taskLoader?: typeof loadTask; verifier?: typeof runVerification }
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const samePaths = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const nulPaths = (s: string) => s.split('\0').filter(Boolean);
const quote = (s: string) => JSON.stringify(s);

export class ControlController {
  run: ImplementationRun | null = null;
  context?: ExtensionContext;
  config: PiControlConfig = { ...defaults };
  busy = false;
  private disabled = false;
  private generation = 0;
  private abortController?: AbortController;
  private taskLoader: typeof loadTask;
  private verifier: typeof runVerification;
  constructor(private pi: ExtensionAPI, private configDirectory: string, deps: ControlDependencies = {}) {
    this.taskLoader = deps.taskLoader ?? loadTask;
    this.verifier = deps.verifier ?? runVerification;
  }
  notify(ctx: ExtensionContext, text: string, severity: 'info' | 'warning' | 'error' = 'info'): void {
    if (ctx.hasUI) ctx.ui.notify(text, severity);
    else process.stderr.write(`pi-control: ${text}\n`);
  }
  persist(): void { this.pi.appendEntry(STATE_ENTRY, serializeState(this.run)); }
  async initialize(ctx: ExtensionContext): Promise<void> {
    this.generation++;
    this.abortController?.abort();
    this.context = ctx;
    this.run = null;
    this.disabled = false;
    try {
      const entries = ctx.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === STATE_ENTRY);
      const latest = entries.at(-1);
      if (latest?.type === 'custom') this.run = restoreState(latest.data);
      if (isActive(this.run)) this.notify(ctx, `Restored ${this.run.task.id} ${this.run.phase}. Automatic work is paused. Use /control-status, /verify, or /implement-resume.`);
    } catch (e) {
      this.run = null;
      this.disabled = true;
      this.notify(ctx, `State recovery failed: ${message(e)} Active enforcement is disabled. Start a new session after inspecting repository changes.`, 'error');
    }
    try { this.config = await loadConfig(await findRoot(ctx.cwd), this.configDirectory, ctx.isProjectTrusted()); }
    catch (e) {
      // A non-repository session may still receive an approved plan event.
      this.config = { ...defaults, autoPlanHandoff: false };
      this.notify(ctx, `Configuration unavailable: ${message(e)}`, 'warning');
    }
  }
  shutdown(): void { this.generation++; this.abortController?.abort(); this.context = undefined; }
  async execute(name: string, args: string, ctx: ExtensionContext): Promise<void> {
    this.context = ctx;
    if (this.busy) { this.notify(ctx, 'A control operation is already running.', 'warning'); return; }
    if (!ctx.isIdle()) { this.notify(ctx, 'Wait for the agent to settle before running control commands.', 'warning'); return; }
    this.busy = true;
    try {
      if (this.disabled) throw new Error('State recovery failed. Start a new session after inspecting repository changes.');
      switch (name) {
        case 'implement': await this.implement(args, ctx); break;
        case 'implement-resume': await this.resume(args, ctx); break;
        case 'verify': this.match(args, false); await this.verify(ctx, false); break;
        case 'verify-waive': await this.waive(args, ctx); break;
        case 'scope-show': this.noArgs(args); await this.showScope(ctx); break;
        case 'scope-add': await this.expandScope(args, ctx); break;
        case 'control-status': this.noArgs(args); await this.status(ctx); break;
        case 'control-abort': this.noArgs(args); await this.abort(ctx); break;
        case 'commit': await this.commit(args, ctx); break;
      }
    } catch (e) { this.notify(ctx, message(e), 'error'); }
    finally { this.busy = false; }
  }
  private noArgs(args: string): void { if (args.trim()) throw new Error('This command takes no arguments.'); }
  private active(): ImplementationRun {
    if (!isActive(this.run)) throw new Error('No active run. Use /implement <task-id>.');
    return this.run;
  }
  private match(args: string, required: boolean): ImplementationRun {
    const run = this.active();
    const id = args.trim();
    if ((required && !id) || /\s/.test(id)) throw new Error('Supply exactly one task ID.');
    if (id && id.toLowerCase() !== run.task.id.toLowerCase()) throw new Error(`Active task is ${run.task.id}, not ${id}.`);
    return run;
  }
  private async confirmed(ctx: ExtensionContext, title: string, text: string): Promise<void> {
    if (!ctx.hasUI) throw new Error('Interactive confirmation is required. Run this command in Pi TUI or an RPC client that supports confirmation.');
    if (!await ctx.ui.confirm(title, text)) throw new Error('Cancelled.');
  }
  private async taskUnchanged(run: ImplementationRun): Promise<void> {
    const task = await this.taskLoader(run.baseline.root, run.task.id, this.pi.exec.bind(this.pi));
    if (stableDigest(task) !== stableDigest(run.task)) throw new Error('Backlog task definition changed. Restore it or /control-abort and start /implement again.');
  }
  private digest(run: ImplementationRun, current: Inspection): string {
    return verificationDigest(run.baseline, run.task.id, effectiveScope(run), run.task.verificationCommands, current);
  }
  private async refresh(ctx: ExtensionContext): Promise<Inspection> {
    const run = this.active();
    try {
      if (await findRoot(ctx.cwd) !== run.baseline.root || await realpath(run.baseline.root) !== run.baseline.root) throw new Error('Repository root changed. Return to the captured repository or /control-abort.');
      await this.taskUnchanged(run);
      const current = await inspectRun(run.baseline, effectiveScope(run));
      if ((run.phase === 'VERIFIED' || run.phase === 'WAIVED') && (!current.scopeOk || !run.latest || this.digest(run, current) !== run.latest.digest)) { staleRun(run); this.persist(); }
      return current;
    } catch (e) { staleRun(run); this.persist(); throw e; }
  }
  private async implement(args: string, ctx: ExtensionContext): Promise<void> {
    if (isActive(this.run)) throw new Error(`${this.run.task.id} is already active. Use /control-abort before starting another run.`);
    const id = args.trim();
    if (!id || /\s/.test(id)) throw new Error('Usage: /implement <task-id>');
    const root = await findRoot(ctx.cwd);
    this.config = await loadConfig(root, this.configDirectory, ctx.isProjectTrusted());
    const task: ControlTask = await this.taskLoader(root, id, this.pi.exec.bind(this.pi));
    const scope = await compileScope(root, task.allowedScope);
    const baseline = await captureBaseline(root, scope);
    this.run = createRun(task, baseline, scope, this.config.maxRepairAttempts);
    this.persist();
    this.notify(ctx, `${task.id}: ${task.title}\nScope: ${scope.map(s => quote(s.text)).join(', ')}\nChecks:\n${task.verificationCommands.join('\n')}\nRepair limit: ${this.run.maxRepairAttempts}`);
    this.pi.sendUserMessage(implementationPrompt(this.run), { deliverAs: 'followUp' });
  }
  private async resume(args: string, ctx: ExtensionContext): Promise<void> {
    const run = this.match(args, false);
    const current = await this.refresh(ctx);
    if (!current.scopeOk) throw new Error(`Cannot resume:\n${current.errors.join('\n')}`);
    this.config = await loadConfig(run.baseline.root, this.configDirectory, ctx.isProjectTrusted());
    run.maxRepairAttempts = this.config.maxRepairAttempts;
    resumeRun(run);
    this.persist();
    this.pi.sendUserMessage(implementationPrompt(run), { deliverAs: 'followUp' });
  }
  async settled(ctx: ExtensionContext): Promise<void> {
    this.context = ctx;
    if (this.busy || !ctx.isIdle() || !isActive(this.run) || !this.run.pendingAutomatic || this.run.restored || !['IMPLEMENTING', 'REPAIRING'].includes(this.run.phase)) return;
    this.busy = true;
    try { await this.verify(ctx, true); }
    catch (e) {
      if (isActive(this.run)) { this.run.phase = 'FAILED'; this.run.pendingAutomatic = false; this.persist(); }
      this.notify(ctx, `${message(e)}\n${recovery}`, 'error');
    } finally { this.busy = false; }
  }
  private async verify(ctx: ExtensionContext, automatic: boolean): Promise<void> {
    const run = this.active();
    await this.refresh(ctx);
    this.config = await loadConfig(run.baseline.root, this.configDirectory, ctx.isProjectTrusted());
    const generation = this.generation;
    this.abortController = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, this.abortController.signal]) : this.abortController.signal;
    beginVerification(run);
    this.persist();
    try {
      const result = await this.verifier({ baseline: run.baseline, task: run.task, scope: effectiveScope(run), shell: this.config.shell, timeoutMs: this.config.verificationTimeoutMs, signal });
      if (generation !== this.generation) return;
      const action = finishVerification(run, result, automatic && !signal.aborted);
      this.persist();
      this.notify(ctx, verificationReport(run.task.id, result), result.passed ? 'info' : 'warning');
      if (action === 'repair') this.pi.sendUserMessage(repairPrompt(run), { deliverAs: 'followUp' });
      else if (!result.passed) this.notify(ctx, recovery, 'warning');
    } catch (e) {
      if (generation === this.generation) { run.phase = 'FAILED'; run.pendingAutomatic = false; this.persist(); }
      throw e;
    } finally { this.abortController = undefined; }
  }
  private async waive(args: string, ctx: ExtensionContext): Promise<void> {
    const parsed = /^(\S+)\s+([\s\S]+)$/.exec(args.trim());
    if (!parsed || !parsed[2].trim()) throw new Error('Usage: /verify-waive <task-id> <reason>');
    const run = this.match(parsed[1], true);
    const current = await this.refresh(ctx);
    if (!current.scopeOk) throw new Error(`Scope and baseline failures cannot be waived:\n${current.errors.join('\n')}`);
    const digest = this.digest(run, current);
    const proposed = structuredClone(run);
    waiveRun(proposed, parsed[2], digest);
    await this.confirmed(ctx, `Waive failed checks for ${run.task.id}?`, `${parsed[2]}\nFailed commands:\n${proposed.waiver!.failedCommands.join('\n')}\nThis records WAIVED, not VERIFIED.`);
    const again = await this.refresh(ctx);
    if (!again.scopeOk || this.digest(run, again) !== digest) throw new Error('Repository changed during confirmation. Run /verify again.');
    waiveRun(run, parsed[2], digest);
    this.persist();
    this.notify(ctx, `${run.task.id}: WAIVED. ${parsed[2]}`);
  }
  private async showScope(ctx: ExtensionContext): Promise<void> {
    const run = this.active();
    await this.refresh(ctx);
    this.notify(ctx, `${run.task.id}\nBacklog scope:\n${run.originalScope.map(s => `${s.kind}: ${quote(s.text)}`).join('\n')}\nUser additions:\n${run.additions.map(a => `${a.entry.kind}: ${quote(a.entry.text)} ${a.timestamp}`).join('\n') || 'none'}`);
  }
  private async expandScope(args: string, ctx: ExtensionContext): Promise<void> {
    const run = this.active();
    if (!args || !args.trim()) throw new Error('Usage: /scope-add <scope-entry>. Use the entry text without shell quoting.');
    const current = await this.refresh(ctx);
    const [entry] = await compileScope(run.baseline.root, [args]);
    if (effectiveScope(run).some(s => s.kind === entry.kind && s.pattern === entry.pattern)) throw new Error('That scope entry is already allowed.');
    const knownPaths = nulPaths(await git(run.baseline.root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']));
    const matching = knownPaths.filter(p => matchesScope(p, [entry]));
    await this.confirmed(ctx, `Expand ${run.task.id} scope?`, `${entry.kind}: ${quote(entry.text)}\nCurrently matching paths:\n${matching.slice(0, 50).map(quote).join('\n') || 'none'}${matching.length > 50 ? '\n[additional matches omitted]' : ''}\nUpdate the Backlog task later if this should be permanent.`);
    const again = await this.refresh(ctx);
    if (current.contentDigest !== again.contentDigest) throw new Error('Repository changed during confirmation. Review and retry /scope-add.');
    const [recompiled] = await compileScope(run.baseline.root, [args]);
    if (stableDigest(entry) !== stableDigest(recompiled)) throw new Error('Scope target changed during confirmation. Retry /scope-add.');
    addScope(run, entry);
    this.persist();
    this.notify(ctx, `Added ${entry.kind} ${quote(entry.text)}. Run /verify. Update the Backlog task later if this scope should be permanent.`);
  }
  private async status(ctx: ExtensionContext): Promise<void> {
    if (!this.run || this.run.phase === 'COMMITTED' || this.run.phase === 'ABORTED') { this.notify(ctx, this.run ? `${this.run.task.id}: ${this.run.phase}${this.run.commitSha ? ` ${this.run.commitSha}` : ''}` : 'No active run.'); return; }
    const run = this.run;
    const current = await this.refresh(ctx);
    const fresh = !!run.latest && current.scopeOk && this.digest(run, current) === run.latest.digest;
    this.notify(ctx, `${run.task.id}: ${run.phase}${run.restored ? ' restored, paused' : ''}\nBaseline: ${run.baseline.head}\nScope: ${effectiveScope(run).map(s => quote(s.text)).join(', ')}\nRepairs: ${run.repairs}/${run.maxRepairAttempts}\nLatest: ${run.latest ? `${run.latest.passed ? 'PASS' : 'FAIL'}, ${fresh ? 'current' : 'stale'}` : 'none'}\n${current.errors.join('\n')}`);
  }
  private async abort(ctx: ExtensionContext): Promise<void> {
    const run = this.active();
    await this.confirmed(ctx, `Abort ${run.task.id}?`, 'End scope enforcement without reverting files. Repository changes remain in place.');
    run.phase = 'ABORTED'; run.pendingAutomatic = false;
    this.persist();
    this.notify(ctx, `${run.task.id}: ABORTED. Repository changes remain in place.`);
  }
  private commitEligible(run: ImplementationRun, current: Inspection): void {
    if (!['VERIFIED', 'WAIVED'].includes(run.phase) || !run.latest || this.digest(run, current) !== run.latest.digest) throw new Error('Commit requires current VERIFIED or WAIVED state. Run /verify.');
    if (!current.scopeOk) throw new Error(`Cannot commit:\n${current.errors.join('\n')}`);
    if (run.phase === 'WAIVED' && run.waiver?.digest !== run.latest.digest) throw new Error('Waiver is stale. Run /verify.');
    const outside = current.stagedPaths.filter(p => !current.changedPaths.includes(p));
    if (outside.length) throw new Error(`Staged paths outside task changes: ${outside.map(quote).join(', ')}`);
    if (!current.changedPaths.length) throw new Error('No task changes to commit.');
  }
  private async gitMutation(run: ImplementationRun, args: string[]): Promise<void> {
    const result = await this.pi.exec('git', ['--literal-pathspecs', ...args], { cwd: run.baseline.root, timeout: this.config.verificationTimeoutMs });
    if (result.code !== 0 || result.killed) {
      const output = `${result.stdout}\n${result.stderr}`;
      throw new Error(`git ${args[0]} failed, exit ${result.code}${result.killed ? ', killed' : ''}:\n${output.length > 16384 ? output.slice(0, 16384) + '\n[output truncated]' : output}\nChanges and index remain in place. Fix the failure, then retry or /verify.`);
    }
  }
  private async commit(args: string, ctx: ExtensionContext): Promise<void> {
    const parsed = /^(\S+)(?:\s+([\s\S]+))?$/.exec(args.trim());
    if (!parsed) throw new Error('Usage: /commit <task-id> [message]');
    const run = this.match(parsed[1], true);
    const current = await this.refresh(ctx);
    this.commitEligible(run, current);
    const commitMessage = parsed[2]?.trim() || `${run.task.id}: ${run.task.title}`;
    if (commitMessage.includes('\0')) throw new Error('Commit message cannot contain NUL.');
    const paths = current.changedPaths;
    const digest = this.digest(run, current);
    await this.confirmed(ctx, run.phase === 'WAIVED' ? `Commit ${run.task.id} WITH FAILED CHECKS?` : `Commit ${run.task.id}?`, `${run.phase}\n${run.waiver && run.phase === 'WAIVED' ? `Waiver reason: ${run.waiver.reason}\nFailed checks: ${run.waiver.failedCommands.join(', ')}\n` : ''}Paths:\n${paths.map(quote).join('\n')}\nMessage: ${commitMessage}`);
    const afterConfirmation = await this.refresh(ctx);
    this.commitEligible(run, afterConfirmation);
    if (this.digest(run, afterConfirmation) !== digest || !samePaths(paths, afterConfirmation.changedPaths)) throw new Error('Repository changed during confirmation. Run /verify.');
    await this.gitMutation(run, ['add', '--', ...paths]);
    const staged = await this.refresh(ctx);
    this.commitEligible(run, staged);
    if (!samePaths(staged.stagedPaths, paths) || this.digest(run, staged) !== digest) throw new Error('Staged paths or content changed. Commit refused; index remains in place.');
    const unstaged = nulPaths(await git(run.baseline.root, ['diff', '--name-only', '-z', '--', ...paths.map(p => `:(literal)${p}`)]));
    if (unstaged.length) throw new Error(`Task files changed after staging: ${unstaged.map(quote).join(', ')}. Run /verify.`);
    const guard = await prepareCommitGuard(run.baseline.root, [...Object.keys(run.baseline.tracked), ...Object.keys(run.baseline.dirty), ...paths]);
    try {
      const ready = await this.refresh(ctx);
      this.commitEligible(run, ready);
      const expectedDiff = await git(run.baseline.root, ['diff', '--cached', '--raw', '-z', '--no-renames', '--abbrev=64', run.baseline.head, '--']);
      await this.gitMutation(run, ['-c', `core.hooksPath=${guard.directory}`, 'commit', '-m', commitMessage]);
      const sha = (await git(run.baseline.root, ['rev-parse', 'HEAD'])).trim();
      const actualDiff = await git(run.baseline.root, ['diff', '--raw', '-z', '--no-renames', '--abbrev=64', run.baseline.head, sha, '--']);
      const parent = (await git(run.baseline.root, ['rev-parse', `${sha}^`])).trim();
      if (actualDiff !== expectedDiff || parent !== run.baseline.head) {
        run.phase = 'STALE'; run.pendingAutomatic = false; this.persist();
        throw new Error(`Commit ${sha} differs from the verified index. A hook or concurrent process changed it. Inspect Git history manually; no rollback was attempted.`);
      }
      run.commitSha = sha;
      run.phase = 'COMMITTED'; run.pendingAutomatic = false;
      this.persist();
      this.notify(ctx, `${run.task.id}: COMMITTED ${run.commitSha}. No push or Backlog status change.`);
    } catch (e) {
      try { await this.refresh(ctx); } catch { staleRun(run); this.persist(); }
      throw e;
    } finally { await guard.cleanup(); }
  }
  async gate(event: { toolName: string; input: Record<string, unknown> }): Promise<{ block: true; reason: string } | undefined> {
    if (!isActive(this.run) || !['edit', 'write'].includes(event.toolName)) return;
    const run = this.run;
    const input = event.input.path;
    try {
      if (this.busy) throw new Error('A verification or control operation is in progress.');
      if (typeof input !== 'string') throw new Error('Missing file path.');
      const supplied = input.startsWith('@') ? input.slice(1) : input;
      const canonical = await canonicalPath(run.baseline.root, supplied);
      if (!matchesScope(canonical, effectiveScope(run))) throw new Error('Path is outside task scope.');
      // Built-in tools use the session cwd. Pin execution to the root we checked.
      event.input.path = resolve(run.baseline.root, canonical);
      if (run.phase === 'VERIFIED' || run.phase === 'WAIVED') { staleRun(run); this.persist(); }
      return;
    } catch (e) { return { block: true, reason: `Rejected ${quote(String(input))}: ${message(e)} Allowed scope: ${effectiveScope(run).map(s => quote(s.text)).join(', ')}` }; }
  }
}
