import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
type PicomatchOptions = { dot?: boolean; strictBrackets?: boolean; nonegate?: boolean };
type Picomatch = ((pattern: string | string[], options?: PicomatchOptions) => (value: string) => boolean) & {
  scan?: (pattern: string, options?: PicomatchOptions) => { isGlob: boolean };
};

const picomatch = require('picomatch') as Picomatch;

export interface ScopeEntry {
  text: string;
  kind: 'file' | 'directory' | 'glob';
  pattern: string;
}

const GLOB_CHARS = /[*?{}[\]()+@!]/;
const DRIVE_PATH = /^[A-Za-z]:(?:[\\/]|$|[^\\/])/;
const MATCH_OPTIONS: PicomatchOptions = { dot: true, strictBrackets: true, nonegate: true };

function hasNul(value: string): boolean {
  return value.includes('\0');
}

function rejectBackslash(value: string, context: string): void {
  if (value.includes('\\')) {
    throw new Error(`${context} contains a backslash, which is not supported safely: ${value}`);
  }
}

function splitInput(value: string): string[] {
  return value.split('/').filter((part) => part.length > 0 && part !== '.');
}

function hasTraversal(value: string): boolean {
  return splitInput(value).includes('..');
}

function hasGitMetadata(value: string): boolean {
  return splitInput(value).includes('.git');
}

function isWindowsDrivePath(value: string): boolean {
  return DRIVE_PATH.test(value);
}

function isAbsoluteAnyPlatform(value: string): boolean {
  return path.isAbsolute(value) || isWindowsDrivePath(value);
}

function isSubpathOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function assertSafeRelativeResult(value: string): string {
  const normalized = value.split(path.sep).join('/');
  if (normalized === '' || normalized === '.') return '';
  if (normalized.startsWith('../') || normalized === '..' || isAbsoluteAnyPlatform(normalized)) {
    throw new Error(`path escapes repository: ${value}`);
  }
  if (hasGitMetadata(normalized)) {
    throw new Error(`path targets git metadata: ${value}`);
  }
  rejectBackslash(normalized, 'path');
  return normalized;
}

async function lstatOptional(absolute: string) {
  try {
    return await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      return null;
    }
    throw error;
  }
}

export async function canonicalPath(root: string, input: string): Promise<string> {
  if (typeof input !== 'string' || input === '') {
    throw new Error('empty path is not allowed');
  }
  if (hasNul(input)) {
    throw new Error('NUL is not allowed in paths');
  }
  input = input.replace(/\\/g, '/');
  if (isWindowsDrivePath(input)) {
    throw new Error(`absolute scope entries are not allowed: ${input}`);
  }
  if (hasTraversal(input)) {
    throw new Error(`path traversal is not allowed: ${input}`);
  }
  if (hasGitMetadata(input)) {
    throw new Error(`path targets git metadata: ${input}`);
  }

  const rootReal = await realpath(root);
  const lexicalAbsolute = path.resolve(path.isAbsolute(input) ? input : path.join(rootReal, input));

  if (!isSubpathOrEqual(rootReal, lexicalAbsolute)) {
    throw new Error(`path is outside repository: ${input}`);
  }

  const relativeLexical = path.relative(rootReal, lexicalAbsolute);
  const parts = relativeLexical === '' ? [] : relativeLexical.split(path.sep).filter(Boolean);
  let current = rootReal;

  for (let index = 0; index < parts.length; index += 1) {
    const candidate = path.join(current, parts[index]);
    const stat = await lstatOptional(candidate);

    if (!stat) {
      const rest = parts.slice(index).join(path.sep);
      const parentReal = await realpath(current);
      if (!isSubpathOrEqual(rootReal, parentReal)) {
        throw new Error(`nearest existing parent is outside repository: ${input}`);
      }
      const resolved = path.resolve(parentReal, rest);
      if (!isSubpathOrEqual(rootReal, resolved)) {
        throw new Error(`path is outside repository: ${input}`);
      }
      return assertSafeRelativeResult(path.relative(rootReal, resolved));
    }

    if (stat.isSymbolicLink()) {
      const targetReal = await realpath(candidate);
      if (!isSubpathOrEqual(rootReal, targetReal)) {
        throw new Error(`symlink escapes outside repository: ${input}`);
      }
      current = targetReal;
    } else {
      current = candidate;
    }
  }

  const finalReal = await realpath(current);
  if (!isSubpathOrEqual(rootReal, finalReal)) {
    throw new Error(`path is outside repository: ${input}`);
  }
  return assertSafeRelativeResult(path.relative(rootReal, finalReal));
}

function splitTopLevel(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (char === ',' && depth === 0) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function expandBracesConservative(value: string, limit = 256): string[] {
  const start = value.indexOf('{');
  if (start === -1) return [value];
  let depth = 0;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      const prefix = value.slice(0, start);
      const suffix = value.slice(index + 1);
      const choices = splitTopLevel(value.slice(start + 1, index));
      const expanded: string[] = [];
      for (const choice of choices) {
        for (const item of expandBracesConservative(`${prefix}${choice}${suffix}`, limit)) {
          expanded.push(item);
          if (expanded.length > limit) throw new Error(`glob expands to too many alternatives: ${value}`);
        }
      }
      return expanded;
    }
  }
  return [value];
}

function assertPatternDoesNotAuthorizeMetadataOrTraversal(pattern: string): void {
  for (const expanded of expandBracesConservative(pattern)) {
    if (isAbsoluteAnyPlatform(expanded)) throw new Error(`absolute scope entries are not allowed: ${pattern}`);
    if (hasTraversal(expanded) || /(?:^|[/(|])\.\.(?:[/)|]|$)/.test(expanded)) {
      throw new Error(`path traversal is not allowed in scope entry: ${pattern}`);
    }
    if (hasGitMetadata(expanded)) {
      throw new Error(`scope entry targets git metadata: ${pattern}`);
    }
  }
}

function looksLikeGlob(entry: string): boolean {
  if (picomatch.scan) {
    return picomatch.scan(entry, MATCH_OPTIONS).isGlob || GLOB_CHARS.test(entry);
  }
  return GLOB_CHARS.test(entry);
}

function validateGlob(pattern: string): void {
  if (pattern === '') {
    throw new Error('empty scope entry is not allowed');
  }
  if (hasNul(pattern)) {
    throw new Error('NUL is not allowed in scope entries');
  }
  rejectBackslash(pattern, 'glob pattern');
  if (pattern.startsWith('!') && !pattern.startsWith('!(')) {
    throw new Error(`invalid glob pattern: ${pattern}`);
  }
  if (isAbsoluteAnyPlatform(pattern)) {
    throw new Error(`absolute scope entries are not allowed: ${pattern}`);
  }
  assertPatternDoesNotAuthorizeMetadataOrTraversal(pattern);

  try {
    picomatch(pattern, MATCH_OPTIONS);
  } catch (error) {
    throw new Error(`invalid glob pattern: ${pattern}: ${(error as Error).message}`);
  }
}

function staticGlobPrefix(pattern: string): string {
  const parts = pattern.split('/');
  const prefix: string[] = [];
  for (const part of parts) {
    if (GLOB_CHARS.test(part)) break;
    prefix.push(part);
  }
  return prefix.join('/');
}

async function canonicalizeGlobPattern(root: string, pattern: string): Promise<string> {
  const prefix = staticGlobPrefix(pattern);
  if (prefix === '') return pattern;
  const canonicalPrefix = await canonicalPath(root, prefix);
  const suffix = pattern.slice(prefix.length);
  return canonicalPrefix ? `${canonicalPrefix}${suffix}` : suffix.replace(/^\/+/, '');
}

export async function compileScope(root: string, entries: string[]): Promise<ScopeEntry[]> {
  const compiled: ScopeEntry[] = [];
  const seen = new Set<string>();

  for (const text of entries) {
    if (typeof text !== 'string' || text === '') {
      throw new Error('empty scope entry is not allowed');
    }
    if (hasNul(text)) {
      throw new Error('NUL is not allowed in scope entries');
    }
    const normalized = text.replace(/\\/g, '/');
    if (isWindowsDrivePath(normalized)) {
      throw new Error(`absolute scope entries are not allowed: ${text}`);
    }
    if (normalized.startsWith('!') && !normalized.startsWith('!(')) {
      throw new Error(`invalid glob pattern: ${text}`);
    }
    if (isAbsoluteAnyPlatform(normalized)) {
      throw new Error(`absolute scope entries are not allowed: ${text}`);
    }
    assertPatternDoesNotAuthorizeMetadataOrTraversal(normalized);

    let entry: ScopeEntry;
    if (looksLikeGlob(normalized)) {
      validateGlob(normalized);
      entry = { text, kind: 'glob', pattern: await canonicalizeGlobPattern(root, normalized) };
    } else {
      const directoryHint = normalized.endsWith('/');
      const withoutTrailing = normalized.replace(/\/+$/, '');
      const pattern = await canonicalPath(root, withoutTrailing === '' ? '.' : withoutTrailing);
      let kind: ScopeEntry['kind'] = 'file';
      if (directoryHint) {
        kind = 'directory';
      } else {
        try {
          const rootReal = await realpath(root);
          const stat = await lstat(path.join(rootReal, pattern));
          if (stat.isDirectory()) kind = 'directory';
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') {
            throw error;
          }
        }
      }
      entry = { text, kind, pattern };
    }

    const key = `${entry.kind}\0${entry.pattern}`;
    if (!seen.has(key)) {
      seen.add(key);
      compiled.push(entry);
    }
  }

  return compiled;
}

function normalizeCandidate(candidate: string): string | null {
  if (typeof candidate !== 'string' || candidate === '') return null;
  if (hasNul(candidate) || candidate.includes('\\')) return null;
  const normalized = candidate.replace(/^\.\//, '');
  if (isAbsoluteAnyPlatform(normalized) || hasTraversal(normalized) || hasGitMetadata(normalized)) return null;
  return normalized;
}

export function matchesScope(candidate: string, scope: ScopeEntry[]): boolean {
  const normalized = normalizeCandidate(candidate);
  if (normalized === null) return false;

  for (const entry of scope) {
    if (entry.kind === 'file' && normalized === entry.pattern) {
      return true;
    }
    if (entry.kind === 'directory') {
      if (entry.pattern === '') return normalized !== '';
      if (normalized.startsWith(`${entry.pattern}/`)) return true;
    }
    if (entry.kind === 'glob') {
      if (picomatch(entry.pattern, MATCH_OPTIONS)(normalized)) return true;
    }
  }

  return false;
}
