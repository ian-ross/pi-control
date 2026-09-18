import { readFile } from 'node:fs/promises';
import { getAgentDir } from '@earendil-works/pi-coding-agent';
import { isAbsolute, join } from 'node:path';

import { normalizeArtifactPatterns } from './artifacts.ts';

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
  plansDirectory: string;
  untrackedArtifacts: string[];
  terminalStatus: string;
}

export const defaults: PiControlConfig = {
  maxRepairAttempts: 2,
  verificationTimeoutMs: 120_000,
  shell: '/bin/bash',
  autoPlanHandoff: true,
  plansDirectory: 'plans',
  claimAssignee: '@pi-control',
  readyStatus: 'To Do',
  inProgressStatus: 'In Progress',
  untrackedArtifacts: [],
  terminalStatus: 'Done',
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

type ConfigLayer = Partial<PiControlConfig>;

export interface LoadConfigOptions {
  home?: string;
  agentDir?: string;
}

function normalizeConfigLayer(value: unknown): ConfigLayer {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('pi-control configuration must be an object.');
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown pi-control configuration field: ${key}`);
  const input = value as Record<string, unknown>;
  const layer: ConfigLayer = {};

  if (Object.hasOwn(input, 'maxRepairAttempts')) {
    if (!Number.isSafeInteger(input.maxRepairAttempts) || (input.maxRepairAttempts as number) < 0 || (input.maxRepairAttempts as number) > 100) throw new Error('maxRepairAttempts must be an integer between 0 and 100.');
    layer.maxRepairAttempts = input.maxRepairAttempts as number;
  }
  if (Object.hasOwn(input, 'verificationTimeoutMs')) {
    if (!Number.isSafeInteger(input.verificationTimeoutMs) || (input.verificationTimeoutMs as number) <= 0 || (input.verificationTimeoutMs as number) > 2_147_483_647) throw new Error('verificationTimeoutMs must be a positive integer no greater than 2147483647.');
    layer.verificationTimeoutMs = input.verificationTimeoutMs as number;
  }
  if (Object.hasOwn(input, 'shell')) {
    if (typeof input.shell !== 'string' || !isAbsolute(input.shell) || input.shell.includes('\0')) throw new Error('shell must be an absolute executable path.');
    layer.shell = input.shell;
  }
  if (Object.hasOwn(input, 'autoPlanHandoff')) {
    if (typeof input.autoPlanHandoff !== 'boolean') throw new Error('autoPlanHandoff must be boolean.');
    layer.autoPlanHandoff = input.autoPlanHandoff;
  }
  if (Object.hasOwn(input, 'plansDirectory')) {
    const value = typeof input.plansDirectory === 'string' ? input.plansDirectory.trim() : input.plansDirectory;
    if (typeof value !== 'string' || !value || CONTROL_CHARS.test(input.plansDirectory as string) || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes('\\') || value.split('/').some(part => part === '..' || part.toLowerCase() === '.git')) {
      throw new Error('plansDirectory must be a non-empty repository-relative directory without traversal, Git metadata, backslashes, or control characters.');
    }
    layer.plansDirectory = value;
  }
  if (Object.hasOwn(input, 'untrackedArtifacts')) {
    layer.untrackedArtifacts = normalizeArtifactPatterns(input.untrackedArtifacts);
  }

  if (Object.hasOwn(input, 'claimAssignee')) layer.claimAssignee = normalizeClaimAssignee(input.claimAssignee);
  if (Object.hasOwn(input, 'readyStatus')) layer.readyStatus = normalizeStatus(input.readyStatus, 'readyStatus');
  if (Object.hasOwn(input, 'inProgressStatus')) layer.inProgressStatus = normalizeStatus(input.inProgressStatus, 'inProgressStatus');
  if (Object.hasOwn(input, 'terminalStatus')) layer.terminalStatus = normalizeStatus(input.terminalStatus, 'terminalStatus');

  return layer;
}

function mergeConfigLayers(...layers: ConfigLayer[]): PiControlConfig {
  const config = Object.assign({ ...defaults }, ...layers);
  const claim = normalizeClaimSettings(config);
  const terminalStatus = normalizeStatus(config.terminalStatus, 'terminalStatus');
  if ([claim.readyStatus, claim.inProgressStatus].some(status => status.toLowerCase() === terminalStatus.toLowerCase())) {
    throw new Error('terminalStatus must differ from readyStatus and inProgressStatus.');
  }
  return { ...config, ...claim, terminalStatus, untrackedArtifacts: normalizeArtifactPatterns(config.untrackedArtifacts) };
}

export function parseConfig(value: unknown): PiControlConfig {
  return mergeConfigLayers(normalizeConfigLayer(value));
}

async function readConfigLayer(path: string): Promise<ConfigLayer | null> {
  let text: string;
  try { text = await readFile(path, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  try { return normalizeConfigLayer(JSON.parse(text)); }
  catch (error) { throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`); }
}

export async function loadConfig(root: string, configDirectory: string, trusted: boolean, options: LoadConfigOptions = {}): Promise<PiControlConfig> {
  const agentDir = options.agentDir ?? (options.home ? join(options.home, configDirectory, 'agent') : getAgentDir());
  const globalPath = join(agentDir, 'pi-control.json');
  const projectPath = join(root, configDirectory, 'pi-control.json');
  const globalLayer = await readConfigLayer(globalPath);
  let projectLayer: ConfigLayer | null = null;
  if (await fileExists(projectPath)) {
    if (!trusted) throw new Error(`Trust this project before loading ${projectPath}.`);
    projectLayer = await readConfigLayer(projectPath);
  }
  return mergeConfigLayers(globalLayer ?? {}, projectLayer ?? {});
}

async function fileExists(path: string): Promise<boolean> {
  try { await readFile(path, 'utf8'); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
