# Live planning smoke

Validated on 2026-09-17 with Pi 0.85.1 and Backlog.md 1.52.0 in a disposable repository.

The live planning model read an `AGENTS.md` that required immediate task creation. Its phase instructions came from `skills/plannotator.example.json`. Bash remained available, so the check tested model compliance rather than a shell restriction.

Before approval:

- The model submitted `PLAN.md` with `plannotator_submit_plan`.
- `PLAN.md` was the only changed file.
- Backlog had no task files or tasks.

A simulated approval transport then emitted `plannotator:plan-approved` into the real controller. The handoff invoked the bundled `plan-to-backlog` skill. The live model created `TASK-1`, "Accept numeric strings in add", through the actual Backlog CLI.

The task remained To Do. Its scope contained `src/add.js` and `test/add.test.js`, its Definition of Done included `Verification: npm test`, and CLI readback returned a 726-character implementation plan. Backlog auto-commit stayed false, Git HEAD did not move, and no product code changed.

The Plannotator browser UI was not part of this smoke. Approval used a file marker after the runner checked the pre-approval state. This supplements the deterministic prompt and event tests in `test/skills.test.ts` and `test/plannotator.test.ts`.
