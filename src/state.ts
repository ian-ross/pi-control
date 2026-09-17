import { isAbsolute } from 'node:path';
import picomatch from 'picomatch';
import type { ControlTask } from './backlog.js';
import { validateBaseline, validateManagedFiles, type ManagedFiles, type Baseline } from './git.js';
import type { ScopeEntry } from './paths.js';
import type { VerificationResult } from './verification.js';

export type RunPhase = 'IMPLEMENTING' | 'VERIFYING' | 'REPAIRING' | 'FAILED' | 'VERIFIED' | 'WAIVED' | 'STALE' | 'COMMITTED' | 'ABORTED';
export interface ImplementationRun {
  task: ControlTask;
  baseline: Baseline;
  managedFiles?: ManagedFiles;
  claimPending?: boolean;
  originalScope: ScopeEntry[];
  additions: { entry: ScopeEntry; timestamp: string; source: 'user' }[];
  phase: RunPhase;
  repairs: number;
  maxRepairAttempts: number;
  pendingAutomatic: boolean;
  restored: boolean;
  createdAt: string;
  latest?: VerificationResult;
  waiver?: { reason: string; timestamp: string; failedCommands: string[]; digest: string };
  commitSha?: string;
}
export interface PersistedControlStateV1 { schemaVersion: 1; run: ImplementationRun | null }
export const effectiveScope = (run: ImplementationRun): ScopeEntry[] => [...run.originalScope, ...run.additions.map(a => a.entry)];
export const isActive = (run: ImplementationRun | null): run is ImplementationRun => !!run && !['COMMITTED', 'ABORTED'].includes(run.phase);
export function createRun(task: ControlTask, baseline: Baseline, scope: ScopeEntry[], maxRepairAttempts: number): ImplementationRun {
  return { task, baseline, originalScope: scope, additions: [], phase: 'IMPLEMENTING', repairs: 0, maxRepairAttempts, pendingAutomatic: true, restored: false, createdAt: new Date().toISOString() };
}
export function beginVerification(run: ImplementationRun): void {
  run.phase = 'VERIFYING';
  run.pendingAutomatic = false;
  delete run.waiver;
}
export function finishVerification(run: ImplementationRun, result: VerificationResult, automatic: boolean): 'repair' | 'stop' {
  run.latest = result;
  run.phase = result.passed ? 'VERIFIED' : 'FAILED';
  run.pendingAutomatic = false;
  if (!result.passed && automatic && run.repairs < run.maxRepairAttempts) {
    run.repairs++;
    run.phase = 'REPAIRING';
    run.pendingAutomatic = true;
    return 'repair';
  }
  return 'stop';
}
export function resumeRun(run: ImplementationRun): void {
  if (!isActive(run) || (run.phase !== 'FAILED' && !run.restored)) throw new Error('Only a FAILED or restored run can resume. Use /verify or /control-abort.');
  run.repairs = 0;
  run.restored = false;
  run.pendingAutomatic = true;
  run.phase = 'IMPLEMENTING';
  delete run.waiver;
}
export function staleRun(run: ImplementationRun): void {
  if (run.phase === 'VERIFIED' || run.phase === 'WAIVED') run.phase = 'STALE';
}
export function addScope(run: ImplementationRun, entry: ScopeEntry): void {
  run.additions.push({ entry, timestamp: new Date().toISOString(), source: 'user' });
  staleRun(run);
}
export function waiveRun(run: ImplementationRun, reason: string, digest: string): void {
  const latest = run.latest;
  if (!reason.trim()) throw new Error('A non-empty waiver reason is required.');
  if (!latest || latest.passed || latest.digest !== digest || run.phase !== 'FAILED') throw new Error('Run /verify first. A current failed result is required.');
  if (!latest.scopeOk || latest.scopeErrors.length || latest.commands.some(c => c.cancelled) || latest.errors.some(e => !e.startsWith('command '))) throw new Error('Only failed command checks can be waived, not repository or verification invariants.');
  const failedCommands = latest.commands.filter(c => c.code !== 0 || c.timedOut || c.cancelled).map(c => c.command);
  if (!failedCommands.length) throw new Error('No failed commands to waive.');
  run.waiver = { reason: reason.trim(), timestamp: new Date().toISOString(), failedCommands, digest };
  run.phase = 'WAIVED';
  run.pendingAutomatic = false;
}
export function serializeState(run: ImplementationRun | null): PersistedControlStateV1 {
  return JSON.parse(JSON.stringify({ schemaVersion: 1, run })) as PersistedControlStateV1;
}

function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
function strings(value: unknown): value is string[] { return Array.isArray(value) && value.every(v => typeof v === 'string'); }
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function count(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function digest(value: unknown): boolean { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function safeRelative(value: string): boolean {
  return !value.includes('\0') && !isAbsolute(value) && !/^[A-Za-z]:/.test(value) && !value.split(/[\\/]/).some(p => p === '..' || p === '.git');
}
function scope(value: unknown): boolean {
  if (!object(value) || !nonempty(value.text) || !safeRelative(value.text) || typeof value.pattern !== 'string' || !safeRelative(value.pattern) || !['file', 'directory', 'glob'].includes(String(value.kind))) return false;
  if (!value.pattern && value.kind !== 'directory') return false;
  if (value.kind === 'glob') {
    try { picomatch(value.pattern, { dot: true, strictBrackets: true }); } catch { return false; }
  }
  return true;
}
function verification(value: unknown): boolean {
  if (!object(value) || !digest(value.digest) || typeof value.scopeOk !== 'boolean' || typeof value.checksOk !== 'boolean' || typeof value.passed !== 'boolean' || !strings(value.scopeErrors) || !strings(value.errors) || !strings(value.changedPaths) || !nonempty(value.timestamp) || !Array.isArray(value.commands) || value.commands.length === 0) return false;
  if (!value.commands.every(c => object(c) && nonempty(c.command) && (c.code === null || Number.isInteger(c.code)) && typeof c.durationMs === 'number' && c.durationMs >= 0 && typeof c.stdout === 'string' && typeof c.stderr === 'string' && typeof c.timedOut === 'boolean' && typeof c.cancelled === 'boolean')) return false;
  const checksOk = value.commands.every(c => c.code === 0 && !c.timedOut && !c.cancelled) && value.errors.length === 0;
  return value.checksOk === checksOk && value.passed === (value.scopeOk && checksOk) && (!value.scopeOk || value.scopeErrors.length === 0);
}

/** Filesystem and baseline validation follows structural validation before any command can act. */
export function restoreState(data: unknown): ImplementationRun | null {
  const invalid = () => new Error('Invalid or unsupported pi-control state. Active enforcement is disabled. Start a new session and /implement after inspecting repository changes.');
  if (!object(data) || data.schemaVersion !== 1 || !('run' in data)) throw invalid();
  if (data.run === null) return null;
  const r = data.run;
  if (!object(r) || !object(r.task) || !object(r.baseline)) throw invalid();
  const t = r.task;
  if (!nonempty(t.id) || !nonempty(t.title) || (t.description !== undefined && typeof t.description !== 'string') || !strings(t.acceptanceCriteria) || !strings(t.allowedScope) || !t.allowedScope.length || !strings(t.verificationCommands) || !t.verificationCommands.length || t.verificationCommands.some(c => !c.trim())) throw invalid();
  if (t.implementationPlan !== undefined && (typeof t.implementationPlan !== 'string' || !t.implementationPlan.trim())) throw invalid();
  if (t.lifecycle !== undefined && (!object(t.lifecycle) || !nonempty(t.lifecycle.status) || !t.lifecycle.status.trim() || !strings(t.lifecycle.assignees) || t.lifecycle.assignees.some(a => !a.trim()) || !nonempty(t.lifecycle.path) || !safeRelative(t.lifecycle.path) || t.lifecycle.path.includes('\\') || !t.lifecycle.path.endsWith('.md') || t.lifecycle.path.split('/').some(p => !p || p === '.'))) throw invalid();
  if (r.managedFiles !== undefined) {
    try { validateManagedFiles(r.managedFiles); } catch { throw invalid(); }
    const paths = Object.keys(r.managedFiles);
    if (paths.length !== 1 || !object(t.lifecycle) || paths[0] !== t.lifecycle.path) throw invalid();
  }
  if (r.claimPending !== undefined && (typeof r.claimPending !== 'boolean' || r.managedFiles === undefined)) throw invalid();
  if (r.claimPending && (!['FAILED', 'ABORTED'].includes(String(r.phase)) || r.pendingAutomatic)) throw invalid();
  try { validateBaseline(r.baseline); } catch { throw invalid(); }
  if (!Array.isArray(r.originalScope) || !r.originalScope.length || !r.originalScope.every(scope) || !Array.isArray(r.additions) || !r.additions.every(a => object(a) && scope(a.entry) && a.source === 'user' && nonempty(a.timestamp))) throw invalid();
  if (!['IMPLEMENTING', 'VERIFYING', 'REPAIRING', 'FAILED', 'VERIFIED', 'WAIVED', 'STALE', 'COMMITTED', 'ABORTED'].includes(String(r.phase)) || !count(r.repairs) || !count(r.maxRepairAttempts) || (r.repairs as number) > (r.maxRepairAttempts as number) || typeof r.pendingAutomatic !== 'boolean' || typeof r.restored !== 'boolean' || !nonempty(r.createdAt)) throw invalid();
  if (r.pendingAutomatic && !['IMPLEMENTING', 'REPAIRING'].includes(String(r.phase))) throw invalid();
  const allowedScope = t.allowedScope;
  if (r.originalScope.some(entry => !allowedScope.includes(entry.text))) throw invalid();
  if (r.latest !== undefined && (!verification(r.latest) || !object(r.latest) || !Array.isArray(r.latest.commands) || JSON.stringify(r.latest.commands.map(c => c.command)) !== JSON.stringify(t.verificationCommands))) throw invalid();
  if (r.waiver !== undefined && (!object(r.waiver) || !nonempty(r.waiver.reason) || !nonempty(r.waiver.timestamp) || !strings(r.waiver.failedCommands) || !r.waiver.failedCommands.length || !digest(r.waiver.digest))) throw invalid();
  if (r.phase === 'VERIFIED' && (!object(r.latest) || r.latest.passed !== true)) throw invalid();
  if (r.phase === 'WAIVED' && (!object(r.waiver) || !object(r.latest) || r.latest.passed !== false || r.latest.scopeOk !== true || r.latest.digest !== r.waiver.digest)) throw invalid();
  if (r.phase === 'COMMITTED' && (typeof r.commitSha !== 'string' || !/^[a-f0-9]{40,64}$/.test(r.commitSha))) throw invalid();
  const run = structuredClone(r) as unknown as ImplementationRun;
  run.pendingAutomatic = false;
  run.restored = isActive(run);
  return run;
}
