import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BacklogTaskError,
  assertClaimable,
  claimTask,
  loadTask,
  normalizeTask,
  requireAutoCommitDisabled,
  type BacklogExec,
  type ClaimSettings,
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

const claimSettings: ClaimSettings = {
  claimAssignee: "@pi-control",
  readyStatus: "To Do",
  inProgressStatus: "In Progress",
};

async function taskView(overrides: Record<string, unknown> = {}): Promise<string> {
  const raw = JSON.parse(await fixture("backlog-1.52.0-task-view-valid.json"));
  raw.task = { ...raw.task, ...overrides };
  return JSON.stringify(raw);
}

test("normalizeTask maps Backlog 1.52.0 task-view JSON", async () => {
  const task = normalizeTask(await fixture("backlog-1.52.0-task-view-valid.json"));

  assert.deepEqual(task, {
    id: "BACK-1",
    title: "Implement parser",
    description: "Add parser logic.\n\nOut of scope:\n- UI",
    implementationPlan: '1. Extend parseTimestamp in src/parser.ts to read numeric UTC offsets.\n2. Preserve naive timestamp handling; reject malformed offsets.\n3. Add offset and invalid-input cases to tests/parser.test.ts.\n4. Run the task verification commands.',
    lifecycle: {
      path: "backlog/tasks/back-1 - Implement-parser.md",
      status: "To Do",
      assignees: [],
    },
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

test("normalizeTask validates lifecycle status, assignees, and safe task path", async () => {
  const raw = JSON.parse(await fixture("backlog-1.52.0-task-view-valid.json"));
  raw.task.status = "In Progress";
  raw.task.assignees = ["@pi-control"];
  raw.task.path = "backlog/tasks/back-1 - Implement-parser.md";

  assert.deepEqual(normalizeTask(raw).lifecycle, {
    path: "backlog/tasks/back-1 - Implement-parser.md",
    status: "In Progress",
    assignees: ["@pi-control"],
  });

  for (const [field, value, message] of [
    ["path", "", /path/i],
    ["path", "backlog/tasks/../back-1.md", /path/i],
    ["path", "backlog//tasks/back-1.md", /path/i],
    ["path", "/backlog/tasks/back-1.md", /relative/i],
    ["path", "backlog\\tasks\\back-1.md", /POSIX/i],
    ["path", "backlog/.git/back-1.md", /\.git/i],
    ["path", "backlog/tasks/back-1.txt", /Markdown/i],
    ["status", "", /status/i],
    ["status", "Done\u0000", /status/i],
    ["assignees", ["@pi-control", ""], /assignees\[1\]/i],
    ["assignees", "@pi-control", /assignees/i],
  ] as const) {
    const changed = structuredClone(raw);
    changed.task[field] = value;
    assert.throws(() => normalizeTask(changed), message, `field ${field} should fail`);
  }
});

test('normalization preserves the full implementation plan and rejects missing or malformed plans', async () => {
  const raw = JSON.parse(await fixture('backlog-1.52.0-task-view-valid.json'));
  const plan = ' 1. Inspect src/parser.ts.\n\n2. Keep offsets intact.\n\t- Test malformed offsets.\n';
  raw.task.implementationPlan = plan;
  assert.equal(normalizeTask(raw).implementationPlan, plan);
  for (const value of [undefined, null, '', ' \n\t ', 42, { steps: ['Do it'] }]) {
    raw.task.implementationPlan = value;
    assert.throws(() => normalizeTask(raw), /implementationPlan.*--plan/);
  }
});

test('loadTask refuses a real task without a plan and provides the CLI repair command', async () => {
  const stdout = await fixture('backlog-1.52.0-task-view-missing-plan.json');
  await assert.rejects(
    () => loadTask('/fixture/repo', 'BACK-1', async () => ({ stdout, stderr: '', code: 0, killed: false })),
    /implementationPlan.*backlog task edit.*--plan/,
  );
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
  raw.task.implementationPlan = '1. Update src/a.ts.\n2. Run the task verification commands.';

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

test('auto-commit prerequisite accepts only CLI false and never changes configuration', async () => {
  const calls: unknown[] = [];
  await requireAutoCommitDisabled('/fixture/repo', async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout: 'false\n', stderr: '', code: 0, killed: false };
  });
  assert.deepEqual(calls, [{ command: 'backlog', args: ['config', 'get', 'autoCommit'], options: { cwd: '/fixture/repo', timeout: 30_000 } }]);
});

test('auto-commit prerequisite rejects enabled, unknown, and missing values', async () => {
  for (const stdout of ['true\n', '', 'undefined\n', 'False\n', '0\n', 'autoCommit = false\n', 'false\ntrue\n']) {
    await assert.rejects(
      () => requireAutoCommitDisabled('/fixture/repo', async () => ({ stdout, stderr: '', code: 0, killed: false })),
      error => error instanceof BacklogTaskError && error.code === 'backlog-config' && /backlog config set autoCommit false/.test(error.message),
    );
  }
});

test('auto-commit prerequisite fails closed on CLI errors, timeouts, and missing executable', async () => {
  for (const result of [
    { stdout: '', stderr: 'No Backlog.md project found.', code: 1, killed: false },
    { stdout: 'false\n', stderr: '', code: 1, killed: false },
    { stdout: 'false\n', stderr: '', code: 0, killed: true },
  ]) {
    await assert.rejects(() => requireAutoCommitDisabled('/fixture/repo', async () => result), /backlog config get autoCommit failed/);
  }
  await assert.rejects(() => requireAutoCommitDisabled('/fixture/repo', async () => { throw new Error('spawn backlog ENOENT'); }), /ENOENT/);
});

test("assertClaimable accepts configured ready and active aliases", async () => {
  const ready = normalizeTask(await taskView({ status: "to do", assignees: ["pi-control"] }));
  assert.equal(assertClaimable(ready, claimSettings), ready.lifecycle);

  const active = normalizeTask(await taskView({ status: "IN PROGRESS", assignees: ["@pi-control"] }));
  assert.equal(assertClaimable(active, claimSettings), active.lifecycle);
});

test("assertClaimable refuses terminal status and other assignees", async () => {
  const done = normalizeTask(await taskView({ status: "Done", assignees: [] }));
  assert.throws(() => assertClaimable(done, claimSettings), /status.*Done/i);

  const otherOwner = normalizeTask(await taskView({ status: "To Do", assignees: ["@someone-else"] }));
  assert.throws(() => assertClaimable(otherOwner, claimSettings), /assigned to/i);
});

test("claimTask edits a claim with safe argv and validates the read-back", async () => {
  const root = await tempRepo();
  const initial = normalizeTask(await taskView());
  const calls: unknown[] = [];
  let edited = false;
  const exec: BacklogExec = async (command, args, options) => {
    calls.push({ command, args, options });
    if (args[0] === "task" && args[1] === "BACK-1" && args[2] === "--json") {
      return { stdout: edited ? await taskView({ status: "In Progress", assignees: ["@pi-control"] }) : await taskView(), stderr: "", code: 0, killed: false };
    }
    if (args[0] === "config") return { stdout: "false\n", stderr: "", code: 0, killed: false };
    if (args[0] === "task" && args[1] === "edit") {
      edited = true;
      return { stdout: "", stderr: "", code: 0, killed: false };
    }
    throw new Error(`unexpected call ${command} ${args.join(" ")}`);
  };

  const claimed = await claimTask(root, initial, claimSettings, exec);

  assert.deepEqual(claimed.lifecycle, {
    path: "backlog/tasks/back-1 - Implement-parser.md",
    status: "In Progress",
    assignees: ["@pi-control"],
  });
  assert.deepEqual(calls, [
    { command: "backlog", args: ["task", "BACK-1", "--json"], options: { cwd: root, timeout: 30_000 } },
    { command: "backlog", args: ["config", "get", "autoCommit"], options: { cwd: root, timeout: 30_000 } },
    { command: "backlog", args: ["task", "edit", "BACK-1", "--status", "In Progress", "--assignee", "@pi-control"], options: { cwd: root, timeout: 30_000 } },
    { command: "backlog", args: ["task", "BACK-1", "--json"], options: { cwd: root, timeout: 30_000 } },
  ]);
});

test("claimTask is idempotent for an active claim with an assignee alias", async () => {
  const root = await tempRepo();
  const stdout = await taskView({ status: "In Progress", assignees: ["pi-control"] });
  const initial = normalizeTask(stdout);
  const calls: unknown[] = [];

  const claimed = await claimTask(root, initial, claimSettings, async (command, args, options) => {
    calls.push({ command, args, options });
    return { stdout, stderr: "", code: 0, killed: false };
  });

  assert.deepEqual(claimed.lifecycle?.assignees, ["pi-control"]);
  assert.deepEqual(calls, [
    { command: "backlog", args: ["task", "BACK-1", "--json"], options: { cwd: root, timeout: 30_000 } },
  ]);
});

test('claimTask accepts Backlog canonical status casing and remains idempotent', async () => {
  const root = await tempRepo();
  const settings = { ...claimSettings, inProgressStatus: 'in progress' };
  const initial = normalizeTask(await taskView());
  let edited = false;
  const claimed = await claimTask(root, initial, settings, async (_command, args) => {
    if (args[0] === 'config') return { stdout: 'false\n', stderr: '', code: 0, killed: false };
    if (args[1] === 'edit') edited = true;
    return { stdout: edited ? await taskView({ status: 'In Progress', assignees: ['@pi-control'] }) : await taskView(), stderr: '', code: 0, killed: false };
  });
  assert.equal(claimed.lifecycle?.status, 'In Progress');
  const calls: string[] = [];
  await claimTask(root, claimed, settings, async (_command, args) => {
    calls.push(args.join(' '));
    return { stdout: await taskView({ status: 'In Progress', assignees: ['@pi-control'] }), stderr: '', code: 0, killed: false };
  });
  assert.deepEqual(calls, ['task BACK-1 --json']);
});

test('claimTask refuses a BACKLOG_CWD override for another project before any CLI call', async () => {
  const root = await tempRepo();
  const other = await tempRepo();
  const initial = normalizeTask(await taskView());
  const previous = process.env.BACKLOG_CWD;
  let called = false;
  try {
    process.env.BACKLOG_CWD = other;
    await assert.rejects(() => claimTask(root, initial, claimSettings, async () => {
      called = true;
      throw new Error('must not run');
    }), /BACKLOG_CWD does not match/);
    assert.equal(called, false);
  } finally {
    if (previous === undefined) delete process.env.BACKLOG_CWD;
    else process.env.BACKLOG_CWD = previous;
  }
});

test("claimTask refuses other owners and terminal status before mutation", async () => {
  const root = await tempRepo();
  for (const stdout of [
    await taskView({ status: "Done", assignees: [] }),
    await taskView({ status: "To Do", assignees: ["@other"] }),
  ]) {
    const initial = normalizeTask(stdout);
    const calls: unknown[] = [];
    await assert.rejects(
      () => claimTask(root, initial, claimSettings, async (command, args, options) => {
        calls.push({ command, args, options });
        return { stdout, stderr: "", code: 0, killed: false };
      }),
      /status|assigned/i,
    );
    assert.deepEqual(calls, [
      { command: "backlog", args: ["task", "BACK-1", "--json"], options: { cwd: root, timeout: 30_000 } },
    ]);
  }
});

test("claimTask checks auto-commit immediately before editing", async () => {
  const root = await tempRepo();
  const initial = normalizeTask(await taskView());
  const calls: string[] = [];

  await assert.rejects(
    () => claimTask(root, initial, claimSettings, async (_command, args) => {
      calls.push(args.join(" "));
      if (args[0] === "task" && args[2] === "--json") return { stdout: await taskView(), stderr: "", code: 0, killed: false };
      if (args[0] === "config") return { stdout: "true\n", stderr: "", code: 0, killed: false };
      throw new Error("edit should not run");
    }),
    /autoCommit/i,
  );
  assert.deepEqual(calls, ["task BACK-1 --json", "config get autoCommit"]);
});

test("claimTask reports CLI edit failure without a read-back", async () => {
  const root = await tempRepo();
  const initial = normalizeTask(await taskView());
  const calls: string[] = [];

  await assert.rejects(
    () => claimTask(root, initial, claimSettings, async (_command, args) => {
      calls.push(args.join(" "));
      if (args[0] === "task" && args[2] === "--json") return { stdout: await taskView(), stderr: "", code: 0, killed: false };
      if (args[0] === "config") return { stdout: "false\n", stderr: "", code: 0, killed: false };
      return { stdout: "", stderr: "locked", code: 1, killed: false };
    }),
    /partially written.*no implementation/i,
  );
  assert.deepEqual(calls, ["task BACK-1 --json", "config get autoCommit", "task edit BACK-1 --status In Progress --assignee @pi-control"]);
});

test("claimTask refuses prewrite drift", async () => {
  const root = await tempRepo();
  const initial = normalizeTask(await taskView());
  const calls: string[] = [];

  await assert.rejects(
    () => claimTask(root, initial, claimSettings, async (_command, args) => {
      calls.push(args.join(" "));
      return { stdout: await taskView({ title: "Changed parser" }), stderr: "", code: 0, killed: false };
    }),
    /changed before claim/i,
  );
  assert.deepEqual(calls, ["task BACK-1 --json"]);
});

test("claimTask rejects wrong read-back and mutated task definition", async () => {
  const root = await tempRepo();

  for (const [overrides, message] of [
    [{ status: "To Do", assignees: [] }, /read-back mismatch/i],
    [{ status: "In Progress", assignees: ["@pi-control"], title: "Changed parser" }, /changed outside lifecycle/i],
  ] as const) {
    const initial = normalizeTask(await taskView());
    let reads = 0;
    await assert.rejects(
      () => claimTask(root, initial, claimSettings, async (_command, args) => {
        if (args[0] === "task" && args[2] === "--json") {
          reads += 1;
          return { stdout: reads === 1 ? await taskView() : await taskView(overrides), stderr: "", code: 0, killed: false };
        }
        if (args[0] === "config") return { stdout: "false\n", stderr: "", code: 0, killed: false };
        return { stdout: "", stderr: "", code: 0, killed: false };
      }),
      message,
    );
  }
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
