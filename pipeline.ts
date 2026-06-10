import { definePipeline, env, job, sh, task, trigger } from "./packages/pipeline/dist/index.js";

export default definePipeline({
  name: "async-pipeline",
  cache: "file:cache-first",
  triggers: {
    pr: trigger.github({ events: ["pull_request"] }),
    main: trigger.github({ events: ["push"], branches: ["main"] }),
    release: trigger.github({ events: ["release"] }),
    manual: trigger.manual()
  },
  sync: {
    github: true,
    tasks: {
      prefix: "pipeline",
      runners: ["package"],
      targets: [{ package: "async-pipeline-workspace" }],
      jobs: ["verify"],
      scripts: {
        "github:check": "github check",
        "github:generate": "github generate",
        "sync:check": "sync check"
      }
    }
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
    }),
    publish: task({
      dependsOn: ["pack"],
      inputs: ["production", "package.json", "packages/*/package.json"],
      cache: false,
      run: sh`cd packages/pipeline && npm publish --access public --registry https://registry.npmjs.org/ --provenance`
    })
  },
  jobs: {
    verify: job({
      target: "pack",
      trigger: ["pr", "main", "release"],
      mode: process.env.CI ? "ci" : "manual"
    }),
    publish: job({
      target: "publish",
      trigger: ["manual"],
      mode: "ci",
      env: {
        NODE_AUTH_TOKEN: env.secret("NPM_TOKEN")
      },
      github: {
        environment: "npm-publish",
        permissions: {
          contents: "read",
          idToken: "write"
        }
      }
    })
  }
});
