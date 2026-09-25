import { stableDigest } from './digest.js';
import type { ControlTask, AcceptanceCriterion } from './backlog.js';
import type { ImplementationRun } from './state.js';
import type { VerificationResult } from './verification.js';

export type AcceptanceStatus = 'satisfied' | 'unsatisfied' | 'uncertain';

export interface AcceptanceCriterionAssessment {
  id: string;
  status: AcceptanceStatus;
  evidence: string[];
}

export interface AcceptanceAssessment {
  taskId: string;
  taskDigest: string;
  codeDigest: string;
  summary: string;
  criteria: AcceptanceCriterionAssessment[];
}

export interface AcceptanceRequest {
  taskId: string;
  taskTitle: string;
  taskDescription?: string;
  implementationPlan?: string;
  verificationResults: VerificationResult['commands'];
  taskDigest: string;
  codeDigest: string;
  criteria: AcceptanceCriterion[];
  changedPaths: string[];
  verificationCommands: string[];
  waiver?: { reason: string; failedCommands: string[] };
}

export interface AcceptanceReview extends AcceptanceAssessment {
  timestamp: string;
  accepted: boolean;
}

export const ACCEPTANCE_SUMMARY_MAX_LENGTH = 4000;
export const ACCEPTANCE_EVIDENCE_MAX_ITEMS = 8;
export const ACCEPTANCE_EVIDENCE_MAX_LENGTH = 2000;

const STATUSES = new Set<AcceptanceStatus>(['satisfied', 'unsatisfied', 'uncertain']);

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function cleanString(value: unknown, field: string, maxLength?: number): string {
  if (typeof value !== 'string' || !value.trim() || value.includes('\0')) throw new Error(`Acceptance review ${field} must be a non-empty string.`);
  const clean = value.trim();
  if (maxLength !== undefined && clean.length > maxLength) throw new Error(`Acceptance review ${field} is too long. Maximum length is ${maxLength} characters.`);
  return clean;
}

function onlyKeys(value: Record<string, unknown>, keys: string[], field: string): void {
  const allowed = new Set(keys);
  const extra = Object.keys(value).filter(key => !allowed.has(key));
  if (extra.length) throw new Error(`Acceptance review ${field} has unsupported fields: ${extra.join(', ')}.`);
}

export function taskDigest(task: ControlTask): string {
  return stableDigest(task);
}

export function criteriaForTask(task: ControlTask): AcceptanceCriterion[] {
  return task.acceptanceCriteriaState?.map(criterion => ({ ...criterion }))
    ?? task.acceptanceCriteria.map((text, index) => ({ id: String(index + 1), index: index + 1, text, checked: false }));
}

export function buildAcceptanceRequest(run: ImplementationRun): AcceptanceRequest {
  if (!run.latest) throw new Error('Run /verify before acceptance review.');
  return {
    taskId: run.task.id,
    taskTitle: run.task.title,
    ...(run.task.description !== undefined ? { taskDescription: run.task.description } : {}),
    ...(run.task.implementationPlan !== undefined ? { implementationPlan: run.task.implementationPlan } : {}),
    verificationResults: structuredClone(run.latest.commands),
    taskDigest: taskDigest(run.task),
    codeDigest: run.latest.digest,
    criteria: criteriaForTask(run.task),
    changedPaths: [...run.latest.changedPaths],
    verificationCommands: [...run.task.verificationCommands],
    ...(run.waiver ? { waiver: { reason: run.waiver.reason, failedCommands: [...run.waiver.failedCommands] } } : {}),
  };
}

export function validateAcceptanceAssessment(raw: unknown, request: AcceptanceRequest, now: () => Date = () => new Date()): AcceptanceReview {
  if (!object(raw)) throw new Error('Acceptance review result must be an object.');
  onlyKeys(raw, ['taskId', 'taskDigest', 'codeDigest', 'summary', 'criteria'], 'result');
  const taskId = cleanString(raw.taskId, 'taskId');
  const receivedTaskDigest = cleanString(raw.taskDigest, 'taskDigest');
  const receivedCodeDigest = cleanString(raw.codeDigest, 'codeDigest');
  const summary = cleanString(raw.summary, 'summary', ACCEPTANCE_SUMMARY_MAX_LENGTH);
  if (taskId !== request.taskId) throw new Error(`Acceptance review taskId ${JSON.stringify(taskId)} does not match ${request.taskId}.`);
  if (receivedTaskDigest !== request.taskDigest) throw new Error('Acceptance review is stale for the task definition.');
  if (receivedCodeDigest !== request.codeDigest) throw new Error('Acceptance review is stale for the verified code state.');
  if (!Array.isArray(raw.criteria)) throw new Error('Acceptance review criteria must be an array.');
  const expected = new Map(request.criteria.map(criterion => [criterion.id, criterion]));
  const seen = new Set<string>();
  const criteria: AcceptanceCriterionAssessment[] = [];
  for (const [index, item] of raw.criteria.entries()) {
    if (!object(item)) throw new Error(`Acceptance review criteria[${index}] must be an object.`);
    onlyKeys(item, ['id', 'status', 'evidence'], `criteria[${index}]`);
    const id = cleanString(item.id, `criteria[${index}].id`);
    if (!expected.has(id)) throw new Error(`Acceptance review references unknown criterion ${JSON.stringify(id)}.`);
    if (seen.has(id)) throw new Error(`Acceptance review duplicates criterion ${JSON.stringify(id)}.`);
    seen.add(id);
    if (typeof item.status !== 'string' || !STATUSES.has(item.status as AcceptanceStatus)) throw new Error(`Acceptance review criterion ${id} has invalid status.`);
    if (!Array.isArray(item.evidence) || item.evidence.length === 0) throw new Error(`Acceptance review criterion ${id} needs evidence.`);
    if (item.evidence.length > ACCEPTANCE_EVIDENCE_MAX_ITEMS) throw new Error(`Acceptance review criterion ${id} has too many evidence entries. Maximum is ${ACCEPTANCE_EVIDENCE_MAX_ITEMS}.`);
    const evidence = item.evidence.map((entry, evidenceIndex) => cleanString(entry, `criteria[${index}].evidence[${evidenceIndex}]`, ACCEPTANCE_EVIDENCE_MAX_LENGTH));
    criteria.push({ id, status: item.status as AcceptanceStatus, evidence });
  }
  const missing = [...expected.keys()].filter(id => !seen.has(id));
  if (missing.length) throw new Error(`Acceptance review omitted criteria: ${missing.join(', ')}.`);
  return {
    taskId,
    taskDigest: receivedTaskDigest,
    codeDigest: receivedCodeDigest,
    summary,
    criteria,
    timestamp: now().toISOString(),
    accepted: criteria.every(criterion => criterion.status === 'satisfied'),
  };
}

export function acceptedReviewCurrent(run: ImplementationRun): boolean {
  return !!run.acceptanceReview
    && !!run.latest
    && run.acceptanceReview.accepted
    && run.acceptanceReview.taskDigest === taskDigest(run.task)
    && run.acceptanceReview.codeDigest === run.latest.digest;
}

export function acceptanceGateCurrent(run: ImplementationRun): boolean {
  if (!run.acceptanceReview || !run.latest) return false;
  if (run.acceptanceReview.taskDigest !== taskDigest(run.task) || run.acceptanceReview.codeDigest !== run.latest.digest) return false;
  if (run.acceptanceReview.accepted) return true;
  const waiver = run.acceptanceWaiver;
  if (!waiver || waiver.taskDigest !== run.acceptanceReview.taskDigest || waiver.codeDigest !== run.acceptanceReview.codeDigest) return false;
  const waived = new Set(waiver.criteria);
  return run.acceptanceReview.criteria.every(criterion => criterion.status === 'satisfied' || waived.has(criterion.id));
}

export function acceptanceReport(review: AcceptanceReview): string {
  return [
    `Acceptance: ${review.accepted ? 'SATISFIED' : 'BLOCKED'}`,
    review.summary,
    ...review.criteria.map(criterion => `${criterion.id}: ${criterion.status}; ${criterion.evidence.join('; ')}`),
  ].join('\n');
}
