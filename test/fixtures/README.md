# Backlog fixtures

## Backlog 1.52.0 task JSON

These files were captured from an isolated temporary Git repository with the installed `backlog` 1.52.0 CLI. Task text is synthetic.

Commands used the supported contract:

```bash
backlog init TestProject --defaults --integration-mode none --task-prefix BACK
backlog task BACK-1 --json
```

Fixtures:

- `backlog-1.52.0-task-view-valid.json` contains a valid task with `modifiedFiles`, an `implementationPlan`, acceptance criteria, and Definition of Done items with `Verification:` commands. It was recaptured after writing a plan through `backlog task edit BACK-1 --plan <text>` while the task remained To Do.
- `backlog-1.52.0-task-view-missing-plan.json` preserves the earlier valid-task capture with `implementationPlan: null`. The new adapter rejects it.
- `backlog-1.52.0-task-view-missing-scope.json` contains the real schema for a task with no modified files.
- `backlog-1.52.0-task-view-missing-verification.json` contains the real schema for a task with no executable verification command.
- `backlog-1.52.0-task-view-duplicates.json` records the CLI schema for duplicate Definition of Done commands. The CLI deduplicates exact duplicate `--modified-file` values before JSON output. The normalization test supplies a task plan before testing deduplication because this older capture lacks one.

## Backlog 1.52.0 auto-commit configuration

Live probes in an isolated temporary Git repository confirmed that `backlog config get autoCommit` prints `false\n` or `true\n` and exits 0. A freshly initialized project using defaults printed `false\n`. Without an initialized Backlog project, the command exited 1 and asked the user to run `backlog init` on stderr.

The configuration tests use these plain-text responses. Only the task-view adapter uses CLI JSON. The supported user command to disable automatic commits is `backlog config set autoCommit false`; the extension only reads the setting.

## Backlog 1.52.0 claiming

A live temporary-project probe confirmed that `backlog task edit BACK-2 --status 'In Progress' --assignee '@pi-control'` reports `status: "In Progress"` and `assignees: ["@pi-control"]` in task-view JSON without changing the task path. Auto-commit was disabled.

A separate controller smoke test used the real CLI and Git. `/implement` changed the claim before its first prompt without moving HEAD. `/verify` passed, and `/commit` included only the implementation file and active task file. No model turn ran during this test.

## Obsolete Backlog 1.44.0 evidence

The 1.44.0 files are kept only as historical evidence for the earlier blocker. They are obsolete and must not be used as supported task JSON fixtures.

- `backlog-1.44.0-browser-task.json` is a task object returned by the CLI-launched browser API.
- `backlog-1.44.0-mcp-initialize-response.json` is the MCP initialization response.
- `backlog-1.44.0-mcp-task-view-response.json` shows that MCP task viewing returned plain text in a JSON-RPC response.
- `backlog-1.44.0-mcp-task-tool-schemas.json` records task tool schemas that did not declare `modifiedFiles`.
