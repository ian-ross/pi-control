import { execFile as execFileCb } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile, readFile, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);

export interface TempRepo {
  root: string;
  git(args: string[]): Promise<string>;
  write(rel: string, content: string | Buffer): Promise<void>;
  read(rel: string): Promise<string>;
  mkdir(rel: string): Promise<void>;
  symlink(target: string, rel: string): Promise<void>;
  chmod(rel: string, mode: number): Promise<void>;
  commitAll(message?: string): Promise<string>;
  cleanup(): Promise<void>;
}

export async function makeTempRepo(): Promise<TempRepo> {
  const root = await mkdtemp(path.join(tmpdir(), 'pi-control-'));

  async function runGit(args: string[]): Promise<string> {
    const { stdout } = await execFile('git', args, {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
    });
    return stdout;
  }

  await runGit(['init']);
  await runGit(['config', 'user.email', 'test@example.invalid']);
  await runGit(['config', 'user.name', 'Test User']);
  await runGit(['config', 'core.autocrlf', 'false']);

  const repo: TempRepo = {
    root,
    git: runGit,
    async write(rel, content) {
      const absolute = path.join(root, rel);
      await mkdir(path.dirname(absolute), { recursive: true });
      await writeFile(absolute, content);
    },
    async read(rel) {
      return readFile(path.join(root, rel), 'utf8');
    },
    async mkdir(rel) {
      await mkdir(path.join(root, rel), { recursive: true });
    },
    async symlink(target, rel) {
      const absolute = path.join(root, rel);
      await mkdir(path.dirname(absolute), { recursive: true });
      await symlink(target, absolute);
    },
    async chmod(rel, mode) {
      await chmod(path.join(root, rel), mode);
    },
    async commitAll(message = 'commit') {
      await runGit(['add', '-A']);
      await runGit(['commit', '-m', message]);
      return (await runGit(['rev-parse', 'HEAD'])).trim();
    },
    async cleanup() {
      await rm(root, { recursive: true, force: true });
    },
  };

  return repo;
}
