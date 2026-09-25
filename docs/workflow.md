# Workflow details

[Back to the README](../README.md#usage)

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

State is persisted in `.pi/pi-control/state/`, with Pi session entries pointing to the latest saved run. On restore, an active run is paused. It does not prompt or verify by itself. Use `/control-status`, `/verify`, or `/implement-resume`. If the Pi session has no pointer, `/verify <task-id>` and `/implement-resume <task-id>` look up the latest saved local run for that task. If those files are gone, `/implement-resume <task-id> --baseline <commit>` reconstructs a run from a clean baseline commit, but only when that commit is the current `HEAD`.

## Baseline and dirty tree rules

At `/implement` start, or during `/implement-resume <task-id> --baseline <commit>`, `pi-control` records:

- Repository root.
- Exact `HEAD`.
- Tracked file fingerprints.
- Dirty outside-scope fingerprints.
- Index state.

Normal `/implement` refuses to start if anything is staged. It also refuses if any pre-existing dirty tracked or untracked path matches the task scope. The active Backlog task file must already be committed, even when it is outside scope. Explicit-baseline resume is for a lost controller state after work already began, so it reconstructs a clean baseline from the commit instead of treating current changes as pre-existing dirt.

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

See [disposable cache files](configuration.md#disposable-cache-files) for artifact exclusions and [claiming a task](backlog-tasks.md#claiming-a-task) for controller-managed task files.

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

Commit confirmation shows the assessment, evidence, and proposed final summary. Known command failures and their waiver reason appear in the final summary. A blocked acceptance review pauses the run as `FAILED`; use `/implement-resume` to repair it, or `/acceptance-waive <task-id> <reason>` when a human accepts the blocked criteria. A malformed response stays unaccepted. Use `/verify` to request a fresh review after interruption or restoration.

## Waivers

`/verify-waive` records `WAIVED`, never `VERIFIED`.

A waiver requires:

- A current failed verification result.
- Completed command failures or timeouts only, not cancelled verification or worktree mutation.
- No scope failure.
- No changed `HEAD`.
- No task definition change.
- A non-empty reason.
- Interactive confirmation.

A waived commit uses a stronger confirmation and shows the waiver reason and failed commands.

`/acceptance-waive` records a human override for a current blocked acceptance review. It requires:

- Verification passed, or command failures were already waived.
- A current acceptance review with at least one unsatisfied or uncertain criterion.
- No scope failure.
- No changed `HEAD`.
- No task definition change.
- A non-empty reason.
- Interactive confirmation.

The override binds to the same task and code digests as the blocked review. If either changes, the override becomes stale. Commit confirmation and the final summary show the human override reason and waived criteria.

## Scope enforcement limits

`pi-control` blocks built-in `edit` and `write` tool calls before execution when the target path is outside scope. It does not block reads.

This gate covers Pi's built-in `edit` and `write` tools only. It does not cover custom tools, arbitrary shell commands, external editors, Git hooks, or concurrent processes. Bash can mutate anything the process user can write. `pi-control` catches Git-visible mutations after the fact during `/verify`, `/control-status`, `/implement-resume`, and `/commit`.

There is no security sandbox. Use operating system permissions, containers, or a Pi permission extension when you need hard isolation.

Recommended external permission rules:

- Allow reads.
- Allow `edit` and `write`; `pi-control` gates those built-ins while a run is active.
- Treat shell as powerful. Approved `Verification:` commands are arbitrary shell.
- Deny agent-issued Git history and ref mutations: `commit`, `merge`, `rebase`, `push`, `tag`, `checkout`, `switch`, `reset`, `clean`, and `stash`.
- Let `/commit` handle commits. It invokes Git directly after checks and confirmation.

Git hooks remain trusted code. During `/commit`, temporary wrappers run existing pre-commit, prepare-commit-msg, and commit-msg hooks, then reject changes to the checked index or Git-visible content. A formatter hook must leave its edits for another `/verify`, not commit them unverified. Post-commit runs normally. Hook failures leave changes and staging in place, and any content changes invalidate verification.

These checks do not isolate malicious hooks or concurrent processes. Do not run another writer against the repository during verification or commit. The extension never pushes, merges, rebases, tags, resets, cleans, checks out, switches, or stashes.

## Commit behavior

`/commit` requires:

- The supplied task ID equals the active task.
- State is current `VERIFIED` or `WAIVED`.
- A current acceptance assessment marks every criterion satisfied and provides evidence.
- `HEAD`, task equality, scope, baseline, and digest still pass.
- No staged paths outside the task-changed path set.
- Interactive confirmation.

The first commit stages only changed implementation paths that match the effective scope, including deletions. The separate metadata commit includes the active task file, including its controller-owned claim changes. It rechecks after confirmation and staging, then compares the resulting commit against the prepared index. It uses argument-safe Git invocation, not shell interpolation.

After implementation commit success, the controller persists the SHA before finalizing Backlog. It checks satisfied criteria through the CLI, writes the confirmed final summary, and moves the task to the terminal status captured at run start. A second commit includes only that task file. `COMMITTED` means both steps succeeded. It never pushes.

If finalization fails, `/commit <task-id>` retries only finalization. It does not create another implementation commit. The saved state survives session restoration and stays paused until explicit retry. Unexpected file changes, task edits, or index changes block the retry. The controller compares CLI readback and task-file text, allowing only intended criterion checkmarks, status, timestamp, and final summary changes. Task files over 1 MiB or unsupported Markdown layouts fail closed. Inspect failures rather than using a blanket `backlog/` scope exemption.

The finalization journal stores the approved summary, criterion indexes, terminal status, and original task text. Partial intended CLI edits can be retried. Both commits use hook guards. The controller records each prepared commit diff before invoking Git. If a commit succeeds before a post-commit timeout or interrupted session, retry recognizes that exact diff and parent. It does not repeat the successful commit. A reported implementation commit failure never triggers task closure in that attempt.
