import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BacklogTaskError,
  loadTask,
  normalizeTask,
  type BacklogExec,
} from "../src/backlog.ts";

const fixtures = new URL("./fixtures/", import.meta.url);

async function fixture(name: string): Promise<string> {
  return readFile(new URL(name, fixtures), "utf8");
}

async function tempRepo(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pi-control-backlog-"));
  await mkdir(join(root, "src", "generated"), { recursive: true });
  await mkdir(join(root, "tests"), { recursive: true });
  await mkdir(join(root, "config"), { recursive: true });
  return root;
}

test("normalizeTask maps Backlog 1.52.0 task-view JSON", async () => {
  const task = normalizeTask(await fixture("backlog-1.52.0-task-view-valid.json"));

  assert.deepEqual(task, {
    id: "BACK-1",
    title: "Implement parser",
    description: "Add parser logic.\n\nOut of scope:\n- UI",
    acceptanceCriteria: ["Parses basic input", "Rejects malformed input"],
    allowedScope: [
      "src/parser.ts",
      "tests/parser.test.ts",
      "src/generated/",
      "config/**/*.json",
    ],
    verificationCommands: ["npm test -- parser", "npm run lint"],
  });
});

test("normalizeTask rejects actual tasks without scope or verification commands", async () => {
  const missingScope = await fixture("backlog-1.52.0-task-view-missing-scope.json");
  const missingVerification = await fixture("backlog-1.52.0-task-view-missing-verification.json");

  assert.throws(() => normalizeTask(missingScope), /modifiedFiles/i);
  assert.throws(() => normalizeTask(missingVerification), /Verification:/);
});

test("normalizeTask deduplicates normalized scope and verification commands", async () => {
  const raw = JSON.parse(await fixture("backlog-1.52.0-task-view-duplicates.json"));
  raw.task.modifiedFiles = ["src/a.ts", "src\\a.ts", "src/A.ts", "./src/a.ts"];

  const task = normalizeTask(raw);

  assert.deepEqual(task.allowedScope, ["src/a.ts", "src/A.ts"]);
  assert.deepEqual(task.verificationCommands, ["npm test", "npm run lint"]);
});

test("normalizeTask validates the versioned Backlog task-view envelope", () => {
  assert.throws(() => normalizeTask("not json"), /JSON/i);
  assert.throws(() => normalizeTask({ schemaVersion: 2, kind: "task-view", task: {} }), /schemaVersion/i);
  assert.throws(() => normalizeTask({ schemaVersion: 1, kind: "task-list", task: {} }), /task-view/i);
  assert.throws(() => normalizeTask({ schemaVersion: 1, kind: "task-view" }), /task/i);
});

test("normalizeTask rejects malformed task fields", async () => {
  const raw = JSON.parse(await fixture("backlog-1.52.0-task-view-valid.json"));

  for (const [field, value, message] of [
    ["id", "", /id/i],
    ["title", "", /title/i],
    ["description", 1, /description/i],
    ["modifiedFiles", [""], /modifiedFiles/i],
    ["modifiedFiles", ["../escape.ts"], /scope/i],
    ["modifiedFiles", ["/escape.ts"], /scope/i],
    ["definitionOfDone", [{ index: 1, text: "Verification:" }], /Verification:/i],
    ["acceptanceCriteria", [{ index: 1 }], /acceptanceCriteria/i],
  ] as const) {
    const changed = structuredClone(raw);
    changed.task[field] = value;
    assert.throws(() => normalizeTask(changed), message, `field ${field} should fail`);
  }
});

test("loadTask runs backlog with safe arguments and validates aliases", async () => {
  const root = await tempRepo();
  const stdout = await fixture("backlog-1.52.0-task-view-valid.json");
  const calls: unknown[] = [];
  const exec: BacklogExec = async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout, stderr: "", code: 0, killed: false };
  };

  assert.equal((await loadTask(root, "back-1", exec)).id, "BACK-1");
  assert.equal((await loadTask(root, "1", exec)).id, "BACK-1");

  assert.deepEqual(calls, [
    { command: "backlog", args: ["task", "back-1", "--json"], options: { cwd: root, timeout: 30_000 } },
    { command: "backlog", args: ["task", "1", "--json"], options: { cwd: root, timeout: 30_000 } },
  ]);
});

test("loadTask rejects unsafe requested ids before executing", async () => {
  const root = await tempRepo();
  let called = false;
  const exec: BacklogExec = async () => {
    called = true;
    return { stdout: "", stderr: "", code: 0, killed: false };
  };

  await assert.rejects(() => loadTask(root, "BACK-1; rm -rf .", exec), /task id/i);
  assert.equal(called, false);
});

test("loadTask reports CLI failures, bad JSON, and mismatched returned ids", async () => {
  const root = await tempRepo();

  await assert.rejects(
    () => loadTask(root, "BACK-1", async () => ({ stdout: "", stderr: "missing", code: 1, killed: false })),
    /backlog task BACK-1 --json failed/i,
  );
  await assert.rejects(
    () => loadTask(root, "BACK-1", async () => ({ stdout: "{", stderr: "", code: 0, killed: false })),
    /JSON/i,
  );

  const raw = JSON.parse(await fixture("backlog-1.52.0-task-view-valid.json"));
  raw.task.id = "BACK-2";
  await assert.rejects(
    () => loadTask(root, "BACK-1", async () => ({ stdout: JSON.stringify(raw), stderr: "", code: 0, killed: false })),
    /returned task BACK-2/i,
  );
});

test("loadTask delegates scope compilation, including invalid glob checks", async () => {
  const root = await tempRepo();
  const raw = JSON.parse(await fixture("backlog-1.52.0-task-view-valid.json"));
  raw.task.modifiedFiles = ["!src/*.ts"];

  await assert.rejects(
    () => loadTask(root, "BACK-1", async () => ({ stdout: JSON.stringify(raw), stderr: "", code: 0, killed: false })),
    /scope/i,
  );
});

test("configuration errors use a user-facing error class", async () => {
  try {
    normalizeTask({ schemaVersion: 1, kind: "task-view", task: null });
  } catch (error) {
    assert.equal(error instanceof BacklogTaskError, true);
    assert.equal((error as BacklogTaskError).code, "malformed-task");
    return;
  }
  assert.fail("expected error");
});
