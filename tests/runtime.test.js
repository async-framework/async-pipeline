import assert from "node:assert/strict";
import { test } from "node:test";
import { cache, createRuntime, defineRuntime, task } from "../packages/pipeline/dist/runtime.js";

test("runtime executes run arrays and nested tasks", async () => {
  const order = [];
  const work = defineRuntime([
    task({ id: "parent" }, [
      async (_ctx, next) => {
        order.push("before-parent");
        await next();
        order.push("after-parent");
      }
    ]),
    task({ id: "child" }, async () => {
      order.push("child");
    })
  ]);

  const runtime = createRuntime(work);
  const result = await runtime.run({});

  assert.equal(result.status, "passed");
  assert.deepEqual(order, ["before-parent", "after-parent", "child"]);
  assert.deepEqual(result.tasks.map((entry) => entry.id), ["parent", "child"]);
});

test("runtime memory cache directive skips repeated work", async () => {
  let runs = 0;
  const runtime = createRuntime(defineRuntime([
    task({ id: "cached" }, [
      cache.use("memory:cache-first"),
      async () => {
        runs += 1;
        return runs;
      }
    ])
  ]));

  const first = await runtime.run({ value: 1 });
  const second = await runtime.run({ value: 1 });

  assert.equal(first.output, 1);
  assert.equal(second.output, 1);
  assert.equal(runs, 1);
  assert.equal(second.tasks[0].status, "cached");
});

test("runtime partial execution runs dependencies first", async () => {
  const order = [];
  const runtime = createRuntime(defineRuntime([
    task({ id: "load" }, async () => {
      order.push("load");
    }),
    task({ id: "send", dependsOn: ["load"] }, async () => {
      order.push("send");
    })
  ]));

  const result = await runtime.run({}, { task: "send" });

  assert.equal(result.status, "passed");
  assert.deepEqual(order, ["load", "send"]);
  assert.deepEqual(result.tasks.map((entry) => entry.id), ["load", "send"]);
});

test("runtime nested tasks run once with parent before child", async () => {
  const order = [];
  const runtime = createRuntime(defineRuntime([
    task({ id: "group" }, [
      task({ id: "child" }, async () => {
        order.push("child");
      })
    ])
  ]));

  const result = await runtime.run({});

  assert.equal(result.status, "passed");
  assert.deepEqual(order, ["child"]);
  assert.deepEqual(result.tasks.map((entry) => entry.id), ["group", "child"]);
});

test("runtime rejects config run with second argument", () => {
  assert.throws(() => task({ id: "bad", run: async () => {} }, async () => {}), (error) => error.code === "ASYNC_PIPELINE_TASK_ARGUMENT_CONFLICT");
});
