import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { definePipeline, job, sh, task, trigger } from "../packages/pipeline-core/dist/index.js";
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
    assert.match(rendered.workflow, /async-pipeline github run/);
    assert.equal(rendered.lock.workflow, ".github/workflows/async-pipeline.yml");
    assert.equal(rendered.lock.jobs[0].id, "verify");
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
      nightly: trigger.cron("17 2 * * *")
    },
    tasks: {
      verify: task({ run: sh`echo verify` }),
      docs: task({ run: sh`echo docs` }),
      release: task({ run: sh`echo release` }),
      published: task({ run: sh`echo published` }),
      nightly: task({ run: sh`echo nightly` })
    },
    jobs: {
      verify: job({ target: "verify", trigger: ["main"] }),
      release: job({ target: "release", trigger: ["release"] }),
      docs: job({ target: "docs", trigger: ["docs"] }),
      published: job({ target: "published", trigger: ["published"] }),
      nightly: job({ target: "nightly", trigger: ["nightly"] })
    }
  });

  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "push", ref: "refs/heads/main" }).map((entry) => entry.id), ["verify"]);
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "push", ref: "refs/heads/release/1.0" }).map((entry) => entry.id), ["release"]);
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "release" }).map((entry) => entry.id), ["published"]);
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "schedule", schedule: "17 2 * * *" }).map((entry) => entry.id), ["nightly"]);
  assert.deepEqual(jobsForGitHubEvent(pipeline, { eventName: "workflow_dispatch" }).map((entry) => entry.id), ["docs", "nightly", "published", "release", "verify"]);
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
