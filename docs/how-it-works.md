# How It Works

`@async/pipeline` keeps workflow logic local-first by separating four jobs:

```txt
define -> resolve graph -> run tasks -> write records/cache
```

The pipeline definition is data. The runner decides what must run, executes it sequentially today, and writes durable local evidence under `.async/`.

## 1. Define

The CLI loads one config file from the project root:

```txt
pipeline.ts
pipeline.mjs
pipeline.js
```

The config default-exports `definePipeline(...)`:

```ts
import { definePipeline, job, sh, task } from "@async/pipeline";

export default definePipeline({
  name: "app",
  tasks: {
    build: task({ run: sh`pnpm build` })
  },
  jobs: {
    verify: job({ target: "build" })
  }
});
```

`definePipeline`, `task`, `job`, `trigger`, `source`, `sh`, and deferred `sh((ctx) => ...)` create metadata only. Importing a pipeline does not clone repos, run commands, or evaluate deferred shell callbacks.

## 2. Resolve Graph

Tasks name their dependencies with `dependsOn`:

```ts
task({
  dependsOn: ["typecheck"],
  run: sh`pnpm test`
})
```

When you run:

```sh
async-pipeline run verify
```

the scheduler:

1. Loads and validates the pipeline.
2. Expands the job target into the required dependency graph.
3. Detects missing tasks, missing job targets, and dependency cycles.
4. Sorts tasks into a deterministic execution order.

Source tasks use namespaced refs such as `storefront:test`. The source map is explicit; `@async/pipeline` does not infer dependents from package manifests, lockfiles, npm metadata, or GitHub search.

## 3. Run Tasks

The Node runner creates a run plan, prepares declared sources when needed, then executes tasks in order.

For each task it:

1. Resolves shell and function steps.
2. Checks declared tools.
3. Computes a cache key from task config, declared inputs, resolved commands, and source context.
4. Replays a passing local cache result when the key matches.
5. Runs dirty tasks with retry and timeout policy.
6. Stops on the first failed task.

Execution is sequential in this tranche. Parallel scheduling is planned later.

## 4. Write Records And Cache

Each run writes:

```txt
.async/runs/<run-id>/execution.json
.async/runs/<run-id>/summary.md
.async/runs/<run-id>/logs/<task>.log
```

`execution.json` is the machine-readable record. `summary.md` is the quick human-readable view. Task logs keep command output for inspection.

Task cache is local:

```txt
.async/cache/tasks/<cache-key>/result.json
```

To make a task dirty when a file changes, include that file or glob in `inputs`.

Many-repo impact runs can also reuse warm git checkouts under:

```txt
.async/sources
```

## Core Objects

| Object | Owns |
| --- | --- |
| Pipeline | Graph shape, named tasks, jobs, triggers, named inputs, sources, and defaults. |
| Task | Work unit, `dependsOn`, inputs, outputs, cache, retry, timeout, requirements, environment, and steps. |
| Job | Named entrypoint, trigger binding, target task or tasks, and execution mode. |
| Source | Explicit local or git repo with its own pipeline and optional `prepare` steps. |
| Scheduler | Graph resolution, deterministic order, cache decisions, retries, timeouts, and fail-fast behavior. |
| Runner | Actual command execution on the host or a programmatic adapter. |
| Store | `.async/cache`, `.async/runs`, logs, summaries, source checkouts, and execution metadata. |

## Source Composition

A root pipeline can declare known dependent repos:

```ts
import { definePipeline, job, sh, source, task } from "@async/pipeline";

export default definePipeline({
  name: "design-system",
  sources: {
    storefront: source.git({
      url: "https://github.com/acme/storefront.git",
      ref: "main",
      pipeline: "pipeline.ts",
      prepare: [
        sh`pnpm install --frozen-lockfile`,
        sh((ctx) => sh`pnpm add @acme/design-system@file:${ctx.candidate.dir}`)
      ]
    })
  },
  tasks: {
    impact: task({ dependsOn: ["storefront:test"] })
  },
  jobs: {
    verifyImpact: job({ target: "impact" })
  }
});
```

During execution, the runner resolves or fetches the source, loads its pipeline metadata, namespaces its tasks, runs `prepare` in the source checkout, and runs source tasks with `cwd` set to that checkout.

Path sources with `prepare` require `writable: true` in v1. Git sources use warm checkouts under `.async/sources`.

## Runners And Adapters

The CLI uses the host runner by default.

The Lima adapter is exported from `@async/pipeline/lima` and can be used programmatically:

```ts
import { LimaRunnerAdapter, runJob } from "@async/pipeline";
import pipeline from "./pipeline.js";

await runJob(pipeline, {
  cwd: process.cwd(),
  jobId: "verify",
  adapter: new LimaRunnerAdapter("async-pipeline")
});
```

The current CLI does not automatically route tasks to Lima based on `environment.backend`. That routing is a future scheduler feature.
