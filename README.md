# pi-control

`pi-control` is a Pi extension for working on one Backlog.md task at a time. It records the task, the allowed file scope, the starting Git state, and the exact verification commands. Then it lets the agent implement, runs mechanical checks, allows a bounded repair loop, and only commits after a current pass or an explicit human waiver.

It is not a sandbox. It is a workflow guard and verifier.

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

The package requires Node 22+. The implementation and unit tests were built against the installed APIs above. The model-free Pi `/control-status` smoke test also passes. Automated tests use temporary Git repositories and fake Pi adapters; they do not exercise a live model implementation turn.

Prerequisites:

- A Git repository.
- `backlog` on `PATH`.
- Backlog tasks with explicit `modifiedFiles` and `Verification:` Definition of Done entries.
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

Project config lives at:

```text
.pi/pi-control.json
```

Defaults:

```json
{
  "maxRepairAttempts": 2,
  "verificationTimeoutMs": 120000,
  "shell": "/bin/bash",
  "autoPlanHandoff": true
}
```

Validation:

- `maxRepairAttempts` must be an integer from 0 to 100.
- `verificationTimeoutMs` must be a positive integer no greater than 2147483647.
- `shell` must be an absolute path without NUL bytes.
- `autoPlanHandoff` must be boolean.
- Unknown fields are rejected.

If `.pi/pi-control.json` exists, the project must be trusted before `pi-control` loads it. Without the file, the defaults apply.

There is no setting to disable scope enforcement or to treat failed checks as verified.

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

Loaded skill availability is enough. `pi-control` checks for the loaded `skill:plan-to-backlog` command and does not check an `enableSkillCommands` setting. The handoff creates or updates Backlog tasks only. It does not start `/implement`.

## Backlog task convention

`pi-control` reads tasks through:

```bash
backlog task <id> --json
```

It expects Backlog 1.52.0 task-view JSON with:

- `modifiedFiles` as the file whitelist.
- `definitionOfDone` items whose text begins exactly with `Verification:`.
- Any ordinary acceptance criteria as human criteria only.

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

Users do not author JSON by hand. The JSON shape is the CLI contract that `pi-control` reads.

## Commands

There are nine slash commands.

| Command | Example | What it does |
| --- | --- | --- |
| `/implement <task-id>` | `/implement BACK-123` | Starts one controlled run from a Backlog task. Captures the baseline, records scope and checks, prompts the agent once, then verifies automatically when the agent settles. |
| `/implement-resume [task-id]` | `/implement-resume BACK-123` | Resumes a `FAILED` or restored run. It rechecks root, `HEAD`, baseline, task equality, and scope. It resets the automatic repair budget. |
| `/verify [task-id]` | `/verify BACK-123` | Runs scope checks and every configured verification command. It requires an active run and its captured baseline. It never starts a repair loop. |
| `/verify-waive <task-id> <reason>` | `/verify-waive BACK-123 upstream service unavailable` | Records a human waiver for current failed command checks. It cannot waive scope failures, changed `HEAD`, task changes, or malformed task data. |
| `/scope-show` | `/scope-show` | Shows original Backlog scope and run-local user additions. |
| `/scope-add <scope-entry>` | `/scope-add src/new-file.ts` | Adds one run-local scope entry after confirmation. The whole remaining slash argument is the entry. Slash args are not a shell, so do not add shell quotes unless quote characters are part of the path. |
| `/control-status` | `/control-status` | Shows active task, phase, baseline commit, scope, repair count, latest verification, and freshness. |
| `/control-abort` | `/control-abort` | Ends the workflow after confirmation. It does not revert files. Without UI confirmation it fails closed. |
| `/commit <task-id> [message]` | `/commit BACK-123 BACK-123: validate config` | Commits the verified or waived task changes after confirmation. It does not push or close the Backlog task. |

Task IDs must match the active task. A changed Backlog task definition is treated as a hard mismatch. Restore the task or abort and start a new `/implement` run.

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

`/verify` is manual and does not consume or start the repair loop.

State is persisted with Pi session entries. On restore, an active run is paused. It does not prompt or verify by itself. Use `/control-status`, `/verify`, or `/implement-resume`.

## Baseline and dirty tree rules

At `/implement` start, `pi-control` records:

- repository root;
- exact `HEAD`;
- tracked file fingerprints;
- dirty outside-scope fingerprints;
- index state.

It refuses to start if anything is staged. It also refuses if any pre-existing dirty tracked or untracked path matches the task scope.

Dirty files outside the task scope may exist at start, but they must stay byte-for-byte and metadata equivalent. If they change later, verification fails.

After start:

- `HEAD` must stay equal to the captured commit until `/commit` succeeds.
- Newly changed paths must match the effective scope.
- Staged content is allowed only for task-changed paths after the run starts.
- Ignored files are not counted unless they become Git-visible.
- Verification reports all offending paths it finds, not just the first one.

The Git adapter hashes all tracked files to detect content and mode changes even when status settings hide them. This can add overhead on large repositories. It stores fingerprints, not copies of file contents.

Submodules, sparse checkout skip-worktree paths, assume-unchanged paths, unmerged index entries, and unsupported index flags fail closed. Literal backslashes in Git filenames are unsupported and produce an error rather than silently naming another file. Scope input separators normalize to `/`, with original text retained for display.

## Verification and stale results

Verification is mechanical:

```text
scope_ok  = repository and path invariants pass
checks_ok = every Verification: command exits 0 and does not mutate Git-visible content
verified  = scope_ok && checks_ok
```

Commands run sequentially from the captured repository root through the configured shell. Default shell invocation on Unix is `/bin/bash -lc <command>`. Each command retains at most 8 KiB each of stdout and stderr, with a truncation marker. Cancellation uses Pi's signal when available and also stops processes on session shutdown.

`Verification:` command text is trusted project configuration from approved Backlog tasks. It is passed as raw shell source. Do not put unreviewed task text there. These commands should be checks, not mutators. If they change Git-visible content, verification fails with `verification-mutated-worktree`.

A `VERIFIED` or `WAIVED` result is bound to a digest of the task, scope, commands, changed paths, and content fingerprints. Any relevant change makes it `STALE`. Staging identical verified content does not by itself change the content digest, but index invariants are still checked.

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
- `HEAD`, task equality, scope, baseline, and digest still pass;
- no staged paths outside the task-changed path set;
- interactive confirmation.

It stages only changed paths that match the effective scope, including deletions. It rechecks after confirmation and staging, then compares the resulting commit against the prepared index. It uses argument-safe Git invocation, not shell interpolation. On success it records `COMMITTED` and the commit SHA. It does not push and does not mark the Backlog task done.

## Troubleshooting

`Cannot run backlog` means Backlog.md 1.52.0 compatible CLI is missing from `PATH`.

`Backlog task scope is invalid` means a `modifiedFiles` entry is unsafe or not supported.

`Backlog task definition changed` means the task JSON no longer exactly matches the task captured at `/implement`. Restore it or `/control-abort` and start over.

`head-changed` means something moved `HEAD` after `/implement`. Return to the captured commit or abort.

`STALE` means verified or waived content changed. Run `/verify` again.

`plan-to-backlog skill is unavailable` means the package skill is not loaded in Pi. Load this package or otherwise install the skill, then rerun task generation from the preserved approved plan.

`Interactive confirmation is required` means the command would change workflow trust, scope, waiver, abort, or commit state. Non-UI mode fails closed.
