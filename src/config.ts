import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export interface PiControlConfig {
  maxRepairAttempts: number;
  verificationTimeoutMs: number;
  shell: string;
  autoPlanHandoff: boolean;
}
export const defaults: PiControlConfig = { maxRepairAttempts: 2, verificationTimeoutMs: 120_000, shell: '/bin/bash', autoPlanHandoff: true };
export function parseConfig(value: unknown): PiControlConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('pi-control configuration must be an object.');
  for (const key of Object.keys(value)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown pi-control configuration field: ${key}`);
  const config = { ...defaults, ...value };
  if (!Number.isSafeInteger(config.maxRepairAttempts) || config.maxRepairAttempts < 0 || config.maxRepairAttempts > 100) throw new Error('maxRepairAttempts must be an integer between 0 and 100.');
  if (!Number.isSafeInteger(config.verificationTimeoutMs) || config.verificationTimeoutMs <= 0 || config.verificationTimeoutMs > 2_147_483_647) throw new Error('verificationTimeoutMs must be a positive integer no greater than 2147483647.');
  if (typeof config.shell !== 'string' || !isAbsolute(config.shell) || config.shell.includes('\0')) throw new Error('shell must be an absolute executable path.');
  if (typeof config.autoPlanHandoff !== 'boolean') throw new Error('autoPlanHandoff must be boolean.');
  return config;
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
