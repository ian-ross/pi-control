# Development

[Back to the README](../README.md)

## Local setup

From a checkout:

```bash
npm install
npm run check
pi -e .
```

To keep the local package installed, run `pi install /absolute/path/to/pi-control`. Load the package directory for plan handoff. Loading only `src/index.ts` does not load the bundled skill.

## Checks

`npm run check` runs typechecking, linting, and the test suite. You can also run them separately:

```bash
npm run typecheck
npm run lint
npm test
```

A model-free load check is:

```bash
pi --no-extensions -e ./src/index.ts --no-skills --no-prompt-templates \
  --no-themes --no-context-files --no-session -p /control-status
```

## Tested setup

The implementation and unit tests were built against these versions:

| Component | Version |
| --- | --- |
| Pi | 0.85.1 |
| Backlog.md CLI | 1.52.0 |
| Plannotator Pi extension | 0.27.15 |
| Node.js | 24.18.1 |
| Git | 2.55.0 |
| OS | Linux with `/bin/bash` |

The package requires Node 22+.

Automated tests use temporary Git repositories and fake Pi adapters. The model-free Pi `/control-status` smoke test also passes.

A separate live-model planning smoke test read conflicting Backlog instructions in `AGENTS.md`, changed only `PLAN.md` before approval, then created a task through the real CLI after approval. That test simulated the approval transport rather than opening the Plannotator browser.

A Backlog CLI completion smoke test checked criterion updates, terminal status, separate commits, and cache exclusion. It used a deterministic acceptance response, not a live model implementation turn.

## Package distribution

The package includes `src/`, `skills/`, `docs/`, and the README. Keep the reference
docs in the package so installed copies retain the README's relative links.

When published as a Pi package, it can also be installed through npm:

```bash
pi install npm:pi-control
```

## Related references

- [Planning and Plannotator](planning.md) documents the approval event and skill handoff.
- [Backlog tasks](backlog-tasks.md) documents the CLI data contract and claiming rules.
- [Workflow details](workflow.md) documents state transitions, Git checks, review, and finalization.
- [Configuration reference](configuration.md) lists defaults and validation rules.
