import { compileScope, matchesScope, validateGlob, type ScopeEntry } from './paths.ts';

export interface ArtifactPolicy {
  untrackedArtifacts: ScopeEntry[];
}

export const emptyArtifactPolicy: ArtifactPolicy = { untrackedArtifacts: [] };

const GLOB_CHARS = /[*?{}[\]()+@!]/;
const DRIVE_PATH = /^[A-Za-z]:(?:[\\/]|$|[^\\/])/;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasTraversal(value: string): boolean {
  return value.split('/').filter(Boolean).includes('..');
}

function hasGitMetadata(value: string): boolean {
  return value.split('/').filter(Boolean).includes('.git');
}

function isAbsoluteAnyPlatform(value: string): boolean {
  return value.startsWith('/') || DRIVE_PATH.test(value);
}

export function normalizeArtifactPatterns(value: unknown): string[] {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error('untrackedArtifacts must be an array of path or glob strings.');
  }

  const seen = new Set<string>();
  const patterns: string[] = [];
  for (const pattern of value) {
    if (pattern.trim().length === 0) throw new Error('untrackedArtifacts entries must not be empty.');
    validateGlob(pattern);
    if (CONTROL_CHARS.test(pattern)) throw new Error(`untrackedArtifacts entry contains a control character: ${JSON.stringify(pattern)}`);
    if (pattern.includes('\\')) throw new Error(`untrackedArtifacts entry contains a backslash, which is not supported safely: ${pattern}`);
    if (pattern.startsWith('!') && !pattern.startsWith('!(')) throw new Error(`invalid untrackedArtifacts glob pattern: ${pattern}`);
    if (isAbsoluteAnyPlatform(pattern)) throw new Error(`absolute untrackedArtifacts entries are not allowed: ${pattern}`);
    if (hasTraversal(pattern) || /(?:^|[/(|])\.\.(?:[/)|]|$)/.test(pattern)) {
      throw new Error(`path traversal is not allowed in untrackedArtifacts entry: ${pattern}`);
    }
    if (hasGitMetadata(pattern)) throw new Error(`untrackedArtifacts entry targets git metadata: ${pattern}`);
    if (!seen.has(pattern)) {
      seen.add(pattern);
      patterns.push(pattern);
    }
  }
  return patterns;
}

export async function compileArtifactPolicy(root: string, patterns: readonly string[] | undefined): Promise<ArtifactPolicy> {
  const normalized = normalizeArtifactPatterns([...(patterns ?? [])]);
  return { untrackedArtifacts: await compileScope(root, normalized) };
}

function safeStoredPath(value: string): boolean {
  return value.length > 0
    && !CONTROL_CHARS.test(value)
    && !value.includes('\\')
    && !isAbsoluteAnyPlatform(value)
    && !hasTraversal(value)
    && !hasGitMetadata(value);
}

function validateStoredScopeEntry(value: unknown): value is ScopeEntry {
  if (!object(value)) return false;
  if (Object.keys(value).sort().join('\0') !== 'kind\0pattern\0text') return false;
  if (typeof value.text !== 'string' || typeof value.pattern !== 'string' || typeof value.kind !== 'string') return false;
  if (!['file', 'directory', 'glob'].includes(value.kind)) return false;
  if (!safeStoredPath(value.text)) return false;
  if (value.kind !== 'directory' && value.pattern.length === 0) return false;
  if (value.pattern.length > 0 && !safeStoredPath(value.pattern)) return false;
  if (value.kind === 'glob' && !GLOB_CHARS.test(value.pattern)) return false;
  try {
    normalizeArtifactPatterns([value.text]);
    if (value.pattern) validateGlob(value.pattern);
  } catch { return false; }
  return true;
}

export function validateArtifactPolicy(value: unknown): asserts value is ArtifactPolicy {
  if (!object(value) || Object.keys(value).sort().join('\0') !== 'untrackedArtifacts') {
    throw new Error('Invalid artifact policy: expected untrackedArtifacts.');
  }
  if (!Array.isArray(value.untrackedArtifacts) || !value.untrackedArtifacts.every(validateStoredScopeEntry)) {
    throw new Error('Invalid artifact policy: untrackedArtifacts must contain compiled safe entries.');
  }
}

export function matchesUntrackedArtifact(candidate: string, policy: ArtifactPolicy | undefined): boolean {
  return !!policy && policy.untrackedArtifacts.length > 0 && matchesScope(candidate, policy.untrackedArtifacts);
}
