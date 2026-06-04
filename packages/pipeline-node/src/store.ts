import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import type { ExecutionRecord, NormalizedPipeline, NormalizedTask, TaskResult } from "@async/pipeline-core";
import { expandInputs } from "@async/pipeline-core";

export interface PipelineStore {
  root: string;
  asyncDir: string;
  runsDir: string;
  cacheDir: string;
}

export async function createStore(root: string): Promise<PipelineStore> {
  const asyncDir = join(root, ".async");
  const runsDir = join(asyncDir, "runs");
  const cacheDir = join(asyncDir, "cache", "tasks");
  await mkdir(runsDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  return { root, asyncDir, runsDir, cacheDir };
}

export async function writeExecution(store: PipelineStore, record: ExecutionRecord): Promise<void> {
  const runDir = join(store.runsDir, record.id);
  await mkdir(runDir, { recursive: true });
  await writeFile(join(runDir, "execution.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await writeFile(join(runDir, "summary.md"), renderSummary(record), "utf8");
}

export async function writeTaskLog(store: PipelineStore, runId: string, taskId: string, log: string): Promise<void> {
  const logDir = join(store.runsDir, runId, "logs");
  await mkdir(logDir, { recursive: true });
  await writeFile(join(logDir, `${safeFileName(taskId)}.log`), log, "utf8");
}

export async function readCacheEntry(store: PipelineStore, cacheKey: string): Promise<TaskResult | null> {
  try {
    const cacheFile = join(store.cacheDir, cacheKey, "result.json");
    return JSON.parse(await readFile(cacheFile, "utf8")) as TaskResult;
  } catch {
    return null;
  }
}

export async function writeCacheEntry(store: PipelineStore, cacheKey: string, result: TaskResult): Promise<void> {
  const cacheEntryDir = join(store.cacheDir, cacheKey);
  await mkdir(cacheEntryDir, { recursive: true });
  await writeFile(join(cacheEntryDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
}

export async function computeTaskCacheKey(pipeline: NormalizedPipeline, taskDefinition: NormalizedTask, cwd: string): Promise<string> {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    pipeline: pipeline.name,
    task: taskDefinition.id,
    dependsOn: taskDefinition.dependsOn,
    inputs: taskDefinition.inputs,
    outputs: taskDefinition.outputs,
    cache: taskDefinition.cache,
    retry: taskDefinition.retry,
    timeout: taskDefinition.timeout,
    timeoutMs: taskDefinition.timeoutMs,
    requires: taskDefinition.requires,
    environment: taskDefinition.environment,
    steps: taskDefinition.steps.map((step) => typeof step === "function" ? "[function]" : step)
  }));

  const expandedInputs = expandInputs(pipeline, taskDefinition.inputs);
  const inputFiles = await resolveInputFiles(cwd, expandedInputs);

  for (const input of expandedInputs) {
    hash.update(input);
  }

  for (const input of inputFiles) {
    hash.update(input);
    try {
      hash.update(await readFile(join(cwd, input)));
    } catch {
      hash.update("[missing]");
    }
  }

  return hash.digest("hex");
}

export async function resolveInputFiles(cwd: string, inputs: readonly string[]): Promise<string[]> {
  const includePatterns = inputs.filter((input) => !input.startsWith("!"));
  const excludeMatchers = inputs
    .filter((input) => input.startsWith("!"))
    .map((input) => globToRegExp(input.slice(1)));
  const files = new Set<string>();

  for (const pattern of includePatterns) {
    if (!pattern.includes("*")) {
      const normalized = normalizePath(pattern);
      try {
        const fileStat = await stat(join(cwd, normalized));
        if (fileStat.isFile()) files.add(normalized);
      } catch {
        files.add(normalized);
      }
      continue;
    }

    const baseDir = baseDirectoryForGlob(pattern);
    const matcher = globToRegExp(pattern);
    for (const file of await walkFiles(join(cwd, baseDir), cwd)) {
      if (matcher.test(file)) files.add(file);
    }
  }

  return [...files]
    .filter((file) => !excludeMatchers.some((matcher) => matcher.test(file)))
    .sort((left, right) => left.localeCompare(right));
}

async function walkFiles(dir: string, cwd: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkFiles(absolutePath, cwd));
    } else if (entry.isFile()) {
      files.push(normalizePath(relative(cwd, absolutePath)));
    }
  }
  return files;
}

function baseDirectoryForGlob(pattern: string): string {
  const parts = pattern.split("/");
  const baseParts = [];
  for (const part of parts) {
    if (part.includes("*")) break;
    baseParts.push(part);
  }
  return baseParts.length === 0 ? "." : baseParts.join("/");
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    const next = pattern[index + 1];

    if (char === "*" && next === "*" && pattern[index + 2] === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }

    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    source += escapeRegExp(char);
  }
  return new RegExp(`^${source}$`);
}

function escapeRegExp(value: string): string {
  return value.replaceAll(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function renderSummary(record: ExecutionRecord): string {
  const lines = [
    `# Pipeline: ${record.pipelineName}`,
    "",
    `Job: ${record.jobId}`,
    `Status: ${record.status}`,
    "",
    "| Task | Status | Attempts | Cache | Duration |",
    "| --- | --- | ---: | --- | ---: |"
  ];
  for (const task of record.tasks) {
    lines.push(`| ${task.id} | ${task.status} | ${task.attempts} | ${task.cacheHit ? "hit" : "miss"} | ${task.durationMs ?? 0}ms |`);
  }
  lines.push("");
  return lines.join("\n");
}

function safeFileName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}
