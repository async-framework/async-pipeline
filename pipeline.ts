import { definePipeline, env, job, sh, task, trigger } from "./packages/pipeline/dist/index.js";

export default definePipeline({
  name: "async-pipeline",
  cache: "file:local",
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
    drift: task({
      description: "Release metadata drift checks: CHANGELOG entry, engines floor, workflow Node versions.",
      inputs: [
        "CHANGELOG.md",
        "package.json",
        "packages/*/package.json",
        ".github/workflows/async-pipeline.yml",
        "examples/*/.github/workflows/*.yml",
        "scripts/check-release-drift.mjs"
      ],
      cache: true,
      run: sh`pnpm drift:check`
    }),
    docs: task({
      description: "Docs-drift checks: every relative link and anchor in README.md and docs/ resolves, for GitHub rendering and the Pages build alike.",
      inputs: [
        "docs/**/*.md",
        "README.md",
        "scripts/check-docs.mjs"
      ],
      cache: true,
      run: sh`pnpm docs:check`
    }),
    "sync-check": task({
      description: "All synced surfaces (generated workflow, lock, package scripts) still match pipeline.ts.",
      inputs: [
        "pipeline.ts",
        "package.json",
        ".github/workflows/async-pipeline.yml",
        ".github/async-pipeline.lock.json",
        ".async-pipeline/tasks.lock.json"
      ],
      cache: false,
      run: sh`pnpm async-pipeline sync check`
    }),
    claims: task({
      description: "Claim coverage checks: every registered doc claim still exists verbatim and is enforced by a named test; every PROMISE test is registered.",
      inputs: [
        "tests/claims.json",
        "scripts/check-claims.mjs",
        "README.md",
        "AGENTS.md",
        "CHANGELOG.md",
        "docs/api.md",
        "tests/**/*.test.js"
      ],
      cache: true,
      run: sh`pnpm claims:check`
    }),
    build: task({
      inputs: ["production"],
      outputs: ["packages/*/dist/**"],
      cache: true,
      run: sh`pnpm build`
    }),
    typecheck: task({
      dependsOn: ["build"],
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
    pack: task({
      dependsOn: ["test", "drift", "claims", "docs", "sync-check"],
      inputs: ["production", "package.json", "packages/*/package.json", "scripts/check-exports.mjs"],
      cache: false,
      run: [sh`pnpm exports:check`, sh`pnpm pack:check`]
    }),
    // GitHub Packages publishing, adapted from PatrickJS's GitHub-native npm
    // preview packages gist (see examples/github-native-npm-preview-package).
    // The mirror is @async-framework/pipeline: GitHub Packages requires the
    // scope to match the repo owner.
    preview: task({
      description: "Same-repo PRs publish an immutable 0.0.0-pr.<n>.sha.<sha> preview to GitHub Packages, move the pr-<n> dist-tag, and upsert one install-instructions comment. Fork PRs skip.",
      dependsOn: ["pack"],
      inputs: ["production", "package.json", "packages/*/package.json", "scripts/publish-github.mjs"],
      cache: false,
      run: sh`node scripts/publish-github.mjs pr`
    }),
    snapshot: task({
      description: "Pushes to main publish an immutable 0.0.0-main.sha.<sha> snapshot to GitHub Packages and move the main dist-tag while the commit is still the branch head.",
      dependsOn: ["pack"],
      inputs: ["production", "package.json", "packages/*/package.json", "scripts/publish-github.mjs"],
      cache: false,
      run: sh`node scripts/publish-github.mjs main`
    }),
    "publish-github": task({
      description: "Stable mirror to GitHub Packages (latest tag). Runs before the npm publish so a stable version always exists on GitHub Packages even when npm has an issue.",
      dependsOn: ["pack"],
      inputs: ["production", "package.json", "packages/*/package.json", "scripts/publish-github.mjs"],
      cache: false,
      run: sh`node scripts/publish-github.mjs release`
    }),
    publish: task({
      // GitHub Packages first, then npm: the fallback registry is never
      // behind the primary one.
      dependsOn: ["publish-github"],
      inputs: ["production", "package.json", "packages/*/package.json", "scripts/publish.mjs"],
      cache: false,
      run: sh`node scripts/publish.mjs`
    })
  },
  jobs: {
    verify: job({
      target: "pack",
      trigger: ["pr", "main", "release"],
      github: {
        // Both GitHub-hosted. Self-hosted label sets (e.g. Tart VMs on Apple
        // Silicon) are supported too; see docs/github-actions.md.
        runsOnMatrix: ["ubuntu-latest", "macos-latest"]
      }
    }),
    preview: job({
      target: "preview",
      trigger: ["pr"],
      env: {
        GITHUB_TOKEN: env.secret("GITHUB_TOKEN")
      },
      github: {
        permissions: {
          // Commenting on a PR through the issues API routes through the
          // pull-requests permission for GITHUB_TOKEN, so both are write.
          issues: "write",
          packages: "write",
          pullRequests: "write"
        }
      }
    }),
    snapshot: job({
      target: "snapshot",
      trigger: ["main"],
      env: {
        GITHUB_TOKEN: env.secret("GITHUB_TOKEN")
      },
      github: {
        permissions: {
          packages: "write"
        }
      }
    }),
    publish: job({
      target: "publish",
      trigger: ["manual"],
      environment: {
        name: "npm-publish",
        url: "https://www.npmjs.com/package/@async/pipeline"
      },
      requires: {
        provenance: true
      },
      env: {
        NODE_AUTH_TOKEN: env.secret("NPM_TOKEN"),
        GITHUB_TOKEN: env.secret("GITHUB_TOKEN")
      },
      github: {
        permissions: {
          packages: "write"
        }
      }
    })
  }
});
