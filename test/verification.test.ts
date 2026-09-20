import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { test } from "node:test";

import { runCommand, TRUNCATION_MARKER } from "../src/process.ts";
import { compileScope } from "../src/paths.ts";
import { captureBaseline } from '../src/git.js';
import { runVerification } from "../src/verification.ts";

const execFileAsync = promisify(execFile);

async function makeTempDir(): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), "pi-control-verification-"));
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function makeRepo(): Promise<{ repo: string; head: string }> {
  const repo = await makeTempDir();
  await git(repo, ["init"]);
  await writeFile(path.join(repo, "allowed.txt"), "initial\n");
  await git(repo, ["add", "allowed.txt"]);
  await git(repo, ["-c", "user.name=Pi Control", "-c", "user.email=pi-control@example.invalid", "commit", "-m", "initial"]);
  const head = await git(repo, ["rev-parse", "HEAD"]);
  return { repo, head };
}

test("runVerification runs commands sequentially and reports every failure", async () => {
  const seen: string[] = [];
  const starts: string[] = [];
  const result = await runVerification(
    {
      baseline: { root: "/tmp/repo", head: "a".repeat(40), dirty: {}, tracked: {}, index: {} },
      task: { id: "BACK-1", title: "x", acceptanceCriteria: [], allowedScope: ["src/a.ts"], verificationCommands: ["first", "second"] },
      scope: [{ text: "src/a.ts", kind: "file", pattern: "src/a.ts" }],
      shell: "/bin/bash",
      timeoutMs: 1000,
      onCommandStart: ({ command, index, total }) => starts.push(`${index}/${total} ${command}`),
    },
    {
      inspectRun: () => ({
        scopeOk: true,
        errors: [],
        changedPaths: [],
        fingerprints: {},
        stagedPaths: [],
        head: "abc",
        contentDigest: "clean",
      }),
      runner: async ({ command }) => {
        seen.push(command);
        return { command, code: command === "first" ? 1 : 2, durationMs: 1, stdout: "", stderr: "boom", timedOut: false, cancelled: false };
      },
      now: () => new Date("2024-01-01T00:00:00.000Z"),
    },
  );

  assert.deepEqual(starts, ["1/2 first", "2/2 second"]);
  assert.deepEqual(seen, ["first", "second"]);
  assert.equal(result.commands.length, 2);
  assert.equal(result.checksOk, false);
  assert.equal(result.passed, false);
  assert.match(result.errors.join("\n"), /first/);
  assert.match(result.errors.join("\n"), /second/);
});

test("runCommand times out process groups", async () => {
  const result = await runCommand({
    command: "node -e \"setTimeout(() => {}, 5000)\"",
    shell: "/bin/bash",
    timeoutMs: 100,
    cwd: process.cwd(),
  });

  assert.equal(result.command.includes("setTimeout"), true);
  assert.equal(result.timedOut, true);
  assert.equal(result.cancelled, false);
  assert.equal(result.code, null);
  assert.ok(result.durationMs < 3000);
});

test("runCommand cancels running commands", async () => {
  const controller = new AbortController();
  const promise = runCommand({
    command: "node -e \"setTimeout(() => {}, 5000)\"",
    shell: "/bin/bash",
    timeoutMs: 5000,
    cwd: process.cwd(),
    signal: controller.signal,
  });

  setTimeout(() => controller.abort(), 50);
  const result = await promise;

  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.code, null);
  assert.ok(result.durationMs < 3000);
});

test("runCommand bounds stdout and stderr with a truncation marker", async () => {
  const result = await runCommand({
    command: "node -e \"process.stdout.write('A'.repeat(20000)); process.stderr.write('B'.repeat(20000))\"",
    shell: "/bin/bash",
    timeoutMs: 2000,
    cwd: process.cwd(),
  });

  assert.equal(result.code, 0);
  assert.ok(Buffer.byteLength(result.stdout) <= 8192);
  assert.ok(Buffer.byteLength(result.stderr) <= 8192);
  assert.match(result.stdout, new RegExp(TRUNCATION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(result.stderr, new RegExp(TRUNCATION_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("runVerification detects command mutations and keeps digest stable after staging identical content", async () => {
  const { repo } = await makeRepo();
  try {
    const scope = await compileScope(repo, ["allowed.txt"]);
    const baseline = await captureBaseline(repo, scope);
    const task = { id: "BACK-2", title: "x", acceptanceCriteria: [], allowedScope: ["allowed.txt"], verificationCommands: ["printf changed > allowed.txt"] };

    const mutating = await runVerification({ baseline, task, scope, shell: "/bin/bash", timeoutMs: 2000 });
    assert.equal(mutating.scopeOk, true);
    assert.equal(mutating.passed, false);
    assert.deepEqual(mutating.changedPaths, ["allowed.txt"]);
    assert.ok(mutating.errors.includes("verification-mutated-worktree"));

    const cleanCheckTask = { ...task, verificationCommands: ["true"] };
    const verified = await runVerification({ baseline, task: cleanCheckTask, scope, shell: "/bin/bash", timeoutMs: 2000 });
    assert.equal(verified.passed, true);

    await git(repo, ["add", "allowed.txt"]);
    const staged = await runVerification({ baseline, task: cleanCheckTask, scope, shell: "/bin/bash", timeoutMs: 2000 });
    assert.equal(staged.scopeOk, true);
    assert.equal(staged.digest, verified.digest);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('out-of-scope check mutations fail both verification layers', async () => {
  const { repo } = await makeRepo();
  try {
    const scope = await compileScope(repo, ['allowed.txt']);
    const baseline = await captureBaseline(repo, scope);
    const task = { id: 'BACK-3', title: 'x', acceptanceCriteria: [], allowedScope: ['allowed.txt'], verificationCommands: ['printf unexpected > outside.txt', 'true'] };
    const result = await runVerification({ baseline, scope, task, shell: '/bin/bash', timeoutMs: 2000 });
    assert.equal(result.scopeOk, false);
    assert.equal(result.passed, false);
    assert.equal(result.commands.length, 2);
    assert.match(result.scopeErrors.join('\n'), /outside.txt/);
    assert.ok(result.errors.includes('verification-mutated-worktree'));
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('pre-cancelled verification records skipped checks without starting a process', async () => {
  const { repo } = await makeRepo();
  try {
    const scope = await compileScope(repo, ['allowed.txt']);
    const baseline = await captureBaseline(repo, scope);
    const task = { id: 'BACK-4', title: 'x', acceptanceCriteria: [], allowedScope: ['allowed.txt'], verificationCommands: ['true', 'false'] };
    const signal = AbortSignal.abort();
    let launched = 0;
    const result = await runVerification({ baseline, scope, task, shell: '/bin/bash', timeoutMs: 2000, signal }, { runner: async () => { launched++; throw new Error('must not launch'); } });
    assert.equal(launched, 0);
    assert.equal(result.commands.length, 2);
    assert.ok(result.commands.every(c => c.cancelled));
    assert.equal(result.passed, false);
  } finally { await rm(repo, { recursive: true, force: true }); }
});
