import type { ArtifactPolicy } from "./artifacts.ts";
import { inspectRun as inspectGitRun, type Baseline, type Inspection, type ManagedFiles, type ManagedImplementationNotes } from "./git.ts";
import { verificationDigest } from "./digest.ts";
import type { ControlTask } from "./backlog.ts";
import type { ScopeEntry } from "./paths.ts";
import { boundOutput, cancelledCommandResult, type CommandResult, type RunCommandInput, repoRootFromBaseline, subprocessRunner } from "./process.ts";

export type { CommandResult } from "./process.ts";

export interface VerificationResult {
  digest: string;
  scopeOk: boolean;
  checksOk: boolean;
  passed: boolean;
  scopeErrors: string[];
  errors: string[];
  commands: CommandResult[];
  timestamp: string;
  changedPaths: string[];
}

export interface VerificationCommandStart {
  command: string;
  index: number;
  total: number;
}

export interface VerificationInput {
  baseline: Baseline;
  task: ControlTask;
  scope: ScopeEntry[];
  managedFiles?: ManagedFiles;
  managedImplementationNotes?: ManagedImplementationNotes;
  artifactPolicy?: ArtifactPolicy;
  shell: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onCommandStart?: (event: VerificationCommandStart) => void;
}

export type RunnerDependency =
  | ((input: RunCommandInput) => Promise<CommandResult>)
  | { run(input: RunCommandInput): Promise<CommandResult> };

export interface VerificationDeps {
  runner?: RunnerDependency;
  inspectRun?: (baseline: Baseline, scope: ScopeEntry[], managedFiles?: ManagedFiles, artifactPolicy?: ArtifactPolicy, managedImplementationNotes?: ManagedImplementationNotes) => Inspection | Promise<Inspection>;
  now?: () => Date;
  verificationDigest?: (
    baseline: Baseline,
    taskId: string,
    scope: ScopeEntry[],
    commands: string[],
    inspection: Inspection,
    artifactPolicy?: ArtifactPolicy,
  ) => string;
}

function normalizeCommandResult(command: string, result: CommandResult): CommandResult {
  return {
    command,
    code: typeof result.code === "number" ? result.code : null,
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : 0,
    stdout: boundOutput(result.stdout ?? ""),
    stderr: boundOutput(result.stderr ?? ""),
    timedOut: result.timedOut === true,
    cancelled: result.cancelled === true,
  };
}

async function runOne(runner: RunnerDependency, input: RunCommandInput): Promise<CommandResult> {
  const result = typeof runner === "function" ? await runner(input) : await runner.run(input);
  return normalizeCommandResult(input.command, result);
}

function commandError(result: CommandResult): string | null {
  if (result.cancelled) return `command cancelled: ${result.command}`;
  if (result.timedOut) return `command timed out: ${result.command}`;
  if (result.code !== 0) return `command failed (${result.code === null ? "no exit code" : `exit ${result.code}`}): ${result.command}`;
  return null;
}

export async function runVerification(input: VerificationInput, deps: VerificationDeps = {}): Promise<VerificationResult> {
  const inspectRun = deps.inspectRun ?? inspectGitRun;
  const runner = deps.runner ?? subprocessRunner;
  const now = deps.now ?? (() => new Date());
  const digest = deps.verificationDigest ?? verificationDigest;
  const repoRoot = repoRootFromBaseline(input.baseline);
  const commands = input.task.verificationCommands;

  const before = await inspectRun(input.baseline, input.scope, input.managedFiles, input.artifactPolicy, input.managedImplementationNotes);
  const commandResults: CommandResult[] = [];

  let stopForCancellation = input.signal?.aborted === true;
  for (const [offset, command] of commands.entries()) {
    if (stopForCancellation || input.signal?.aborted) {
      stopForCancellation = true;
      commandResults.push(cancelledCommandResult(command));
      continue;
    }

    input.onCommandStart?.({ command, index: offset + 1, total: commands.length });
    const result = await runOne(runner, {
      command,
      shell: input.shell,
      timeoutMs: input.timeoutMs,
      cwd: repoRoot,
      signal: input.signal,
    });
    commandResults.push(result);
    if (result.cancelled) stopForCancellation = true;
  }

  const after = await inspectRun(input.baseline, input.scope, input.managedFiles, input.artifactPolicy, input.managedImplementationNotes);
  const mutated = before.contentDigest !== after.contentDigest;
  const inspection = after;
  const errors = commandResults.map(commandError).filter((error): error is string => error !== null);
  if (mutated) errors.push("verification-mutated-worktree");
  if (stopForCancellation && !errors.includes("verification-cancelled")) errors.push("verification-cancelled");

  const commandsOk = commandResults.every((result) => result.code === 0 && !result.timedOut && !result.cancelled);
  const checksOk = commandsOk && !mutated && !stopForCancellation;
  const scopeOk = inspection.scopeOk;

  return {
    digest: digest(input.baseline, input.task.id, input.scope, commands, inspection, input.artifactPolicy),
    scopeOk,
    checksOk,
    passed: scopeOk && checksOk,
    scopeErrors: [...inspection.errors],
    errors,
    commands: commandResults,
    timestamp: now().toISOString(),
    changedPaths: [...inspection.changedPaths],
  };
}
