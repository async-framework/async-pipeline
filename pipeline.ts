import { definePipeline, job, sh, task, trigger } from "./packages/pipeline/dist/index.js";

export default definePipeline({
  name: "async-pipeline",
  cache: "file:cache-first",
  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    release: trigger.github({ events: ["release"] })
  },
  namedInputs: {
    default: [
      "packages/**/*.ts",
      "tests/**/*.test.js",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "tsconfig.base.json"
    ],
    production: [
      "packages/**/*.ts",
      "!tests/**/*.test.js"
    ]
  },
  tasks: {
    typecheck: task({
      inputs: ["default"],
      cache: true,
      run: sh`pnpm typecheck`
    }),
    test: task({
      dependsOn: ["typecheck"],
      inputs: ["default"],
      cache: true,
      run: sh`pnpm test`
    }),
    build: task({
      dependsOn: ["test"],
      inputs: ["production"],
      outputs: ["packages/*/dist/**"],
      cache: true,
      run: sh`pnpm build`
    }),
    pack: task({
      dependsOn: ["build"],
      inputs: ["production", "package.json", "packages/*/package.json"],
      cache: false,
      run: sh`pnpm pack:check`
    })
  },
  jobs: {
    verify: job({
      target: "pack",
      trigger: ["pr", "main", "release"],
      mode: process.env.CI ? "ci" : "manual"
    })
  }
});
