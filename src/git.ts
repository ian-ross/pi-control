import { execFile as execFileCb } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, readlink, realpath } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';

import { matchesScope, type ScopeEntry } from './paths.ts';
import { stableDigest } from './digest.ts';

const execFile = promisify(execFileCb);

export type PathFingerprint =
  | { kind: 'absent' }
  | { kind: 'file'; sha256: string; executable: boolean; mode: number; size: number }
  | { kind: 'symlink'; target: string }
  | { kind: 'directory' }
  | { kind: 'other'; mode: number };

export interface IndexFingerprint {
  mode: string;
  object: string;
  stage: string;
}

export interface Baseline {
  root: string;
  head: string;
  dirty: Record<string, PathFingerprint>;
  tracked: Record<string, PathFingerprint>;
  index: Record<string, IndexFingerprint>;
}

export interface Inspection {
  scopeOk: boolean;
  errors: string[];
  changedPaths: string[];
  fingerprints: Record<string, PathFingerprint>;
  stagedPaths: string[];
  head: string;
  contentDigest: string;
}

interface StatusEntry {
  x: string;
  y: string;
  path: string;
  originalPath?: string;
}

interface IndexEntry extends IndexFingerprint {
  path: string;
  tag: string;
}

class UnsafeRepoPathError extends Error {
  constructor(public readonly rel: string, message: string) {
    super(message);
  }
}

const READ_ONLY_GIT = new Set([
  'status',
  'diff',
  'rev-parse',
  'ls-files',
  'cat-file',
  'show',
  'log',
  'merge-base',
]);

function stripOneFinalLf(value: string): string {
  return value.endsWith('\n') ? value.slice(0, -1) : value;
}

function rejectBackslash(value: string, context: string): void {
  if (value.includes('\\')) {
    throw new Error(`${context} contains a literal backslash, which is not supported safely: ${value}`);
  }
}

function normalizeGitPath(value: string): string {
  if (value.includes('\0')) throw new Error('git path contains NUL');
  rejectBackslash(value, 'git path');
  return value.replace(/^\.\//, '');
}

function uniqueSorted(values: Iterable<string>): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

async function execGit(root: string, args: string[], encoding: BufferEncoding | 'buffer' = 'utf8'): Promise<string | Buffer> {
  const options = {
    cwd: root,
    encoding: encoding === 'buffer' ? 'buffer' as const : encoding,
    maxBuffer: 50 * 1024 * 1024,
  };
  const { stdout } = await execFile('git', args, options);
  return stdout;
}

export async function git(root: string, args: string[]): Promise<string> {
  if (!Array.isArray(args) || args.length === 0 || args.some((arg) => typeof arg !== 'string')) {
    throw new Error('git arguments must be a non-empty string array');
  }
  if (!READ_ONLY_GIT.has(args[0])) {
    throw new Error(`git helper only permits read-only commands, got: ${args[0]}`);
  }
  return (await execGit(root, args, 'utf8')) as string;
}

export async function findRoot(cwd: string): Promise<string> {
  const { stdout } = await execFile('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  return realpath(stripOneFinalLf(stdout));
}

async function assertRepositoryRoot(root: string): Promise<string> {
  const rootReal = await realpath(root);
  const found = await findRoot(root);
  if (rootReal !== found) {
    throw new Error(`repository root mismatch: expected ${found}, got ${rootReal}`);
  }
  return found;
}

function parseStatus(raw: string): StatusEntry[] {
  const parts = raw.split('\0');
  if (parts.at(-1) === '') parts.pop();
  const entries: StatusEntry[] = [];

  for (let index = 0; index < parts.length; index += 1) {
    const record = parts[index];
    if (record.length < 4) continue;
    const x = record[0];
    const y = record[1];
    let filePath = record.slice(3);
    let originalPath: string | undefined;

    if (x === 'R' || x === 'C') {
      originalPath = parts[index + 1];
      index += 1;
    }

    filePath = normalizeGitPath(filePath);
    if (originalPath !== undefined) originalPath = normalizeGitPath(originalPath);
    entries.push({ x, y, path: filePath, originalPath });
  }

  return entries;
}

async function statusEntries(root: string): Promise<StatusEntry[]> {
  const raw = (await execGit(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'utf8')) as string;
  return parseStatus(raw);
}

function statusPaths(entries: StatusEntry[]): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    paths.push(entry.path);
    if (entry.originalPath) paths.push(entry.originalPath);
  }
  return uniqueSorted(paths);
}

function stagedPaths(entries: StatusEntry[]): string[] {
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.x !== ' ' && entry.x !== '?') {
      paths.push(entry.path);
      if (entry.originalPath) paths.push(entry.originalPath);
    }
  }
  return uniqueSorted(paths);
}

function parseIndexEntries(raw: string): IndexEntry[] {
  const records = raw.split('\0').filter(Boolean);
  return records.map((record) => {
    const tag = record[0];
    const body = record.slice(2);
    const tab = body.indexOf('\t');
    if (tab === -1) throw new Error(`invalid ls-files record: ${record}`);
    const meta = body.slice(0, tab).split(' ');
    if (meta.length !== 3) throw new Error(`invalid ls-files metadata: ${record}`);
    return {
      tag,
      mode: meta[0],
      object: meta[1],
      stage: meta[2],
      path: normalizeGitPath(body.slice(tab + 1)),
    };
  });
}

async function indexEntries(root: string): Promise<IndexEntry[]> {
  const raw = (await execGit(root, ['ls-files', '-v', '-s', '-z'], 'utf8')) as string;
  return parseIndexEntries(raw);
}

function unsupportedIndexErrors(entries: IndexEntry[]): string[] {
  const errors: string[] = [];
  for (const entry of entries) {
    if (entry.mode === '160000') errors.push(`unsupported-submodule: ${entry.path}`);
    if (entry.stage !== '0') errors.push(`unsupported-unmerged-index: ${entry.path}`);
    if (entry.tag === 'S') errors.push(`unsupported-index-flag skip-worktree: ${entry.path}`);
    if (entry.tag !== entry.tag.toUpperCase()) errors.push(`unsupported-index-flag assume-unchanged: ${entry.path}`);
    if (!['H', 'M', 'R', 'C', 'K', '?', 'S'].includes(entry.tag) && entry.tag === entry.tag.toUpperCase()) {
      errors.push(`unsupported-index-flag ${entry.tag}: ${entry.path}`);
    }
  }
  return uniqueSorted(errors);
}

function indexMap(entries: IndexEntry[]): Record<string, IndexFingerprint> {
  const result: Record<string, IndexFingerprint> = Object.create(null);
  for (const entry of entries) {
    if (entry.stage === '0') result[entry.path] = { mode: entry.mode, object: entry.object, stage: entry.stage };
  }
  return result;
}

function indexModeExecutable(mode: string): boolean {
  return mode === '100755';
}

async function currentHead(root: string): Promise<string> {
  return stripOneFinalLf(await git(root, ['rev-parse', 'HEAD']));
}

function isSubpathOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
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

async function safeRepoPath(rootReal: string, rel: string): Promise<string> {
  if (rel === '' || rel.startsWith('/') || rel.split('/').some((part) => part === '..' || part === '.git' || part === '')) {
    throw new UnsafeRepoPathError(rel, `unsafe repository path: ${rel}`);
  }
  rejectBackslash(rel, 'repository path');

  const parts = rel.split('/');
  let current = rootReal;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const candidate = path.join(current, parts[index]);
    const stat = await lstatOptional(candidate);
    if (!stat) {
      const parentReal = await realpath(current);
      const resolved = path.resolve(parentReal, ...parts.slice(index));
      if (!isSubpathOrEqual(rootReal, resolved)) {
        throw new UnsafeRepoPathError(rel, `path resolves outside repository: ${rel}`);
      }
      return resolved;
    }
    if (stat.isSymbolicLink()) {
      const targetReal = await realpath(candidate);
      if (!isSubpathOrEqual(rootReal, targetReal)) {
        throw new UnsafeRepoPathError(rel, `symlink parent escapes repository: ${rel}`);
      }
      current = targetReal;
    } else {
      current = candidate;
    }
  }

  const finalPath = path.join(current, parts.at(-1) ?? '');
  const parentReal = await realpath(path.dirname(finalPath));
  if (!isSubpathOrEqual(rootReal, parentReal)) {
    throw new UnsafeRepoPathError(rel, `path parent resolves outside repository: ${rel}`);
  }
  return finalPath;
}

async function hashFile(absolute: string): Promise<string> {
  const hash = createHash('sha256');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(absolute);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function fingerprintPath(root: string, rel: string): Promise<PathFingerprint> {
  const rootReal = await realpath(root);
  const absolute = await safeRepoPath(rootReal, rel);

  try {
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      return { kind: 'symlink', target: await readlink(absolute) };
    }
    if (stat.isFile()) {
      return {
        kind: 'file',
        sha256: await hashFile(absolute),
        executable: (stat.mode & 0o111) !== 0,
        mode: stat.mode & 0o7777,
        size: stat.size,
      };
    }
    if (stat.isDirectory()) {
      return { kind: 'directory' };
    }
    return { kind: 'other', mode: stat.mode };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
      return { kind: 'absent' };
    }
    throw error;
  }
}

function sameFingerprint(left: PathFingerprint | undefined, right: PathFingerprint): boolean {
  return stableDigest(left ?? { kind: 'absent' }) === stableDigest(right);
}

async function symlinkTargetRel(rootReal: string, rel: string, target: string): Promise<{ rel?: string; escapes: boolean }> {
  try {
    const absolute = await safeRepoPath(rootReal, rel);
    const linkParent = path.dirname(absolute);
    const lexicalTarget = path.resolve(linkParent, target);
    if (!isSubpathOrEqual(rootReal, lexicalTarget)) return { escapes: true };

    const lexicalRel = path.relative(rootReal, lexicalTarget).split(path.sep).join('/');
    if (lexicalRel !== '') await safeRepoPath(rootReal, lexicalRel);

    try {
      const realTarget = await realpath(lexicalTarget);
      if (!isSubpathOrEqual(rootReal, realTarget)) return { escapes: true };
      return { rel: path.relative(rootReal, realTarget).split(path.sep).join('/'), escapes: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && (error as NodeJS.ErrnoException).code !== 'ENOTDIR') throw error;
      return { rel: lexicalRel, escapes: false };
    }
  } catch (error) {
    if (error instanceof UnsafeRepoPathError) return { escapes: true };
    throw error;
  }
}

async function canonicalPathTargets(rootReal: string, rel: string, fingerprint: PathFingerprint): Promise<{ targets: string[]; escapes: boolean }> {
  const targets = [rel];
  try {
    const absolute = await safeRepoPath(rootReal, rel);
    const parent = path.dirname(absolute);
    if (!isSubpathOrEqual(rootReal, parent)) return { targets, escapes: true };
    const parentRel = path.relative(rootReal, parent).split(path.sep).join('/');
    const parentTarget = parentRel === '' ? path.basename(rel) : `${parentRel}/${path.basename(rel)}`;
    if (parentTarget !== rel) targets.push(parentTarget);

    if (fingerprint.kind === 'symlink') {
      const target = await symlinkTargetRel(rootReal, rel, fingerprint.target);
      if (target.escapes) return { targets, escapes: true };
      if (target.rel && target.rel !== rel) targets.push(target.rel);
    }
    return { targets: uniqueSorted(targets), escapes: false };
  } catch (error) {
    if (error instanceof UnsafeRepoPathError) return { targets, escapes: true };
    throw error;
  }
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateFingerprint(value: unknown): value is PathFingerprint {
  if (!objectRecord(value) || typeof value.kind !== 'string') return false;
  if (value.kind === 'absent' || value.kind === 'directory') return Object.keys(value).length === 1;
  if (value.kind === 'file') {
    return Object.keys(value).sort().join('\0') === 'executable\0kind\0mode\0sha256\0size'
      && typeof value.sha256 === 'string'
      && /^[a-f0-9]{64}$/.test(value.sha256)
      && typeof value.executable === 'boolean'
      && typeof value.mode === 'number'
      && Number.isSafeInteger(value.mode)
      && value.mode >= 0
      && value.mode <= 0o7777
      && typeof value.size === 'number'
      && Number.isSafeInteger(value.size)
      && value.size >= 0;
  }
  if (value.kind === 'symlink') {
    return Object.keys(value).sort().join('\0') === 'kind\0target' && typeof value.target === 'string' && !value.target.includes('\0');
  }
  if (value.kind === 'other') {
    return Object.keys(value).sort().join('\0') === 'kind\0mode'
      && typeof value.mode === 'number'
      && Number.isSafeInteger(value.mode)
      && value.mode >= 0;
  }
  return false;
}

function validatePathMap(value: unknown): value is Record<string, PathFingerprint> {
  if (!objectRecord(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (key === '' || key.includes('\0') || key.includes('\\') || key.startsWith('/') || key.split('/').includes('..') || key.split('/').includes('.git')) return false;
    if (!validateFingerprint(item)) return false;
  }
  return true;
}

function validateIndexMap(value: unknown): value is Record<string, IndexFingerprint> {
  if (!objectRecord(value)) return false;
  for (const [key, item] of Object.entries(value)) {
    if (key === '' || key.includes('\0') || key.includes('\\') || key.startsWith('/') || key.split('/').includes('..') || key.split('/').includes('.git')) return false;
    if (!objectRecord(item)) return false;
    if (Object.keys(item).sort().join('\0') !== 'mode\0object\0stage') return false;
    if (typeof item.mode !== 'string' || !/^[0-7]{6}$/.test(item.mode)) return false;
    if (typeof item.object !== 'string' || !/^[a-f0-9]{40,64}$/.test(item.object)) return false;
    if (item.stage !== '0') return false;
  }
  return true;
}

export function validateBaseline(value: unknown): asserts value is Baseline {
  if (!objectRecord(value)) throw new Error('Invalid baseline: expected object.');
  if (Object.keys(value).sort().join('\0') !== 'dirty\0head\0index\0root\0tracked') {
    throw new Error('Invalid baseline: expected root, head, dirty, tracked, and index.');
  }
  if (typeof value.root !== 'string' || value.root === '' || value.root.includes('\0') || !path.isAbsolute(value.root)) {
    throw new Error('Invalid baseline root.');
  }
  if (typeof value.head !== 'string' || !/^[a-f0-9]{40,64}$/.test(value.head)) {
    throw new Error('Invalid baseline HEAD.');
  }
  if (!validatePathMap(value.dirty)) throw new Error('Invalid baseline dirty map.');
  if (!validatePathMap(value.tracked)) throw new Error('Invalid baseline tracked map.');
  if (!validateIndexMap(value.index)) throw new Error('Invalid baseline index map.');

  const trackedKeys = Object.keys(value.tracked).sort();
  const indexKeys = Object.keys(value.index).sort();
  if (trackedKeys.join('\0') !== indexKeys.join('\0')) {
    throw new Error('Invalid baseline: tracked and index paths differ.');
  }
  for (const filePath of Object.keys(value.dirty)) {
    if (Object.prototype.hasOwnProperty.call(value.tracked, filePath) && !sameFingerprint(value.dirty[filePath], value.tracked[filePath])) {
      throw new Error(`Invalid baseline: dirty tracked fingerprint differs for ${filePath}.`);
    }
  }
}

export async function captureBaseline(root: string, scope: ScopeEntry[]): Promise<Baseline> {
  const repoRoot = await assertRepositoryRoot(root);
  const entries = await indexEntries(repoRoot);
  const indexErrors = unsupportedIndexErrors(entries);
  if (indexErrors.length > 0) {
    throw new Error(indexErrors.join('\n'));
  }

  const status = await statusEntries(repoRoot);
  const staged = stagedPaths(status);
  if (staged.length > 0) {
    throw new Error(`staged changes are not allowed at baseline: ${staged.join(', ')}`);
  }

  const index = indexMap(entries);
  const tracked: Record<string, PathFingerprint> = Object.create(null);
  const modeMismatchPaths: string[] = [];
  for (const entry of entries) {
    if (entry.stage !== '0') continue;
    const fingerprint = await fingerprintPath(repoRoot, entry.path);
    tracked[entry.path] = fingerprint;
    if (fingerprint.kind === 'file' && fingerprint.executable !== indexModeExecutable(entry.mode)) {
      modeMismatchPaths.push(entry.path);
    }
  }

  const dirtyPaths = uniqueSorted([...statusPaths(status), ...modeMismatchPaths]);
  const dirtyInsideScope = dirtyPaths.filter((filePath) => matchesScope(filePath, scope));
  if (dirtyInsideScope.length > 0) {
    throw new Error(`dirty paths inside scope are not allowed at baseline: ${dirtyInsideScope.join(', ')}`);
  }

  const dirty: Record<string, PathFingerprint> = Object.create(null);
  for (const filePath of dirtyPaths) {
    dirty[filePath] = tracked[filePath] ?? await fingerprintPath(repoRoot, filePath);
  }

  return {
    root: repoRoot,
    head: await currentHead(repoRoot),
    dirty,
    tracked,
    index,
  };
}

export async function inspectRun(baseline: Baseline, scope: ScopeEntry[]): Promise<Inspection> {
  validateBaseline(baseline);
  const root = await realpath(baseline.root);
  const foundRoot = await findRoot(root);
  const errors: string[] = [];
  if (root !== foundRoot) {
    errors.push(`repository root mismatch: expected ${foundRoot}, got ${root}`);
  }

  const entries = await indexEntries(root);
  errors.push(...unsupportedIndexErrors(entries));
  const currentIndex = indexMap(entries);

  const head = await currentHead(root);
  if (head !== baseline.head) {
    errors.push(`head-changed: expected ${baseline.head}, got ${head}`);
  }

  const status = await statusEntries(root);
  const staged = stagedPaths(status);
  const currentStatusPaths = statusPaths(status);
  const currentTrackedPaths = entries.filter((entry) => entry.stage === '0').map((entry) => entry.path);
  const candidatePaths = uniqueSorted([
    ...Object.keys(baseline.tracked),
    ...Object.keys(baseline.dirty),
    ...currentTrackedPaths,
    ...currentStatusPaths,
  ]);

  const changedPaths: string[] = [];
  const fingerprints: Record<string, PathFingerprint> = Object.create(null);
  const changedSet = new Set<string>();
  const rootReal = await realpath(root);

  for (const filePath of candidatePaths) {
    let current: PathFingerprint;
    let pathEscapes = false;
    try {
      current = await fingerprintPath(root, filePath);
    } catch (error) {
      if (error instanceof UnsafeRepoPathError) {
        current = { kind: 'absent' };
        pathEscapes = true;
      } else {
        throw error;
      }
    }

    const wasDirtyAtBaseline = Object.prototype.hasOwnProperty.call(baseline.dirty, filePath);
    const wasTrackedAtBaseline = Object.prototype.hasOwnProperty.call(baseline.tracked, filePath);
    const changedSinceBaseline = wasTrackedAtBaseline
      ? !sameFingerprint(baseline.tracked[filePath], current)
      : wasDirtyAtBaseline
        ? !sameFingerprint(baseline.dirty[filePath], current)
        : currentStatusPaths.includes(filePath) || currentTrackedPaths.includes(filePath);

    const indexChangedForBaselineDirty = wasDirtyAtBaseline
      && stableDigest(Object.hasOwn(baseline.index, filePath) ? baseline.index[filePath] : null) !== stableDigest(currentIndex[filePath] ?? null);

    if (!changedSinceBaseline && !pathEscapes) {
      if (indexChangedForBaselineDirty) errors.push(`baseline-dirty-index-changed: ${filePath}`);
      continue;
    }

    if (changedSinceBaseline) {
      changedPaths.push(filePath);
      changedSet.add(filePath);
      fingerprints[filePath] = current;
    }

    if (wasDirtyAtBaseline && changedSinceBaseline) {
      errors.push(`baseline-dirty-changed: ${filePath}`);
    }
    if (indexChangedForBaselineDirty) {
      errors.push(`baseline-dirty-index-changed: ${filePath}`);
    }

    const auth = pathEscapes ? { targets: [filePath], escapes: true } : await canonicalPathTargets(rootReal, filePath, current);
    if (auth.escapes) {
      errors.push(`symlink-escape: ${filePath}`);
    }
    for (const target of auth.targets) {
      if (!matchesScope(target, scope)) {
        errors.push(target === filePath ? `out-of-scope: ${filePath}` : `out-of-scope-target: ${filePath} -> ${target}`);
      }
    }
  }

  for (const filePath of staged) {
    let current = fingerprints[filePath];
    let pathEscapes = false;
    if (!current) {
      try {
        current = await fingerprintPath(root, filePath);
      } catch (error) {
        if (error instanceof UnsafeRepoPathError) {
          current = { kind: 'absent' };
          pathEscapes = true;
        } else {
          throw error;
        }
      }
    }
    const auth = pathEscapes ? { targets: [filePath], escapes: true } : await canonicalPathTargets(rootReal, filePath, current);
    if (auth.escapes) errors.push(`symlink-escape: ${filePath}`);
    const allowed = changedSet.has(filePath) && !auth.escapes && auth.targets.every((target) => matchesScope(target, scope));
    const wasDirtyAtBaseline = Object.prototype.hasOwnProperty.call(baseline.dirty, filePath);
    if (wasDirtyAtBaseline) {
      errors.push(`baseline-dirty-index-changed: ${filePath}`);
    } else if (!allowed) {
      errors.push(`staged change is not allowed: ${filePath}`);
    }
  }

  const sortedChanged = uniqueSorted(changedPaths);
  const sortedFingerprints: Record<string, PathFingerprint> = Object.create(null);
  for (const filePath of sortedChanged) {
    sortedFingerprints[filePath] = fingerprints[filePath];
  }

  const contentDigest = stableDigest({
    root,
    head,
    changedPaths: sortedChanged,
    fingerprints: sortedFingerprints,
  });

  return {
    scopeOk: errors.length === 0,
    errors: uniqueSorted(errors),
    changedPaths: sortedChanged,
    fingerprints: sortedFingerprints,
    stagedPaths: staged,
    head,
    contentDigest,
  };
}
