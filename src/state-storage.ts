import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, normalize, relative, resolve } from 'node:path';
import { stableDigest } from './digest.js';
import { restoreState, serializeState, type ImplementationRun } from './state.js';

const STATE_DIR = '.pi/pi-control/state';
const DIGEST = /^[a-f0-9]{64}$/;

export interface PersistedControlStateV2 {
  schemaVersion: 2;
  kind: 'pi-control-state-ref';
  run: null | {
    root: string;
    digest: string;
    path: string;
    taskId: string;
    phase: string;
    updatedAt: string;
  };
}

function stateRelativePath(digest: string): string {
  return `${STATE_DIR}/${digest}.json`;
}

function stateAbsolutePath(root: string, digest: string): string {
  return join(root, STATE_DIR, `${digest}.json`);
}

function assertStateDir(root: string): string {
  const dir = join(root, STATE_DIR);
  const rootReal = realpathSync(root);
  const dirReal = realpathSync(dir);
  const rel = relative(rootReal, dirReal);
  if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw invalid();
  return dir;
}

function invalid(): Error {
  return new Error('Invalid or unsupported pi-control state. Active enforcement is disabled. Start a new session and /implement after inspecting repository changes.');
}

function validateRef(ref: PersistedControlStateV2['run']): asserts ref is Exclude<PersistedControlStateV2['run'], null> {
  if (!ref || typeof ref !== 'object') throw invalid();
  if (!isAbsolute(ref.root) || !DIGEST.test(ref.digest) || typeof ref.path !== 'string') throw invalid();
  if (ref.path !== stateRelativePath(ref.digest)) throw invalid();
  if (typeof ref.taskId !== 'string' || !ref.taskId || typeof ref.phase !== 'string' || !ref.phase || typeof ref.updatedAt !== 'string' || !ref.updatedAt) throw invalid();
  const expected = normalize(stateAbsolutePath(ref.root, ref.digest));
  const resolved = normalize(resolve(ref.root, ref.path));
  if (resolved !== expected) throw invalid();
}

export function createStateMarker(run: ImplementationRun | null): PersistedControlStateV2 {
  if (!run) return { schemaVersion: 2, kind: 'pi-control-state-ref', run: null };
  const payload = serializeState(run);
  const digest = stableDigest(payload);
  return {
    schemaVersion: 2,
    kind: 'pi-control-state-ref',
    run: {
      root: run.baseline.root,
      digest,
      path: stateRelativePath(digest),
      taskId: run.task.id,
      phase: run.phase,
      updatedAt: new Date().toISOString(),
    },
  };
}

export function persistStateMarker(run: ImplementationRun | null): PersistedControlStateV2 {
  if (!run) return createStateMarker(null);
  run.stateRevision = (run.stateRevision ?? 0) + 1;
  run.updatedAt = new Date().toISOString();
  const marker = createStateMarker(run);
  if (!marker.run) return marker;
  const payload = serializeState(run);
  if (stableDigest(payload) !== marker.run.digest) throw new Error('pi-control state changed while creating marker. Retry the command.');
  mkdirSync(join(run.baseline.root, STATE_DIR), { recursive: true });
  const dir = assertStateDir(run.baseline.root);
  const target = stateAbsolutePath(run.baseline.root, marker.run.digest);
  const temp = join(dir, `.${marker.run.digest}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`);
  writeFileSync(temp, `${JSON.stringify(payload)}\n`, 'utf8');
  renameSync(temp, target);
  return marker;
}

export function restoreStateMarker(data: unknown): ImplementationRun | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid();
  const marker = data as Record<string, unknown>;
  if (marker.schemaVersion !== 2 || marker.kind !== 'pi-control-state-ref' || !('run' in marker)) throw invalid();
  if (marker.run === null) return null;
  const ref = marker.run as PersistedControlStateV2['run'];
  validateRef(ref);
  let payload: unknown;
  try { assertStateDir(ref.root); payload = JSON.parse(readFileSync(stateAbsolutePath(ref.root, ref.digest), 'utf8')) as unknown; }
  catch { throw invalid(); }
  if (stableDigest(payload) !== ref.digest) throw invalid();
  return restoreState(payload);
}

export function restoreLatestStateForTask(root: string, taskId: string): ImplementationRun | null {
  const dirPath = join(root, STATE_DIR);
  if (!existsSync(dirPath)) return null;
  const rootReal = realpathSync(root);
  const dir = assertStateDir(rootReal);
  const wanted = taskId.toLowerCase();
  const candidates: { run: ImplementationRun; mtimeMs: number }[] = [];

  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.json')) continue;
    const digest = name.slice(0, -'.json'.length);
    if (!DIGEST.test(digest)) continue;
    const path = stateAbsolutePath(rootReal, digest);
    try {
      const payload = JSON.parse(readFileSync(path, 'utf8')) as unknown;
      if (stableDigest(payload) !== digest) continue;
      const run = restoreState(payload);
      if (!run || run.baseline.root !== rootReal || run.task.id.toLowerCase() !== wanted) continue;
      candidates.push({ run, mtimeMs: statSync(path).mtimeMs });
    } catch {
      continue;
    }
  }

  candidates.sort((left, right) => {
    const leftUpdated = Date.parse(left.run.updatedAt ?? '');
    const rightUpdated = Date.parse(right.run.updatedAt ?? '');
    const leftOrder = Number.isFinite(leftUpdated) ? leftUpdated : left.mtimeMs;
    const rightOrder = Number.isFinite(rightUpdated) ? rightUpdated : right.mtimeMs;
    return rightOrder - leftOrder || (right.run.stateRevision ?? -1) - (left.run.stateRevision ?? -1) || right.mtimeMs - left.mtimeMs;
  });

  return candidates[0]?.run ?? null;
}

