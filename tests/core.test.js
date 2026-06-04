import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph, definePipeline, job, sh, task, tasksForJob } from "../packages/pipeline-core/dist/index.js";

test("orders tasks deterministically with dependencies before dependents", () => {
  const pipeline = definePipeline({
    name: "test",
    tasks: {
      build: task({ dependsOn: ["typecheck", "test"], run: sh`echo build` }),
      typecheck: task({ run: sh`echo typecheck` }),
      test: task({ dependsOn: ["typecheck"], run: sh`echo test` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  });

  assert.deepEqual(tasksForJob(pipeline, "verify").executionOrder, ["typecheck", "test", "build"]);
});

test("rejects missing dependencies", () => {
  assert.throws(() => definePipeline({
    name: "test",
    tasks: {
      build: task({ dependsOn: ["missing"], run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  }), /missing task/);
});

test("rejects cycles", () => {
  assert.throws(() => buildGraph(definePipeline({
    name: "test",
    tasks: {
      a: task({ dependsOn: ["b"], run: sh`echo a` }),
      b: task({ dependsOn: ["a"], run: sh`echo b` })
    },
    jobs: {
      verify: job({ target: "a" })
    }
  })), /cycle/);
});

test("normalizes cache and retry defaults", () => {
  const pipeline = definePipeline({
    name: "test",
    tasks: {
      build: task({ cache: true, retry: 2, run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  });

  assert.equal(pipeline.tasks.build.cache.enabled, true);
  assert.equal(pipeline.tasks.build.retry.attempts, 2);
});

test("normalizes timeout durations", () => {
  const pipeline = definePipeline({
    name: "test",
    tasks: {
      build: task({ timeout: "2s", run: sh`echo build` })
    },
    jobs: {
      verify: job({ target: "build" })
    }
  });

  assert.equal(pipeline.tasks.build.timeoutMs, 2000);
});
