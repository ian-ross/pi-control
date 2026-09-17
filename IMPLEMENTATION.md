# Implementation plan

Status: implemented and checked. Backlog 1.52.0 supports task JSON and modified-file scope. The user approved checking loaded skill availability without inspecting Pi's skill-command setting. Tests preceded the core state machine. Git and commit review added coverage for staging-neutral digests, symlink escapes, hidden mode changes, hook mutations, and validated session restoration.

1. Inspect Pi 0.85.1, Backlog 1.52.0, and the installed Plannotator event and skill APIs. Capture CLI output in an isolated fixture.
2. Write tests for path matching and Git snapshots before implementing them. Use temporary repositories, NUL-delimited Git output, explicit fingerprints, and argument-safe processes.
3. Test task normalization and sequential verification, including cancellation, output limits, and worktree mutation.
4. Write state-machine tests before implementation. Keep the repair budget explicit and persist every transition. Restore without scheduling work.
5. Wire slash commands, edit/write gating, confirmations, and commit checks to the tested core. Recheck after confirmation and staging.
6. Add the isolated Plannotator adapter and fake-event tests. Ship the existing skill after checking its CLI instructions.
7. Run type checking, linting, and the full test suite. Review hard invariants and document installed-API differences and limitations.

## Follow-up work from open-issues.md

1. Ship planning-only Plannotator instructions and test the approval handoff with Backlog repository instructions present.
2. Add user-controlled disposable untracked artifacts. Freeze policy per run and keep tracked and staged files under normal checks.
3. Add read-only, digest-bound acceptance review. Validate every criterion and keep command waivers separate.
4. Finalize Backlog only after implementation commit success. Use a separate active-task-file-only metadata commit, persist retry state, and never repeat the implementation commit on retry.
5. Test restoration, stale assessments, CLI and commit failures, unexpected metadata changes, and cache exclusion. Update the README and build brief to match.

No commits will be created in this checkout.
