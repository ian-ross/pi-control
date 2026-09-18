# Troubleshooting

[Back to the README](../README.md#usage)

Start with `/control-status` to see the active task, phase, latest verification, and freshness. A restored session stays paused until you run `/verify` or `/implement-resume`.

## Common errors

| Message | Meaning and next step |
| --- | --- |
| `Cannot run backlog` | A Backlog.md 1.52.0 compatible CLI is missing from `PATH`. Install it or fix `PATH` before retrying. |
| `Backlog task scope is invalid` | A `modifiedFiles` entry is unsafe or unsupported. Check the [task convention](backlog-tasks.md#task-convention). |
| `Backlog task definition changed` | The normalized task definition or claim no longer matches the task captured at `/implement`. Restore it or use `/control-abort` and start over. |
| `head-changed` | Something moved `HEAD` after `/implement`. Restore the captured state only if you can do so without losing work, or abort the run. |
| `STALE` | Verified or waived content changed. Run `/verify` again. |
| `plan-to-backlog skill is unavailable` | The package skill is not loaded in Pi. Load the package directory, not just `src/index.ts`, then rerun task generation from the preserved approved plan. |
| `Interactive confirmation is required` | The command would change workflow trust, scope, waiver, abort, or commit state. Use interactive Pi. Non-UI mode fails closed. |

## Handoff did not generate tasks

Check that Plannotator uses `"executionMode": "external"`, the `plan-to-backlog` skill is loaded, and Backlog auto-commit is disabled. A blocked auto-commit check preserves the approved plan but does not retry automatically. Fix the setting, then invoke `/skill:plan-to-backlog` with that approved plan explicitly.

See [planning and Plannotator](planning.md) for the configuration and handoff contract.

## A task has no implementation plan

Populate its `implementationPlan` from the approved parent plan using `backlog task edit <id> --plan <text>`, then read it back with `backlog task <id> --json`. Do not use a placeholder. Abort an active run before changing its task definition, then start a new run.

See the [manual task example](backlog-tasks.md#create-a-task-manually).

## Verification or acceptance review stopped

Use `/implement-resume <task-id>` to continue repairs after a failed run. It rechecks the saved baseline and resets the automatic repair budget. Use `/verify` to rerun checks and request a fresh acceptance review after an interruption. Acceptance review cannot be waived.

If checks generate disposable cache files, prefer `.gitignore` or configure [artifact exclusions](configuration.md#disposable-cache-files) before starting a new run. Commands that change other Git-visible content fail verification.

## Commit finalization failed

After fixing the reported problem, retry `/commit <task-id>`. If the implementation commit already succeeded, the controller retries only Backlog finalization. It does not create another implementation commit. Do not edit the task or expand scope to all of `backlog/` to bypass the failure.

See [commit behavior](workflow.md#commit-behavior) for retry checks and hook handling. `/control-abort` does not revert files or release a task claim.
