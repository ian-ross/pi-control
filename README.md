# pi-control

`pi-control` is a Pi extension for planning and implementing development work
in a structured way with deterministic verification at each step along the
way.

In _planning mode_, `pi-control` uses a detailed grilling approach along with
Plannotator for plan review and adjustment, in order to arrive at an agreed
plan for a piece of work. It then breaks that plan down into Backlog issues
for implementation. Importantly, the Backlog issues record the expected scope
of modifications for the issue (as a list of files and file globs), plus a set
of agent-judged acceptance criteria *and* a set of deterministic verification
criteria.

In the _implementation phase_, the agent implements a single Backlog issue.
The `pi-control` extension records the task, the allowed file scope, the
starting Git state, and the exact verification commands. When the agent claims
that the task is complete, `pi-control` runs mechanical checks, and allows a
bounded repair loop. A separate read-only LLM-as-judge acceptance review must
pass before commit.

A separate _commit confirmation_ covers the assessment, final summary, and any
human-waived command failures. After the implementation commit, the controller
finalizes the Backlog task in a separate task-file-only commit.


## Preparation

### Install tools and extensions

Set up [Backlog](https://github.com/MrLesk/Backlog.md).

Install the following extensions:

```
mkdir -p .pi
pi install -l git:github.com/ian-ross/plannotator@plannotator-pi
pi install -l npm:pi-rules
pi install -l git:github.com/earendil-works/pi-review
pi install -l npm:pi-answer@0.1.4
```

and install this extension. (Note that it's important to use my fork of
Plannotator! The documentation of Plannotator claims some functionality that
doesn't exist and I had to add.)

### Configure Plannotator

Copy [`skills/plannotator.example.json`](skills/plannotator.example.json) to `.pi/plannotator.json`, or merge its `executionMode` and planning phase into your existing configuration. Keep your preferred model and thinking settings. The full prompt is also readable in [`skills/plannotator-planning-instructions.md`](skills/plannotator-planning-instructions.md).

The prompt tells the planning agent to inspect the repository, clarify requirements, write only the planning document, and submit it for approval. Before approval it explicitly prohibits creating or updating Backlog tasks, changing task status or checkboxes, and implementing code. Repository task-management instructions in `AGENTS.md` apply after approval. The approved-plan handoff invokes task generation.

These instructions guide the model. They are not hard shell enforcement. Plannotator controls its planning tools; this extension does not intercept arbitrary Bash commands during planning.

### Generate rules

Use a coding agent to generate `pi-rules` rules for the codebase.


## Supported setup

Tested against the installed APIs here:

| Component | Version |
| --- | --- |
| Pi | 0.85.1 |
| Backlog.md CLI | 1.52.0 |
| Plannotator Pi extension | 0.27.15 |
| Node.js | 24.18.1, with package minimum 22 |
| Git | 2.55.0 |
| OS | Linux with `/bin/bash` |

The package requires Node 22+. The implementation and unit tests were built against the installed APIs above. The model-free Pi `/control-status` smoke test also passes. Automated tests use temporary Git repositories and fake Pi adapters. A separate live-model planning smoke read conflicting Backlog instructions in `AGENTS.md`, changed only `PLAN.md` before approval, then created a task through the real CLI after approval. That smoke simulated the approval transport rather than opening the Plannotator browser. A Backlog CLI completion smoke also checked criterion updates, terminal status, separate commits, and cache exclusion. It used a deterministic acceptance response, not a live model implementation turn.

Prerequisites:

- A Git repository.
- `backlog` on `PATH`, with an initialized Backlog project and auto-commit disabled.
- Backlog tasks with explicit `modifiedFiles`, a non-empty `implementationPlan`, and `Verification:` Definition of Done entries.
- Pi project trust if you want to load `.pi/pi-control.json`.
- Plannotator configured for external execution if you want approved plans handed to `plan-to-backlog`.

## Install and development

From a checkout:

```bash
npm install
npm run check
pi -e .
```

When published as a Pi package, install it with Pi's npm package path:

```bash
pi install npm:pi-control
```

To keep the local package installed, run `pi install /absolute/path/to/pi-control`. A model-free load check is:

```bash
pi --no-extensions -e ./src/index.ts --no-skills --no-prompt-templates \
  --no-themes --no-context-files --no-session -p /control-status
```

Loading only `src/index.ts` does not load the bundled skill. Use the package directory for plan handoff.

## Configuration

### Backlog auto-commit

Disable Backlog auto-commit before starting a controlled run or generating tasks:

```bash
backlog config set autoCommit false
backlog config get autoCommit
```

The second command must print `false`. This is a Backlog project setting, not a field in `.pi/pi-control.json`.

`pi-control` checks it before `/implement` and automatic plan handoff, and rechecks it during verification, resume, and commit eligibility checks. Enabled, unreadable, or unexpected values block the operation. A blocked handoff preserves the approved plan without starting task generation. After fixing the setting, invoke `/skill:plan-to-backlog` with that approved plan explicitly; it is not retried automatically.

The extension never changes this setting, commits the configuration change, or accepts an unexpected `HEAD` change. Set it before starting a run. Later configuration edits remain subject to the normal scope and baseline checks. The skill also checks the prerequisite before task writes. These checks do not intercept arbitrary Backlog commands issued through Bash or another terminal.

### pi-control settings

User-global config lives at `~/.pi/agent/pi-control.json`, or the Pi agent directory selected by `PI_CODING_AGENT_DIR`. Trusted project config lives at `.pi/pi-control.json`.

Settings merge in this order: defaults, global config, project config. Project values replace global values. Lists do not concatenate, so `"untrackedArtifacts": []` disables inherited artifact exclusions for new runs.

Defaults:

```json
{
  "maxRepairAttempts": 2,
  "verificationTimeoutMs": 120000,
  "shell": "/bin/bash",
  "autoPlanHandoff": true,
  "plansDirectory": "plans",
  "claimAssignee": "@pi-control",
  "readyStatus": "To Do",
  "inProgressStatus": "In Progress",
  "terminalStatus": "Done",
  "untrackedArtifacts": []
}
```

Validation:

- `maxRepairAttempts` must be an integer from 0 to 100.
- `verificationTimeoutMs` must be a positive integer no greater than 2147483647.
- `shell` must be an absolute path without NUL bytes.
- `autoPlanHandoff` must be boolean.
- `plansDirectory` is a non-empty repository-relative directory. Absolute paths, `..`, Git metadata paths, backslashes, and control characters are rejected. Symlinks must stay inside the repository.
- `claimAssignee` names one Backlog assignee. An omitted leading `@` is added. Letters, digits, dots, underscores, and hyphens are accepted.
- `readyStatus`, `inProgressStatus`, and `terminalStatus` must be distinct, non-empty status names without control characters. Use names from your Backlog project.
- `untrackedArtifacts` is a list of safe repository-relative paths or glob patterns. It defaults to empty.
- Unknown fields are rejected.

If `.pi/pi-control.json` exists, the project must be trusted before `pi-control` loads it. Without the project file, global settings and defaults apply.

There is no setting to disable scope enforcement or to treat failed checks as verified.

## Starting a plan

```text
/plan add user profile page
```

`/plan` reloads `pi-control.json`, creates `plansDirectory` if needed, and selects a filename such as `plans/005-add-user-profile-page.md`. The directory is relative to the Git repository root, even when Pi starts in a subdirectory.

The sequence starts at `001` and uses the highest existing `number-name.md` plus one. It does not fill gaps or scan subdirectories. Numbers have at least three digits and grow past `999`. The slug uses lowercase ASCII letters and digits, removes accents, and replaces separators with hyphens. Empty descriptions or empty slugs show usage.

The command forwards only the selected path to `/plannotator-plan-mode`. Then write your detailed planning prompt. It does not submit the description as a prompt or create an empty plan file. Numbers are not reserved until a plan exists on disk, so avoid concurrent planning sessions in the same directory. Finish or abort any controlled implementation run before using `/plan`.

This requires a Plannotator version whose `/plannotator-plan-mode` handler accepts a file path. Some releases document that argument but ignore it in the handler. Those releases toggle mode without selecting the file and need a Plannotator update or fix. The wrapper preserves Plannotator's toggle behavior, so invoke it while plan mode is off.

## Plannotator handoff

For automatic task generation after plan approval, set Plannotator to external mode. Use either global config:

```text
~/.pi/agent/plannotator.json
```

or project config:

```text
.pi/plannotator.json
```

with:

```json
{
  "executionMode": "external"
}
```

Plannotator 0.27.15 emits `plannotator:plan-approved` with `cwd`, `planFilePath`, `planContent`, and optional `feedback`. `pi-control` listens to that plain string event. It resolves `planFilePath` against the event `cwd`, queues a follow-up prompt, and invokes:

```text
/skill:plan-to-backlog
```

The skill is shipped in this package at:

```text
skills/plan-to-backlog/SKILL.md
```

Loaded skill availability is enough. `pi-control` checks for the loaded `skill:plan-to-backlog` command and does not check an `enableSkillCommands` setting. The skill sets `disable-model-invocation: true`, so Pi does not advertise it for the model to select during planning. Explicit invocation and the approved-plan handoff still work.

The handoff creates or updates Backlog tasks only. It requires a task-local implementation plan for every task and instructs the agent to verify the saved field through CLI JSON. It does not start `/implement`.

## Backlog task convention

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

- exact repository-relative file paths, such as `src/config.ts`;
- directory scopes, such as `src/`;
- picomatch globs, such as `test/**/*.test.ts`.

Absolute paths, `..`, paths outside the repo, empty paths, invalid globs, submodule paths, sparse checkout `skip-worktree` paths, `assume-unchanged` paths, and unmerged index entries fail closed.

Example task creation:

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

## Commands

There are ten slash commands.

| Command | Example | What it does |
| --- | --- | --- |
| `/plan <description>` | `/plan add user profile page` | Selects a numbered filename in `plansDirectory` and invokes Plannotator plan mode without starting a planning prompt. |
| `/implement <task-id>` | `/implement BACK-123` | Validates the task and Git baseline, assigns the task to `claimAssignee`, and sets `inProgressStatus`. It reads the claim back before prompting the agent, then verifies automatically when the agent settles. |
| `/implement-resume [task-id]` | `/implement-resume BACK-123` | Resumes a `FAILED` or restored run. It rechecks root, `HEAD`, baseline, task equality, and scope. It resets the automatic repair budget. |
| `/verify [task-id]` | `/verify BACK-123` | Runs scope checks and every configured verification command, then requests read-only acceptance review on success. It requires the captured baseline and never starts a repair loop. |
| `/verify-waive <task-id> <reason>` | `/verify-waive BACK-123 upstream service unavailable` | Records a human waiver for current failed command checks. It cannot waive scope failures, changed `HEAD`, task changes, or malformed task data. |
| `/scope-show` | `/scope-show` | Shows original Backlog scope, run-local user additions, and the frozen artifact policy. |
| `/scope-add <scope-entry>` | `/scope-add src/new-file.ts` | Adds one run-local scope entry after confirmation. The whole remaining slash argument is the entry. Slash args are not a shell, so do not add shell quotes unless quote characters are part of the path. |
| `/control-status` | `/control-status` | Shows active task, phase, baseline commit, scope, repair count, latest verification, and freshness. |
| `/control-abort` | `/control-abort` | Ends the workflow after confirmation. It does not revert files. Without UI confirmation it fails closed. |
| `/commit <task-id> [message]` | `/commit BACK-123 BACK-123: validate config` | Commits the verified or waived task changes after confirmation. It then finalizes the task in a separate metadata commit. Retry pending finalization with the same command. It does not push. |

Task IDs must match the active task. A changed Backlog task definition is treated as a hard mismatch. Restore the task or abort and start a new `/implement` run.

## Claiming a task

By default, `/implement` claims an unassigned To Do task as `@pi-control` and moves it to In Progress. Set `claimAssignee` in `.pi/pi-control.json` to use your own Backlog identity. If your project uses different status names, set `readyStatus` and `inProgressStatus` too.

The command refuses tasks assigned to someone else and tasks outside those two statuses. It does not reopen Done tasks under the default configuration. An existing In Progress claim by the same assignee needs no additional write. Resume checks the saved claim rather than reassigning it.

Backlog auto-commit must stay disabled. The extension captures the original Git baseline before issuing the claim, then freezes the exact resulting task-file fingerprint. That file is controller-managed, not an addition to the agent's editable scope. A broad scope glob does not grant the agent permission to edit it. Any later task-file changes fail verification, even when the normalized task fields still look unchanged.

The active task file must be a Git-visible regular file without symlinks. If `BACKLOG_CWD` is set, it must resolve to the captured repository root. Other Backlog files receive no exemption. A claim can update an already-uncommitted task file, as long as baseline validation passes. The final metadata commit includes the active task file's full resulting contents, even if it was already claimed and required no claim write. Commit confirmation warns if that task file was already uncommitted at startup. Other pre-existing changes remain outside both commits.

If claiming fails or changes unexpected files or `HEAD`, no implementation prompt is sent. The run stays paused. Inspect the task, use `/control-abort`, then retry `/implement`. Aborting does not release the claim or revert files. Task closure happens only after the implementation commit succeeds and the controller validates the intended finalization changes.

Active runs saved before claiming support lack a captured claim and cannot silently resume under the new task contract. Preserve their changes before aborting, then satisfy the clean-scope baseline requirements before starting a new run.

The assignee is an identity label, not a cross-session lock. Do not run concurrent writers against the same task or worktree.

## State machine and repair limit

Phases:

```text
IMPLEMENTING
VERIFYING
REPAIRING
FAILED
VERIFIED
WAIVED
STALE
FINALIZING
COMMITTED
ABORTED
```

Only one run can be active.

Default automatic loop:

1. `/implement` sends one implementation prompt.
2. Agent settles.
3. `pi-control` verifies.
4. If verification fails, it sends exact failures back for repair.
5. At most two repair turns run by default.
6. After the limit, the run becomes `FAILED` and automatic prompting stops.

`/verify` is manual and does not consume or start the repair loop. A successful verification starts a separate acceptance-review turn. `VERIFIED` describes the mechanical result; commit still requires a satisfied acceptance assessment.

State is persisted with Pi session entries. On restore, an active run is paused. It does not prompt or verify by itself. Use `/control-status`, `/verify`, or `/implement-resume`.

## Baseline and dirty tree rules

At `/implement` start, `pi-control` records:

- repository root;
- exact `HEAD`;
- tracked file fingerprints;
- dirty outside-scope fingerprints;
- index state.

It refuses to start if anything is staged. It also refuses if any pre-existing dirty tracked or untracked path matches the task scope.

Dirty files outside the task scope may exist at start, but they must stay byte-for-byte and metadata equivalent. The only exception is the active Backlog task file changed by the controller's claim operation. Its post-claim content and mode must remain exact. Other changes fail verification.

After start:

- `HEAD` must stay equal to the captured commit until `/commit` succeeds.
- Newly changed paths must match the effective scope or the exact controller-managed claim fingerprint.
- Staged content is allowed only for task-changed paths after the run starts.
- Ignored, untracked files are not counted.
- Matching disposable untracked artifacts are excluded under the policy captured at run start. Tracked and staged files still undergo normal checks.
- Verification reports all offending paths it finds, not just the first one.

The Git adapter hashes all tracked files to detect content and mode changes even when status settings hide them. This can add overhead on large repositories. It stores fingerprints, not copies of file contents.

Submodules, sparse checkout skip-worktree paths, assume-unchanged paths, unmerged index entries, and unsupported index flags fail closed. Literal backslashes in Git filenames are unsupported and produce an error rather than silently naming another file. Scope input separators normalize to `/`, with original text retained for display.

## Disposable cache files

For caches that every contributor should ignore, prefer `.gitignore`. For user-specific exclusions, set `untrackedArtifacts` in global config, or override it in a trusted project:

```json
{
  "untrackedArtifacts": ["**/__pycache__/**", "**/.pytest_cache/**"]
}
```

Only matching untracked, unstaged regular files qualify. They do not cause scope violations or verification-mutation failures, do not affect the content digest, and are never automatically staged, even when task scope also matches. Tracked and staged files get no exemption. Generated files intended for commit still require explicit task scope and must not qualify as disposable artifacts.

Patterns use the existing path and glob safety rules. Symlink escapes are not cache exemptions. Each run saves its effective artifact policy. Editing config or restoring a session does not change an active run's exclusions. Start a new run to adopt a different policy.

## Verification and stale results

Verification is mechanical:

```text
scope_ok  = repository and path invariants pass
checks_ok = every Verification: command exits 0 and does not mutate Git-visible content
verified  = scope_ok && checks_ok
```

Commands run sequentially from the captured repository root through the configured shell. Default shell invocation on Unix is `/bin/bash -lc <command>`. Each command retains at most 8 KiB each of stdout and stderr, with a truncation marker. Cancellation uses Pi's signal when available and also stops processes on session shutdown.

`Verification:` command text is trusted project configuration from approved Backlog tasks. It is passed as raw shell source. Do not put unreviewed task text there. These commands should be checks, not mutators. If they change Git-visible content, verification fails with `verification-mutated-worktree`.

A `VERIFIED` or `WAIVED` result is bound to a digest of the task, scope, commands, frozen artifact policy, changed paths, and content fingerprints. Any relevant change makes it `STALE`. Staging identical verified content does not by itself change the content digest, but index invariants are still checked.

## Acceptance review

Mechanical verification and acceptance review are separate. After successful checks or an explicit command waiver, the controller requests a read-only model turn and accepts its structured result through `pi_control_acceptance_review`. While review is pending, the tool gate permits only read, grep, find, ls, read-only LSP queries, and the review submission tool. It blocks Bash and other tools, even if tool-list filtering fails. Other extensions and external processes remain trusted code, not sandboxed processes.

The reviewer assesses every criterion as `satisfied`, `unsatisfied`, or `uncertain` and supplies evidence plus a proposed final summary. Missing, malformed, unsatisfied, or uncertain results block completion. Review cannot override scope failures or turn failed commands into a pass.

The assessment binds to the checked task definition and code digest. Changing either invalidates it. Existing human checkmarks remain intact but do not count as review evidence. The controller writes no automated checkmarks before commit, so a stale assessment cannot leave new checkmarks behind.

Commit confirmation shows the assessment, evidence, and proposed final summary. Known command failures and their waiver reason appear in the final summary. Acceptance review has no waiver. An unsatisfied or uncertain result pauses the run as `FAILED`; use `/implement-resume` to repair it. A malformed response stays unaccepted. Use `/verify` to request a fresh review after interruption or restoration.

## Waivers

`/verify-waive` records `WAIVED`, never `VERIFIED`.

A waiver requires:

- a current failed verification result;
- completed command failures or timeouts only, not cancelled verification or worktree mutation;
- no scope failure;
- no changed `HEAD`;
- no task definition change;
- a non-empty reason;
- interactive confirmation.

A waived commit uses a stronger confirmation and shows the waiver reason and failed commands.

## Scope enforcement limits

`pi-control` blocks built-in `edit` and `write` tool calls before execution when the target path is outside scope. It does not block reads.

This gate covers Pi's built-in `edit` and `write` tools only. It does not cover custom tools, arbitrary shell commands, external editors, Git hooks, or concurrent processes. Bash can mutate anything the process user can write. `pi-control` catches Git-visible mutations after the fact during `/verify`, `/control-status`, `/implement-resume`, and `/commit`.

There is no security sandbox. Use operating system permissions, containers, or a Pi permission extension when you need hard isolation.

Recommended external permission rules:

- Allow reads.
- Allow `edit` and `write`; `pi-control` gates those built-ins while a run is active.
- Treat shell as powerful. Approved `Verification:` commands are arbitrary shell.
- Deny agent-issued Git history and ref mutations: `commit`, `merge`, `rebase`, `push`, `tag`, `checkout`, `switch`, `reset`, `clean`, and `stash`.
- Let `/commit` handle the one allowed commit. It invokes Git directly after checks and confirmation.

Git hooks remain trusted code. During `/commit`, temporary wrappers run existing pre-commit, prepare-commit-msg, and commit-msg hooks, then reject changes to the checked index or Git-visible content. A formatter hook must leave its edits for another `/verify`, not commit them unverified. Post-commit runs normally. Hook failures leave changes and staging in place, and any content changes invalidate verification.

These checks do not isolate malicious hooks or concurrent processes. Do not run another writer against the repository during verification or commit. The extension never pushes, merges, rebases, tags, resets, cleans, checks out, switches, or stashes.

## Commit behavior

`/commit` requires:

- the supplied task ID equals the active task;
- state is current `VERIFIED` or `WAIVED`;
- a current acceptance assessment marks every criterion satisfied and provides evidence;
- `HEAD`, task equality, scope, baseline, and digest still pass;
- no staged paths outside the task-changed path set;
- interactive confirmation.

The first commit stages only changed implementation paths that match the effective scope, including deletions. The separate metadata commit includes the active task file, including its controller-owned claim changes. It rechecks after confirmation and staging, then compares the resulting commit against the prepared index. It uses argument-safe Git invocation, not shell interpolation. After implementation commit success, it persists the SHA before finalizing Backlog. It checks satisfied criteria through the CLI, writes the confirmed final summary, and moves the task to the terminal status captured at run start. A second commit includes only that task file. `COMMITTED` means both steps succeeded. It never pushes.

If finalization fails, `/commit <task-id>` retries only finalization. It does not create another implementation commit. The saved state survives session restoration and stays paused until explicit retry. Unexpected file changes, task edits, or index changes block the retry. The controller compares CLI readback and task-file text, allowing only intended criterion checkmarks, status, timestamp, and final summary changes. Task files over 1 MiB or unsupported Markdown layouts fail closed. Inspect failures rather than using a blanket `backlog/` scope exemption.

The finalization journal stores the approved summary, criterion indexes, terminal status, and original task text. Partial intended CLI edits can be retried. Both commits use hook guards. The controller records each prepared commit diff before invoking Git. If a commit succeeds before a post-commit timeout or interrupted session, retry recognizes that exact diff and parent. It does not repeat the successful commit. A reported implementation commit failure never triggers task closure in that attempt.

## Troubleshooting

`Cannot run backlog` means Backlog.md 1.52.0 compatible CLI is missing from `PATH`.

`Backlog task scope is invalid` means a `modifiedFiles` entry is unsafe or not supported.

`Backlog task definition changed` means the normalized task definition or claim no longer matches the task captured at `/implement`. Restore it or `/control-abort` and start over.

`head-changed` means something moved `HEAD` after `/implement`. Return to the captured commit or abort.

`STALE` means verified or waived content changed. Run `/verify` again.

`plan-to-backlog skill is unavailable` means the package skill is not loaded in Pi. Load this package or otherwise install the skill, then rerun task generation from the preserved approved plan.

`Interactive confirmation is required` means the command would change workflow trust, scope, waiver, abort, or commit state. Non-UI mode fails closed.
