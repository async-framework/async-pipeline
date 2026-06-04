import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph, composePipelines, definePipeline, job, sh, source, task, tasksForJob } from "../packages/pipeline-core/dist/index.js";

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

test("normalizes sources and allows declared external task refs as metadata", () => {
  let evaluated = 0;
  const pipeline = definePipeline({
    name: "design-system",
    sources: {
      app: source.path({
        path: "../app",
        pipeline: "pipeline.ts",
        prepare: [sh((ctx) => {
          evaluated += 1;
          return sh`echo ${ctx.candidate.dir}`;
        })]
      })
    },
    tasks: {
      impact: task({ dependsOn: ["app:test"], run: sh`echo impact` })
    },
    jobs: {
      verifyImpact: job({ target: "impact" })
    }
  });

  assert.equal(evaluated, 0);
  assert.equal(pipeline.sources.app.type, "path");
  assert.equal(pipeline.sources.app.prepare[0]?.kind, "deferred-shell");
  assert.deepEqual(tasksForJob(pipeline, "verifyImpact").executionOrder, ["app:test", "impact"]);
});

test("rejects local task ids containing source namespace delimiter", () => {
  assert.throws(() => definePipeline({
    name: "bad",
    tasks: {
      "app:test": task({ run: sh`echo bad` })
    },
    jobs: {
      verify: job({ target: "app:test" })
    }
  }), /cannot contain ":"/);
});

test("composes source pipeline tasks into a namespaced graph", () => {
  const root = definePipeline({
    name: "root",
    sources: {
      app: source.path({ path: "../app" })
    },
    tasks: {
      impact: task({ dependsOn: ["app:test"], run: sh`echo impact` })
    },
    jobs: {
      verifyImpact: job({ target: "impact" })
    }
  });
  const app = definePipeline({
    name: "app",
    tasks: {
      build: task({ run: sh`echo build` }),
      test: task({ dependsOn: ["build"], run: sh`echo test` })
    },
    jobs: {
      verify: job({ target: "test" })
    }
  });

  const composed = composePipelines(root, {
    app: {
      pipeline: app,
      context: { name: "app", dir: "/tmp/app", type: "path" }
    }
  });

  assert.deepEqual(tasksForJob(composed, "verifyImpact").executionOrder, ["app:build", "app:test", "impact"]);
  assert.equal(composed.tasks["app:test"].source.dir, "/tmp/app");
});

test("detects missing tasks when loaded source metadata is composed", () => {
  const root = definePipeline({
    name: "root",
    sources: {
      app: source.path({ path: "../app" })
    },
    tasks: {
      impact: task({ dependsOn: ["app:missing"], run: sh`echo impact` })
    },
    jobs: {
      verifyImpact: job({ target: "impact" })
    }
  });
  const app = definePipeline({
    name: "app",
    tasks: {
      test: task({ run: sh`echo test` })
    },
    jobs: {
      verify: job({ target: "test" })
    }
  });

  assert.throws(() => composePipelines(root, { app: { pipeline: app } }), /missing task "app:missing"/);
});
