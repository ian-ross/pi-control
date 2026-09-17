# Backlog fixtures

## Backlog 1.52.0 task JSON

These files were captured from an isolated temporary Git repository with the installed `backlog` 1.52.0 CLI. Task text is synthetic.

Commands used the supported contract:

```bash
backlog init TestProject --defaults --integration-mode none --task-prefix BACK
backlog task BACK-1 --json
```

Fixtures:

- `backlog-1.52.0-task-view-valid.json` contains a valid task with `modifiedFiles`, acceptance criteria, and Definition of Done items with `Verification:` commands.
- `backlog-1.52.0-task-view-missing-scope.json` contains the real schema for a task with no modified files.
- `backlog-1.52.0-task-view-missing-verification.json` contains the real schema for a task with no executable verification command.
- `backlog-1.52.0-task-view-duplicates.json` records the CLI schema for duplicate Definition of Done commands. The CLI deduplicates exact duplicate `--modified-file` values before JSON output.

## Obsolete Backlog 1.44.0 evidence

The 1.44.0 files are kept only as historical evidence for the earlier blocker. They are obsolete and must not be used as supported task JSON fixtures.

- `backlog-1.44.0-browser-task.json` is a task object returned by the CLI-launched browser API.
- `backlog-1.44.0-mcp-initialize-response.json` is the MCP initialization response.
- `backlog-1.44.0-mcp-task-view-response.json` shows that MCP task viewing returned plain text in a JSON-RPC response.
- `backlog-1.44.0-mcp-task-tool-schemas.json` records task tool schemas that did not declare `modifiedFiles`.
