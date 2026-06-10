# @async/pipeline

Define one local workflow, run it anywhere, and inspect what happened.

`@async/pipeline` is a small TypeScript pipeline engine for projects that want their everyday verification flow to be local-first instead of CI-only. Put the task graph in `pipeline.ts`, run it on your laptop with `async-pipeline`, and let GitHub Actions call the same graph with a thin workflow.

## Why Use It

- Replace duplicated local scripts and CI-only YAML logic with one typed `pipeline.ts`.
- Run the same task graph on a laptop and in GitHub Actions.
- Keep run records, logs, summaries, source checkouts, and task cache under `.async/`.
- Make cache behavior explicit through declared task inputs and task config.
- Give people and agents inspectable commands: `list`, `graph`, `explain`, `metadata`, `matrix`, and `doctor`.
- Run many-repo impact checks with explicit dependent repos and namespaced task refs such as `storefront:test`.
- Read pipeline metadata without cloning sources, running `prepare`, executing tasks, or evaluating deferred shell callbacks.
- Keep GitHub Actions pinned, low-permission, and focused on invoking the local pipeline.

## Quick Start

Try the repo's own pipeline:

```sh
cd /Users/patrickjs/code/async-framework/async-pipeline
pnpm install --frozen-lockfile
pnpm build
pnpm async-pipeline run verify
```

Inspect the run:

```sh
ls .async/runs
cat .async/runs/<run-id>/summary.md
cat .async/runs/<run-id>/execution.json
```

The self pipeline lives in [pipeline.ts](pipeline.ts). It runs `typecheck`, `test`, `build`, and `pack` through the `verify` job.

## Add A Pipeline

After the package is published, install the public package:

```sh
pnpm add -D @async/pipeline
```

Create `pipeline.ts`:

```ts
import { definePipeline, job, sh, task } from "@async/pipeline";

export default definePipeline({
  name: "app",
  namedInputs: {
    source: ["src/**/*.ts", "package.json", "pnpm-lock.yaml", "tsconfig.json"]
  },
  tasks: {
    typecheck: task({
      inputs: ["source"],
      cache: true,
      run: sh`pnpm typecheck`
    }),
    test: task({
      dependsOn: ["typecheck"],
      inputs: ["source"],
      cache: true,
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
    verify: job({ target: "build" })
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

Run the same graph locally:

```sh
pnpm async-pipeline run verify
```

## Useful Commands

```sh
async-pipeline list
async-pipeline run <job>
async-pipeline run-task <task>
async-pipeline graph --format json
async-pipeline graph --format dot
async-pipeline explain <task>
async-pipeline metadata --format json
async-pipeline sources list
async-pipeline sources sync
async-pipeline matrix <job> --format github
async-pipeline doctor
```

Use `async-pipeline` as the explicit command in docs and CI. Short aliases and smart runner dispatch belong in `@async/run`, not this package.

## GitHub Actions

GitHub Actions should install dependencies, build the CLI when working from source, and run the same pipeline command used locally.

```yaml
permissions:
  contents: read

jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<pinned-sha>
      - uses: actions/setup-node@<pinned-sha>
        with:
          node-version: 24
      - run: |
          corepack enable
          corepack prepare pnpm@10.20.0 --activate
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - run: pnpm async-pipeline run verify
        env:
          CI: true
```

The checked-in workflow is [.github/workflows/ci.yml](.github/workflows/ci.yml).

## Many-Repo Impact Runs

Declare known dependent repos yourself:

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

`@async/pipeline` does not infer reverse dependencies from package manifests, lockfiles, npm metadata, or GitHub search. The dependency map stays explicit and reviewable.

## Use It When

- You want local verification to be the source of truth.
- CI should invoke, not redefine, your project workflow.
- You need typed task dependencies, cache inputs, retries, timeouts, requirements, and run records.
- You want metadata and graph inspection for humans, tools, and AI agents.
- You own the list of repos that should be checked against a candidate change.

## Not Yet For

- Parallel task scheduling. Execution is deterministic and sequential today.
- Shared or remote task cache. Cache is local-first only.
- Automatic dependency discovery. Sources are explicit by design.
- Automatic CLI routing to Lima. The Lima adapter is available programmatically, and `doctor` checks for `limactl`.
- Deno or Ollama runtime integration. They can be declared as optional tool requirements, but they are not package dependencies.

## Package Split

| Package | Purpose |
| --- | --- |
| `@async/pipeline` | Public convenience package and `async-pipeline` CLI bin. |
| `@async/pipeline-core` | Pipeline, task, job, graph, source, and type contracts. |
| `@async/pipeline-node` | CLI, filesystem store, scheduler, host runner, source sync, and doctor checks. |
| `@async/pipeline-adapter-lima` | Programmatic Lima runner adapter using `limactl`. |

## Docs

- [Getting started](docs/getting-started.md)
- [How it works](docs/how-it-works.md)
- [Running locally](docs/local-runs.md)
- [GitHub Actions setup](docs/github-actions.md)
- [API reference](docs/api.md)
- [Many-repo impact runs](docs/many-repo-impact-runs.md)
