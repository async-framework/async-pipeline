import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { definePipeline, job, sh, task } from "../packages/pipeline-core/dist/index.js";
import { computeTaskCacheKey, resolveInputFiles } from "../packages/pipeline-node/dist/store.js";

test("glob inputs are resolved deterministically and included in cache keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-cache-"));
  try {
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "src", "a.ts"), "export const value = 1;\n", "utf8");
    await writeFile(join(dir, "src", "b.test.ts"), "test('noop', () => {});\n", "utf8");

    assert.deepEqual(await resolveInputFiles(dir, ["src/**/*.ts", "!src/**/*.test.ts"]), ["src/a.ts"]);

    const pipeline = definePipeline({
      name: "cache-test",
      tasks: {
        build: task({ inputs: ["src/**/*.ts", "!src/**/*.test.ts"], run: sh`echo build` })
      },
      jobs: {
        verify: job({ target: "build" })
      }
    });

    const first = await computeTaskCacheKey(pipeline, pipeline.tasks.build, dir);
    await writeFile(join(dir, "src", "a.ts"), "export const value = 2;\n", "utf8");
    const second = await computeTaskCacheKey(pipeline, pipeline.tasks.build, dir);

    assert.notEqual(first, second);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("cache keys include candidate, source, and resolved prepare commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-source-cache-"));
  try {
    await writeFile(join(dir, "input.txt"), "one\n", "utf8");
    const pipeline = definePipeline({
      name: "cache-test",
      tasks: {
        test: task({ inputs: ["input.txt"], cache: true, run: sh`echo test` })
      },
      jobs: {
        verify: job({ target: "test" })
      }
    });

    const baseOptions = {
      source: { name: "app", dir, type: "path" },
      prepareCommands: ["pnpm install"]
    };
    const first = await computeTaskCacheKey(pipeline, pipeline.tasks.test, dir, {
      ...baseOptions,
      candidate: { dir, fingerprint: "candidate-a" }
    });
    const second = await computeTaskCacheKey(pipeline, pipeline.tasks.test, dir, {
      ...baseOptions,
      candidate: { dir, fingerprint: "candidate-b" }
    });
    const third = await computeTaskCacheKey(pipeline, pipeline.tasks.test, dir, {
      ...baseOptions,
      candidate: { dir, fingerprint: "candidate-a" },
      prepareCommands: ["pnpm install", "pnpm add file:../candidate"]
    });

    assert.notEqual(first, second);
    assert.notEqual(first, third);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
