import { mkdtemp, writeFile, rm, lstat, readFile, readlink, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative, isAbsolute, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { git } from './git.js';

const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

// Each pre-commit hook runs normally, then this guard rejects index or content edits.
// The manifest is data, not interpolated shell source.
const hookSource = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const dir = path.dirname(process.argv[1]);
const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
const original = path.join(manifest.hooks, path.basename(process.argv[1]));
try {
  let executable = false;
  try { fs.accessSync(original, fs.constants.X_OK); executable = fs.statSync(original).isFile(); }
  catch (e) { if (e.code !== 'ENOENT' && e.code !== 'EACCES') throw e; }
  if (executable) {
    const result = cp.spawnSync(original, process.argv.slice(2), { cwd: manifest.root, stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status || 1);
  }
  const gitEnv = { ...process.env };
  delete gitEnv.GIT_LITERAL_PATHSPECS;
  delete gitEnv.GIT_NOGLOB_PATHSPECS;
  const git = args => cp.execFileSync('git', args, { cwd: manifest.root, maxBuffer: 50 * 1024 * 1024, env: gitEnv });
  const stateExclude = ':!.pi/pi-control/state/**';
  if (git(['rev-parse', 'HEAD']).toString('utf8').trim() !== manifest.head || hash(git(['ls-files', '--stage', '-z', '--', stateExclude])) !== manifest.index || hash(git(['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', stateExclude])) !== manifest.status) {
    throw new Error('hook changed index or Git-visible paths');
  }
  for (const [name, expected] of manifest.files) {
    const absolute = path.join(manifest.root, name);
    let actual;
    try {
      const parent = fs.realpathSync(path.dirname(absolute));
      const rel = path.relative(manifest.root, parent);
      if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) throw new Error('hook created symlink escape');
      const stat = fs.lstatSync(absolute);
      actual = stat.isSymbolicLink() ? ['link', fs.readlinkSync(absolute)] : stat.isFile() ? ['file', stat.mode & 511, hash(fs.readFileSync(absolute))] : ['other', stat.mode];
    } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') actual = ['absent']; else throw e; }
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('hook changed file ' + JSON.stringify(name));
  }
} catch (e) {
  console.error('pi-control: commit refused: ' + e.message + '. Run /verify after reviewing hook changes.');
  process.exit(1);
}
`;

async function fingerprint(root: string, name: string): Promise<unknown[]> {
  const absolute = join(root, name);
  try {
    const parent = await realpath(dirname(absolute));
    const rel = relative(root, parent);
    if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Symlink escape while preparing commit.');
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) return ['link', await readlink(absolute)];
    if (stat.isFile()) return ['file', stat.mode & 0o777, hash(await readFile(absolute))];
    return ['other', stat.mode];
  } catch (e) {
    if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return ['absent'];
    throw e;
  }
}

export async function prepareCommitGuard(root: string, paths: string[]): Promise<{ directory: string; cleanup(): Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-control-commit-'));
  const cleanup = () => rm(directory, { recursive: true, force: true });
  try {
    const hooks = resolve(root, (await git(root, ['rev-parse', '--git-path', 'hooks'])).replace(/\n$/, ''));
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    const stateExclude = ':!.pi/pi-control/state/**';
    const index = hash(await git(root, ['ls-files', '--stage', '-z', '--', stateExclude]));
    const status = hash(await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', stateExclude]));
    const files = await Promise.all([...new Set(paths)].sort().map(async p => [p, await fingerprint(root, p)]));
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ root, hooks, head, index, status, files }), { mode: 0o600 });
    for (const hook of ['pre-commit', 'prepare-commit-msg', 'commit-msg']) await writeFile(join(directory, hook), hookSource, { mode: 0o700 });
    // Post-commit cannot affect the commit being checked. Keep its normal behavior.
    const post = `#!/usr/bin/env node\nconst fs = require('node:fs'); const p = require('node:path'); const cp = require('node:child_process');\nconst m = JSON.parse(fs.readFileSync(p.join(p.dirname(process.argv[1]), 'manifest.json'), 'utf8'));\nconst hook = p.join(m.hooks, 'post-commit');\ntry { fs.accessSync(hook, fs.constants.X_OK); const r = cp.spawnSync(hook, process.argv.slice(2), {cwd:m.root,stdio:'inherit',env:process.env}); process.exit(r.status || 0); } catch(e) { if(e.code !== 'ENOENT' && e.code !== 'EACCES') { console.error(e.message); process.exit(1); } }\n`;
    await writeFile(join(directory, 'post-commit'), post, { mode: 0o700 });
    return { directory, cleanup };
  } catch (e) { await cleanup(); throw e; }
}
