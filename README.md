# pi-control

`pi-control` is a Pi extension for planning and implementing development work
in a structured way with deterministic verification at each step along the
way.

In _planning mode_, `pi-control` uses a detailed grilling approach along with
Plannotator for plan review and adjustment, to arrive at an agreed
plan for a piece of work. It then breaks that plan down into Backlog issues
for implementation. Importantly, the Backlog issues record the expected scope
of modifications for the issue as a list of files and file globs, plus a set
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

- [Installation](#installation)
- [Configuration](#configuration)
- [Usage](#usage)
- [Command reference](#command-reference)
- [Further documentation](#further-documentation)

## Installation

You need Node.js 22+, [Pi](https://github.com/earendil-works/pi-mono), Git,
and [Backlog.md](https://github.com/MrLesk/Backlog.md) installed, with
`backlog` on `PATH`. Initialize Backlog in the Git repository where you want
to work. Ensure that auto-commit for Backlog issue changes is *disabled*. The
tested environment is Linux with `/bin/bash`, Pi 0.85.1, and Backlog CLI
1.52.0. See [the tested setup](docs/development.md#tested-setup) for all
versions.

From your project's root, install the extensions:

```bash
pi install -l git:github.com/ian-ross/plannotator@plannotator-pi
pi install -l npm:pi-rules
pi install -l git:github.com/ian-ross/pi-review
pi install -l npm:pi-answer@0.1.4
pi install -l git:github.com/ian-ross/pi-control
```

Use my fork of Plannotator as shown above. Some other releases document a
plan-file argument but ignore it, so `/plan` cannot select the intended file.
Also use my fork of `pi-review`, which returns more compact summaries and has
a "fixes only" return mode that helps prevent context blowup.

These commands install packages for the local project only. Omit `-l` for a
user-global installation.

## Configuration

### Configure Plannotator

Copy [`skills/plannotator.example.json`](skills/plannotator.example.json) from
this package to your project's `.pi/plannotator.json`. If you already have a
Plannotator configuration, merge the example's `executionMode` and planning
phase into it. Keep your preferred model and thinking settings.

The example sets `"executionMode": "external"` so approval hands the plan to
`plan-to-backlog` instead of starting implementation. Its planning instructions
keep the agent focused on the plan document and defer Backlog task changes
until approval. You can read the prompt in
[`skills/plannotator-planning-instructions.md`](skills/plannotator-planning-instructions.md).

These are model instructions, not shell restrictions. See
[planning and Plannotator](docs/planning.md) for global configuration and
handoff details.

### Set project preferences

No `pi-control` config file is required for the defaults. To override them,
create `.pi/pi-control.json` in a trusted project, or use
`~/.pi/agent/pi-control.json` for user-global settings. Project values override
global values.

For example, these are the default identity, statuses, and repair limit:

```json
{
  "claimAssignee": "@pi-control",
  "readyStatus": "To Do",
  "inProgressStatus": "In Progress",
  "terminalStatus": "Done",
  "maxRepairAttempts": 2
}
```

Change the identity and status names to match your Backlog project. Plans go
in `plans/` by default, and each verification command has a 120-second timeout.
The [configuration reference](docs/configuration.md) lists every setting,
validation rule, and disposable-cache exclusion option.

`pi-control` writes durable run state under `.pi/pi-control/state/`. Keep that
state local and add it to `.gitignore`. The files contain controller state and
baseline fingerprints. `pi-control` ignores that directory during scope checks
and guarded commits, but it should not be committed.

Use a coding agent to generate `pi-rules` rules for your codebase.

Start interactive Pi in the project and approve project trust so it can load
the project packages and configuration. Restart Pi if you changed its trust
decision. If Pi was already running during setup, use `/reload` to load the
installed extensions and skills. Run `/control-status` to check that
`pi-control` loaded.

## Usage

### Plan work

With Plannotator plan mode off, run:

```text
/plan add user profile page
```

This selects a numbered path such as `plans/001-add-user-profile-page.md`
and enters Plannotator plan mode. The description names the file; it is not
the planning prompt. Send your detailed requirements in the next message.

Work through the planning questions, review the plan in Plannotator, and
approve it when ready. The approved-plan handoff generates Backlog tasks with
file scope, a task-local implementation plan, acceptance criteria, and
`Verification:` Definition of Done entries. It does not start implementation.

If handoff is blocked, fix the reported problem and invoke
`/skill:plan-to-backlog` with the approved plan explicitly. It does not retry
automatically. You can also [create compatible tasks manually](docs/backlog-tasks.md#create-a-task-manually).

### Implement a task

Before starting, make sure nothing is staged and no files in the task's scope
have uncommitted changes. Existing changes outside scope may remain, but must
stay unchanged during the run. Do not run another writer against the same
worktree or task.

```text
/implement BACK-123
```

By default, this claims an unassigned To Do task as `@pi-control`, moves it to
In Progress, and prompts the agent to implement its saved plan. It refuses
tasks assigned to someone else. Only one controlled run can be active.

When the agent finishes, `pi-control` checks scope and runs the task's
verification commands. Failed verification allows up to two automatic repair
turns by default. Successful checks lead to a separate read-only LLM-as-judge
acceptance review based on the acceptance criteria of the task. Every
criterion must be satisfied before commit.

Use `/control-status` to inspect progress and `/scope-show` to see the allowed
files. If the task needs another file, add it with confirmation:

```text
/scope-add src/new-file.ts
```

Scope additions apply only to this run. Do not edit the Backlog task definition
during a run. Task changes invalidate the captured definition.

### Recover or recheck

If the repair limit is reached or acceptance review fails, inspect the reported
failures, then resume:

```text
/implement-resume BACK-123
```

Resume rechecks the saved baseline and resets the repair budget. If the saved
run state is gone but the implementation began from the current `HEAD`, provide
that clean commit explicitly:

```text
/implement-resume BACK-123 --baseline abc1234
```

The explicit baseline must be the current `HEAD`; `pi-control` still refuses to
resume across a changed Git history. To rerun checks without starting an automatic
repair loop, use `/verify BACK-123`. Use it again if changes make a result `STALE`.

Restored sessions stay paused. Check `/control-status`, then explicitly verify
or resume. In a new Pi session, `/verify BACK-123` and `/implement-resume BACK-123`
can restore the latest local run state from `.pi/pi-control/state/`. `/control-abort`
ends a run after confirmation, but does not revert files or release the task claim.

A human can waive eligible command failures with
`/verify-waive BACK-123 upstream service unavailable`. A waiver records the
failure and reason; it does not turn a failed check into a pass. Scope failures
and task changes cannot be waived. If the read-only acceptance review blocks on
a criterion that a human accepts, use `/acceptance-waive BACK-123 <reason>`.
See [waiver rules](docs/workflow.md#waivers) and [troubleshooting](docs/troubleshooting.md).

### Review and commit

After verification and acceptance review succeed:

```text
/commit BACK-123
```

Review the acceptance evidence, final summary, and any waived failures in the
confirmation dialog. The controller commits the implementation, then finalizes
the Backlog task in a separate task-file-only commit. It never pushes.

If finalization fails after the implementation commit, fix the reported problem
and retry `/commit BACK-123`. It retries finalization without creating another
implementation commit.

### Safety limits

`pi-control` is not a security sandbox. It blocks out-of-scope built-in `edit`
and `write` calls, but shell commands, custom tools, and external processes can
still write files. The controller detects Git-visible violations afterward.
Review `Verification:` commands before running a task. They execute as raw
shell commands and must check files without changing them.

Use interactive Pi for commands that require confirmation. See
[scope enforcement limits](docs/workflow.md#scope-enforcement-limits) for hook
behavior and suggested external permission rules.

## Command reference

| Command | What it does |
| --- | --- |
| `/plan <description>` | Selects a numbered plan path and enters Plannotator plan mode. Send the planning prompt afterward. |
| `/implement <task-id>` | Validates and claims the task, then starts implementation and automatic verification. |
| `/implement-resume [task-id] [--baseline <commit>]` | Resumes a failed or restored run after rechecking its baseline. With a task ID and current `HEAD` commit, reconstructs missing run state from that clean baseline. |
| `/verify [task-id]` | Runs scope and command checks, then requests acceptance review on success. Does not start a repair loop. |
| `/verify-waive <task-id> <reason>` | Records a confirmed human waiver for eligible failed commands. |
| `/acceptance-waive <task-id> <reason>` | Records a confirmed human override for blocked acceptance criteria. |
| `/scope-show` | Shows task scope, run-local additions, and the frozen artifact policy. |
| `/scope-add <scope-entry>` | Adds one run-local scope entry after confirmation. Use the path or glob directly, without shell quotes. |
| `/control-status` | Shows the active task, phase, baseline, scope, repair count, latest verification, and freshness. |
| `/control-abort` | Ends the workflow after confirmation. Does not revert files. |
| `/commit <task-id> [message]` | Commits checked changes and finalizes the task after confirmation. Also retries pending finalization. |

Task IDs must match the active task. If its definition changes, restore it or
abort and start a new run.

## Further documentation

- [Configuration reference](docs/configuration.md)
- [Planning and Plannotator](docs/planning.md)
- [Backlog task format and claiming](docs/backlog-tasks.md)
- [Workflow details](docs/workflow.md), including Git baseline rules, acceptance review, and commit recovery
- [Troubleshooting](docs/troubleshooting.md)
- [Development and tested setup](docs/development.md)
