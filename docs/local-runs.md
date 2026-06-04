# Running Locally

Local runs are the primary workflow. GitHub Actions should only invoke the same pipeline you already run on your machine.

Use `async-pipeline` when you want the command to be explicit. Short aliases and smart runner dispatch belong in `@async/run`.

## Commands

List jobs and tasks:

```sh
pnpm async-pipeline list
```

Run a job:

```sh
pnpm async-pipeline run verify
```

Run one task without its dependents:

```sh
pnpm async-pipeline run-task test
```

Explain a task:

```sh
pnpm async-pipeline explain build
```

Render the graph:

```sh
pnpm async-pipeline graph --format json
pnpm async-pipeline graph --format dot
```

Read pipeline metadata without running anything:

```sh
pnpm async-pipeline metadata --format json
pnpm async-pipeline metadata --format json --include-sources
```

List and sync declared sources:

```sh
pnpm async-pipeline sources list
pnpm async-pipeline sources sync
```

Run a source task:

```sh
pnpm async-pipeline run-task storefront:test
```

Generate a GitHub matrix for source tasks in a job:

```sh
pnpm async-pipeline matrix verifyImpact --format github
```

Run environment checks:

```sh
pnpm async-pipeline doctor
```

## Inspect A Run

After `async-pipeline run verify`, inspect `.async/runs`:

```sh
ls .async/runs
cat .async/runs/<run-id>/summary.md
cat .async/runs/<run-id>/execution.json
ls .async/runs/<run-id>/logs
```

The execution record includes:

- run id
- pipeline name
- job id
- mode
- start and finish time
- overall status
- task statuses
- task attempts
- cache keys
- cache hit flags
- errors
- metadata

## Cache Behavior

Enable cache per task:

```ts
task({
  inputs: ["src/**/*.ts", "package.json", "pnpm-lock.yaml"],
  outputs: ["dist/**"],
  cache: true,
  run: sh`pnpm build`
})
```

On the next run, the task can be skipped when:

- the task config is the same
- shell commands are the same
- declared input file contents are the same
- the previous cached result passed

For source tasks, cache keys also include source context, candidate fingerprint, and resolved `prepare` commands.

Warm source checkouts live under:

```txt
.async/sources
```

That lets repeated impact runs reuse git checkouts and dependency/build caches inside the dependent repo.

Clear local state:

```sh
rm -rf .async
```

## Retry And Timeout

Retry a flaky command:

```ts
task({
  retry: { attempts: 3, delayMs: 1000 },
  run: sh`pnpm test`
})
```

Set a timeout:

```ts
task({
  timeout: "5m",
  run: sh`pnpm build`
})
```

Supported timeout units:

```txt
ms
s
m
h
```

## Requirements

Declare required tools:

```ts
task({
  requires: {
    tools: ["node", "pnpm", "ollama"]
  },
  run: sh`ollama list`
})
```

The host runner checks tools with `command -v`. Ollama is an optional requirement declaration, not a package dependency.

## Config Files

The CLI searches the project root in this order:

```txt
pipeline.ts
pipeline.mjs
pipeline.js
```

Use `pipeline.ts` on Node 24. Use `pipeline.mjs` or `pipeline.js` for Node 20.
