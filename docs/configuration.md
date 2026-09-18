# Configuration reference

[Back to the README](../README.md#configuration)

## Backlog auto-commit

Disable Backlog auto-commit before starting a controlled run or generating tasks:

```bash
backlog config set autoCommit false
backlog config get autoCommit
```

The second command must print `false`. This is a Backlog project setting, not a field in `.pi/pi-control.json`.

`pi-control` checks it before `/implement` and automatic plan handoff, and rechecks it during verification, resume, and commit eligibility checks. Enabled, unreadable, or unexpected values block the operation. A blocked handoff preserves the approved plan without starting task generation. After fixing the setting, invoke `/skill:plan-to-backlog` with that approved plan explicitly. It is not retried automatically.

The extension never changes this setting, commits the configuration change, or accepts an unexpected `HEAD` change. Set it before starting a run. Later configuration edits remain subject to the normal scope and baseline checks. The skill also checks the prerequisite before task writes. These checks do not intercept arbitrary Backlog commands issued through Bash or another terminal.

## pi-control settings

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

## Disposable cache files

For caches that every contributor should ignore, prefer `.gitignore`. For user-specific exclusions, set `untrackedArtifacts` in global config, or override it in a trusted project:

```json
{
  "untrackedArtifacts": ["**/__pycache__/**", "**/.pytest_cache/**"]
}
```

Only matching untracked, unstaged regular files qualify. They do not cause scope violations or verification-mutation failures, do not affect the content digest, and are never automatically staged, even when task scope also matches. Tracked and staged files get no exemption. Generated files intended for commit still require explicit task scope and must not qualify as disposable artifacts.

Patterns use the path and glob safety rules described in [Backlog tasks](backlog-tasks.md). Symlink escapes are not cache exemptions. Each run saves its effective artifact policy. Editing config or restoring a session does not change an active run's exclusions. Start a new run to adopt a different policy.
