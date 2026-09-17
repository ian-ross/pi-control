---
name: plan-to-backlog
description: Convert an approved plan into Backlog.md tasks with required task-local implementation plans, explicit file scope, acceptance criteria, dependencies, and deterministic verification checks. Invoke only after explicit plan approval. Do not implement the tasks.
disable-model-invocation: true
---

# Plan to backlog

Convert an already-approved implementation plan into executable Backlog.md tasks.

The output of this skill is a set of Backlog.md issues suitable for later execution by a constrained `/implement` workflow. Every created or updated implementation task must have a non-empty `implementationPlan` field. Task generation is incomplete until each plan has been written through the CLI and read back from task JSON.

Do **not** implement the plan.
Do **not** modify product code.
Do **not** mark any created task as complete.

## Goals

Produce tasks that are:

* small enough to implement, verify, review, and commit independently;
* explicit about which files may be modified;
* explicit about the observable behavior required;
* explicit about deterministic verification commands;
* ordered through dependencies where necessary;
* understandable without needing to reread the full planning conversation.

Each task should represent one coherent reviewable diff.

## Inputs

The invoking context should contain an approved implementation plan.

Treat that plan as authoritative unless repository inspection proves that a specific detail is impossible or materially incorrect.

You may inspect the repository to:

* confirm file names and locations;
* understand existing tests and tooling;
* identify appropriate verification commands;
* determine natural task boundaries;
* identify necessary dependencies between tasks.

Do not reopen architectural questions that were already resolved in the approved plan unless you find a concrete contradiction in the repository.

If such a contradiction materially prevents correct task generation, report it instead of silently changing the approved design.

## Backlog.md usage

Use the `backlog` CLI. Do not create or edit Backlog task files manually.

Before creating or updating tasks, run `backlog config get autoCommit` in the project. It must succeed and print `false`. If auto-commit is enabled or cannot be read, stop and ask the user to run `backlog config set autoCommit false`. Do not change configuration yourself, initialize a missing project, or create tasks until this prerequisite passes. Backlog must not create commits during this workflow.

Useful forms include:

```bash
backlog task create "Title" \
  -d "Description" \
  --ac "Acceptance criterion" \
  --modified-file path/to/file \
  --dod "Verification: command"

backlog task edit <id> --plan $'1. Update path/to/file using the approved design.\n2. Add the specified behavior and regression tests.\n3. Run the task verification commands.'
backlog task edit <id> --dep task-1 --dep task-2
backlog task <id> --json
```

Use `backlog task <id> --json` for the installed Backlog 1.52.0 task-view JSON schema. Use `--plain` only for human-readable inspection.

## Task decomposition

Break the approved plan into the smallest useful set of tasks that preserves architectural coherence.

Prefer a task when all of the following are true:

1. It has one clear purpose.
2. Its changes form one sensible code-review unit.
3. Its acceptance criteria can be verified independently.
4. It can be committed independently after verification.
5. Its file scope is reasonably bounded.

Do not create tiny bookkeeping tasks solely because individual implementation steps exist in the plan.

Do not create broad umbrella tasks that combine unrelated code changes merely because they belong to the same feature.

As a rule of thumb, prefer:

```text
one task
→ one coherent behavioral change
→ one bounded diff
→ one verification cycle
→ one commit
```

## Dependency ordering

Create foundational tasks before tasks that depend on them.

Use Backlog dependencies where a later task genuinely requires an earlier one to be complete.

Avoid unnecessary dependency chains. Tasks that can safely be implemented independently should remain independent.

Never create a dependency on a task that has not yet been created.

## File scope

Every implementation task must declare its expected modification scope using `--modified-file`.

Treat this list as a **whitelist for later implementation**, not merely documentation.

Include every file that the task is expected to modify.

Do not include files merely because they are useful references.

Use repository-relative paths. Exact files, recursive directory scopes ending in `/`, and picomatch globs are supported. Quote glob arguments so the shell passes the pattern unchanged, for example `--modified-file 'src/parser/**/*.ts'`. Patterns authorize future matching files, including dotfiles. Never use absolute paths or `..` traversal.

Prefer precise file paths:

```text
src/parser.py
tests/test_parser.py
```

rather than broad directory scopes:

```text
src/
tests/
```

If the exact file cannot yet be known, use the narrowest defensible path and state the uncertainty in the task description.

Do not include unrelated files "just in case."

### New files

If a task is expected to create a new file, include its planned path with `--modified-file` so it appears in the JSON `modifiedFiles` field.

### Generated files

Do not include generated files unless the repository convention requires generated artifacts to be committed.

### Shared files

If several tasks would need to modify the same central file, reconsider the decomposition. Prefer task boundaries that minimize overlapping scope where practical.

## Acceptance criteria

Acceptance criteria describe **what must be true**, not how to implement it.

Good acceptance criteria are:

* observable;
* unambiguous;
* independently checkable;
* specific to the task.

Prefer:

```text
Invalid configuration values produce a ConfigError with the offending field name.
```

Avoid:

```text
Add validation logic to config.py.
```

Include preservation criteria where relevant:

```text
Existing callers that omit the new option retain their current behavior.
```

Include important negative cases and edge cases identified in the approved plan.

Do not turn implementation steps into acceptance criteria.

## Verification

Every implementation task must contain explicit deterministic verification checks.

Put verification checks in Definition of Done entries prefixed with:

```text
Verification:
```

For example:

```text
Verification: uv run pytest tests/test_parser.py
Verification: uv run ruff check src/parser.py tests/test_parser.py
```

These commands will later be executed mechanically by the implementation harness.

### Verification rules

Verification commands must:

* be non-interactive;
* return exit code 0 on success;
* be runnable from the repository root unless explicitly stated otherwise;
* verify the task as narrowly as practical;
* use existing project tooling where possible.

Prefer focused checks over the entire repository when they provide adequate coverage.

For example, prefer:

```bash
uv run pytest tests/test_parser.py
```

over:

```bash
uv run pytest
```

when the focused test file fully covers the task.

Add broader regression checks where the affected subsystem warrants them.

Typical checks include:

* focused unit or integration tests;
* type checking;
* linting;
* formatting checks;
* builds or compilation;
* project-specific validation scripts.

Do not use natural-language statements such as:

```text
Verification: manually inspect that the code looks correct
```

as deterministic verification checks.

Human or agentic review happens separately.

### Missing tests

If the required behavior cannot currently be verified automatically, the task should normally include adding or updating tests within its file scope.

Do not weaken verification merely because suitable tests do not yet exist.

## Task description

The description should explain:

* the purpose of the task;
* relevant architectural context from the approved plan;
* important constraints;
* any deliberate non-goals.

Keep it self-contained but concise.

Do not paste the entire approved plan into each task.

Where useful, state explicitly:

```text
Out of scope:
- ...
```

This complements the hard file whitelist with semantic boundaries.

## Implementation plan field

Every implementation task must contain a task-local plan in Backlog's `implementationPlan` field. Populate it during task generation, not when implementation starts. This approved-plan workflow prepares queued tasks for a later implementation session, even when generic Backlog guidance suggests deferring plans until work starts.

Write the plan for an implementation agent that has not seen the planning conversation. Include:

* ordered changes, with relevant repository paths and symbols confirmed by inspection;
* the approved design decisions and constraints needed for this task;
* dependency assumptions and any interfaces supplied by earlier tasks;
* specific test cases and edge cases, with the verification commands already listed in Definition of Done.

Use enough detail to implement the task without reconstructing the parent plan. Do not paste unrelated parts of that plan into every issue. A link, title, acceptance-criteria list, or placeholder such as "see approved plan" does not replace implementation instructions.

For example, after confirming these paths and symbols exist:

```text
1. Extend parseTimestamp in src/parser.ts to read numeric UTC offsets using
   the existing date parser. Preserve the current behavior for naive timestamps.
2. Reject missing offset digits and out-of-range hours or minutes through the
   existing validation error path. Do not change the public return type.
3. Add cases in tests/parser.test.ts for positive and negative offsets, zero
   offset, malformed offsets, and existing naive timestamp inputs.
4. Run npm test -- parser and npm run lint.
```

After creating the task, use `backlog task edit <id> --plan <text>`. Pass real newlines, for example with Bash `$'...\n...'` quoting. Read it back with `backlog task <id> --json` and inspect `task.implementationPlan`.

Keep the task in its initial status. Do not mark it In Progress merely to attach a plan. Backlog 1.52.0 accepts `task edit --plan` on To Do tasks. If the installed CLI rejects this operation, report the error rather than omitting the plan or changing status.

## Existing tasks

Before creating tasks, inspect the existing Backlog when relevant.

Avoid creating duplicate tasks for work already represented.

Do not modify unrelated existing tasks.

If the approved plan clearly extends an existing incomplete task, prefer updating that task only when doing so preserves its original purpose and scope. Otherwise create a new task and add an appropriate dependency.

## Creation procedure

Follow this sequence.

### 1. Read the approved plan

Extract:

* major implementation units;
* ordering constraints;
* explicit non-goals;
* affected components;
* expected tests and validation.

### 2. Inspect the repository

Inspect only enough repository context to validate:

* actual file paths;
* existing test locations;
* build/test/lint commands;
* natural task boundaries.

Do not start implementing.

### 3. Propose task boundaries internally

For each candidate task determine:

* purpose;
* task-local implementation plan;
* file whitelist;
* acceptance criteria;
* verification commands;
* dependencies.

Reconsider any task whose file scope is very large or crosses unrelated components.

### 4. Create tasks in dependency order

Create prerequisite tasks first so later tasks can refer to their Backlog IDs.

Use `backlog task create`, then immediately write that task's implementation plan with `backlog task edit <id> --plan <text>`. Do not leave the plan only in the description, a comment, the parent planning document, or the final chat response.

Add dependencies using `--dep` during creation or immediately afterward with `backlog task edit`.

### 5. Inspect the created tasks

Read each created task back using:

```bash
backlog task <id> --json
```

Confirm that each task contains:

* a clear description;
* a non-empty `task.implementationPlan` with the intended task-local instructions, not just a heading or reference;
* acceptance criteria;
* explicit modified files;
* deterministic verification checks;
* correct dependencies.

Correct any omissions using the Backlog CLI. If `task.implementationPlan` is null, missing, or blank, write it with `backlog task edit <id> --plan <text>` and read the task back again. Do not report generation as complete while any task lacks its plan.

### 6. Stop

After task creation and validation:

* do not implement anything;
* do not run `/implement`;
* do not claim tasks or move them to In Progress; `/implement` owns that transition;
* do not mark acceptance criteria complete;
* do not mark Definition of Done items complete;
* do not change task status to Done;
* do not commit code.

Report the created or updated task IDs and a brief dependency summary. Confirm that every task's implementation plan was saved and read back.

## Quality checks

Before finishing, verify all of the following for every implementation task:

* [ ] It represents one coherent change.
* [ ] It can be reviewed and committed independently.
* [ ] `task.implementationPlan` contains a self-contained implementation plan and was checked in CLI JSON after writing.
* [ ] `modifiedFiles` is explicit and narrow.
* [ ] Every expected modified file is included.
* [ ] Acceptance criteria describe outcomes rather than implementation steps.
* [ ] Important compatibility and edge-case requirements are represented.
* [ ] At least one deterministic verification command is present.
* [ ] Verification commands are valid for this repository.
* [ ] Dependencies are necessary and correctly ordered.
* [ ] The task does not silently broaden the approved plan.
* [ ] No product code was changed while generating tasks.

## Important constraints

Never:

* implement the approved plan;
* modify product code;
* create speculative work not justified by the approved plan;
* silently expand task scope;
* use broad path whitelists merely for convenience;
* substitute agent judgment for deterministic verification where an executable check is practical;
* mark tasks complete.

When uncertain between a broad task and two independently verifiable tasks, prefer the smaller independently verifiable tasks unless doing so would create artificial coupling or duplicate work.

