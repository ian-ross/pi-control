# Planning and Plannotator

[Back to the README](../README.md#plan-work)

## Configure Plannotator

Use the [Plannotator fork listed in the installation instructions](../README.md#installation). `/plan` requires a `/plannotator-plan-mode` handler that accepts a file path. Some releases document that argument but ignore it in the handler. Those releases toggle mode without selecting the file and need an update or fix.

Copy [`skills/plannotator.example.json`](../skills/plannotator.example.json) to `.pi/plannotator.json`, or merge its `executionMode` and planning phase into your existing configuration. Keep your preferred model and thinking settings. You can also use global config at `~/.pi/agent/plannotator.json`.

For automatic task generation after plan approval, Plannotator must use external mode:

```json
{
  "executionMode": "external"
}
```

The example also includes a planning prompt, readable in [`skills/plannotator-planning-instructions.md`](../skills/plannotator-planning-instructions.md). It tells the planning agent to inspect the repository, clarify requirements, write only the planning document, and submit it for approval. Before approval it prohibits creating or updating Backlog tasks, changing task status or checkboxes, and implementing code. Repository task-management instructions in `AGENTS.md` apply after approval. The approved-plan handoff invokes task generation.

These instructions guide the model. They are not hard shell enforcement. Plannotator controls its planning tools; this extension does not intercept arbitrary Bash commands during planning.

## Plan filenames

```text
/plan add user profile page
```

`/plan` reloads `pi-control.json`, creates `plansDirectory` if needed, and selects a filename such as `plans/005-add-user-profile-page.md`. The directory is relative to the Git repository root, even when Pi starts in a subdirectory.

The sequence starts at `001` and uses the highest existing `number-name.md` plus one. It does not fill gaps or scan subdirectories. Numbers have at least three digits and grow past `999`. The slug uses lowercase ASCII letters and digits, removes accents, and replaces separators with hyphens. Empty descriptions or empty slugs show usage.

The command forwards only the selected path to `/plannotator-plan-mode`. Then write your detailed planning prompt. It does not submit the description as a prompt or create an empty plan file. Numbers are not reserved until a plan exists on disk, so avoid concurrent planning sessions in the same directory. Finish or abort any controlled implementation run before using `/plan`.

The wrapper preserves Plannotator's toggle behavior, so invoke it while plan mode is off.

## Approved-plan handoff

Plannotator 0.27.15 emits `plannotator:plan-approved` with `cwd`, `planFilePath`, `planContent`, and optional `feedback`. `pi-control` listens to that plain string event. It resolves `planFilePath` against the event `cwd`, queues a follow-up prompt, and invokes:

```text
/skill:plan-to-backlog
```

The skill ships at [`skills/plan-to-backlog/SKILL.md`](../skills/plan-to-backlog/SKILL.md). Load the package directory, not just `src/index.ts`, to make the skill available.

Loaded skill availability is enough. `pi-control` checks for the loaded `skill:plan-to-backlog` command and does not check an `enableSkillCommands` setting. The skill sets `disable-model-invocation: true`, so Pi does not advertise it for the model to select during planning. Explicit invocation and the approved-plan handoff still work.

The handoff creates or updates Backlog tasks only. It requires a task-local implementation plan for every task and instructs the agent to verify the saved field through CLI JSON. It does not start `/implement`.

Backlog auto-commit must be disabled before handoff. If the check blocks handoff, the approved plan is preserved. Fix the setting, then invoke `/skill:plan-to-backlog` with the approved plan explicitly. Handoff does not retry automatically. See [configuration](configuration.md#backlog-auto-commit).
