import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { definePipeline, job, sh, task } from "../packages/pipeline-core/dist/index.js";
import { runSingleTask } from "../packages/pipeline-node/dist/runner.js";

test("task timeout fails the execution and records the error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-timeout-"));
  try {
    const pipeline = definePipeline({
      name: "timeout-test",
      tasks: {
        slow: task({
          cache: false,
          timeout: 50,
          run: sh`node -e "setTimeout(() => {}, 250)"`
        })
      },
      jobs: {
        verify: job({ target: "slow" })
      }
    });

    const record = await runSingleTask(pipeline, "slow", { cwd: dir });

    assert.equal(record.status, "failed");
    assert.equal(record.tasks[0]?.status, "failed");
    assert.match(record.tasks[0]?.error ?? "", /timed out/);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
