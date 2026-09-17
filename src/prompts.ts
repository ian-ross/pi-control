import type { ImplementationRun } from './state.js';
import { effectiveScope } from './state.js';
import type { VerificationResult } from './verification.js';

export function implementationPrompt(run: ImplementationRun): string {
  return [
    `Implement only ${run.task.id}: ${run.task.title}`,
    `Repository root: ${run.baseline.root}`,
    run.task.description ?? '',
    'Acceptance criteria:', ...run.task.acceptanceCriteria.map(c => `- ${c}`),
    'Allowed scope entries, exactly as approved:', ...effectiveScope(run).map(s => `- ${s.text}`),
    'Exact verification commands:', ...run.task.verificationCommands.map(c => `\n${c}`),
    'Do not commit, edit Backlog state, waive checks, invoke workflow commands, or broaden scope. Implement only this task within the allowed scope. The extension runs verification after you settle. No special evidence format is needed.',
  ].join('\n');
}
export function verificationReport(taskId: string, result: VerificationResult): string {
  return [taskId, `Scope  ${result.scopeOk ? 'PASS' : 'FAIL'}`, ...result.scopeErrors,
    ...result.commands.map(c => `${c.command}  ${c.code === 0 && !c.timedOut && !c.cancelled ? 'PASS' : 'FAIL'}  ${(c.durationMs / 1000).toFixed(1)}s${c.timedOut ? ' timeout' : ''}${c.cancelled ? ' cancelled' : ''}`),
    ...result.errors, `Result: ${result.passed ? 'VERIFIED' : 'FAILED'}`].join('\n');
}
export function repairPrompt(run: ImplementationRun): string {
  const r = run.latest!;
  return [
    `Repair ${run.task.id}. Automatic repair ${run.repairs}/${run.maxRepairAttempts}. Remaining repair turns after this one: ${run.maxRepairAttempts - run.repairs}.`,
    'Scope failures:', ...r.scopeErrors,
    'Verification errors:', ...r.errors,
    ...r.commands.filter(c => c.code !== 0 || c.timedOut || c.cancelled).map(c => [
      `Command: ${c.command}`, `Exit: ${c.code}; timeout: ${c.timedOut}; cancelled: ${c.cancelled}`, `stdout:\n${c.stdout}`, `stderr:\n${c.stderr}`,
    ].join('\n')),
    'Change only files within the effective scope:', ...effectiveScope(run).map(s => s.text),
    'Do not commit, modify Backlog or workflow state, waive checks, or broaden scope. The extension will rerun verification. If a failure needs a human decision, stop and explain it.',
  ].join('\n');
}
export const recovery = 'Next: /verify, /implement-resume, /scope-add, /verify-waive for eligible command failures, or /control-abort.';
