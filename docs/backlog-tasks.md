# Backlog tasks

[Back to the README](../README.md#implement-a-task)

## Task convention

`pi-control` reads tasks through:

```bash
backlog task <id> --json
```

It expects Backlog 1.52.0 task-view JSON with:

- `modifiedFiles` as the file whitelist.
- A non-empty `implementationPlan` containing task-local implementation instructions.
- The task's `path`, `status`, and `assignees` for claiming and later consistency checks.
- `definitionOfDone` items whose text begins exactly with `Verification:`.
- Acceptance criterion identifiers, text, and checkbox state for separate acceptance review.

Scope entries may be:

- Exact repository-relative file paths, such as `src/config.ts`.
- Directory scopes, such as `src/`.
- picomatch globs, such as `test/**/*.test.ts`.

Absolute paths, `..`, paths outside the repo, empty paths, invalid globs, submodule paths, sparse checkout `skip-worktree` paths, `assume-unchanged` paths, and unmerged index entries fail closed.

## Create a task manually

The [plan-to-backlog skill](../skills/plan-to-backlog/SKILL.md) generates tasks from approved plans. To create one yourself:

```bash
backlog task create "Validate pi-control config" \
  -d "Reject bad config values and keep defaults conservative." \
  --ac "Invalid values report the bad field." \
  --modified-file src/config.ts \
  --modified-file test/config.test.ts \
  --dod "Verification: npm test -- test/config.test.ts" \
  --dod "Verification: npm run typecheck"
```

Then attach a plan using the returned task ID, shown here as `BACK-123`:

```bash
backlog task edit BACK-123 --plan $'1. Add field validation to parseConfig in src/config.ts before accepting overrides. Keep defaults unchanged.\n2. Add cases to test/config.test.ts for invalid types, unknown fields, and valid overrides.\n3. Run npm test -- test/config.test.ts and npm run typecheck.'
backlog task BACK-123 --json
```

Check that `task.implementationPlan` contains the saved instructions. Backlog 1.52.0 accepts `task edit --plan` while the task remains To Do. Do not change status just to attach a plan. Its create-command help recommends reserving `--plan` for already-started work; this workflow instead writes approved task-local guidance through `task edit` before implementation.

Users do not author JSON by hand. The JSON shape is the CLI contract that `pi-control` reads.

`/implement` rejects missing, blank, or malformed plans. It includes the full saved plan in implementation, resume, and repair prompts. Plan changes count as task-definition changes and invalidate an existing pass or waiver when rechecked.

For tasks generated before this requirement, use the approved parent plan to populate the field with `backlog task edit <id> --plan <text>` and read it back. Do not use a placeholder merely to pass validation. Abort an active run before changing its task definition, then start a new run. Reload the extension and skill after updating this package.

## Claiming a task

By default, `/implement` claims an unassigned To Do task as `@pi-control` and moves it to In Progress. Set `claimAssignee` in `.pi/pi-control.json` to use your own Backlog identity. If your project uses different status names, set `readyStatus` and `inProgressStatus` too.

The command refuses tasks assigned to someone else and tasks outside those two statuses. It does not reopen Done tasks under the default configuration. An existing In Progress claim by the same assignee needs no additional write. Resume checks the saved claim rather than reassigning it.

Backlog auto-commit must stay disabled. The extension captures the original Git baseline before issuing the claim, then freezes the exact resulting task-file fingerprint. That file is controller-managed, not an addition to the agent's editable scope. A broad scope glob does not grant the agent permission to edit it. Any later task-file changes fail verification, even when the normalized task fields still look unchanged.

The active task file must be a committed Git-visible regular file without symlinks. Commit or revert pending edits to that file before `/implement`. If `BACKLOG_CWD` is set, it must resolve to the captured repository root. Other Backlog files receive no exemption. The controller may change the active task file to record its claim and later finalization, but user edits to the task definition during a run fail verification. Other pre-existing changes remain outside both commits.

If claiming fails or changes unexpected files or `HEAD`, no implementation prompt is sent. The run stays paused. Inspect the task, use `/control-abort`, then retry `/implement`. Aborting does not release the claim or revert files. Task closure happens only after the implementation commit succeeds and the controller validates the intended finalization changes.

Active runs saved before claiming support lack a captured claim and cannot silently resume under the new task contract. Preserve their changes before aborting, then satisfy the clean-scope baseline requirements before starting a new run.

The assignee is an identity label, not a cross-session lock. Do not run concurrent writers against the same task or worktree.

See [workflow details](workflow.md) for baseline checks, verification, and task finalization.
