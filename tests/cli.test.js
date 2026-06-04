import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("pipeline list shows self job and tasks", () => {
  const result = spawnSync("node", ["packages/pipeline-node/dist/cli.js", "list"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /verify/);
  assert.match(result.stdout, /typecheck/);
});

test("pipeline graph emits JSON", () => {
  const result = spawnSync("node", ["packages/pipeline-node/dist/cli.js", "graph", "--format", "json"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const graph = JSON.parse(result.stdout);
  assert.ok(Array.isArray(graph.tasks));
  assert.ok(graph.executionOrder.includes("pack"));
});

test("pipeline explain emits task details", () => {
  const result = spawnSync("node", ["packages/pipeline-node/dist/cli.js", "explain", "pack"], {
    cwd: new URL("..", import.meta.url),
    encoding: "utf8"
  });

  assert.equal(result.status, 0, result.stderr);
  const explained = JSON.parse(result.stdout);
  assert.deepEqual(explained.dependsOn, ["build"]);
});
