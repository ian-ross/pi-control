# Open issues

Follow-up work after `2c8bc0a`, now implemented. The requirements below remain as a record of the work and its acceptance checks.

## 1. Keep planning limited to the planning document

Status: implemented. The bundled Plannotator configuration limits planning to the document and defers repository task-management instructions until approval. Prompt tests and a live-model smoke passed. The smoke used simulated approval transport, then the real handoff and Backlog CLI. See `test/fixtures/planning-smoke.md`.

- Add explicit Plannotator planning instructions. The agent should inspect the repository, clarify requirements, write the planning document, and submit it for approval. It must not create or update Backlog tasks or implement code during this phase.
- State that repository instructions about task management apply after approval. Approved-plan handoff remains responsible for invoking task generation.
- Update the documented Plannotator configuration. Do not present prompt guidance as hard shell enforcement.

Acceptance:
- Test that the planning instructions explicitly prohibit Backlog mutations before approval.
- Exercise a planning session with Backlog instructions in `AGENTS.md`. Confirm that it submits a plan without creating tasks, then generates tasks after approval.

## 2. Support disposable cache and generated artifacts

Status: implemented. `untrackedArtifacts` loads from user-global config and trusted project overrides. Project lists replace global lists. Runs freeze the compiled policy. Only matching untracked, unstaged regular files qualify; tracked and staged files retain normal checks.

- Add user-controlled artifact patterns, with user-global configuration and trusted project overrides. Define merge behavior and use the existing path/glob safety rules.
- Prefer an `untrackedArtifacts` setting over a universal editable-file whitelist. Keep defaults empty. Example patterns include `**/__pycache__/**` and `**/.pytest_cache/**`.
- Exclude matching untracked artifacts from scope violations, content digests, and verification-mutation failures. Never automatically stage them.
- Keep tracked or staged files subject to normal checks. Generated files intended for commit still require explicit task scope.
- Capture the effective artifact policy in run state so configuration changes cannot silently weaken an active run's checks.

Acceptance:
- A check that creates matching cache files passes without making verification stale.
- Unmatched files, tracked artifacts, and unauthorized staged artifacts still fail.
- Test configuration precedence, restoration, and unsafe patterns or symlink escapes. Confirm that commit excludes artifacts.
- Document Git ignore rules as the simpler alternative when appropriate.

## 3. Assess acceptance criteria and finalize Backlog tasks

Status: implemented. Mechanical verification remains separate from digest-bound read-only acceptance review. Commit requires satisfied criteria and confirms evidence, the final summary, and waived command failures. After the implementation commit, the controller updates only the active task through the CLI and creates a separate task-file-only metadata commit. A persisted finalization journal supports retry without repeating either successful commit.

- Add a separate read-only acceptance review after mechanical verification. Assess each criterion as satisfied, unsatisfied, or uncertain, with supporting evidence. Model review must never override scope or command failures.
- Preserve criterion identifiers and checkbox state from Backlog JSON. Update satisfied criteria through the CLI, not Markdown edits. Define how to handle existing human checkmarks and stale automated assessments.
- Bind review results to the checked task definition and code state. Invalidate them when either changes. Unsatisfied or uncertain criteria must block normal completion; do not silently extend command waivers to acceptance review.
- Present the assessment and proposed final summary during commit confirmation. Record known waived failures explicitly.
- After a successful implementation commit, write the final summary and move the task to the configured terminal status. If finalization fails, persist a retryable state without creating another implementation commit.
- Decide how to commit post-commit Backlog updates before implementing finalization. Auto-commit must remain disabled. Use narrow controller-owned task-file handling, never a blanket exemption for `backlog/`.

Acceptance:
- Test satisfied, unsatisfied, uncertain, malformed, and stale review results. Failed mechanical checks cannot become a model-approved pass.
- Update only the active task's intended criteria and metadata. Unexpected file changes still fail.
- A failed implementation commit never closes the task.
- Test finalization failure and retry, session restoration, waiver disclosure, and the chosen metadata-commit policy.

## Validation

The README and build brief now describe the implemented policy. Tests cover artifact configuration and restoration, stale and malformed acceptance results, human checkmarks, task-file content restrictions, failed implementation commits, partial finalization, hook mutations, and retry after a successful metadata commit.

`npm run check` passes. A separate smoke against installed Backlog.md 1.52.0 confirmed criterion updates, terminal status, two narrow commits, and cache exclusion. That completion smoke supplied a deterministic review response. The live-model planning smoke did not exercise the browser approval UI.
