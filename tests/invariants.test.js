// Product-promise invariants. Each test encodes a claim from README.md or docs/.
// If one of these fails, the product is lying about its core behavior — fix the
// implementation, never the assertion.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { definePipeline, job, sh, task } from "../packages/pipeline-core/dist/index.js";
import { hostWorkspace, runJob } from "../packages/pipeline-node/dist/runner.js";

const cliPath = fileURLToPath(new URL("../packages/pipeline-node/dist/cli.js", import.meta.url));
const coreUrl = new URL("../packages/pipeline-core/dist/index.js", import.meta.url).href;

function statusOf(record, taskId) {
  return record.tasks.find((entry) => entry.id === taskId)?.status;
}

test("PROMISE: per-task inputs isolate cache invalidation", async () => {
  // README: "Make cache behavior explicit through declared task inputs."
  // Editing a file that only belongs to task b's inputs must not invalidate task a.
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-invariant-isolation-"));
  try {
    await writeFile(join(dir, "a.txt"), "a1\n", "utf8");
    await writeFile(join(dir, "b.txt"), "b1\n", "utf8");
    const pipeline = () => definePipeline({
      name: "isolation",
      cache: "file:local",
      tasks: {
        a: task({ inputs: ["a.txt"], cache: true, run: sh`node -e "process.exit(0)"` }),
        b: task({ inputs: ["b.txt"], cache: true, run: sh`node -e "process.exit(0)"` })
      },
      jobs: { all: job({ target: ["a", "b"] }) }
    });
    const workspace = hostWorkspace({ cwd: dir, env: { PATH: process.env.PATH } });

    await runJob(pipeline(), { id: "all", workspace });
    await writeFile(join(dir, "b.txt"), "b2\n", "utf8");
    const record = await runJob(pipeline(), { id: "all", workspace });

    assert.equal(statusOf(record, "a"), "cached", "task a must stay cached when only b's inputs change");
    assert.equal(statusOf(record, "b"), "passed", "task b must re-run when its inputs change");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: a second run of an unchanged pipeline is fully cached", async () => {
  // README: local-first verification — a warm verify must be a no-op.
  // This is the invariant that catches outputs leaking into inputs, global
  // fingerprints, unstable cache keys, and similar self-invalidation bugs.
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-invariant-warm-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "main.txt"), "stable\n", "utf8");
    const pipeline = () => definePipeline({
      name: "warm",
      cache: "file:local",
      tasks: {
        build: task({
          inputs: ["src/**/*.txt"],
          outputs: ["out/**"],
          cache: true,
          run: sh`node -e "const fs=require('node:fs');fs.mkdirSync('out',{recursive:true});fs.writeFileSync('out/build.txt','built\\n')"`
        }),
        check: task({
          dependsOn: ["build"],
          inputs: ["src/**/*.txt"],
          cache: true,
          run: sh`node -e "process.exit(0)"`
        })
      },
      jobs: { verify: job({ target: "check" }) }
    });
    const workspace = hostWorkspace({ cwd: dir, env: { PATH: process.env.PATH } });

    const cold = await runJob(pipeline(), { id: "verify", workspace });
    assert.equal(cold.status, "passed");
    const warm = await runJob(pipeline(), { id: "verify", workspace });
    assert.equal(warm.status, "passed");
    for (const entry of warm.tasks) {
      assert.equal(entry.status, "cached", `task ${entry.id} must be cached on an unchanged second run`);
    }
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: declared outputs do not feed back into a task's own cache inputs", async () => {
  // docs/api.md: a task's declared outputs are ignored by its input resolution.
  // Outputs written inside an input glob must not invalidate the task that wrote them.
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-invariant-feedback-"));
  try {
    await mkdir(join(dir, "site"), { recursive: true });
    await writeFile(join(dir, "site", "page.txt"), "page\n", "utf8");
    const pipeline = () => definePipeline({
      name: "feedback",
      cache: "file:local",
      tasks: {
        render: task({
          inputs: ["site/**/*.txt"],
          outputs: ["site/gen/**"],
          cache: true,
          run: sh`node -e "const fs=require('node:fs');fs.mkdirSync('site/gen',{recursive:true});fs.writeFileSync('site/gen/rendered.txt','rendered\\n')"`
        })
      },
      jobs: { render: job({ target: "render" }) }
    });
    const workspace = hostWorkspace({ cwd: dir, env: { PATH: process.env.PATH } });

    const first = await runJob(pipeline(), { id: "render", workspace });
    assert.equal(first.status, "passed");
    const second = await runJob(pipeline(), { id: "render", workspace });
    assert.equal(statusOf(second, "render"), "cached", "render must not invalidate itself by writing its declared outputs");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: the CLI streams the plan before task output and prefixes task lines", async () => {
  // CHANGELOG 0.2.0: CLI progress streams during the run, and parallel task
  // output stays attributable. Plan line first, prefixed task output, summary last.
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-invariant-cli-"));
  try {
    await writeFile(join(dir, "pipeline.mjs"), [
      `import { definePipeline, job, sh, task } from ${JSON.stringify(coreUrl)};`,
      "export default definePipeline({",
      '  name: "ordering",',
      "  tasks: { hello: task({ cache: false, run: sh`node -e \"console.log('hello-from-task')\"` }) },",
      '  jobs: { all: job({ target: "hello" }) }',
      "});",
      ""
    ].join("\n"), "utf8");

    const result = spawnSync("node", [cliPath, "run", "all"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    const planIndex = result.stdout.indexOf("Running ordering:all");
    const taskIndex = result.stdout.indexOf("[hello] hello-from-task");
    const doneIndex = result.stdout.indexOf("Pipeline passed");
    assert.ok(planIndex >= 0, `missing plan line in: ${result.stdout}`);
    assert.ok(taskIndex >= 0, `missing prefixed task output in: ${result.stdout}`);
    assert.ok(doneIndex >= 0, `missing completion line in: ${result.stdout}`);
    assert.ok(planIndex < taskIndex, "plan line must stream before task output");
    assert.ok(taskIndex < doneIndex, "task output must stream before the completion line");
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
