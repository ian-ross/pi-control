import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { git, fingerprintPath, inspectRun, type Inspection } from './git.js';
import { stableDigest, verificationDigest } from './digest.js';
import { criteriaForTask } from './acceptance.js';
import { canonicalPath } from './paths.js';
import { assertTaskMetadataEdit } from './metadata.js';
import { effectiveScope, type ImplementationRun } from './state.js';
import { ensureAcceptanceCriteriaState, type ControlTask } from './backlog.js';

export interface FinalizationState {
  summary: string;
  terminalStatus: string;
  checkedIndexes: number[];
  originalTaskFile: string;
  implementationExpectedDiff?: string;
  metadataExpectedDiff?: string;
  error?: string;
}

type Exec = ExtensionAPI['exec'];

export function satisfiedCriterionIndexes(run: ImplementationRun): number[] {
  const satisfied = new Set(run.acceptanceReview?.criteria.filter(c => c.status === 'satisfied').map(c => c.id));
  return criteriaForTask(run.task).filter(c => satisfied.has(c.id) && !c.checked).map(c => c.index);
}

export function finalSummary(run: ImplementationRun): string {
  const lines = [`${run.task.id}: ${run.task.title}`, '', run.acceptanceReview?.summary ?? 'No acceptance review recorded.'];
  for (const criterion of run.acceptanceReview?.criteria ?? []) {
    lines.push(`- Criterion ${criterion.id}: ${criterion.status}. ${criterion.evidence.join('; ')}`);
  }
  if (run.waiver) lines.push('', `Waived verification failures: ${run.waiver.reason}`, ...run.waiver.failedCommands.map(command => `- ${command}`));
  return lines.join('\n');
}

export async function readTaskFile(run: ImplementationRun): Promise<string> {
  const path = run.task.lifecycle?.path;
  if (!path || await canonicalPath(run.baseline.root, path) !== path) throw new Error('Backlog task path must remain a regular file without symlinks.');
  const fp = await fingerprintPath(run.baseline.root, path);
  if (fp.kind !== 'file' || fp.size > 1024 * 1024) throw new Error('Backlog task file must be regular and no larger than 1 MiB.');
  return readFile(join(run.baseline.root, path), 'utf8');
}

export function expectedFinalTask(run: ImplementationRun): ControlTask {
  const journal = run.finalization;
  if (!journal || !run.task.lifecycle) throw new Error('Missing finalization journal.');
  return {
    ...run.task,
    lifecycle: { ...run.task.lifecycle, status: journal.terminalStatus },
    finalSummary: journal.summary,
    acceptanceCriteriaState: criteriaForTask(run.task).map(c => ({ ...c, checked: c.checked || journal.checkedIndexes.includes(c.index) })),
  };
}

/** CLI failure can leave any subset of the intended edits. Nothing else is accepted. */
export function validateFinalTask(run: ImplementationRun, loaded: ControlTask): boolean {
  const task = ensureAcceptanceCriteriaState(loaded);
  const expected = expectedFinalTask(run);
  const original = run.task;
  const statusKey = (value: string) => value.trim().toLowerCase();
  const allowedStatus = [original.lifecycle!.status, expected.lifecycle!.status].map(statusKey);
  if (!task.lifecycle || !allowedStatus.includes(statusKey(task.lifecycle.status))) throw new Error('Unexpected Backlog status during finalization.');
  if (task.finalSummary !== original.finalSummary && task.finalSummary !== expected.finalSummary) throw new Error('Unexpected Backlog final summary during finalization.');
  const criteria = criteriaForTask(task);
  const originalCriteria = criteriaForTask(original);
  if (criteria.length !== originalCriteria.length) throw new Error('Backlog acceptance criteria changed during finalization.');
  for (let i = 0; i < criteria.length; i++) {
    const before = originalCriteria[i], after = criteria[i], intended = expected.acceptanceCriteriaState![i];
    if (stableDigest({ ...after, checked: before.checked }) !== stableDigest(before) || (after.checked !== before.checked && after.checked !== intended.checked)) {
      throw new Error('Unexpected Backlog criterion edit during finalization.');
    }
  }
  const normalized = { ...task, lifecycle: { ...task.lifecycle, status: original.lifecycle!.status }, acceptanceCriteriaState: originalCriteria };
  if (original.finalSummary === undefined) delete normalized.finalSummary;
  else normalized.finalSummary = original.finalSummary;
  if (stableDigest(normalized) !== stableDigest(original)) throw new Error('Backlog task definition changed during finalization.');
  return statusKey(task.lifecycle.status) === statusKey(expected.lifecycle!.status)
    && stableDigest({ ...task, lifecycle: { ...task.lifecycle, status: expected.lifecycle!.status } }) === stableDigest(expected);
}

export async function inspectFinalization(run: ImplementationRun, head: string): Promise<Inspection> {
  const journal = run.finalization;
  const path = run.task.lifecycle?.path;
  if (!journal || !path || !run.latest) throw new Error('Missing finalization state.');
  const text = await readTaskFile(run);
  assertTaskMetadataEdit(journal.originalTaskFile, text, journal.checkedIndexes);
  const fingerprint = await fingerprintPath(run.baseline.root, path);
  const originalFingerprint = run.managedFiles?.[path];
  if (fingerprint.kind !== 'file' || originalFingerprint?.kind !== 'file' || fingerprint.mode !== originalFingerprint.mode || fingerprint.executable !== originalFingerprint.executable) throw new Error('Backlog task file mode changed during finalization.');
  const current = await inspectRun({ ...run.baseline, head }, effectiveScope(run), { [path]: fingerprint }, run.artifactPolicy);
  if (!current.scopeOk) throw new Error(`Finalization repository checks failed:\n${current.errors.join('\n')}`);
  const outsideStaged = current.stagedPaths.filter(p => p !== path);
  if (outsideStaged.length) throw new Error(`Unexpected staged paths during finalization: ${outsideStaged.join(', ')}`);
  // Compare implementation content against the checked state, substituting only the
  // exact pre-finalization task fingerprint. This also detects hidden tracked edits.
  const normalized = { ...current, changedPaths: current.changedPaths.filter(p => p !== path), fingerprints: { ...current.fingerprints } };
  delete normalized.fingerprints[path];
  if (run.latest.changedPaths.includes(path)) {
    normalized.changedPaths.push(path);
    normalized.fingerprints[path] = run.managedFiles![path];
  }
  const digest = verificationDigest(run.baseline, run.task.id, effectiveScope(run), run.task.verificationCommands, normalized, run.artifactPolicy);
  if (digest !== run.latest.digest) throw new Error('Implementation content changed after its commit. Finalization refused.');
  return current;
}

export async function runBacklogEdit(root: string, taskId: string, args: string[], exec: Exec): Promise<void> {
  const result = await exec('backlog', ['task', 'edit', taskId, ...args], { cwd: root, timeout: 30_000 });
  if (result.killed || result.code !== 0) {
    const detail = `${result.stderr}\n${result.stdout}`.slice(0, 16384).trim();
    throw new Error(`backlog task edit ${taskId} failed${result.killed ? ' or timed out' : ''}: ${detail}`);
  }
}

export async function ensureMetadataCommit(root: string, parent: string, sha: string, path: string, expectedDiff: string): Promise<void> {
  if ((await git(root, ['rev-parse', `${sha}^`])).trim() !== parent) throw new Error('Unexpected HEAD while finalizing. Inspect Git history manually.');
  const actual = await git(root, ['diff', '--raw', '-z', '--no-renames', '--abbrev=64', parent, sha, '--']);
  const paths = (await git(root, ['diff', '--name-only', '-z', parent, sha, '--'])).split('\0').filter(Boolean);
  if (actual !== expectedDiff || paths.length !== 1 || paths[0] !== path) throw new Error('Metadata commit differs from the checked task-file-only index. Inspect Git history manually.');
}

export function finalizationFailure(error: unknown): Error {
  return new Error(`Implementation commit succeeded, but Backlog finalization failed: ${error instanceof Error ? error.message : String(error)}. Retry /commit for the same task after inspecting changes. The controller will not create another implementation commit.`);
}
