import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { definePipeline, env, job, sh, task, trigger } from "../packages/pipeline-core/dist/index.js";
import { jobsForGitHubEvent, renderGitHubWorkflow } from "../packages/pipeline-node/dist/index.js";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const packageUrl = pathToFileURL(join(repoRoot, "packages/pipeline/dist/index.js")).href;
const cliPath = join(repoRoot, "packages/pipeline-node/dist/cli.js");

test("renders github workflow triggers and bootloader steps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-render-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.20.0" }), "utf8");
    const pipeline = definePipeline({
      name: "test",
      triggers: {
        pr: trigger.github({ events: ["pull_request"] }),
        main: trigger.github({ events: ["push"], branches: ["main"] }),
        nightly: trigger.cron("17 2 * * *")
      },
      tasks: {
        verify: task({ run: sh`echo verify` })
      },
      jobs: {
        verify: job({ target: "verify", trigger: ["pr", "main", "nightly"] })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /pull_request:/);
    assert.match(rendered.workflow, /push:/);
    assert.match(rendered.workflow, /schedule:/);
    assert.match(rendered.workflow, /async-pipeline github check/);
    assert.match(rendered.workflow, /async-pipeline run verify/);
    assert.equal(rendered.lock.workflow, ".github/workflows/async-pipeline.yml");
    assert.equal(rendered.lock.jobs[0].id, "verify");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("renders github job environment and secret env wiring", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-github-env-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ packageManager: "pnpm@10.20.0" }), "utf8");
    const pipeline = definePipeline({
      name: "test",
      env: {
        NODE_VERSION: env.var("NODE_VERSION", { default: "24" })
      },
      triggers: {
        publish: trigger.manual()
      },
      tasks: {
        publish: task({
          requires: { secrets: ["NPM_TOKEN"] },
          run: sh`npm publish`
        })
      },
      jobs: {
        publish: job({
          target: "publish",
          trigger: ["publish"],
          env: {
            NODE_AUTH_TOKEN: env.secret("NPM_TOKEN"),
            PUBLISH_REGISTRY: "https://registry.npmjs.org/"
          },
          environment: {
            name: "npm-publish",
            url: "https://www.npmjs.com/package/@async/pipeline"
          },
          requires: {
            provenance: true
          }
        })
      }
    });

    const rendered = await renderGitHubWorkflow(pipeline, { cwd: dir, configPath: join(dir, "pipeline.ts") });

    assert.match(rendered.workflow, /publish:/);
    assert.match(rendered.workflow, /if: github\.event_name == 'workflow_dispatch'/);
    assert.match(rendered.workflow, /environment:\n      name: "npm-publish"\n      url: "https:\/\/www\.npmjs\.com\/package\/@async\/pipeline"/);
    assert.match(rendered.workflow, /permissions:\n      contents: read\n      id-token: write/);
    assert.match(rendered.workflow, /NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/);
    assert.match(rendered.workflow, /NODE_VERSION: \$\{\{ vars\.NODE_VERSION \}\}/);
    assert.match(rendered.workflow, /PUBLISH_REGISTRY: "https:\/\/registry\.npmjs\.org\/"/);
    assert.match(rendered.workflow, /async-pipeline run publish/);
    assert.deepEqual(rendered.lock.jobs[0].environment, {
      name: "npm-publish",
      url: "https://www.npmjs.com/package/@async/pipeline"
    });
    assert.deepEqual(rendered.lock.jobs[0].requires, { provenance: true });
    assert.equal(rendered.lock.jobs[0].env.NODE_AUTH_TOKEN.kind, "async-pipeline.env.secret");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("matches github jobs from event context", () => {
  const pipeline = definePipeline({
    name: "test",
    triggers: {
      main: trigger.github({ events: ["push"], branches: ["main"] }),
      release: trigger.github({ events: ["push"], branches: ["release/*"] }),
      docs: trigger.github({ events: ["push"], branches: ["docs"] }),
      published: trigger.github({ events: ["release"] }),
      nightly: trigger.cron("17 2 * * *"),
      manual: trigger.manual()
    },
    tasks: {
      verify: task({ run: sh`echo verify` }),
      docs: task({ run: sh`echo docs` }),
      release: task({ run: sh`echo release` }),
      published: task({ run: sh`echo published` }),
      nightly: task({ run: sh`echo nightly` }),
      deploy: task({ run: sh`echo deploy` })
    },
    jobs: {
      verify: job({ target: "verify", trigger: ["main"] }),
      release: job({ target: "release", trigger: ["release"] }),
      docs: job({ target: "docs", trigger: ["docs"] }),
      published: job({ target: "published", trigger: ["published"] }),
      nightly: job({ target: "nightly", trigger: ["nightly"] }),
      deploy: job({ target: "deploy", trigger: ["manual"] })
    }
  });

  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "push", ref: "refs/heads/main" }).map((entry) => entry.id), ["verify"]);
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "push", ref: "refs/heads/release/1.0" }).map((entry) => entry.id), ["release"]);
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "release" }).map((entry) => entry.id), ["published"]);
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "schedule", schedule: "17 2 * * *" }).map((entry) => entry.id), ["nightly"]);
  // workflow_dispatch runs only jobs with a manual trigger; everything else
  // needs explicit selection (github run --job <id>).
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "workflow_dispatch" }).map((entry) => entry.id), ["deploy"]);
});

test("github generate writes a current workflow and lock", () => {
  const dir = mkdtempSyncCompat("async-pipeline-github-cli-");
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      type: "module",
      packageManager: "pnpm@10.20.0",
      scripts: {
        "async-pipeline": `node ${JSON.stringify(cliPath)}`
      }
    }), "utf8");
    writeFileSync(join(dir, "pipeline.js"), `
import { definePipeline, job, sh, task, trigger } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "fixture",
  triggers: {
    main: trigger.github({ events: ["push"], branches: ["main"] })
  },
  tasks: {
    verify: task({ run: sh\`node -e 'console.log("ok")'\` })
  },
  jobs: {
    verify: job({ target: "verify", trigger: ["main"] })
  }
});
`, "utf8");

    const generate = spawnSync("node", [cliPath, "github", "generate"], { cwd: dir, encoding: "utf8" });
    assert.equal(generate.status, 0, generate.stderr);
    assert.equal(existsSync(join(dir, ".github/workflows/async-pipeline.yml")), true);
    assert.equal(existsSync(join(dir, ".github/async-pipeline.lock.json")), true);

    const check = spawnSync("node", [cliPath, "github", "check"], { cwd: dir, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);

    const lock = JSON.parse(readFileSync(join(dir, ".github/async-pipeline.lock.json"), "utf8"));
    assert.equal(lock.triggers.push.branches[0], "main");
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

test("github generate and check support custom output paths", () => {
  const dir = mkdtempSyncCompat("async-pipeline-github-custom-");
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      type: "module",
      packageManager: "pnpm@10.20.0",
      scripts: {
        "async-pipeline": `node ${JSON.stringify(cliPath)}`
      }
    }), "utf8");
    writeFileSync(join(dir, "pipeline.js"), `
import { definePipeline, job, sh, task, trigger } from ${JSON.stringify(packageUrl)};

export default definePipeline({
  name: "fixture",
  triggers: {
    pr: trigger.github({ events: ["pull_request"] })
  },
  tasks: {
    verify: task({ run: sh\`node -e 'console.log("ok")'\` })
  },
  jobs: {
    verify: job({ target: "verify", trigger: ["pr"] })
  }
});
`, "utf8");

    const workflow = ".tmp/generated-workflow.yml";
    const lock = ".tmp/generated-lock.json";
    const generate = spawnSync("node", [cliPath, "github", "generate", "--workflow", workflow, "--lock", lock], { cwd: dir, encoding: "utf8" });
    assert.equal(generate.status, 0, generate.stderr);
    assert.equal(existsSync(join(dir, workflow)), true);
    assert.equal(existsSync(join(dir, lock)), true);
    assert.equal(existsSync(join(dir, ".github/workflows/async-pipeline.yml")), false);

    const check = spawnSync("node", [cliPath, "github", "check", "--workflow", workflow, "--lock", lock], { cwd: dir, encoding: "utf8" });
    assert.equal(check.status, 0, check.stderr);

    const lockJson = JSON.parse(readFileSync(join(dir, lock), "utf8"));
    assert.equal(lockJson.workflow, workflow);
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
});

function mkdtempSyncCompat(prefix) {
  const dir = join(tmpdir(), `${prefix}${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}
