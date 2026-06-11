# Path To 1.0

`@async/pipeline` is pre-1.0: breaking changes bump the minor version and are labeled `### Breaking` in the CHANGELOG (see AGENTS.md). This page records what 1.0 means so the bar is explicit instead of vibes.

## What freezes at 1.0

- The `pipeline.ts` config surface: `definePipeline`, `task`, `job`, `trigger`, `source`, `sh`, `env`, `command`, `workspace`, cache refs, and `sync` config.
- CLI command names, flags, and the [exit code contract](api.md#exit-codes).
- The execution record shape at `schemaVersion: 1`; later additive fields stay non-breaking, and any breaking shape change increments `schemaVersion`.
- `.async/` layout: `runs/`, `cache/tasks/`, `sources/`, `run.lock`.
- Generated workflow and lock file paths under `.github/`.

## What must be true before 1.0

- The claims map (`tests/claims.json`) covers every README and api.md behavior claim, and `release:check` stays green on Linux and macOS in CI.
- A decision on Windows: supported with tests, or explicitly out of scope in the README (today: untested, WSL recommended).
- A decision on remote cache stores: shipped, or removed from metadata until a runtime exists.
- A decision on Node-version matrices: today a library that verifies on Node 20/22 keeps a slim hand-maintained matrix workflow running package scripts directly (async-db does this), because the CLI itself requires Node >= 24. Either the CLI floor drops, the generator learns direct-command matrix jobs, or the exception gets blessed in the docs.
- At least one external project using the package in CI whose breakage reports inform the final API pass.
- One minor release with no breaking changes, demonstrating the surface has stopped moving.

## What stays out of 1.0

- Hosted/remote cache execution, automatic dependency discovery, and provider-specific runners stay extension points; their absence is documented in the README's "Not Yet For" list.
