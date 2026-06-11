# @async/pipeline

Write the workflow in TypeScript, run it locally, and generate the thin GitHub Actions bootloader from the same `pipeline.ts`.

`@async/pipeline` is a small TypeScript pipeline engine for projects that want their everyday verification flow to be local-first instead of CI-only. Put the task graph in `pipeline.ts`, run it on your laptop with `async-pipeline`, and let GitHub Actions call the same graph with a thin workflow.

## Install

Requires Node `>= 24` (pipeline.ts loads through native TypeScript type stripping) on macOS or Linux.

```sh
pnpm add -D @async/pipeline
```

## Minimal Pipeline

```ts
import { definePipeline, job, sh, task, trigger } from "@async/pipeline";

export default definePipeline({
  name: "app",
  cache: "file:local",
  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] })
  },
  tasks: {
    typecheck: task({
      inputs: ["src/**/*.ts", "package.json", "pnpm-lock.yaml"],
      cache: "file:local",
      run: sh`pnpm typecheck`
    }),
    test: task({
      dependsOn: ["typecheck"],
      inputs: ["src/**/*.ts", "tests/**/*.ts", "package.json"],
      cache: "file:local",
      run: sh`pnpm test`
    })
  },
  jobs: {
    verify: job({ target: "test", trigger: ["pr", "main"] })
  }
});
```

Run it:

```sh
pnpm async-pipeline run verify
```

Inspect the run:

```sh
ls .async/runs
cat .async/runs/<run-id>/summary.md
cat .async/runs/<run-id>/execution.json
```

Generate the GitHub Actions bootloader:

```sh
pnpm async-pipeline github generate
```

## Package Shape

Only `@async/pipeline` is published. The monorepo's core, node, runtime, and Lima implementation pieces are private/bundled behind this package's `dist/internal` output during build.

Full docs live in the repository README and `docs/` directory.
