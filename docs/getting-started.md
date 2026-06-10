# Getting Started

Use this guide to try the repo, add a pipeline to another project, inspect local runs, and wire the same workflow into CI.

## Requirements

- pnpm
- Node 24 for `pipeline.ts`
- Node 20+ for `pipeline.mjs` or `pipeline.js`
- Optional: Lima as `limactl` for programmatic isolated-runner experiments

## 1. Try This Repo

From the checkout:

```sh
cd /Users/patrickjs/code/async-framework/async-pipeline
pnpm install --frozen-lockfile
pnpm build
pnpm async-pipeline run verify
```

The repo dogfoods its own pipeline in [../pipeline.ts](../pipeline.ts). The `verify` job expands to:

```txt
typecheck -> test -> build -> pack
```

Run quick inspection commands:

```sh
pnpm async-pipeline list
pnpm async-pipeline graph --format json
pnpm async-pipeline explain build
pnpm async-pipeline doctor
```

## 2. Add A Pipeline To A Project

After the package is published:

```sh
pnpm add -D @async/pipeline
```

Create `pipeline.ts` at the project root:

```ts
import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "web-app",
  namedInputs: {
    source: [
      "src/**/*.ts",
      "src/**/*.tsx",
      "package.json",
      "pnpm-lock.yaml",
      "tsconfig.json"
    ]
  },
  triggers: {
    push: trigger.github({ events: ["push", "pull_request"] })
  },
  tasks: {
    typecheck: task({
      inputs: ["source"],
      cache: true,
      timeout: "2m",
      run: sh`pnpm typecheck`
    }),
    test: task({
      dependsOn: ["typecheck"],
      inputs: ["source"],
      cache: true,
      retry: { attempts: 2, delayMs: 500 },
      run: sh`pnpm test`
    }),
    build: task({
      dependsOn: ["test"],
      inputs: ["source"],
      outputs: ["dist/**"],
      cache: true,
      run: sh`pnpm build`
    })
  },
  jobs: {
    verify: job({
      target: "build",
      trigger: ["push"]
    })
  }
});
```

Add scripts:

```json
{
  "scripts": {
    "async-pipeline": "async-pipeline",
    "verify": "async-pipeline run verify"
  }
}
```

Run it:

```sh
pnpm async-pipeline run verify
```

Use the explicit `async-pipeline` command in docs and CI. Short aliases and smart runner dispatch belong in `@async/run`, not this package.

## 3. Inspect The Run

Runs write machine-readable records and human-readable summaries under `.async/`:

```sh
ls .async/runs
cat .async/runs/<run-id>/summary.md
cat .async/runs/<run-id>/execution.json
ls .async/runs/<run-id>/logs
```

The execution record includes task status, attempts, timings, cache keys, cache hit flags, errors, source metadata, and task metadata.

Use metadata commands when you want to inspect a pipeline without running it:

```sh
pnpm async-pipeline metadata --format json
pnpm async-pipeline graph --format dot
```

Metadata reads are safe for planning and automation: they do not clone sources, run `prepare`, execute tasks, or evaluate deferred shell callbacks.

## 4. Wire CI

Keep CI thin. It should install dependencies, build the CLI if needed, and invoke the same job:

```yaml
- run: pnpm install --frozen-lockfile
- run: pnpm build
- run: pnpm async-pipeline run verify
  env:
    CI: true
```

Use pinned GitHub Actions, `permissions: contents: read`, and add write permissions only for publishing, deployment, comments, or privileged artifact uploads.

## What To Commit

Commit:

- `pipeline.ts`, `pipeline.mjs`, or `pipeline.js`
- `.github/workflows/ci.yml`
- package metadata and lockfile changes
- docs that explain the project pipeline

Do not commit:

- `.async/`
- package tarballs from `npm pack`
- `dist/` unless your project already commits build output

## Troubleshooting

If the CLI cannot find a config file, make sure one of these exists at the project root:

```txt
pipeline.ts
pipeline.mjs
pipeline.js
```

If `pipeline.ts` fails to load on Node 20, use Node 24 or convert the config to `pipeline.mjs`.

If a task keeps returning a cache hit, check its `inputs`. A task only becomes dirty when its task config or declared input files change.
