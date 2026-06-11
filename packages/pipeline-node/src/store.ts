import { createHash } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";
import type { CandidateContext, ExecutionRecord, NormalizedPipeline, NormalizedTask, TaskCacheOptions, TaskResult, TaskSourceContext, TaskStep } from "@async/pipeline-core";
import { expandInputs } from "@async/pipeline-core";

export interface PipelineStore {
  root: string;
  asyncDir: string;
  runsDir: string;
  cacheDir: string;
  sourcesDir: string;
}

export interface TaskCacheKeyOptions {
  steps?: TaskStep[];
  candidate?: CandidateContext;
  source?: TaskSourceContext;
  prepareCommands?: string[];
  dependencyFingerprints?: Record<string, string | null | undefined>;
}

export interface ResolvedFileOptions {
  exclude?: readonly string[];
  includeMissing?: boolean;
  pruneDefaultDirs?: boolean;
}

export interface CacheOutputManifest {
  version: 1;
  generatedAt: string;
  outputs: string[];
  files: CacheOutputFile[];
}

export interface CacheOutputFile {
  path: string;
  size: number;
  sha256: string;
}

export async function createStore(root: string): Promise<PipelineStore> {
  const asyncDir = join(root, ".async");
  const runsDir = join(asyncDir, "runs");
  const cacheDir = join(asyncDir, "cache", "tasks");
  const sourcesDir = join(asyncDir, "sources");
  await mkdir(runsDir, { recursive: true });
  await mkdir(cacheDir, { recursive: true });
  await mkdir(sourcesDir, { recursive: true });
  return { root, asyncDir, runsDir, cacheDir, sourcesDir };
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

export async function writeCacheEntry(
  store: PipelineStore,
  cacheKey: string,
  result: TaskResult,
  outputOptions?: { cwd: string; outputs: readonly string[] }
): Promise<CacheOutputManifest | null> {
  const cacheEntryDir = join(store.cacheDir, cacheKey);
  await mkdir(cacheEntryDir, { recursive: true });
  await writeFile(join(cacheEntryDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  if (!outputOptions || outputOptions.outputs.length === 0) return null;
  return writeCacheOutputs(store, cacheKey, outputOptions.cwd, outputOptions.outputs);
}

export async function computeTaskCacheKey(
  pipeline: NormalizedPipeline,
  taskDefinition: NormalizedTask,
  cwd: string,
  options: TaskCacheKeyOptions = {}
): Promise<string> {
  const hash = createHash("sha256");
  hash.update(JSON.stringify({
    pipeline: pipeline.name,
    task: taskDefinition.id,
    source: serializeSourceContext(options.source ?? taskDefinition.source),
    candidate: serializeCandidateContext(options.candidate),
    prepareCommands: (options.prepareCommands ?? []).map((command) => normalizeCommandForCacheKey(command, options)),
    dependencyFingerprints: normalizeDependencyFingerprints(options.dependencyFingerprints),
    dependsOn: taskDefinition.dependsOn,
    inputs: taskDefinition.inputs,
    outputs: taskDefinition.outputs,
    cache: serializeCacheOptions(taskDefinition.cache),
    retry: taskDefinition.retry,
    timeout: taskDefinition.timeout,
    timeoutMs: taskDefinition.timeoutMs,
    requires: taskDefinition.requires,
    environment: taskDefinition.environment,
    steps: serializeSteps(options.steps ?? taskDefinition.steps)
  }));

  const expandedInputs = expandInputs(pipeline, taskDefinition.inputs);
  const inputFiles = await resolveInputFiles(cwd, expandedInputs, { exclude: taskDefinition.outputs });

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

export async function computeCandidateContext(pipeline: NormalizedPipeline, cwd: string): Promise<CandidateContext> {
  const hash = createHash("sha256");
  const inputs = new Set<string>(["pipeline.ts", "pipeline.mjs", "pipeline.js"]);
  for (const taskDefinition of Object.values(pipeline.tasks)) {
    for (const input of expandInputs(pipeline, taskDefinition.inputs)) {
      inputs.add(input);
    }
  }

  const inputFiles = await resolveInputFiles(cwd, [...inputs]);
  for (const input of [...inputs].sort()) {
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

  return {
    dir: cwd,
    fingerprint: hash.digest("hex")
  };
}

export function resolveInputFiles(cwd: string, inputs: readonly string[]): Promise<string[]>;
export function resolveInputFiles(cwd: string, inputs: readonly string[], options: ResolvedFileOptions): Promise<string[]>;
export async function resolveInputFiles(cwd: string, inputs: readonly string[], options?: ResolvedFileOptions): Promise<string[]> {
  return resolveFiles(cwd, inputs, {
    includeMissing: options?.includeMissing ?? true,
    pruneDefaultDirs: options?.pruneDefaultDirs ?? true,
    exclude: options?.exclude
  });
}

export async function resolveOutputFiles(cwd: string, outputs: readonly string[]): Promise<string[]> {
  return resolveFiles(cwd, outputs, {
    includeMissing: false,
    pruneDefaultDirs: false
  });
}

export async function restoreCacheOutputs(store: PipelineStore, cacheKey: string, cwd: string, outputs: readonly string[]): Promise<boolean> {
  const manifest = await readCacheOutputManifest(store, cacheKey);
  if (!manifest || !sameStringList(manifest.outputs, [...outputs])) return false;

  const outputDir = cacheOutputFilesDir(store, cacheKey);
  for (const file of manifest.files) {
    if (!isSafeRelativePath(file.path)) return false;
    const cachedPath = join(outputDir, file.path);
    let cachedStat;
    try {
      cachedStat = await stat(cachedPath);
    } catch {
      return false;
    }
    if (!cachedStat.isFile() || cachedStat.size !== file.size) return false;
    if (await sha256File(cachedPath) !== file.sha256) return false;
  }

  for (const file of manifest.files) {
    const destination = join(cwd, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(outputDir, file.path), destination);
  }

  return true;
}

export async function outputFilesExist(cwd: string, files: readonly string[]): Promise<boolean> {
  for (const file of files) {
    if (!isSafeRelativePath(file)) return false;
    try {
      const fileStat = await stat(join(cwd, file));
      if (!fileStat.isFile()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function writeCacheOutputs(store: PipelineStore, cacheKey: string, cwd: string, outputs: readonly string[]): Promise<CacheOutputManifest> {
  const outputDir = cacheOutputFilesDir(store, cacheKey);
  await rm(outputDir, { force: true, recursive: true });
  await mkdir(outputDir, { recursive: true });

  const outputFiles = await resolveOutputFiles(cwd, outputs);
  const files: CacheOutputFile[] = [];
  for (const file of outputFiles) {
    if (!isSafeRelativePath(file)) continue;
    const source = join(cwd, file);
    const destination = join(outputDir, file);
    const fileStat = await stat(source);
    if (!fileStat.isFile()) continue;
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(source, destination);
    files.push({
      path: file,
      size: fileStat.size,
      sha256: await sha256File(source)
    });
  }

  const manifest: CacheOutputManifest = {
    version: 1,
    generatedAt: new Date().toISOString(),
    outputs: [...outputs],
    files: files.sort((left, right) => left.path.localeCompare(right.path))
  };
  await writeFile(cacheOutputManifestPath(store, cacheKey), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return manifest;
}

async function readCacheOutputManifest(store: PipelineStore, cacheKey: string): Promise<CacheOutputManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(cacheOutputManifestPath(store, cacheKey), "utf8")) as CacheOutputManifest;
    if (parsed.version !== 1 || !Array.isArray(parsed.outputs) || !Array.isArray(parsed.files)) return null;
    for (const file of parsed.files) {
      if (typeof file.path !== "string" || typeof file.size !== "number" || typeof file.sha256 !== "string") return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function cacheOutputManifestPath(store: PipelineStore, cacheKey: string): string {
  return join(store.cacheDir, cacheKey, "outputs.json");
}

function cacheOutputFilesDir(store: PipelineStore, cacheKey: string): string {
  return join(store.cacheDir, cacheKey, "outputs");
}

async function resolveFiles(cwd: string, inputs: readonly string[], options: ResolvedFileOptions): Promise<string[]> {
  const includePatterns = inputs.filter((input) => !input.startsWith("!"));
  const excludePatterns = [
    ...inputs.filter((input) => input.startsWith("!")).map((input) => input.slice(1)),
    ...(options.exclude ?? [])
  ];
  const excludeMatchers = excludePatterns
    .filter((input) => input.length > 0)
    .flatMap(expandExcludePattern)
    .map((input) => globToRegExp(input));
  const files = new Set<string>();

  for (const pattern of includePatterns) {
    const normalizedPattern = normalizePath(pattern);
    if (isIgnoredPath(normalizedPattern, options)) continue;

    if (!normalizedPattern.includes("*")) {
      const normalized = normalizePath(normalizedPattern);
      if (isIgnoredPath(normalized, options) || excludeMatchers.some((matcher) => matcher.test(normalized))) continue;
      try {
        const fileStat = await stat(join(cwd, normalized));
        if (fileStat.isFile()) files.add(normalized);
        if (fileStat.isDirectory()) {
          for (const file of await walkFiles(join(cwd, normalized), cwd, options)) {
            files.add(file);
          }
        }
      } catch {
        if (options.includeMissing ?? true) files.add(normalized);
      }
      continue;
    }

    const baseDir = baseDirectoryForGlob(normalizedPattern);
    const matcher = globToRegExp(normalizedPattern);
    for (const file of await walkFiles(join(cwd, baseDir), cwd, options)) {
      if (matcher.test(file)) files.add(file);
    }
  }

  return [...files]
    .filter((file) => !excludeMatchers.some((matcher) => matcher.test(file)))
    .sort((left, right) => left.localeCompare(right));
}

async function walkFiles(dir: string, cwd: string, options: ResolvedFileOptions): Promise<string[]> {
  const relativeDir = normalizePath(relative(cwd, dir));
  if (relativeDir && relativeDir !== "." && isIgnoredPath(relativeDir, options)) return [];

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    const relativePath = normalizePath(relative(cwd, absolutePath));
    if (isIgnoredPath(relativePath, options)) continue;
    if (entry.isDirectory()) {
      files.push(...await walkFiles(absolutePath, cwd, options));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function expandExcludePattern(pattern: string): string[] {
  const normalized = normalizePath(pattern);
  if (normalized.endsWith("/**")) return [normalized];
  if (normalized.endsWith("/")) return [`${normalized}**`];
  if (normalized.includes("*")) return [normalized];
  return [normalized, `${normalized}/**`];
}

const PRUNED_DIR_NAMES = new Set([".git", ".async", "node_modules"]);

function isIgnoredPath(path: string, options: ResolvedFileOptions): boolean {
  if (options.pruneDefaultDirs === false) return false;
  const normalized = normalizePath(path);
  if (!normalized || normalized === ".") return false;
  return normalized.split("/").some((segment) => PRUNED_DIR_NAMES.has(segment));
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isSafeRelativePath(path: string): boolean {
  const normalized = normalizePath(path);
  return Boolean(normalized)
    && !isAbsolute(normalized)
    && normalized !== ".."
    && !normalized.startsWith("../")
    && !normalized.includes("/../");
}

function serializeCandidateContext(candidate: CandidateContext | undefined): unknown {
  if (!candidate) return undefined;
  return {
    commit: candidate.commit,
    ref: candidate.ref,
    dirty: candidate.dirty
  };
}

function serializeSourceContext(source: TaskSourceContext | undefined): unknown {
  if (!source) return undefined;
  return {
    name: source.name,
    type: source.type,
    ref: source.ref,
    commit: source.commit
  };
}

function normalizeDependencyFingerprints(fingerprints: Record<string, string | null | undefined> | undefined): Record<string, string | null> {
  return Object.fromEntries(
    Object.entries(fingerprints ?? {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, value]) => [key, value ?? null])
  );
}

function normalizeCommandForCacheKey(command: string, options: Pick<TaskCacheKeyOptions, "candidate" | "source">): string {
  let normalized = command;
  const replacements = [
    [options.candidate?.dir, "$ASYNC_PIPELINE_CANDIDATE_DIR"],
    [options.source?.dir, "$ASYNC_PIPELINE_SOURCE_DIR"]
  ] as const;
  for (const [value, replacement] of replacements) {
    if (!value) continue;
    normalized = normalized.split(value).join(replacement);
    normalized = normalized.split(normalizePath(value)).join(replacement);
  }
  return normalized;
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

function serializeSteps(steps: readonly TaskStep[]): unknown[] {
  return steps.map((step) => {
    if (typeof step === "function") return "[function]";
    if (step.kind === "deferred-shell") return { kind: "deferred-shell" };
    return step;
  });
}

function serializeCacheOptions(cache: TaskCacheOptions): unknown {
  return {
    ...cache,
    key: typeof cache.key === "function" ? "[function]" : cache.key
  };
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
