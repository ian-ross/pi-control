# Implementation plan

Status: implemented and checked. Backlog 1.52.0 supports task JSON and modified-file scope. The user approved checking loaded skill availability without inspecting Pi's skill-command setting. Tests preceded the core state machine. Git and commit review added coverage for staging-neutral digests, symlink escapes, hidden mode changes, hook mutations, and validated session restoration.

1. Inspect Pi 0.85.1, Backlog 1.52.0, and the installed Plannotator event and skill APIs. Capture CLI output in an isolated fixture.
2. Write tests for path matching and Git snapshots before implementing them. Use temporary repositories, NUL-delimited Git output, explicit fingerprints, and argument-safe processes.
3. Test task normalization and sequential verification, including cancellation, output limits, and worktree mutation.
4. Write state-machine tests before implementation. Keep the repair budget explicit and persist every transition. Restore without scheduling work.
5. Wire slash commands, edit/write gating, confirmations, and commit checks to the tested core. Recheck after confirmation and staging.
6. Add the isolated Plannotator adapter and fake-event tests. Ship the existing skill after checking its CLI instructions.
7. Run type checking, linting, and the full test suite. Review hard invariants and document installed-API differences and limitations.

No implementation commits will be created.
