import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { normalizeClaimSettings, type ClaimSettings } from './config.js';
import { compileScope } from './paths.js';
import { stableDigest } from './digest.js';

export type { ClaimSettings } from './config.js';

export interface TaskLifecycle {
  path: string;
  status: string;
  assignees: string[];
}

export interface ControlTask {
  id: string;
  title: string;
  description?: string;
  // Only legacy restored runs may omit this field; new task loads require it.
  implementationPlan?: string;
  // Only legacy restored runs may omit this field; new task loads require it.
  lifecycle?: TaskLifecycle;
  acceptanceCriteria: string[];
  allowedScope: string[];
  verificationCommands: string[];
}

type PiExecOptions = NonNullable<Parameters<ExtensionAPI['exec']>[2]>;

type PiExecResult = Awaited<ReturnType<ExtensionAPI['exec']>>;

export type BacklogExec = (
  command: string,
  args: string[],
  options?: PiExecOptions & { maxBuffer?: number },
) => Promise<PiExecResult>;

export type BacklogTaskErrorCode =
  | "invalid-task-id"
  | "backlog-cli"
  | "backlog-config"
  | "claim-conflict"
  | "malformed-task"
  | "invalid-scope"
  | "task-id-mismatch";

export class BacklogTaskError extends Error {
  readonly code: BacklogTaskErrorCode;

  constructor(code: BacklogTaskErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BacklogTaskError";
    this.code = code;
  }
}

const VERIFICATION_PREFIX = "Verification:";
const DEFAULT_BACKLOG_TIMEOUT_MS = 30_000;
const SAFE_TASK_ID = /^(?:[A-Za-z][A-Za-z0-9_-]*-)?\d+(?:\.\d+)*$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function taskError(message: string): BacklogTaskError {
  return new BacklogTaskError("malformed-task", message);
}

function parseRawTask(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;

  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new BacklogTaskError("malformed-task", "Backlog task JSON could not be parsed.", { cause: error });
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw taskError(`Backlog task field ${field} must be a non-empty string.`);
  }
  return value;
}

function requireCleanNonBlankString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw taskError(`Backlog task field ${field} must be a non-empty string.`);
  }
  if (CONTROL_CHARS.test(value)) {
    throw taskError(`Backlog task field ${field} must not contain control characters.`);
  }
  return value;
}

function optionalDescription(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") {
    throw taskError("Backlog task field description must be a string or null.");
  }
  return value;
}

function listObjects(value: unknown, field: string): UnknownRecord[] {
  if (!Array.isArray(value)) {
    throw taskError(`Backlog task field ${field} must be an array.`);
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw taskError(`Backlog task field ${field}[${index}] must be an object.`);
    }
    return item;
  });
}

function normalizeScopeText(value: unknown, index: number): string {
  if (typeof value !== "string") {
    throw taskError(`Backlog task modifiedFiles[${index}] must be a string.`);
  }
  if (value.length === 0 || value.trim().length === 0) {
    throw taskError(`Backlog task modifiedFiles[${index}] must not be empty.`);
  }
  if (value.includes("\0")) {
    throw taskError(`Backlog task modifiedFiles[${index}] contains a NUL byte.`);
  }

  const normalized = value.replace(/\\/g, "/");
  const key = scopeKey(normalized);
  if (
    normalized.startsWith("/") ||
    /^[A-Za-z]:\//.test(normalized) ||
    normalized.startsWith("//") ||
    key === ".." ||
    key.startsWith("../") ||
    key.split("/").includes("..")
  ) {
    throw taskError(`Backlog task scope entry ${JSON.stringify(value)} is not repository-relative.`);
  }

  // Scope compilation normalizes separators; retain the exact text for display.
  return value;
}

function scopeKey(text: string): string {
  let key = text.replace(/\\/g, "/").replace(/\/+/g, "/");
  while (key.startsWith("./")) key = key.slice(2);
  return key;
}

function dedupePreservingOrder(values: string[], keyOf: (value: string) => string = (value) => value): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const key = keyOf(value);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function extractAcceptanceCriteria(task: UnknownRecord): string[] {
  return listObjects(task.acceptanceCriteria, "acceptanceCriteria").map((item, index) => {
    if (typeof item.text !== "string") {
      throw taskError(`Backlog task acceptanceCriteria[${index}].text must be a string.`);
    }
    return item.text;
  });
}

function extractVerificationCommands(task: UnknownRecord): string[] {
  const commands: string[] = [];
  for (const [index, item] of listObjects(task.definitionOfDone, "definitionOfDone").entries()) {
    if (typeof item.text !== "string") {
      throw taskError(`Backlog task definitionOfDone[${index}].text must be a string.`);
    }
    if (!item.text.startsWith(VERIFICATION_PREFIX)) continue;

    const command = item.text.slice(VERIFICATION_PREFIX.length).trim();
    if (command.length === 0) {
      throw taskError("Backlog Verification: Definition of Done entries must include a command.");
    }
    commands.push(command);
  }

  const deduped = dedupePreservingOrder(commands);
  if (deduped.length === 0) {
    throw taskError("Backlog task must include at least one Definition of Done entry beginning with Verification:.");
  }
  return deduped;
}

function extractAllowedScope(task: UnknownRecord): string[] {
  if (!Array.isArray(task.modifiedFiles)) {
    throw taskError("Backlog task modifiedFiles must be an array.");
  }

  const normalized = task.modifiedFiles.map((entry, index) => normalizeScopeText(entry, index));
  const deduped = dedupePreservingOrder(normalized, scopeKey);
  if (deduped.length === 0) {
    throw taskError("Backlog task modifiedFiles must include at least one scope entry.");
  }
  return deduped;
}

function extractLifecycle(task: UnknownRecord): TaskLifecycle {
  const assignees = task.assignees;
  if (!Array.isArray(assignees)) {
    throw taskError("Backlog task assignees must be an array.");
  }
  return {
    path: normalizeTaskPath(task.path),
    status: requireCleanNonBlankString(task.status, "status"),
    assignees: assignees.map((assignee, index) => requireCleanNonBlankString(assignee, `assignees[${index}]`)),
  };
}

function normalizeTaskPath(value: unknown): string {
  const path = requireCleanNonBlankString(value, "path");
  if (path.includes("\\")) {
    throw taskError("Backlog task path must use repository-relative POSIX separators.");
  }
  if (path.startsWith("/") || path.startsWith("//") || /^[A-Za-z]:/.test(path)) {
    throw taskError("Backlog task path must be repository-relative.");
  }
  if (!path.endsWith(".md")) {
    throw taskError("Backlog task path must point to a Markdown task file.");
  }

  const segments = path.split("/");
  if (segments.some(segment => segment.length === 0 || segment === "." || segment === ".." || segment.toLowerCase() === ".git")) {
    throw taskError("Backlog task path must not contain empty, traversal, or .git segments.");
  }
  return path;
}

export function normalizeTask(raw: unknown): ControlTask {
  const envelope = parseRawTask(raw);
  if (!isRecord(envelope)) {
    throw taskError("Backlog task JSON must be an object.");
  }
  if (envelope.schemaVersion !== 1) {
    throw taskError("Backlog task JSON schemaVersion must be 1.");
  }
  if (envelope.kind !== "task-view") {
    throw taskError('Backlog task JSON kind must be "task-view".');
  }
  if (!isRecord(envelope.task)) {
    throw taskError("Backlog task JSON must contain a task object.");
  }

  const sourceTask = envelope.task;
  const description = optionalDescription(sourceTask.description);
  const task: ControlTask = {
    id: requireString(sourceTask.id, "id"),
    title: requireString(sourceTask.title, "title"),
    lifecycle: extractLifecycle(sourceTask),
    acceptanceCriteria: extractAcceptanceCriteria(sourceTask),
    allowedScope: extractAllowedScope(sourceTask),
    verificationCommands: extractVerificationCommands(sourceTask),
  };
  if (description !== undefined) task.description = description;
  if (typeof sourceTask.implementationPlan !== 'string' || !sourceTask.implementationPlan.trim()) {
    throw taskError('Backlog task must include a non-empty implementationPlan. Add it with `backlog task edit <id> --plan <text>` before /implement.');
  }
  task.implementationPlan = sourceTask.implementationPlan;
  return task;
}

export async function requireAutoCommitDisabled(root: string, exec: BacklogExec): Promise<void> {
  const remedy = 'pi-control requires Backlog auto-commit to be disabled. In the project, run `backlog config set autoCommit false`, then retry. pi-control does not change this setting.';
  let result: PiExecResult;
  try {
    result = await exec('backlog', ['config', 'get', 'autoCommit'], { cwd: root, timeout: DEFAULT_BACKLOG_TIMEOUT_MS });
  } catch (error) {
    throw new BacklogTaskError('backlog-config', `Cannot read Backlog autoCommit: ${truncate(error instanceof Error ? error.message : String(error))}. ${remedy}`, { cause: error });
  }
  if (result.killed || result.code !== 0) {
    const detail = truncate([result.stderr, result.stdout].filter(Boolean).join('\n').trim());
    throw new BacklogTaskError('backlog-config', `backlog config get autoCommit failed${result.killed ? ' or timed out' : ''}${detail ? `: ${detail}` : '.'} ${remedy}`);
  }
  // Backlog 1.52.0 prints the effective boolean as a single plain-text value.
  if (result.stdout.trim() !== 'false') {
    throw new BacklogTaskError('backlog-config', `Backlog autoCommit reported ${JSON.stringify(truncate(result.stdout.trim(), 200))}. ${remedy}`);
  }
}

export function assertClaimable(task: ControlTask, settings: ClaimSettings): TaskLifecycle {
  const claim = normalizeClaimSettings(settings);
  const lifecycle = requireLifecycle(task);
  const status = statusKey(lifecycle.status);
  if (status !== statusKey(claim.readyStatus) && status !== statusKey(claim.inProgressStatus)) {
    throw new BacklogTaskError(
      "claim-conflict",
      `Backlog task ${task.id} has status ${JSON.stringify(lifecycle.status)}. Only ${JSON.stringify(claim.readyStatus)} or ${JSON.stringify(claim.inProgressStatus)} can be claimed.`,
    );
  }

  const owner = assigneeKey(claim.claimAssignee);
  const other = lifecycle.assignees.find(assignee => assigneeKey(assignee) !== owner);
  if (other !== undefined) {
    throw new BacklogTaskError(
      "claim-conflict",
      `Backlog task ${task.id} is assigned to ${JSON.stringify(other)}, not ${JSON.stringify(claim.claimAssignee)}.`,
    );
  }

  return lifecycle;
}

export async function claimTask(root: string, task: ControlTask, settings: ClaimSettings, exec: BacklogExec): Promise<ControlTask> {
  const claim = normalizeClaimSettings(settings);
  if (process.env.BACKLOG_CWD && await realpath(resolve(root, process.env.BACKLOG_CWD)) !== await realpath(root)) {
    throw new BacklogTaskError('backlog-config', 'BACKLOG_CWD does not match the captured project root. Unset it or point it at this repository before claiming a task.');
  }
  const reread = await loadTask(root, task.id, exec);
  if (stableDigest(reread) !== stableDigest(task)) {
    throw new BacklogTaskError(
      "claim-conflict",
      `Backlog task ${task.id} changed before claim. Refusing to overwrite changed definition or ownership.`,
    );
  }

  const lifecycle = assertClaimable(reread, claim);
  if (isAlreadyActiveClaim(lifecycle, claim)) {
    return reread;
  }

  await requireAutoCommitDisabled(root, exec);

  const id = validateRequestedTaskId(reread.id);
  let result: PiExecResult;
  try {
    result = await exec("backlog", ["task", "edit", id, "--status", claim.inProgressStatus, "--assignee", claim.claimAssignee], {
      cwd: root,
      timeout: DEFAULT_BACKLOG_TIMEOUT_MS,
    });
  } catch (error) {
    throw new BacklogTaskError(
      "backlog-cli",
      `Cannot run backlog task edit for ${id}: ${truncate(error instanceof Error ? error.message : String(error))}. The task may have been partially written; no implementation was dispatched.`,
      { cause: error },
    );
  }

  if (result.killed || result.code !== 0) {
    const detail = truncate([result.stderr, result.stdout].filter(Boolean).join("\n").trim());
    throw new BacklogTaskError(
      "backlog-cli",
      `backlog task edit ${id} failed${result.killed ? " or timed out" : ""}${detail ? `: ${detail}` : "."} The task may have been partially written; no implementation was dispatched.`,
    );
  }

  const claimed = await loadTask(root, id, exec);
  const claimedLifecycle = requireLifecycle(claimed);
  if (!hasExpectedClaim(claimedLifecycle, claim)) {
    throw new BacklogTaskError(
      "claim-conflict",
      `Backlog task ${id} claim read-back mismatch. Expected status ${JSON.stringify(claim.inProgressStatus)} and assignee ${JSON.stringify(claim.claimAssignee)}, got status ${JSON.stringify(claimedLifecycle.status)} and assignees ${JSON.stringify(claimedLifecycle.assignees)}. The task may have been partially written; no implementation was dispatched.`,
    );
  }
  if (definitionDigest(claimed) !== definitionDigest(reread)) {
    throw new BacklogTaskError(
      "claim-conflict",
      `Backlog task ${id} changed outside lifecycle status or assignees during claim. The task may have been partially written; no implementation was dispatched.`,
    );
  }

  return claimed;
}

export async function loadTask(root: string, id: string, exec: BacklogExec): Promise<ControlTask> {
  const requestedId = validateRequestedTaskId(id);
  let result: PiExecResult;
  try {
    result = await exec("backlog", ["task", requestedId, "--json"], {
      cwd: root,
      timeout: DEFAULT_BACKLOG_TIMEOUT_MS,
    });
  } catch (error) {
    throw new BacklogTaskError('backlog-cli', `Cannot run backlog. Install Backlog.md 1.52.0 or compatible and put backlog on PATH: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  if (result.killed || result.code !== 0) {
    const detail = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
    throw new BacklogTaskError(
      "backlog-cli",
      `backlog task ${requestedId} --json failed${detail ? `: ${truncate(detail)}` : "."}`,
    );
  }

  const task = normalizeTask(result.stdout);
  if (!taskIdMatchesRequest(task.id, requestedId)) {
    throw new BacklogTaskError(
      "task-id-mismatch",
      `Backlog returned task ${task.id} for requested task ${requestedId}.`,
    );
  }

  try {
    await compileScope(root, task.allowedScope);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BacklogTaskError("invalid-scope", `Backlog task scope is invalid: ${message}`, { cause: error });
  }

  return task;
}

function requireLifecycle(task: ControlTask): TaskLifecycle {
  if (!task.lifecycle) {
    throw new BacklogTaskError("malformed-task", `Backlog task ${task.id} is missing lifecycle data. Reload it from Backlog before claiming.`);
  }
  return task.lifecycle;
}

function statusKey(value: string): string {
  return value.trim().toLowerCase();
}

function assigneeKey(value: string): string {
  return value.startsWith("@") ? value.slice(1) : value;
}

function isAlreadyActiveClaim(lifecycle: TaskLifecycle, settings: ClaimSettings): boolean {
  return statusKey(lifecycle.status) === statusKey(settings.inProgressStatus)
    && lifecycle.assignees.length === 1
    && assigneeKey(lifecycle.assignees[0]) === assigneeKey(settings.claimAssignee);
}

function hasExpectedClaim(lifecycle: TaskLifecycle, settings: ClaimSettings): boolean {
  return statusKey(lifecycle.status) === statusKey(settings.inProgressStatus)
    && lifecycle.assignees.length === 1
    && lifecycle.assignees[0] === settings.claimAssignee;
}

function definitionDigest(task: ControlTask): string {
  const lifecycle = task.lifecycle ? { path: task.lifecycle.path } : undefined;
  return stableDigest({ ...task, lifecycle });
}

function validateRequestedTaskId(id: string): string {
  if (typeof id !== "string") {
    throw new BacklogTaskError("invalid-task-id", "Backlog task id must be a string.");
  }
  const trimmed = id.trim();
  if (trimmed !== id || !SAFE_TASK_ID.test(trimmed)) {
    throw new BacklogTaskError(
      "invalid-task-id",
      "Backlog task id must be a safe CLI id such as BACK-123 or 123.",
    );
  }
  return trimmed;
}

function taskIdParts(id: string): { prefix?: string; number: string } | undefined {
  const match = /^(?:(?<prefix>[A-Za-z][A-Za-z0-9_-]*)-)?(?<number>\d+(?:\.\d+)*)$/.exec(id);
  if (!match?.groups) return undefined;
  return {
    prefix: match.groups.prefix?.toLowerCase(),
    number: match.groups.number.split('.').map(n => BigInt(n).toString()).join('.'),
  };
}

function taskIdMatchesRequest(returnedId: string, requestedId: string): boolean {
  if (returnedId.toLowerCase() === requestedId.toLowerCase()) return true;

  const returned = taskIdParts(returnedId);
  const requested = taskIdParts(requestedId);
  if (!returned || !requested) return false;
  if (returned.number !== requested.number) return false;
  return requested.prefix === undefined || requested.prefix === returned.prefix;
}

function truncate(value: string, max = 2_000): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}
