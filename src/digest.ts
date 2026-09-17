import { createHash } from 'node:crypto';

import type { Baseline, Inspection, PathFingerprint } from './git.ts';
import type { ScopeEntry } from './paths.ts';

function canonicalize(value: unknown): unknown {
  if (value === null) return null;
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(input).sort()) {
      const item = input[key];
      if (item !== undefined) output[key] = canonicalize(item);
    }
    return output;
  }
  return value;
}

export function stableDigest(value: unknown): string {
  const json = JSON.stringify(canonicalize(value));
  return createHash('sha256').update(json).digest('hex');
}

export function verificationDigest(
  baseline: Baseline,
  taskId: string,
  scope: ScopeEntry[],
  commands: string[],
  inspection: Inspection,
): string {
  const changedPaths = [...inspection.changedPaths].sort((a, b) => a.localeCompare(b));
  const fingerprints: Record<string, PathFingerprint> = Object.create(null);
  for (const filePath of changedPaths) {
    fingerprints[filePath] = inspection.fingerprints[filePath];
  }

  return stableDigest({
    root: baseline.root,
    head: baseline.head,
    taskId,
    scope: scope.map((entry) => ({ text: entry.text, kind: entry.kind, pattern: entry.pattern })),
    commands,
    changedPaths,
    fingerprints,
  });
}
