import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ExecutionRecord, NormalizedPipeline } from "@async/pipeline-core";
import { buildGraph, tasksForJob } from "@async/pipeline-core";
import { runJob } from "./runner.js";
import { readPipelineMetadata } from "./sources.js";
import {
  computeTaskInputManifest,
  diffInputManifests,
  readCacheInputManifest,
  readContextPacks,
  readTaskBaseline,
  type PipelineStore
} from "./store.js";

/**
 * ADR-0002: a hand-rolled MCP server over stdio. The protocol surface this
 * server needs — initialize, ping, tools/list, tools/call as line-delimited
 * JSON-RPC 2.0 — is small and pinned, which is what keeps the zero-runtime-
 * dependency promise intact. Every tool delegates to the same internals the
 * CLI uses, so the MCP surface cannot drift from `--format json` output.
 */
const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface McpServerOptions {
  pipeline: NormalizedPipeline;
  configPath: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  store: PipelineStore;
  /** Mutating tools (run_job) are exposed only when explicitly enabled. */
  allowRun?: boolean;
  serverVersion?: string;
  input: NodeJS.ReadableStream;
  write: (line: string) => void;
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

const TOOLS: ToolDefinition[] = [
  {
    name: "list_tasks",
    description: "List the pipeline's tasks and jobs: ids, descriptions, dependencies, inputs, outputs, cache settings, and job targets. Reads metadata only; executes nothing.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    readOnly: true
  },
  {
    name: "graph",
    description: "The dependency graph and deterministic execution order, for the whole pipeline or expanded from one job's targets.",
    inputSchema: { type: "object", properties: { job: { type: "string", description: "Optional job id to expand" } }, additionalProperties: false },
    readOnly: true
  },
  {
    name: "explain_task",
    description: "The full normalized definition of one task.",
    inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"], additionalProperties: false },
    readOnly: true
  },
  {
    name: "metadata",
    description: "Full pipeline metadata as JSON. Does not clone sources, run prepare, execute tasks, or evaluate deferred shell callbacks.",
    inputSchema: { type: "object", properties: { includeSources: { type: "boolean" } }, additionalProperties: false },
    readOnly: true
  },
  {
    name: "list_runs",
    description: "Recent run records under .async/runs: id, job, status, timings.",
    inputSchema: { type: "object", properties: { limit: { type: "number", description: "Max records, newest first (default 20)" } }, additionalProperties: false },
    readOnly: true
  },
  {
    name: "read_run",
    description: "One run's execution record plus any failure context packs (error, redacted log tail, input diff vs last passing state, reproduction command).",
    inputSchema: { type: "object", properties: { runId: { type: "string" } }, required: ["runId"], additionalProperties: false },
    readOnly: true
  },
  {
    name: "diff_inputs",
    description: "Which of a task's declared input files changed (content digests) since the task last passed. Reads files; executes nothing.",
    inputSchema: { type: "object", properties: { task: { type: "string" } }, required: ["task"], additionalProperties: false },
    readOnly: true
  },
  {
    name: "run_job",
    description: "Run a job through the scheduler: same run lock, cache, records, and evidence as the CLI. Only available when the server was started with --allow-run.",
    inputSchema: {
      type: "object",
      properties: {
        job: { type: "string" },
        force: { type: "boolean", description: "Re-run tasks while still recording fresh cache entries" }
      },
      required: ["job"],
      additionalProperties: false
    },
    readOnly: false
  }
];

export async function runMcpServer(options: McpServerOptions): Promise<number> {
  const lines = createInterface({ input: options.input, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let message: JsonRpcMessage;
    try {
      message = JSON.parse(trimmed) as JsonRpcMessage;
    } catch {
      options.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
      continue;
    }
    const response = await handleMessage(message, options);
    if (response !== undefined) options.write(JSON.stringify(response));
  }
  return 0;
}

async function handleMessage(message: JsonRpcMessage, options: McpServerOptions): Promise<unknown> {
  if (!message.method) return undefined; // responses and malformed traffic are ignored
  if (message.method.startsWith("notifications/")) return undefined;
  const id = message.id ?? null;

  if (message.method === "initialize") {
    return result(id, {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "async-pipeline", version: options.serverVersion ?? "0.0.0" }
    });
  }
  if (message.method === "ping") return result(id, {});
  if (message.method === "tools/list") {
    const tools = TOOLS
      .filter((tool) => tool.readOnly || options.allowRun)
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
    return result(id, { tools });
  }
  if (message.method === "tools/call") {
    const name = typeof message.params?.name === "string" ? message.params.name : "";
    const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (!tool) {
      return error(id, -32602, `Unknown tool "${name}".`);
    }
    try {
      const payload = await callTool(name, args, options);
      return result(id, { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] });
    } catch (cause) {
      const text = cause instanceof Error ? cause.message : String(cause);
      return result(id, { content: [{ type: "text", text }], isError: true });
    }
  }
  return error(id, -32601, `Method "${message.method}" not found.`);
}

async function callTool(name: string, args: Record<string, unknown>, options: McpServerOptions): Promise<unknown> {
  const { pipeline, store } = options;

  if (name === "list_tasks") {
    return {
      pipeline: pipeline.name,
      tasks: Object.values(pipeline.tasks).map((task) => ({
        id: task.id,
        description: task.description,
        dependsOn: task.dependsOn,
        inputs: task.inputs,
        outputs: task.outputs,
        cache: task.cache.enabled
      })),
      jobs: Object.values(pipeline.jobs).map((job) => ({ id: job.id, target: job.target, trigger: job.trigger }))
    };
  }

  if (name === "graph") {
    const jobId = typeof args.job === "string" ? args.job : undefined;
    const graph = jobId ? tasksForJob(pipeline, jobId) : buildGraph(pipeline);
    return graph;
  }

  if (name === "explain_task") {
    const task = pipeline.tasks[requireString(args, "task")];
    if (!task) throw new Error(`Unknown task "${String(args.task)}".`);
    return JSON.parse(JSON.stringify(task, (_key, value) => (typeof value === "function" ? "[function]" : value)));
  }

  if (name === "metadata") {
    return readPipelineMetadata(options.configPath, {
      cwd: options.cwd,
      includeSources: args.includeSources === true,
      store
    });
  }

  if (name === "list_runs") {
    const limit = typeof args.limit === "number" && args.limit > 0 ? Math.floor(args.limit) : 20;
    let entries: string[];
    try {
      entries = (await readdir(store.runsDir)).sort().reverse();
    } catch {
      return { runs: [] };
    }
    const runs = [];
    for (const entry of entries.slice(0, limit)) {
      try {
        const record = JSON.parse(await readFile(join(store.runsDir, entry, "execution.json"), "utf8")) as ExecutionRecord;
        runs.push({ id: record.id, jobId: record.jobId, status: record.status, startedAt: record.startedAt, finishedAt: record.finishedAt });
      } catch {
        // Partial or foreign directories under runs/ are skipped, not fatal.
      }
    }
    return { runs };
  }

  if (name === "read_run") {
    const runId = requireString(args, "runId");
    const record = JSON.parse(await readFile(join(store.runsDir, runId, "execution.json"), "utf8")) as ExecutionRecord;
    const contextPacks = await readContextPacks(store, runId);
    return { record, contextPacks };
  }

  if (name === "diff_inputs") {
    const taskId = requireString(args, "task");
    const task = pipeline.tasks[taskId];
    if (!task) throw new Error(`Unknown task "${taskId}".`);
    const baseline = await readTaskBaseline(store, taskId);
    const baselineManifest = baseline ? await readCacheInputManifest(store, baseline.cacheKey) : null;
    const current = await computeTaskInputManifest(pipeline, task, options.cwd);
    if (!baseline || !baselineManifest) {
      return { task: taskId, baselineMissing: true, currentFiles: Object.keys(current.files).length };
    }
    return {
      task: taskId,
      baselineCacheKey: baseline.cacheKey,
      baselineRecordedAt: baseline.recordedAt,
      ...diffInputManifests(baselineManifest, current)
    };
  }

  if (name === "run_job") {
    if (!options.allowRun) {
      throw new Error("run_job is disabled. Start the server with `async-pipeline mcp --allow-run` to expose it.");
    }
    const jobId = requireString(args, "job");
    return runJob(pipeline, {
      id: jobId,
      cwd: options.cwd,
      env: options.env,
      mode: options.env.CI ? "ci" : "manual",
      force: args.force === true,
      // stdout is the JSON-RPC channel: task output must never echo into it.
      // It still lands in task logs and the execution record as always.
      echo: false
    });
  }

  throw new Error(`Unknown tool "${name}".`);
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`Tool argument "${key}" must be a non-empty string.`);
  }
  return value;
}

function result(id: number | string | null, payload: unknown): unknown {
  return { jsonrpc: "2.0", id, result: payload };
}

function error(id: number | string | null, code: number, message: string): unknown {
  return { jsonrpc: "2.0", id, error: { code, message } };
}
