# Build `pi-control`: a minimal task-conformance extension for Pi

You are implementing a new Pi extension named **`pi-control`**. Build the extension in the current repository.

This document is the product and engineering brief. Treat its behavioral requirements and invariants as authoritative. Inspect the repository, the installed Pi version, the installed Backlog.md CLI, and the current Plannotator package before settling implementation details. When local APIs differ from examples in upstream documentation, target the installed versions and record the difference in the README.

Do not broaden this into a general agent framework. The point of `pi-control` is to add a small, understandable control layer around one Backlog.md task at a time.

## Before writing code

1. Read the repository's `AGENTS.md`, contribution instructions, package scripts, and relevant existing code.
2. Inspect the installed Pi extension API and the official extension examples, especially command registration, `tool_call`, `agent_settled`, `pi.exec`, `pi.sendUserMessage`, `pi.appendEntry`, and session restoration.
3. Inspect the installed Backlog.md CLI rather than guessing its JSON schema or edit syntax. Capture representative `backlog task <id> --json` output in test fixtures, with sensitive or project-specific content removed.
4. Inspect Plannotator's exported event definitions if it is installed. The integration must also work by listening to the plain string event name, so `pi-control` must not require a runtime import from Plannotator.
5. Write a short implementation plan and tests before implementing the state machine.
6. If a requirement below cannot be implemented safely using the installed APIs, stop and explain the concrete conflict. Do not silently weaken a hard invariant.

Useful upstream references:

- Pi extension API: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md>
- Pi skills: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/skills.md>
- Plannotator Pi extension: <https://github.com/backnotprop/plannotator/blob/main/apps/pi-extension/README.md>
- Backlog.md CLI: <https://github.com/MrLesk/Backlog.md/blob/main/CLI-INSTRUCTIONS.md>

## Product goal

`pi-control` creates explicit boundaries between planning, task definition, implementation, deterministic verification, review, and committing:

```text
approved Plannotator plan
        -> plan-to-backlog skill
        -> Backlog.md tasks
        -> /implement one task
        -> deterministic scope and command verification
        -> bounded repair loop
        -> external/manual review
        -> /commit
```

The extension must enforce the parts that should not depend on model obedience:

- which task is active;
- which files that task may change;
- what repository state existed when work began;
- which verification commands must succeed;
- how many automatic repair attempts are permitted;
- whether verification is current or stale;
- whether a commit is permitted.

The implementing agent proposes code changes. The extension owns workflow state and decides the mechanical verification result.

## Deliberate non-goals

Do not add any of the following in the first version:

- an LLM-as-judge verifier;
- semantic code review;
- subagents, swarms, or parallel task execution;
- autonomous task decomposition;
- worktree management;
- automatic commits;
- automatic pushes, merges, rebases, or tags;
- automatic closure of Backlog tasks;
- a new task database or a replacement for Backlog.md;
- a generic shell permission system;
- a custom planning UI;
- a broad coding-style doctrine;
- a requirement that the agent format free-form evidence in a special schema.

Code review remains the responsibility of existing review tools and the user. General shell and Git permissions may be supplied by another Pi permission extension. Document the recommended permission rules, but do not grow `pi-control` into a shell parser.

## External assumptions

`pi-control` expects:

- a Git repository;
- the `backlog` executable on `PATH`;
- Backlog tasks generated according to the accompanying `plan-to-backlog` skill;
- each implementation task to have explicit `modifiedFiles` entries containing file paths, directory scopes, or glob patterns;
- deterministic Definition of Done entries whose text begins exactly with `Verification:`;
- Plannotator configured with `"executionMode": "external"` when automatic plan handoff is wanted;
- the `plan-to-backlog` skill installed and loaded in Pi when automatic invocation of `/skill:plan-to-backlog` is wanted. Skill availability is sufficient; the extension need not inspect `enableSkillCommands`.

The extension must fail with a concise diagnostic when a prerequisite is absent. It must not invent missing scope or verification checks.

## Backlog task contract

Load tasks using the Backlog CLI's JSON output. Do not scrape task Markdown files and do not edit them directly.

Normalize the installed CLI's JSON into an internal task representation resembling:

```ts
interface ControlTask {
  id: string;
  title: string;
  description?: string;
  allowedScope: string[];
  verificationCommands: string[];
}
```

The adapter must:

- take `allowedScope` from Backlog's `modifiedFiles` field;
- take verification commands only from Definition of Done entries beginning with `Verification:`;
- remove the prefix and surrounding whitespace, preserving the command text otherwise;
- reject a task with no allowed scope entries;
- reject a task with no verification commands;
- reject absolute paths, paths containing `..` traversal, paths outside the repository, empty paths, and invalid glob patterns;
- normalize repository-relative path separators to `/` without changing case;
- deduplicate scope entries and commands while preserving their first occurrence order;
- report malformed task data as a user-facing configuration error rather than throwing an unhandled exception.

Treat `modifiedFiles` as the task scope whitelist. Entries may be exact repository-relative file paths, recursive directory scopes, or picomatch glob patterns, matching the `paths` behavior documented for pi-rules and Claude Code rules.

Scope entry semantics:

- An exact file entry matches only that canonical repository-relative path. A path for a not-yet-created file is valid.
- An entry that resolves to an existing directory, or that ends with `/`, matches files below that directory recursively, including files created later.
- An entry containing glob metacharacters is a picomatch pattern over canonical repository-relative target paths with `/` separators. Compile patterns with `dot: true`, as pi-rules does.
- Do not expand glob entries only at task-load time. They authorize future matching files too.
- Reject absolute entries, traversal through `..`, patterns that cannot compile, and any entry that would authorize paths outside the repository.
- Preserve the user's scope entry text for display, but store a canonical compiled representation for checks.

Do not interpret ordinary acceptance criteria as executable checks. Do not execute Definition of Done text without the exact `Verification:` prefix.

## Commands

Implement these Pi slash commands:

### `/implement <task-id>`

Start controlled implementation of one Backlog task.

Required behavior:

1. Require exactly one task ID and refuse to start if another run is active.
2. Locate the Git repository root from the current working directory.
3. Load and validate the Backlog task.
4. Capture and validate the baseline described below.
5. Persist the run state before prompting the agent.
6. Display a compact summary containing the task, allowed scope entries, verification commands, and repair limit.
7. Send the agent an actual user message that includes the task description, acceptance criteria, allowed scope entries with their exact text, exact verification commands, and explicit instructions to implement only this task. Tell it not to commit, edit Backlog state, waive checks, or broaden scope.
8. When the agent becomes settled, run deterministic verification automatically.
9. If verification fails and repair attempts remain, send the exact failures back as a follow-up user message and allow a repair turn.
10. When the agent settles after a repair, verify again.
11. Stop automatically after the configured limit. Never continue prompting indefinitely.

Default circuit breaker:

- initial implementation;
- one automatic verification run;
- at most two agent repair turns;
- therefore at most three automatic verification runs.

The repair limit must be configurable, but default to `2` repair turns.

### `/implement-resume [task-id]`

Resume a run that is in `FAILED` or was restored after a session restart.

- Default to the active/restored task when the ID is omitted.
- Reject a mismatched ID.
- Revalidate the repository root, `HEAD`, baseline assumptions, task definition, and current scope before prompting the agent.
- Treat an intentional user resume as resetting the automatic repair budget.
- Do not silently recapture the baseline. A new baseline requires abandoning the old run and starting `/implement` again.

### `/verify [task-id]`

Run scope checks and all configured verification commands without prompting the agent to implement or repair anything.

- Default to the active task when the ID is omitted.
- Reject a mismatched task ID while another run is active.
- Print a compact per-check result and a final status.
- Persist the result and its digest.
- A manual verification failure must not start an automatic repair loop.

Example presentation:

```text
BACK-123

Scope                         PASS
uv run pytest tests/foo.py    PASS   4.2s
uv run ruff check ...         FAIL   0.8s

Result: FAILED
```

### `/verify-waive <task-id> <reason>`

Record a human waiver of command verification.

Rules:

- require a non-empty reason;
- require an existing failed verification result for the current task state;
- require an interactive confirmation when UI is available;
- bind the waiver to the current verification digest;
- store the reason, timestamp, failed commands, and digest;
- report the state as `WAIVED`, never as `VERIFIED`;
- become `STALE` after any relevant repository change;
- never waive an out-of-scope change, a changed `HEAD`, an invalid baseline, or malformed task data.

If scope fails, the user must restore the offending change or explicitly add the path with `/scope-add`.

### `/scope-show`

Show the active task's original Backlog scope and any user-approved run-local additions.

### `/scope-add <scope-entry>`

Expand the active run's scope only through an explicit user command.

Rules:

- require an active run;
- apply the same path validation, canonicalization, and matching semantics used for task scope;
- accept one safe scope entry, which may be an exact file path, a recursive directory scope, or a picomatch glob pattern;
- show whether the entry is treated as an exact file, directory scope, or glob, and show the currently matching paths when practical;
- require interactive confirmation when UI is available;
- record the addition, timestamp, and source (`user`) in persisted run state;
- invalidate any prior `VERIFIED` or `WAIVED` result;
- do not let the agent invoke scope expansion through a custom LLM tool;
- do not modify Backlog task files during the run in version 1.

The command should remind the user to update the Backlog task later if the expanded scope should become permanent.

### `/control-status`

Show the active run, phase, baseline commit, allowed scope entries, repair count, latest verification result, and whether that result is current or stale.

### `/control-abort`

End the active workflow without reverting files.

- require confirmation;
- persist an `ABORTED` terminal state;
- remove active enforcement after confirmation;
- clearly state that repository changes remain in place;
- never run Git reset, checkout, clean, stash, or any other destructive recovery command.

### `/commit <task-id> [message]`

Create an explicit task commit. This is the only Git mutation that `pi-control` itself should perform.

Rules:

1. Require an active task matching the supplied ID.
2. Require state `VERIFIED` or `WAIVED`.
3. Recompute the verification digest and refuse if the result is stale.
4. Recheck `HEAD`, scope, and baseline invariants.
5. Determine the paths actually changed by this run; do not stage every path merely matched by the allowed scope.
6. Refuse if anything is staged outside the changed paths that match the effective scope.
7. Stage only the changed paths that match the effective scope, including deletions, with argument-safe process invocation rather than interpolated shell text.
8. Recheck the staged path set before committing.
9. Use the supplied message, or a deterministic default such as `<task-id>: <task title>`.
10. Show the task ID, status, paths, and message and require interactive confirmation.
11. Run the commit through `pi.exec`, not by asking the model to call Bash.
12. If Git or a hook fails, report the exact failure and leave the run recoverable.
13. On success, persist `COMMITTED` and the resulting commit SHA.
14. Do not push, merge, rebase, tag, or mark the Backlog task Done.

A `WAIVED` commit must use a visibly stronger confirmation that includes the waiver reason.

## Baseline and dirty-working-tree policy

The extension must know which changes belong to the controlled run. A bare `git diff <starting-HEAD>` is insufficient when the repository was already dirty.

At `/implement` start:

1. Record the repository root and exact `HEAD` commit.
2. Refuse to start if there are any staged changes anywhere in the repository.
3. Enumerate tracked changes and untracked files with a NUL-safe porcelain format and with individual untracked files, not collapsed directories.
4. Refuse if any pre-existing tracked or untracked change matches the task's allowed scope.
5. Permit pre-existing unstaged or untracked changes outside task scope, but record their exact baseline fingerprints.
6. Store enough information to detect later content, type, mode, symlink-target, deletion, creation, rename, and index-state changes for relevant paths.

During the run:

- `HEAD` must remain equal to the captured commit until `/commit` succeeds;
- pre-existing outside-scope dirty paths must remain byte-for-byte and metadata-equivalent to their recorded baseline state;
- any newly changed path must be within the effective allowed scope;
- any outside-scope baseline path changed after the run starts is an out-of-scope change;
- ignored files are outside version 1's scope accounting unless they become Git-visible;
- path handling must be NUL-safe and must correctly support spaces, tabs, Unicode, and leading dashes.

Implement this with structured Git process calls and explicit path fingerprints. Do not parse human-formatted `git status` output. Avoid shell interpolation.

The candidate paths that need comparison can be the union of:

- paths dirty at baseline;
- paths currently reported dirty or untracked;
- original and destination paths reported for renames or copies;
- effective allowed scope entries where needed for direct checks.

For each relevant path, distinguish at least:

- absent;
- regular file content and executable mode;
- symbolic link and its link target;
- directory where applicable;
- Git index state where applicable.

It is acceptable to use Git blob hashes or SHA-256 rather than retaining file contents. Do not copy the whole repository to create a baseline.

## Scope enforcement

Enforce scope in two layers.

### Before direct Pi mutations

Subscribe to Pi's `tool_call` event. While a run is active, inspect built-in `write` and `edit` calls and block a path outside the effective scope whitelist before execution.

Path checking must:

- resolve relative paths against the active repository root, not the extension package directory;
- reject paths outside the repository;
- account for symlink escapes;
- resolve the nearest existing parent for a new path and ensure it remains within the repository;
- compare canonical repository-relative paths against the effective scope using exact, directory-recursive, and picomatch matching;
- return a concise reason containing the rejected path and allowed scope entries.

Do not block reads.

Do not claim that this hook controls arbitrary shell mutations. Bash may alter files, so final scope verification against actual repository state is mandatory.

### At every verification and before commit

Compare the current repository state with the captured baseline and compute the paths changed during the run.

The hard invariant is:

```text
every path changed since run baseline must match the effective allowed scope
```

In addition, pre-existing outside-scope dirty paths must still match their baseline fingerprints. Here, "matches the effective allowed scope" means the canonical repository-relative path is covered by at least one exact file entry, directory scope, or glob pattern.

Return all offending paths in one result. Do not fail after the first path and force a repeated discovery loop.

## Deterministic verification

Verification consists of two independent layers:

```text
scope_ok  = repository and path invariants pass
checks_ok = every Verification: command exits 0
verified  = scope_ok && checks_ok
```

No model decides these booleans.

Run verification commands:

- sequentially;
- from the captured repository root;
- using a configurable shell executable, defaulting to `/bin/bash` with `-lc` on supported Unix systems;
- with a configurable per-command timeout;
- with abort support where Pi provides a signal;
- without embedding task data into shell source;
- collecting exit code, duration, and bounded stdout/stderr for the report;
- continuing through all commands by default so one run returns the complete failure set.

The command strings are trusted project configuration taken from approved Backlog tasks. State this trust boundary in the README.

Verification commands should be checks, not mutators. Compute the repository content digest immediately before and after the command set. If a command changes Git-visible repository content, verification fails with a specific `verification-mutated-worktree` error and the new state must be evaluated for scope. Do not silently bless formatter-induced edits.

## Verification digest and stale state

A successful or waived result applies only to the exact task output that was checked.

Compute a stable SHA-256 digest over canonical structured data containing at least:

- repository identity/root;
- captured baseline `HEAD`;
- task ID;
- effective allowed scope entries;
- verification commands;
- the set of paths changed during the run;
- their current content/type/mode/symlink fingerprints relative to the baseline.

The digest should represent the task's content state, not incidental staging of identical content, so staging performed by `/commit` does not itself make verification stale. Index invariants still need separate checking.

Before reporting status, verifying, waiving, resuming, or committing, recompute relevant state. If a previously `VERIFIED` or `WAIVED` digest no longer matches, transition to `STALE` and require `/verify` again.

Direct `edit` or `write` calls after verification should mark the result stale immediately. Shell or external editor changes may only be discoverable on the next command or lifecycle event; the recomputation requirement is the authoritative protection.

## Automatic implementation and repair loop

Use an explicit state machine. Do not infer workflow state from prose in the conversation.

Suggested phases:

```ts
type RunPhase =
  | "IMPLEMENTING"
  | "VERIFYING"
  | "REPAIRING"
  | "FAILED"
  | "VERIFIED"
  | "WAIVED"
  | "STALE"
  | "COMMITTED"
  | "ABORTED";
```

Only one run may be active in version 1.

Use `agent_settled`, or the installed Pi equivalent with the same no-more-automatic-work semantics, to trigger automatic verification after an implementation or repair turn. Guard the handler with explicit run state so it does not verify after unrelated turns or recursively respond to its own status messages.

On failure with remaining repair budget, send the agent a follow-up user message containing:

- the task ID;
- the complete scope failure list;
- every failed verification command, exit code, and bounded output;
- any command timeout or worktree-mutation error;
- remaining repair attempts;
- an instruction to make only changes within the effective scope and not to commit or modify workflow state.

Do not ask the agent to produce verification evidence. The extension reruns verification itself.

After the final failed attempt:

- transition to `FAILED`;
- stop sending prompts;
- show the available recovery commands (`/verify`, `/implement-resume`, `/scope-add`, `/verify-waive` when eligible, and `/control-abort`);
- retain the exact final failures.

## Plannotator handoff

Listen on Pi's shared event bus for the plain string event:

```text
plannotator:plan-approved
```

The expected event has:

```ts
{
  cwd: string;
  planFilePath: string;
  planContent: string;
  feedback?: string;
}
```

Required behavior:

1. Validate the event shape and resolve `planFilePath` against `event.cwd`, never against the extension directory.
2. Ensure the resolved plan remains within the event working directory or its Git repository as appropriate.
3. Start a new agent turn that explicitly invokes the `plan-to-backlog` skill and tells the agent to create Backlog tasks from the approved plan without implementing them.
4. Use Pi's supported skill-command expansion path. In current Pi documentation this is `pi.sendUserMessage(..., { expandPromptTemplates: true })` with a `/skill:plan-to-backlog ...` message; verify against the installed API.
5. Include the approved plan path and approval feedback. Include `planContent` directly when practical so the approved event payload remains authoritative, while avoiding duplicate huge content if the file is verified to contain the same text.
6. Choose a safe delivery mode if the agent is still streaming; queue a follow-up rather than interrupting approval handling.
7. Do not start `/implement` automatically after task generation.
8. If the skill is unavailable, show an actionable error and preserve the plan information; do not fall back to ad hoc task generation. Check for the loaded `skill:plan-to-backlog` command with Pi's public API. Do not require a separate check of `enableSkillCommands`.

The Plannotator integration must be isolated behind a small adapter and have tests using emitted fake events. `pi-control` must still load and provide its commands when Plannotator is absent.

## State persistence and restoration

Persist state with Pi's extension persistence mechanism, currently `pi.appendEntry()`. Custom state entries must not be injected into the model context.

Persist after every meaningful transition, including:

- run creation;
- scope addition;
- verification start and completion;
- repair count change;
- waiver;
- stale transition;
- abort;
- commit.

Use a versioned serialized schema, for example:

```ts
interface PersistedControlStateV1 {
  schemaVersion: 1;
  run: ImplementationRun | null;
}
```

On `session_start`, replay entries and restore the latest valid state. Validate restored data rather than trusting arbitrary session contents. If the schema is unsupported or inconsistent, disable active enforcement and report a recovery-oriented diagnostic instead of crashing.

After restoration, do not assume verification is still current. Recheck the repository root, `HEAD`, and digest when the next control command runs. A restored nonterminal implementation should be resumable but must not spontaneously prompt the model on startup.

## Suggested internal structure

Keep Pi-specific adapters thin and make the core logic independently testable. A reasonable structure is:

```text
pi-control/
  package.json
  tsconfig.json
  README.md
  src/
    index.ts                 # extension registration and event wiring
    backlog.ts               # Backlog CLI adapter and normalization
    git.ts                   # structured Git calls and repository snapshots
    paths.ts                 # canonicalization and scope checks
    verification.ts          # command runner and result aggregation
    digest.ts                # canonical digest computation
    state.ts                 # state machine and persistence schema
    prompts.ts               # implementation and repair messages
    plannotator.ts           # plan-approved handoff adapter
    commands.ts              # slash-command handlers
  test/
    ...
```

This is guidance, not a requirement. Prefer a simpler structure if the repository already has conventions that fit better.

Avoid runtime dependencies unless they clearly reduce risk. In particular, do not add `node-pty`. Use Node built-ins and Pi APIs where practical.

## Configuration

Provide a small documented configuration surface with conservative defaults. Project-local configuration is preferable where Pi conventions support it.

At minimum support:

```ts
interface PiControlConfig {
  maxRepairAttempts: number;       // default 2
  verificationTimeoutMs: number;  // choose and document a sensible default
  shell: string;                   // default /bin/bash on Unix
  autoPlanHandoff: boolean;        // default true
}
```

Validate configuration and report bad values. Do not silently coerce dangerous or nonsensical values.

Do not add configuration for disabling the core scope invariant or for making failed checks count as verified.

## Git and security behavior

Use `pi.exec(command, args, options)` or an equally argument-safe process API for all extension-owned commands. Do not concatenate paths, task IDs, commit messages, or other external strings into shell commands.

The only exception is execution of the already-approved `Verification:` command string through the configured shell, because those entries are intentionally shell programs. Keep that trust boundary explicit and local.

`pi-control` must never itself run:

- `git reset`;
- `git checkout` or `git switch`;
- `git clean`;
- `git stash`;
- `git merge`;
- `git rebase`;
- `git push`;
- `git tag`.

Document that users should configure their Pi permission extension to deny agent-issued Git history/ref mutations such as commit, merge, rebase, push, tag, checkout, switch, reset, and clean. `/commit` remains available because the extension invokes Git directly after its own checks and confirmation.

Do not log full environment variables, secrets, or unlimited command output. Bound output retained in state and shown to the model. Make truncation explicit.

## User experience

Keep output terse and operational. Users should be able to see:

- what task is active;
- what state it is in;
- what paths are permitted;
- why verification failed;
- how many repairs remain;
- whether a pass or waiver is stale;
- what command can be used next.

Use Pi status or widget APIs sparingly if helpful, but functionality must not depend on custom TUI rendering. Noninteractive mode should receive plain diagnostics and must fail closed where interactive confirmation is required. Do not auto-confirm a waiver, scope addition, abort, or commit merely because no UI is present; require an explicit documented noninteractive mechanism if one is added later.

## Required tests

Build the core test suite around temporary Git repositories and fake command adapters. Tests must not depend on the developer's real repository or global Backlog data.

At minimum cover:

### Backlog parsing

- valid task normalization;
- missing `modifiedFiles`;
- missing `Verification:` entries;
- duplicate paths and commands;
- exact file, directory, and glob scope entries;
- absolute, traversal, and invalid glob scope entries are rejected;
- Definition of Done entries that are not verification commands;
- malformed or changed CLI JSON.

### Path handling

- repository-relative normalization;
- paths with spaces, tabs, Unicode, and leading dashes;
- new files;
- deleted files;
- symlinks inside the repository;
- symlink escape outside the repository;
- `..` traversal;
- directory scopes match descendants recursively but not sibling prefixes;
- glob scopes use picomatch semantics with `dot: true`;
- an allowed exact path that is a prefix of a disallowed path (`src/a.ts` versus `src/a.ts.bak`).

### Baseline and scope

- clean repository;
- staged changes cause startup refusal;
- pre-existing dirty file inside scope causes refusal;
- pre-existing dirty file outside scope is allowed if unchanged;
- modification of that outside-scope dirty file is detected;
- new out-of-scope tracked and untracked files are detected;
- rename across the scope boundary is detected;
- deletion and mode change are detected;
- changed `HEAD` invalidates the run;
- multiple offending paths are reported together.

### Verification

- all commands pass;
- one or several commands fail;
- commands run sequentially and all results are reported;
- timeout and cancellation;
- stdout/stderr truncation;
- verification command mutates an allowed file;
- verification command mutates an out-of-scope file;
- success stores a stable digest;
- later content change makes the result stale;
- staging identical verified content does not change the content digest.

### State machine and repair circuit breaker

- `/implement` enters `IMPLEMENTING` and prompts once;
- settled implementation triggers one verification run;
- failure triggers at most the configured number of repairs;
- success stops the loop;
- final failure stops all automatic prompting;
- manual `/verify` never starts repair;
- `/implement-resume` resets the repair budget only on explicit invocation;
- unrelated settled turns do not trigger verification;
- persistence and restoration for each important terminal/nonterminal phase.

### Waiver and scope expansion

- empty waiver reason rejected;
- no prior failed result rejected;
- scope failure cannot be waived;
- waiver records reason and failures;
- waiver becomes stale after change;
- `/scope-add` requires confirmation and adds only a safe scope entry;
- scope addition invalidates prior verification;
- no model-callable scope-expansion tool exists.

### Commit

- rejected when failed or stale;
- rejected for mismatched task;
- rejected for staged outside-scope content;
- stages only changed paths that match the effective scope, including deletion;
- safe handling of unusual filenames and commit messages;
- hook/commit failure leaves recoverable state;
- successful commit records SHA and does not push or close the task;
- waived commit displays and confirms the waiver reason.

### Plannotator integration

- correct handling of `plannotator:plan-approved`;
- plan path resolved against event `cwd`;
- skill command expansion requested;
- handoff queued safely while streaming;
- missing skill produces an actionable error;
- extension loads when Plannotator is absent;
- task implementation is not started automatically.

## Documentation deliverables

The README must include:

- the problem `pi-control` solves;
- prerequisites and supported versions actually tested;
- installation and development commands;
- Plannotator `executionMode: external` configuration;
- installation/location of the `plan-to-backlog` skill;
- the Backlog task schema convention (`modifiedFiles` file paths, directory scopes, glob patterns, and `Verification:` DoD items);
- every slash command with examples;
- the state machine and repair limit;
- dirty-working-tree behavior;
- waiver semantics;
- verification staleness;
- the distinction between scope enforcement for `edit`/`write` and after-the-fact detection of Bash changes;
- recommended external permission rules for Git commands;
- the trust boundary around verification shell commands;
- troubleshooting for missing Backlog, malformed tasks, missing skills, stale verification, and changed `HEAD`.

Include a minimal example Backlog task JSON fixture or user-facing task example, but do not require users to author JSON manually.

## Acceptance criteria

The implementation is complete only when all of the following are true:

1. A Plannotator approval can deterministically trigger the `plan-to-backlog` skill without starting implementation.
2. `/implement TASK` loads the task from Backlog JSON, records a reliable baseline, enforces direct edit/write scope, prompts the agent once, and begins the bounded verify/repair loop.
3. Actual Git-visible changes are checked against the baseline at verification time, including shell-created changes.
4. Verification is purely mechanical: scope invariants and command exit statuses.
5. The automatic loop stops after the configured number of repair attempts and cannot enter an unbounded verifier loop.
6. `/verify` runs independently without prompting a repair.
7. `/verify-waive` records a reason, cannot waive scope failure, and is distinct from success.
8. `/scope-add` requires an explicit human action for any new scope entry and invalidates prior verification.
9. Any relevant change after verification makes the result stale.
10. `/commit` requires a current verified or waived state, stages only task changes, requires confirmation, and performs no push or task closure.
11. State survives Pi session restoration without spontaneously resuming agent work.
12. The extension remains usable without Plannotator installed.
13. Tests cover the hard invariants and failure paths listed above.
14. Type checking, tests, linting, and any repository-required checks pass.
15. The README accurately describes both guarantees and limitations.

## Implementation sequence

Prefer this order so the dangerous pieces rest on tested pure logic:

1. Backlog JSON adapter and fixtures.
2. Path canonicalization and scope matching for exact files, directories, and globs.
3. Git baseline snapshots, fingerprints, scope comparison, and content digest.
4. Verification command runner.
5. Pure state machine and circuit-breaker tests.
6. Pi persistence adapter and command handlers.
7. `tool_call` edit/write gate.
8. automatic `agent_settled` verification and repair prompting.
9. waiver, scope, status, abort, and commit commands.
10. Plannotator event handoff.
11. end-to-end tests and README.

Keep commits out of the implementation process unless the user explicitly asks you to commit. At the end, report:

- files added or changed;
- architecture in a few sentences;
- commands and behavior implemented;
- tests and checks run with their results;
- any requirement not completed or any installed-API discrepancy discovered.

