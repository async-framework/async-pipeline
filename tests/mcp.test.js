import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const CLI = join(process.cwd(), "packages", "pipeline-node", "dist", "cli.js");
const DIST = join(process.cwd(), "packages", "pipeline", "dist", "index.js");

async function scratchPipeline() {
  const dir = await mkdtemp(join(tmpdir(), "async-pipeline-mcp-"));
  await writeFile(join(dir, "pipeline.mjs"), `import { definePipeline, job, sh, task } from ${JSON.stringify(DIST)};
export default definePipeline({
  name: "mcp-test",
  cache: "file:local",
  tasks: {
    build: task({ description: "demo build", inputs: ["seed.txt"], cache: true, run: sh\`grep ok seed.txt\` })
  },
  jobs: { verify: job({ target: "build" }) }
});
`);
  await writeFile(join(dir, "seed.txt"), "ok\n");
  return dir;
}

/** Drive the MCP server subprocess line-by-line and resolve responses by request id. */
function mcpClient(args, cwd) {
  const child = spawn(process.execPath, [CLI, "mcp", ...args], {
    cwd,
    env: { PATH: process.env.PATH },
    stdio: ["pipe", "pipe", "pipe"]
  });
  const pending = new Map();
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk);
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) {
        const message = JSON.parse(line);
        const waiter = pending.get(message.id);
        if (waiter) {
          pending.delete(message.id);
          waiter(message);
        }
      }
      index = buffer.indexOf("\n");
    }
  });
  return {
    request(message) {
      return new Promise((resolve) => {
        pending.set(message.id, resolve);
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    },
    notify(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async close() {
      child.stdin.end();
      const code = await new Promise((resolve) => child.once("exit", resolve));
      return code;
    }
  };
}

function toolText(response) {
  assert.equal(response.result?.isError ?? false, false, JSON.stringify(response.result));
  return JSON.parse(response.result.content[0].text);
}

test("PROMISE: the MCP server answers initialize and exposes read-only inspection tools without run_job by default", async () => {
  const dir = await scratchPipeline();
  const client = mcpClient([], dir);
  try {
    const init = await client.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
    assert.equal(init.result.serverInfo.name, "async-pipeline");
    assert.ok(init.result.protocolVersion);
    assert.deepEqual(init.result.capabilities, { tools: {} });
    client.notify({ jsonrpc: "2.0", method: "notifications/initialized" });

    const tools = await client.request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const names = tools.result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ["diff_inputs", "explain_task", "graph", "list_runs", "list_tasks", "metadata", "read_run"]);

    const list = toolText(await client.request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "list_tasks", arguments: {} } }));
    assert.equal(list.pipeline, "mcp-test");
    assert.deepEqual(list.tasks.map((task) => task.id), ["build"]);
    assert.deepEqual(list.jobs.map((job) => job.id), ["verify"]);

    const graph = toolText(await client.request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "graph", arguments: { job: "verify" } } }));
    assert.deepEqual(graph.executionOrder, ["build"]);

    const explain = toolText(await client.request({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "explain_task", arguments: { task: "build" } } }));
    assert.equal(explain.description, "demo build");

    // run_job is hidden and politely refused without --allow-run.
    const refused = await client.request({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "run_job", arguments: { job: "verify" } } });
    assert.equal(refused.result.isError, true);
    assert.match(refused.result.content[0].text, /--allow-run/);

    const unknownMethod = await client.request({ jsonrpc: "2.0", id: 7, method: "resources/list" });
    assert.equal(unknownMethod.error.code, -32601);

    assert.equal(await client.close(), 0);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("PROMISE: MCP run_job with --allow-run runs the same scheduler and records run evidence", async () => {
  const dir = await scratchPipeline();
  const client = mcpClient(["--allow-run"], dir);
  try {
    await client.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });

    const tools = await client.request({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    assert.ok(tools.result.tools.some((tool) => tool.name === "run_job"));

    const record = toolText(await client.request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run_job", arguments: { job: "verify" } } }));
    assert.equal(record.status, "passed");
    assert.equal(record.tasks[0].status, "passed");

    // The run left the same evidence a CLI run leaves.
    const stored = JSON.parse(await readFile(join(dir, ".async", "runs", record.id, "execution.json"), "utf8"));
    assert.equal(stored.id, record.id);
    assert.equal(stored.jobId, "verify");

    // A second run through MCP replays the cache.
    const cached = toolText(await client.request({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run_job", arguments: { job: "verify" } } }));
    assert.equal(cached.tasks[0].status, "cached");

    // read_run and list_runs see what run_job produced.
    const runs = toolText(await client.request({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_runs", arguments: {} } }));
    assert.ok(runs.runs.length >= 2);
    const read = toolText(await client.request({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "read_run", arguments: { runId: record.id } } }));
    assert.equal(read.record.id, record.id);
    assert.deepEqual(read.contextPacks, []);

    assert.equal(await client.close(), 0);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});

test("MCP diff_inputs reports baseline-relative changes through the server", async () => {
  const dir = await scratchPipeline();
  const client = mcpClient(["--allow-run"], dir);
  try {
    await client.request({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
    toolText(await client.request({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "run_job", arguments: { job: "verify" } } }));

    await writeFile(join(dir, "seed.txt"), "ok but different\n");
    const diff = toolText(await client.request({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "diff_inputs", arguments: { task: "build" } } }));
    assert.deepEqual(diff.changed, ["seed.txt"]);

    assert.equal(await client.close(), 0);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
});
