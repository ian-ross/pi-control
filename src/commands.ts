import { resolve } from 'node:path';
import { realpath } from 'node:fs/promises';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { loadTask, requireAutoCommitDisabled, assertClaimable, claimTask, ensureAcceptanceCriteriaState, type ControlTask } from './backlog.js';
import { prepareCommitGuard } from './commit-guard.js';
import { defaults, loadConfig, type PiControlConfig } from './config.js';
import { findRoot, captureBaseline, inspectRun, fingerprintPath, git, type Inspection } from './git.js';
import { compileScope, canonicalPath, matchesScope } from './paths.js';
import { stableDigest, verificationDigest } from './digest.js';
import { runVerification } from './verification.js';
import { createRun, effectiveScope, isActive, beginVerification, finishVerification, resumeRun, staleRun, addScope, waiveRun, type ImplementationRun } from './state.js';
import { persistStateMarker, restoreStateMarker } from './state-storage.js';
import { implementationPrompt, repairPrompt, verificationReport, recovery, acceptanceReviewPrompt, formatAcceptanceForConfirmation } from './prompts.js';
import { buildAcceptanceRequest, validateAcceptanceAssessment, acceptanceReport, acceptedReviewCurrent, taskDigest, type AcceptanceRequest } from './acceptance.js';
import { ensureMetadataCommit, inspectFinalization, readTaskFile, validateFinalTask, finalSummary, finalizationFailure, runBacklogEdit, satisfiedCriterionIndexes } from './finalization.js';
import { compileArtifactPolicy } from './artifacts.js';
import { implementationNotesComparableDigest } from './metadata.js';
import { nextPlanPath, planSlug } from './plans.js';

export const STATE_ENTRY = 'pi-control:state';
export type AcceptanceReviewer = (request: AcceptanceRequest, ctx: ExtensionContext) => Promise<unknown | null>;
export interface ControlDependencies { taskLoader?: typeof loadTask; verifier?: typeof runVerification; acceptanceReviewer?: AcceptanceReviewer }
const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const samePaths = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const nulPaths = (s: string) => s.split('\0').filter(Boolean);
const quote = (s: string) => JSON.stringify(s);
const ACCEPTANCE_READ_ONLY_TOOLS = new Set(['read', 'grep', 'find', 'ls', 'lsp_definition', 'lsp_references', 'lsp_hover', 'lsp_symbols', 'lsp_diagnostics', 'pi_control_acceptance_review']);

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
  private acceptanceReviewer?: AcceptanceReviewer;
  private savedActiveTools?: string[];
  private acceptanceToolAvailable: boolean;
  constructor(private pi: ExtensionAPI, private configDirectory: string, deps: ControlDependencies = {}) {
    this.taskLoader = deps.taskLoader ?? loadTask;
    this.verifier = deps.verifier ?? runVerification;
    this.acceptanceReviewer = deps.acceptanceReviewer;
    this.acceptanceToolAvailable = typeof (pi as unknown as { registerTool?: unknown }).registerTool === 'function';
  }
  notify(ctx: ExtensionContext, text: string, severity: 'info' | 'warning' | 'error' = 'info'): void {
    if (ctx.hasUI) ctx.ui.notify(text, severity);
    else process.stderr.write(`pi-control: ${text}\n`);
  }
  persist(): void { this.pi.appendEntry(STATE_ENTRY, persistStateMarker(this.run)); }
  async initialize(ctx: ExtensionContext): Promise<void> {
    this.restoreReviewTools();
    this.generation++;
    this.abortController?.abort();
    this.context = ctx;
    this.run = null;
    this.disabled = false;
    try {
      const entries = ctx.sessionManager.getBranch().filter(e => e.type === 'custom' && e.customType === STATE_ENTRY);
      const latest = entries.at(-1);
      if (latest?.type === 'custom') this.run = restoreStateMarker(latest.data);
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
  shutdown(): void { this.restoreReviewTools(); this.generation++; this.abortController?.abort(); this.context = undefined; }
  async execute(name: string, args: string, ctx: ExtensionContext): Promise<void> {
    this.context = ctx;
    if (this.busy) { this.notify(ctx, 'A control operation is already running.', 'warning'); return; }
    if (!ctx.isIdle()) { this.notify(ctx, 'Wait for the agent to settle before running control commands.', 'warning'); return; }
    this.busy = true;
    try {
      if (this.disabled) throw new Error('State recovery failed. Start a new session after inspecting repository changes.');
      if (name === 'plan' && isActive(this.run)) throw new Error('A controlled run is active. Finish it or use /control-abort before planning.');
      if (name !== 'control-abort' && isActive(this.run)) await this.recoverImplementationCommit(this.run);
      if (this.run?.phase === 'FINALIZING' && !['commit', 'control-status', 'control-abort'].includes(name)) throw new Error('Implementation is already committed. Retry /commit to finalize Backlog, or /control-abort.');
      switch (name) {
        case 'plan': await this.plan(args, ctx); break;
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
  private async plan(args: string, ctx: ExtensionContext): Promise<void> {
    const slug = planSlug(args);
    const available = () => this.pi.getCommands().some(command => command.source === 'extension' && command.name === 'plannotator-plan-mode');
    if (!available()) throw new Error('Load the Plannotator extension to use /plan. /plannotator-plan-mode is unavailable.');
    const generation = this.generation;
    const root = await findRoot(ctx.cwd);
    this.config = await loadConfig(root, this.configDirectory, ctx.isProjectTrusted());
    const path = await nextPlanPath(root, ctx.cwd, this.config.plansDirectory, slug);
    if (generation !== this.generation) throw new Error('Session changed while selecting the plan file. Run /plan again.');
    if (!ctx.isIdle() || !available()) throw new Error('Session is no longer ready for planning. Run /plan again when idle.');
    this.pi.sendUserMessage(`/plannotator-plan-mode ${path}`, { expandPromptTemplates: true });
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
  private restoreReviewTools(): void {
    if (!this.savedActiveTools) return;
    try { (this.pi as unknown as { setActiveTools?: (tools: string[]) => void }).setActiveTools?.(this.savedActiveTools); } catch { /* keep workflow state even if tool restoration fails */ }
    this.savedActiveTools = undefined;
  }
  private async assertAcceptanceCurrent(run: ImplementationRun, request: AcceptanceRequest, ctx: ExtensionContext, generation: number, requirePending: boolean): Promise<void> {
    if (generation !== this.generation || this.run !== run || !isActive(this.run)) throw new Error('Session changed during acceptance review. Run /verify again.');
    const current = await this.refresh(ctx);
    if (generation !== this.generation || this.run !== run || !isActive(this.run)) throw new Error('Session changed during acceptance review. Run /verify again.');
    if (requirePending && run.acceptanceRequest !== request) throw new Error('Acceptance review is stale. Run /verify again.');
    if (!current.scopeOk) throw new Error(`Cannot submit acceptance review while scope or baseline checks fail:\n${current.errors.join('\n')}`);
    if (!['VERIFIED', 'WAIVED'].includes(run.phase) || !run.latest) throw new Error('Acceptance review is stale. Run /verify again.');
    if (this.digest(run, current) !== request.codeDigest || taskDigest(run.task) !== request.taskDigest || run.task.id !== request.taskId) throw new Error('Acceptance review is stale. Run /verify again.');
  }
  private startToolAcceptanceReview(run: ImplementationRun, request: AcceptanceRequest): void {
    run.acceptanceRequest = request;
    delete run.acceptanceReview;
    this.persist();
    try {
      const api = this.pi as unknown as { getActiveTools?: () => string[]; getAllTools?: () => { name: string }[]; setActiveTools?: (tools: string[]) => void };
      const active = api.getActiveTools?.();
      const all = new Set(api.getAllTools?.().map(tool => tool.name) ?? []);
      if (active && api.setActiveTools) {
        this.savedActiveTools = active;
        const next = [...new Set([...active.filter(tool => ACCEPTANCE_READ_ONLY_TOOLS.has(tool)), 'pi_control_acceptance_review'].filter(tool => tool === 'pi_control_acceptance_review' || all.has(tool)))];
        api.setActiveTools(next);
      }
    } catch { /* prompting still works with the current tools */ }
    this.pi.sendUserMessage(acceptanceReviewPrompt(request), { deliverAs: 'followUp' });
  }
  private recordAcceptance(run: ImplementationRun, raw: unknown, request: AcceptanceRequest): void {
    const review = validateAcceptanceAssessment(raw, request);
    delete run.acceptanceRequest;
    run.acceptanceReview = review;
    this.restoreReviewTools();
    if (!review.accepted) {
      run.phase = 'FAILED';
      run.pendingAutomatic = false;
    }
    this.persist();
  }
  private async assessAcceptance(ctx: ExtensionContext): Promise<void> {
    const run = this.active();
    if (!run.latest || (!run.latest.passed && run.phase !== 'WAIVED')) return;
    const request = buildAcceptanceRequest(run);
    if (!request.criteria.length) {
      this.recordAcceptance(run, { taskId: request.taskId, taskDigest: request.taskDigest, codeDigest: request.codeDigest, summary: 'No acceptance criteria are defined.', criteria: [] }, request);
      return;
    }
    const generation = this.generation;
    if (this.acceptanceReviewer) {
      const raw = await this.acceptanceReviewer(request, ctx);
      await this.assertAcceptanceCurrent(run, request, ctx, generation, false);
      if (raw !== null) {
        this.recordAcceptance(run, raw, request);
        this.notify(ctx, acceptanceReport(run.acceptanceReview!), run.acceptanceReview!.accepted ? 'info' : 'warning');
        return;
      }
    }
    if (!this.acceptanceToolAvailable) throw new Error('Acceptance review tool protocol is unavailable. Acceptance criteria cannot be confirmed.');
    await this.assertAcceptanceCurrent(run, request, ctx, generation, false);
    this.startToolAcceptanceReview(run, request);
    this.notify(ctx, `${run.task.id}: verification passed. A read-only acceptance review is required before commit.`, 'info');
  }
  async receiveAcceptanceTool(raw: unknown, ctx: ExtensionContext): Promise<{ content: { type: 'text'; text: string }[]; details: unknown; terminate: true }> {
    this.context = ctx;
    const run = this.active();
    const request = run.acceptanceRequest;
    if (!request) throw new Error('No pi-control acceptance review is pending.');
    await this.assertAcceptanceCurrent(run, request, ctx, this.generation, true);
    this.recordAcceptance(run, raw, request);
    const text = acceptanceReport(run.acceptanceReview!);
    this.notify(ctx, text, run.acceptanceReview!.accepted ? 'info' : 'warning');
    return { content: [{ type: 'text', text }], details: run.acceptanceReview, terminate: true };
  }
  private async taskUnchanged(run: ImplementationRun): Promise<void> {
    const task = ensureAcceptanceCriteriaState(await this.taskLoader(run.baseline.root, run.task.id, this.pi.exec.bind(this.pi)));
    if (stableDigest(task) !== stableDigest(run.task)) throw new Error('Backlog task definition changed. Restore it or /control-abort and start /implement again.');
  }
  private async restoreNotesAllowance(run: ImplementationRun): Promise<boolean> {
    const path = run.task.lifecycle?.path;
    if (!run.restored || !path || run.managedImplementationNotes || !Object.hasOwn(run.managedFiles ?? {}, path)) return false;
    try {
      run.managedImplementationNotes = { [path]: { comparableDigest: implementationNotesComparableDigest(await readTaskFile(run)) } };
      return true;
    } catch {
      return false;
    }
  }
  private digest(run: ImplementationRun, current: Inspection): string {
    return verificationDigest(run.baseline, run.task.id, effectiveScope(run), run.task.verificationCommands, current, run.artifactPolicy);
  }
  private async refresh(ctx: ExtensionContext): Promise<Inspection> {
    const run = this.active();
    try {
      if (run.claimPending) throw new Error(`Claiming ${run.task.id} did not complete. Inspect the Backlog task, /control-abort, then retry /implement. No implementation was dispatched.`);
      if (await findRoot(ctx.cwd) !== run.baseline.root || await realpath(run.baseline.root) !== run.baseline.root) throw new Error('Repository root changed. Return to the captured repository or /control-abort.');
      await requireAutoCommitDisabled(run.baseline.root, this.pi.exec.bind(this.pi));
      await this.taskUnchanged(run);
      if (await this.restoreNotesAllowance(run)) this.persist();
      const current = await inspectRun(run.baseline, effectiveScope(run), run.managedFiles, run.artifactPolicy, run.managedImplementationNotes);
      if ((run.phase === 'VERIFIED' || run.phase === 'WAIVED' || run.acceptanceReview || run.acceptanceRequest) && (!current.scopeOk || !run.latest || this.digest(run, current) !== run.latest.digest)) { staleRun(run); this.restoreReviewTools(); this.persist(); }
      return current;
    } catch (e) { staleRun(run); this.restoreReviewTools(); this.persist(); throw e; }
  }
  private async implement(args: string, ctx: ExtensionContext): Promise<void> {
    if (isActive(this.run)) throw new Error(`${this.run.task.id} is already active. Use /control-abort before starting another run.`);
    const id = args.trim();
    if (!id || /\s/.test(id)) throw new Error('Usage: /implement <task-id>');
    const generation = this.generation;
    const root = await findRoot(ctx.cwd);
    this.config = await loadConfig(root, this.configDirectory, ctx.isProjectTrusted());
    await requireAutoCommitDisabled(root, this.pi.exec.bind(this.pi));
    const task: ControlTask = ensureAcceptanceCriteriaState(await this.taskLoader(root, id, this.pi.exec.bind(this.pi)));
    const lifecycle = assertClaimable(task, this.config);
    if (await canonicalPath(root, lifecycle.path) !== lifecycle.path) throw new Error('Backlog task path must name a regular file without symlinks.');
    const scope = await compileScope(root, task.allowedScope);
    const artifactPolicy = await compileArtifactPolicy(root, this.config.untrackedArtifacts);
    const baseline = await captureBaseline(root, scope, artifactPolicy);
    const before = baseline.dirty[lifecycle.path] ?? baseline.tracked[lifecycle.path];
    if (!before || before.kind !== 'file') throw new Error('Backlog task file must be a Git-visible regular file. Remove its ignore rule or track it before /implement.');
    if (generation !== this.generation) throw new Error('Session changed before the task could be claimed.');
    const run = createRun(task, baseline, scope, this.config.maxRepairAttempts);
    run.artifactPolicy = structuredClone(artifactPolicy);
    run.terminalStatus = this.config.terminalStatus;
    run.phase = 'FAILED';
    run.pendingAutomatic = false;
    run.claimPending = true;
    run.managedFiles = { [lifecycle.path]: before };
    this.run = run;
    this.persist();
    try {
      const claimed = await claimTask(root, task, this.config, this.pi.exec.bind(this.pi));
      if (generation !== this.generation) throw new Error('Session changed while claiming the task.');
      const fingerprint = await fingerprintPath(root, lifecycle.path);
      if (fingerprint.kind !== 'file' || await canonicalPath(root, lifecycle.path) !== lifecycle.path) throw new Error('Backlog task path changed while claiming it.');
      run.task = claimed;
      run.managedFiles = { [lifecycle.path]: fingerprint };
      try {
        run.managedImplementationNotes = { [lifecycle.path]: { comparableDigest: implementationNotesComparableDigest(await readTaskFile(run)) } };
      } catch {
        delete run.managedImplementationNotes;
      }
      const current = await inspectRun(baseline, scope, run.managedFiles, run.artifactPolicy, run.managedImplementationNotes);
      if (!current.scopeOk || current.changedPaths.some(p => p !== lifecycle.path) || current.stagedPaths.length) {
        throw new Error(`Repository changed unexpectedly while claiming the task:\n${current.errors.join('\n')}\nChanged paths: ${current.changedPaths.map(quote).join(', ')}`);
      }
      await requireAutoCommitDisabled(root, this.pi.exec.bind(this.pi));
      if (generation !== this.generation) throw new Error('Session changed while claiming the task.');
      run.claimPending = false;
      run.phase = 'IMPLEMENTING';
      run.pendingAutomatic = true;
      this.persist();
      this.notify(ctx, `${task.id}: ${task.title}\nClaimed by ${claimed.lifecycle!.assignees.join(', ')}; status: ${claimed.lifecycle!.status}\nController-managed task file: ${quote(lifecycle.path)}\nScope: ${scope.map(s => quote(s.text)).join(', ')}\nChecks:\n${task.verificationCommands.join('\n')}\nRepair limit: ${run.maxRepairAttempts}`);
      this.pi.sendUserMessage(implementationPrompt(run), { deliverAs: 'followUp' });
    } catch (e) {
      if (generation === this.generation && this.run === run) { run.phase = 'FAILED'; run.pendingAutomatic = false; run.claimPending = true; this.persist(); }
      throw new Error(`Could not start ${task.id}: ${message(e)} The Backlog task may have changed. No rollback was attempted. Inspect it, then /control-abort before retrying.`);
    }
  }
  private async resume(args: string, ctx: ExtensionContext): Promise<void> {
    this.restoreReviewTools();
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
    this.restoreReviewTools();
    const run = this.active();
    await this.refresh(ctx);
    this.config = await loadConfig(run.baseline.root, this.configDirectory, ctx.isProjectTrusted());
    const generation = this.generation;
    this.abortController = new AbortController();
    const signal = ctx.signal ? AbortSignal.any([ctx.signal, this.abortController.signal]) : this.abortController.signal;
    beginVerification(run);
    this.persist();
    try {
      const result = await this.verifier({ baseline: run.baseline, task: run.task, scope: effectiveScope(run), managedFiles: run.managedFiles, managedImplementationNotes: run.managedImplementationNotes, artifactPolicy: run.artifactPolicy, shell: this.config.shell, timeoutMs: this.config.verificationTimeoutMs, signal });
      if (generation !== this.generation) return;
      await requireAutoCommitDisabled(run.baseline.root, this.pi.exec.bind(this.pi));
      if (generation !== this.generation) return;
      const action = finishVerification(run, result, automatic && !signal.aborted);
      this.persist();
      this.notify(ctx, verificationReport(run.task.id, result), result.passed ? 'info' : 'warning');
      if (action === 'repair') this.pi.sendUserMessage(repairPrompt(run), { deliverAs: 'followUp' });
      else if (!result.passed) this.notify(ctx, recovery, 'warning');
      else await this.assessAcceptance(ctx);
    } catch (e) {
      if (generation === this.generation) { if (run.phase !== 'STALE') run.phase = 'FAILED'; run.pendingAutomatic = false; this.persist(); }
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
    await this.assessAcceptance(ctx);
  }
  private async showScope(ctx: ExtensionContext): Promise<void> {
    const run = this.active();
    await this.refresh(ctx);
    this.notify(ctx, `${run.task.id}\nBacklog scope:\n${run.originalScope.map(s => `${s.kind}: ${quote(s.text)}`).join('\n')}\nUser additions:\n${run.additions.map(a => `${a.entry.kind}: ${quote(a.entry.text)} ${a.timestamp}`).join('\n') || 'none'}\nFrozen disposable artifact patterns: ${(run.artifactPolicy?.untrackedArtifacts ?? []).map(e => quote(e.text)).join(', ') || 'none'}\nController-managed claim files, Implementation Notes edits allowed:\n${Object.keys(run.managedFiles ?? {}).map(quote).join('\n') || 'none'}`);
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
    this.restoreReviewTools();
    this.persist();
    this.notify(ctx, `Added ${entry.kind} ${quote(entry.text)}. Run /verify. Update the Backlog task later if this scope should be permanent.`);
  }
  private async status(ctx: ExtensionContext): Promise<void> {
    if (!this.run || this.run.phase === 'COMMITTED' || this.run.phase === 'ABORTED') { this.notify(ctx, this.run ? `${this.run.task.id}: ${this.run.phase}${this.run.commitSha ? ` ${this.run.commitSha}` : ''}${this.run.metadataCommitSha ? ` metadata ${this.run.metadataCommitSha}` : ''}` : 'No active run.'); return; }
    if (this.run.phase === 'FINALIZING') { this.notify(ctx, `${this.run.task.id}: FINALIZING. Implementation commit ${this.run.implementationCommitSha}. Retry /commit ${this.run.task.id} to finalize Backlog metadata.${this.run.finalization?.error ? `\nLast failure: ${this.run.finalization.error}` : ''}`); return; }
    const run = this.run;
    const current = await this.refresh(ctx);
    const fresh = !!run.latest && current.scopeOk && this.digest(run, current) === run.latest.digest;
    this.notify(ctx, `${run.task.id}: ${run.phase}${run.restored ? ' restored, paused' : ''}\nBacklog claim: ${run.task.lifecycle ? `${run.task.lifecycle.status}, ${run.task.lifecycle.assignees.join(', ')}` : 'legacy run'}\nBaseline: ${run.baseline.head}\nScope: ${effectiveScope(run).map(s => quote(s.text)).join(', ')}\nRepairs: ${run.repairs}/${run.maxRepairAttempts}\nLatest: ${run.latest ? `${run.latest.passed ? 'PASS' : 'FAIL'}, ${fresh ? 'current' : 'stale'}` : 'none'}\nAcceptance: ${run.acceptanceReview ? `${run.acceptanceReview.accepted ? 'SATISFIED' : 'BLOCKED'}, ${fresh && run.acceptanceReview.taskDigest === taskDigest(run.task) && run.acceptanceReview.codeDigest === run.latest?.digest ? 'current' : 'stale'}` : run.acceptanceRequest ? 'pending' : 'none'}\n${current.errors.join('\n')}`);
  }
  private async abort(ctx: ExtensionContext): Promise<void> {
    this.restoreReviewTools();
    const run = this.active();
    await this.confirmed(ctx, `Abort ${run.task.id}?`, 'End scope enforcement without reverting files. Repository changes remain in place.');
    run.phase = 'ABORTED'; run.pendingAutomatic = false;
    this.persist();
    this.notify(ctx, `${run.task.id}: ABORTED. Repository changes and any Backlog claim remain in place.`);
  }
  private commitEligible(run: ImplementationRun, current: Inspection): void {
    if (!['VERIFIED', 'WAIVED'].includes(run.phase) || !run.latest || this.digest(run, current) !== run.latest.digest) throw new Error('Commit requires current VERIFIED or WAIVED state. Run /verify.');
    if (!current.scopeOk) throw new Error(`Cannot commit:\n${current.errors.join('\n')}`);
    if (run.phase === 'WAIVED' && run.waiver?.digest !== run.latest.digest) throw new Error('Waiver is stale. Run /verify.');
    if (!acceptedReviewCurrent(run)) throw new Error('Commit requires a current satisfied acceptance review. Run /verify and complete the read-only review.');
    const outside = current.stagedPaths.filter(p => !current.changedPaths.includes(p));
    if (outside.length) throw new Error(`Staged paths outside task changes: ${outside.map(quote).join(', ')}`);
    const implementationPaths = current.changedPaths.filter(p => !Object.hasOwn(run.managedFiles ?? {}, p));
    if (!implementationPaths.length) throw new Error('No implementation changes to commit.');
  }
  private async gitMutation(run: ImplementationRun, args: string[]): Promise<void> {
    const result = await this.pi.exec('git', ['--literal-pathspecs', ...args], { cwd: run.baseline.root, timeout: this.config.verificationTimeoutMs });
    if (result.code !== 0 || result.killed) {
      const output = `${result.stdout}\n${result.stderr}`;
      throw new Error(`git ${args[0]} failed, exit ${result.code}${result.killed ? ', killed' : ''}:\n${output.length > 16384 ? output.slice(0, 16384) + '\n[output truncated]' : output}\nChanges and index remain in place. Fix the failure, then retry or /verify.`);
    }
  }
  private async recoverImplementationCommit(run: ImplementationRun): Promise<boolean> {
    const expected = run.finalization?.implementationExpectedDiff;
    if (this.run !== run || run.implementationCommitSha || !expected) return false;
    const sha = (await git(run.baseline.root, ['rev-parse', 'HEAD'])).trim();
    if (sha === run.baseline.head) return false;
    if (!acceptedReviewCurrent(run)) throw new Error('Pending implementation commit has no current acceptance review. Inspect Git history manually.');
    const parent = (await git(run.baseline.root, ['rev-parse', `${sha}^`])).trim();
    const diff = await git(run.baseline.root, ['diff', '--raw', '-z', '--no-renames', '--abbrev=64', run.baseline.head, sha, '--']);
    if (parent !== run.baseline.head || diff !== expected) throw new Error('HEAD changed and does not match the pending implementation commit. Inspect Git history manually.');
    if (this.run !== run) throw new Error('Session changed while reconciling the implementation commit.');
    run.implementationCommitSha = sha;
    run.commitSha = sha;
    run.phase = 'FINALIZING';
    run.pendingAutomatic = false;
    this.persist();
    return true;
  }
  private async commit(args: string, ctx: ExtensionContext): Promise<void> {
    const parsed = /^(\S+)(?:\s+([\s\S]+))?$/.exec(args.trim());
    if (!parsed) throw new Error('Usage: /commit <task-id> [message]');
    const run = this.match(parsed[1], true);
    const generation = this.generation;
    const live = () => { if (generation !== this.generation || this.run !== run) throw new Error('Session changed during commit. Restore the original session to reconcile its pending commit.'); };
    if (run.phase === 'FINALIZING') {
      await this.confirmed(ctx, `Retry Backlog finalization for ${run.task.id}?`, `Implementation commit: ${run.implementationCommitSha}\nOnly the active task file will be committed.\nTerminal status: ${run.finalization?.terminalStatus}\n${run.finalization?.summary}`);
      await this.finalizeBacklog(ctx);
      return;
    }
    const current = await this.refresh(ctx);
    this.commitEligible(run, current);
    const commitMessage = parsed[2]?.trim() || `${run.task.id}: ${run.task.title}`;
    if (commitMessage.includes('\0')) throw new Error('Commit message cannot contain NUL.');
    const paths = current.changedPaths;
    const implementationPaths = paths.filter(p => !Object.hasOwn(run.managedFiles ?? {}, p));
    const digest = this.digest(run, current);
    const summary = finalSummary(run);
    const metadataNotice = `\nBacklog metadata will be committed after the implementation commit in a separate task-file-only commit: ${quote(run.task.lifecycle!.path)}. Terminal status: ${run.terminalStatus ?? 'Done'}.${Object.hasOwn(run.baseline.dirty, run.task.lifecycle!.path) ? ' This task file was already uncommitted at start; the metadata commit includes its full current contents.' : ''}`;
    await this.confirmed(ctx, run.phase === 'WAIVED' ? `Commit ${run.task.id} WITH FAILED CHECKS?` : `Commit ${run.task.id}?`, `${run.phase}\n${run.waiver && run.phase === 'WAIVED' ? `Waiver reason: ${run.waiver.reason}\nFailed checks: ${run.waiver.failedCommands.join(', ')}\n` : ''}Acceptance review:\n${formatAcceptanceForConfirmation(run.acceptanceReview!)}\n\nImplementation paths:\n${implementationPaths.map(quote).join('\n')}${metadataNotice}\n\nFinal Backlog summary to write after commit:\n${summary}\n\nMessage: ${commitMessage}`);
    live();
    const afterConfirmation = await this.refresh(ctx);
    live();
    this.commitEligible(run, afterConfirmation);
    if (this.digest(run, afterConfirmation) !== digest || !samePaths(paths, afterConfirmation.changedPaths)) throw new Error('Repository changed during confirmation. Run /verify.');
    run.finalization = { summary, terminalStatus: run.terminalStatus ?? 'Done', checkedIndexes: satisfiedCriterionIndexes(run), originalTaskFile: await readTaskFile(run) };
    this.persist();
    live();
    await this.gitMutation(run, ['add', '--', ...implementationPaths]);
    live();
    const staged = await this.refresh(ctx);
    this.commitEligible(run, staged);
    if (!samePaths(staged.stagedPaths, implementationPaths) || this.digest(run, staged) !== digest) throw new Error('Staged paths or content changed. Commit refused; index remains in place.');
    const unstaged = nulPaths(await git(run.baseline.root, ['diff', '--name-only', '-z', '--', ...implementationPaths.map(p => `:(literal)${p}`)]));
    if (unstaged.length) throw new Error(`Task files changed after staging: ${unstaged.map(quote).join(', ')}. Run /verify.`);
    const guard = await prepareCommitGuard(run.baseline.root, [...Object.keys(run.baseline.tracked), ...Object.keys(run.baseline.dirty), ...paths]);
    try {
      const ready = await this.refresh(ctx);
      this.commitEligible(run, ready);
      const expectedDiff = await git(run.baseline.root, ['diff', '--cached', '--raw', '-z', '--no-renames', '--abbrev=64', run.baseline.head, '--']);
      live();
      run.finalization!.implementationExpectedDiff = expectedDiff;
      this.persist();
      await this.gitMutation(run, ['-c', `core.hooksPath=${guard.directory}`, 'commit', '-m', commitMessage]);
      live();
      const sha = (await git(run.baseline.root, ['rev-parse', 'HEAD'])).trim();
      const actualDiff = await git(run.baseline.root, ['diff', '--raw', '-z', '--no-renames', '--abbrev=64', run.baseline.head, sha, '--']);
      const parent = (await git(run.baseline.root, ['rev-parse', `${sha}^`])).trim();
      if (actualDiff !== expectedDiff || parent !== run.baseline.head) {
        run.phase = 'STALE'; run.pendingAutomatic = false; this.persist();
        throw new Error(`Commit ${sha} differs from the verified index. A hook or concurrent process changed it. Inspect Git history manually; no rollback was attempted.`);
      }
      run.implementationCommitSha = sha;
      run.commitSha = sha;
      run.phase = 'FINALIZING'; run.pendingAutomatic = false;
      this.persist();
    } catch (e) {
      live();
      if (await this.recoverImplementationCommit(run)) {
        run.finalization!.error = message(e).slice(0, 16384);
        this.persist();
        throw finalizationFailure(e);
      }
      try { await this.refresh(ctx); } catch { staleRun(run); this.persist(); }
      throw e;
    } finally { await guard.cleanup(); }
    await this.finalizeBacklog(ctx);
  }
  private async finalizeBacklog(ctx: ExtensionContext): Promise<void> {
    const run = this.active();
    const journal = run.finalization;
    const path = run.task.lifecycle?.path;
    if (run.phase !== 'FINALIZING' || !run.implementationCommitSha || !journal || !path) throw new Error('No complete Backlog finalization journal is available.');
    const generation = this.generation;
    const live = () => { if (generation !== this.generation || this.run !== run) throw new Error('Session changed during finalization.'); };
    const validate = async (head: string) => {
      live();
      if (await findRoot(ctx.cwd) !== run.baseline.root || await realpath(run.baseline.root) !== run.baseline.root) throw new Error('Repository root changed.');
      await requireAutoCommitDisabled(run.baseline.root, this.pi.exec.bind(this.pi));
      const task = await this.taskLoader(run.baseline.root, run.task.id, this.pi.exec.bind(this.pi));
      const complete = validateFinalTask(run, task);
      const inspection = await inspectFinalization(run, head);
      live();
      return { complete, inspection };
    };
    try {
      const head = (await git(run.baseline.root, ['rev-parse', 'HEAD'])).trim();
      if (head !== run.implementationCommitSha) {
        if (!journal.metadataExpectedDiff) throw new Error('HEAD changed after implementation commit.');
        await ensureMetadataCommit(run.baseline.root, run.implementationCommitSha, head, path, journal.metadataExpectedDiff);
        const checked = await validate(head);
        if (!checked.complete || checked.inspection.stagedPaths.length || (await git(run.baseline.root, ['diff', '--name-only', '-z', 'HEAD', '--', `:(literal)${path}`]))) throw new Error('Metadata changed after its commit. Restore the checked state before retrying.');
        run.metadataCommitSha = head;
      } else {
        let checked = await validate(head);
        if (!checked.complete) {
          const args = ['--final-summary', journal.summary, '--status', journal.terminalStatus];
          for (const index of journal.checkedIndexes) args.push('--check-ac', String(index));
          await runBacklogEdit(run.baseline.root, run.task.id, args, this.pi.exec.bind(this.pi));
          checked = await validate(head);
          if (!checked.complete) throw new Error('Backlog did not save every intended finalization change.');
        }
        await this.gitMutation(run, ['add', '--', path]);
        checked = await validate(head);
        if (!checked.complete || !samePaths(checked.inspection.stagedPaths, [path])) throw new Error('Metadata index is not limited to the active task file.');
        if (await git(run.baseline.root, ['diff', '--name-only', '-z', '--', `:(literal)${path}`])) throw new Error('Task file changed after metadata staging.');
        const guard = await prepareCommitGuard(run.baseline.root, [...Object.keys(run.baseline.tracked), ...Object.keys(run.baseline.dirty), ...checked.inspection.changedPaths]);
        try {
          await validate(head);
          journal.metadataExpectedDiff = await git(run.baseline.root, ['diff', '--cached', '--raw', '-z', '--no-renames', '--abbrev=64', head, '--']);
          delete journal.error;
          this.persist();
          await this.gitMutation(run, ['-c', `core.hooksPath=${guard.directory}`, 'commit', '-m', `${run.task.id}: finalize Backlog metadata`]);
          const sha = (await git(run.baseline.root, ['rev-parse', 'HEAD'])).trim();
          await ensureMetadataCommit(run.baseline.root, head, sha, path, journal.metadataExpectedDiff);
          const committed = await validate(sha);
          if (!committed.complete || committed.inspection.stagedPaths.length || (await git(run.baseline.root, ['diff', '--name-only', '-z', 'HEAD', '--', `:(literal)${path}`]))) throw new Error('Metadata changed after its commit. Inspect hook changes and retry.');
          run.metadataCommitSha = sha;
        } finally { await guard.cleanup(); }
      }
      live();
      run.phase = 'COMMITTED';
      run.pendingAutomatic = false;
      delete journal.error;
      this.persist();
      this.notify(ctx, `${run.task.id}: COMMITTED ${run.implementationCommitSha}. Backlog finalized ${run.metadataCommitSha}. No push.`);
    } catch (error) {
      if (generation === this.generation && this.run === run) { journal.error = message(error).slice(0, 16384); this.persist(); }
      throw finalizationFailure(error);
    }
  }
  async gate(event: { toolName: string; input: Record<string, unknown> }): Promise<{ block: true; reason: string } | undefined> {
    if (!isActive(this.run)) return;
    const run = this.run;
    if (run.acceptanceRequest) {
      if (ACCEPTANCE_READ_ONLY_TOOLS.has(event.toolName)) return;
      return { block: true, reason: `Rejected ${event.toolName}: read-only acceptance review is pending. Allowed tools: ${[...ACCEPTANCE_READ_ONLY_TOOLS].sort().join(', ')}.` };
    }
    if (!['edit', 'write'].includes(event.toolName)) return;
    const input = event.input.path;
    try {
      if (this.busy) throw new Error('A verification or control operation is in progress.');
      if (run.phase === 'FINALIZING' || run.acceptanceRequest) throw new Error('The controller is reviewing or finalizing; file edits are paused.');
      if (typeof input !== 'string') throw new Error('Missing file path.');
      const supplied = input.startsWith('@') ? input.slice(1) : input;
      const canonical = await canonicalPath(run.baseline.root, supplied);
      if (Object.hasOwn(run.managedFiles ?? {}, canonical)) {
        if (!Object.hasOwn(run.managedImplementationNotes ?? {}, canonical)) throw new Error('The Backlog task file is controller-managed and cannot be edited by the agent.');
        event.input.path = resolve(run.baseline.root, canonical);
        if (run.phase === 'VERIFIED' || run.phase === 'WAIVED') { staleRun(run); this.persist(); }
        return;
      }
      if (!matchesScope(canonical, effectiveScope(run))) throw new Error('Path is outside task scope.');
      // Built-in tools use the session cwd. Pin execution to the root we checked.
      event.input.path = resolve(run.baseline.root, canonical);
      if (run.phase === 'VERIFIED' || run.phase === 'WAIVED') { staleRun(run); this.persist(); }
      return;
    } catch (e) { return { block: true, reason: `Rejected ${quote(String(input))}: ${message(e)} Allowed scope: ${effectiveScope(run).map(s => quote(s.text)).join(', ')}` }; }
  }
}
