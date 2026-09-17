---
name: plan-to-backlog
description: Convert an approved implementation plan into a small set of atomic Backlog.md tasks with explicit file scope, acceptance criteria, dependencies, and deterministic verification checks. Use after a plan has been reviewed and approved. Do not implement the tasks.
---

# Plan to backlog

Convert an already-approved implementation plan into executable Backlog.md tasks.

The output of this skill is a set of Backlog.md issues suitable for later execution by a constrained `/implement` workflow.

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

Useful forms include:

```bash
backlog task create "Title" \
  -d "Description" \
  --ac "Acceptance criterion" \
  --modified-file path/to/file \
  --dod "Verification: command"

backlog task edit <id> --dep task-1 --dep task-2
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

Use the Backlog implementation-plan field only for short task-local implementation guidance.

Do not reproduce the project-level Plannotator plan verbatim.

A task-local plan should normally be 2–6 concise steps.

Example:

```text
1. Extend timestamp parsing to handle numeric UTC offsets.
2. Preserve the existing naive timestamp path.
3. Add success and invalid-offset test cases.
4. Run the task verification commands.
```

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
* file whitelist;
* acceptance criteria;
* verification commands;
* dependencies.

Reconsider any task whose file scope is very large or crosses unrelated components.

### 4. Create tasks in dependency order

Create prerequisite tasks first so later tasks can refer to their Backlog IDs.

Use `backlog task create`.

Add dependencies using `--dep` during creation or immediately afterward with `backlog task edit`.

### 5. Inspect the created tasks

Read each created task back using:

```bash
backlog task <id> --json
```

Confirm that each task contains:

* a clear description;
* acceptance criteria;
* explicit modified files;
* deterministic verification checks;
* correct dependencies.

Correct any omissions using the Backlog CLI.

### 6. Stop

After task creation and validation:

* do not implement anything;
* do not run `/implement`;
* do not mark acceptance criteria complete;
* do not mark Definition of Done items complete;
* do not change task status to Done;
* do not commit code.

Report the created task IDs and a brief dependency summary.

## Quality checks

Before finishing, verify all of the following for every implementation task:

* [ ] It represents one coherent change.
* [ ] It can be reviewed and committed independently.
* [ ] `modified_files` is explicit and narrow.
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

