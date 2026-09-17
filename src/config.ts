import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface ClaimSettings {
  claimAssignee: string;
  readyStatus: string;
  inProgressStatus: string;
}

export interface PiControlConfig extends ClaimSettings {
  maxRepairAttempts: number;
  verificationTimeoutMs: number;
  shell: string;
  autoPlanHandoff: boolean;
}

export const defaults: PiControlConfig = {
  maxRepairAttempts: 2,
  verificationTimeoutMs: 120_000,
  shell: '/bin/bash',
  autoPlanHandoff: true,
  claimAssignee: '@pi-control',
  readyStatus: 'To Do',
  inProgressStatus: 'In Progress',
};

const USERNAME = /^@?[A-Za-z0-9._-]+$/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

export function normalizeClaimSettings(settings: ClaimSettings): ClaimSettings {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error('claim settings must be an object.');
  }

  const claimAssignee = normalizeClaimAssignee(settings.claimAssignee);
  const readyStatus = normalizeStatus(settings.readyStatus, 'readyStatus');
  const inProgressStatus = normalizeStatus(settings.inProgressStatus, 'inProgressStatus');
  if (readyStatus.toLowerCase() === inProgressStatus.toLowerCase()) {
    throw new Error('readyStatus and inProgressStatus must be distinct.');
  }

  return { claimAssignee, readyStatus, inProgressStatus };
}

function normalizeClaimAssignee(value: unknown): string {
  if (typeof value !== 'string' || !USERNAME.test(value)) {
    throw new Error('claimAssignee must be one username using letters, digits, dot, underscore, or hyphen, with an optional leading @.');
  }
  const bare = value.startsWith('@') ? value.slice(1) : value;
  if (bare.length === 0) {
    throw new Error('claimAssignee must not be empty.');
  }
  return `@${bare}`;
}

function normalizeStatus(value: unknown, field: string): string {
  if (typeof value !== 'string') {
    throw new Error(`${field} must be a string.`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error(`${field} must not be blank.`);
  }
  if (CONTROL_CHARS.test(trimmed)) {
    throw new Error(`${field} must not contain control characters.`);
  }
  return trimmed;
}

export function parseConfig(value: unknown): PiControlConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('pi-control configuration must be an object.');
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown pi-control configuration field: ${key}`);
  const config = { ...defaults, ...(value as Partial<PiControlConfig>) };
  if (!Number.isSafeInteger(config.maxRepairAttempts) || config.maxRepairAttempts < 0 || config.maxRepairAttempts > 100) throw new Error('maxRepairAttempts must be an integer between 0 and 100.');
  if (!Number.isSafeInteger(config.verificationTimeoutMs) || config.verificationTimeoutMs <= 0 || config.verificationTimeoutMs > 2_147_483_647) throw new Error('verificationTimeoutMs must be a positive integer no greater than 2147483647.');
  if (typeof config.shell !== 'string' || !isAbsolute(config.shell) || config.shell.includes('\0')) throw new Error('shell must be an absolute executable path.');
  if (typeof config.autoPlanHandoff !== 'boolean') throw new Error('autoPlanHandoff must be boolean.');
  return { ...config, ...normalizeClaimSettings(config) };
}

export async function loadConfig(root: string, configDirectory: string, trusted: boolean): Promise<PiControlConfig> {
  const path = join(root, configDirectory, 'pi-control.json');
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { ...defaults }; throw error; }
  if (!trusted) throw new Error(`Trust this project before loading ${path}.`);
  try { return parseConfig(JSON.parse(text)); }
  catch (error) { throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
}
