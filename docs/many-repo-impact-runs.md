# Many-Repo Impact Runs

Use many-repo impact runs when one repo owns a change and wants to run explicitly declared dependent repos against that candidate.

The dependency map is developer-owned. `@async/pipeline` does not scan package manifests, lockfiles, npm metadata, or GitHub to infer dependents.

## Define Sources

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
    }),
    admin: source.path({
      path: "../admin",
      pipeline: "pipeline.ts",
      writable: true,
      prepare: [sh`pnpm install --frozen-lockfile`]
    })
  },
  tasks: {
    impact: task({
      dependsOn: ["storefront:test", "admin:test-design-system"]
    })
  },
  jobs: {
    verifyImpact: job({ target: "impact" })
  }
});
```

Each source repo must have its own `pipeline.ts`. Root tasks reference source tasks with `<source>:<task>`.

## Prepare Sources

`prepare` runs inside the source checkout before source tasks run. The root pipeline owns candidate wiring, so it can install dependencies, link a local package, or write config required by the dependent repo.

Static shell steps stay simple:

```ts
sh`pnpm install --frozen-lockfile`
```

Use deferred shell only when runtime context is needed:

```ts
sh((ctx) => sh`pnpm add @acme/design-system@file:${ctx.candidate.dir}`)
```

Deferred shell callbacks are not evaluated during metadata reads.

## Run Locally

```sh
async-pipeline sources list
async-pipeline sources sync
async-pipeline run verifyImpact
```

Run one dependent task:

```sh
async-pipeline run-task storefront:test
```

Warm git checkouts are stored in:

```txt
.async/sources
```

Repeated runs can reuse source checkouts, dependency/build caches inside those checkouts, and `.async/cache/tasks`.

## Read Metadata

```sh
async-pipeline metadata --format json
async-pipeline metadata --format json --include-sources
```

Metadata reads do not clone, prepare, run, or evaluate deferred shell callbacks. `--include-sources` only loads source pipeline metadata from already-available source paths or synced checkouts.

## GitHub Actions

Generate a matrix from the declared source task refs:

```sh
async-pipeline matrix verifyImpact --format github
```

The command prints:

```json
{"include":[{"task":"storefront:test","source":"storefront","taskId":"test","type":"git","url":"https://github.com/acme/storefront.git","ref":"main"}]}
```

A workflow can use that matrix and run:

```sh
async-pipeline run-task "$TASK"
```

This runs dependent repo tests in the current repo's CI. v1 does not dispatch workflows in consumer repos and does not generate workflow files.
