import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { canonicalPath } from './paths.js';

export function planSlug(text: string): string {
  const slug = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error('Usage: /plan <description>. Include letters or digits for the filename.');
  return slug;
}

// Select a path without reserving it or creating the plan file.
export async function nextPlanPath(root: string, cwd: string, directory: string, slug: string): Promise<string> {
  const safeDirectory = await canonicalPath(root, directory);
  const absoluteDirectory = resolve(root, safeDirectory);
  await mkdir(absoluteDirectory, { recursive: true });
  const entries = await readdir(absoluteDirectory, { withFileTypes: true });
  let highest = 0n;
  for (const entry of entries) {
    if (!entry.isFile() && !entry.isSymbolicLink()) continue;
    const match = /^(\d+)-.+\.md$/i.exec(entry.name);
    if (match) {
      const sequence = BigInt(match[1]);
      if (sequence > highest) highest = sequence;
    }
  }
  const filename = `${String(highest + 1n).padStart(3, '0')}-${slug}.md`;
  const target = join(absoluteDirectory, filename);
  try {
    await lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return relative(cwd, target).split(sep).join('/');
  }
  throw new Error(`Plan path already exists: ${target}`);
}
