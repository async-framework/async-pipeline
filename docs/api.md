# API Reference

This is the first public API surface for `@async/pipeline`.

## Imports

Use the public package for normal authoring:

```ts
import { definePipeline, job, sh, source, task, trigger } from "@async/pipeline";
```

Subpaths are available for advanced use:

```ts
import { definePipeline } from "@async/pipeline/core";
import { runJob } from "@async/pipeline/node";
import { LimaRunnerAdapter } from "@async/pipeline/lima";
```

## definePipeline

```ts
definePipeline({
  name: "app",
  namedInputs: {},
  taskDefaults: {},
  triggers: {},
  sources: {},
  tasks: {},
  jobs: {}
});
```

Fields:

| Field | Purpose |
| --- | --- |
| `name` | Pipeline name written into execution records. |
| `namedInputs` | Reusable input groups referenced by task `inputs`. |
| `taskDefaults` | Defaults applied by exact task id or task name segment. |
| `triggers` | Named trigger declarations. |
| `sources` | Explicit local or git repos whose pipeline can be composed into this graph. |
| `tasks` | Task map. |
| `jobs` | Job map. |

Pipeline definitions are metadata. Importing a pipeline, calling `definePipeline`, or reading metadata does not execute tasks.

## task

```ts
task({
  description: "Build the app",
  dependsOn: ["typecheck"],
  inputs: ["src/**/*.ts", "package.json"],
  outputs: ["dist/**"],
  cache: true,
  retry: { attempts: 2, delayMs: 500 },
  timeout: "2m",
  requires: { tools: ["node", "pnpm"] },
  environment: { backend: "host" },
  run: sh`pnpm build`
})
```

Fields:

| Field | Purpose |
| --- | --- |
| `dependsOn` | Task ids that must run first. Use `<source>:<task>` for declared source tasks. |
| `inputs` | Files or named input groups that affect cache keys. |
| `outputs` | Files produced by the task. Included in metadata and cache config. |
| `cache` | `true`, `false`, or cache options. |
| `retry` | Number of attempts or `{ attempts, delayMs }`. |
| `timeout` | Milliseconds or a duration string such as `500ms`, `30s`, `5m`, `1h`. |
| `requires` | Tool, secret, or runtime declarations. |
| `environment` | Backend declaration such as host or Lima. CLI routing to Lima is not automatic today. |
| `run` | One shell command or function step. |
| `steps` | Multiple shell commands or function steps. |

`dependsOn` is the author-facing dependency keyword.

## source

```ts
source.path({
  path: "../admin",
  pipeline: "pipeline.ts",
  writable: true,
  prepare: [sh`pnpm install --frozen-lockfile`]
});

source.git({
  url: "https://github.com/acme/storefront.git",
  ref: "main",
  pipeline: "pipeline.ts",
  prepare: [
    sh`pnpm install --frozen-lockfile`,
    sh((ctx) => sh`pnpm add @acme/design-system@file:${ctx.candidate.dir}`)
  ]
});
```

Sources are explicit. `@async/pipeline` does not infer reverse dependencies from package manifests, lockfiles, npm metadata, or GitHub search.

Use namespaced refs from root tasks:

```ts
task({
  dependsOn: ["storefront:test", "admin:test-design-system"]
})
```

Path sources with `prepare` require `writable: true` in v1. Git sources use warm checkouts under `.async/sources`.

## sh

```ts
task({
  run: sh`pnpm test`
})
```

`sh` creates a shell step. The host runner executes it from the task working directory.

Use deferred `sh` only when runtime context is needed:

```ts
sh((ctx) => sh`pnpm add @acme/design-system@file:${ctx.candidate.dir}`)
```

Deferred shell callbacks are metadata-safe. They are not evaluated when a pipeline is imported or read through `metadata`.

## Function Steps

```ts
task({
  async run(ctx) {
    ctx.log(`running ${ctx.taskId}`);
    ctx.meta({ checked: true });
  }
})
```

Function steps receive:

| Field | Purpose |
| --- | --- |
| `taskId` | Current task id. |
| `runId` | Current execution id. |
| `cwd` | Current task working directory. Root tasks use the root repo; source tasks use the source checkout. |
| `env` | Process environment. |
| `root.dir` | Root pipeline directory. |
| `candidate` | Candidate repo context: `dir`, `fingerprint`, optional git facts. |
| `source` | Source repo context for namespaced source tasks and `prepare` steps. |
| `meta` | Add task metadata to the execution record. |
| `log` | Append to the task log. |
| `sh` | Create shell command values. |

## job

```ts
job({
  description: "Full verification",
  target: "build",
  trigger: ["push"],
  mode: "ci"
})
```

Fields:

| Field | Purpose |
| --- | --- |
| `target` | Task id or task ids used as the job entrypoint. |
| `trigger` | Trigger ids attached to the job. |
| `mode` | Optional `manual` or `ci` mode. |

## trigger

```ts
trigger.manual();
trigger.github({ events: ["push", "pull_request"] });
trigger.schedule("0 9 * * 1");
```

Triggers are declarations today. GitHub Actions still invokes the CLI explicitly with `async-pipeline run <job>`.

## Execution Record Shape

Runs are written to:

```txt
.async/runs/<run-id>/execution.json
```

The record includes:

```ts
interface ExecutionRecord {
  id: string;
  pipelineName: string;
  jobId: string;
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "passed" | "failed";
  mode: "manual" | "ci";
  tasks: TaskResult[];
  sources?: Record<string, ExecutionSourceRecord>;
}
```

Task results include status, attempts, cache key, cache hit, timings, error, and metadata.

## Metadata

Read metadata without running anything:

```sh
async-pipeline metadata --format json
async-pipeline metadata --format json --include-sources
```

Metadata reads do not clone sources, run source `prepare`, execute tasks, or evaluate deferred shell callbacks. `--include-sources` only loads source pipeline metadata from already-available path sources or previously synced git checkouts.
