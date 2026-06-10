import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { JobId, NormalizedJob, NormalizedPipeline, TriggerDefinition, TriggerId } from "@async/pipeline-core";
import { pipelineError } from "@async/pipeline-core";

export const GITHUB_WORKFLOW_PATH = ".github/workflows/async-pipeline.yml";
export const GITHUB_LOCK_PATH = ".github/async-pipeline.lock.json";
const GENERATOR_VERSION = 1;

export interface GitHubRenderOptions {
  cwd: string;
  configPath: string;
  workflowPath?: string;
  lockPath?: string;
}

export interface GitHubLock {
  version: number;
  generator: string;
  config: string;
  workflow: string;
  hash: string;
  generatedAt: string;
  triggers: Record<string, unknown>;
  jobs: Array<{ id: string; target: string[]; trigger: string[] }>;
  packageManager: string;
  buildCommand?: string;
}

export interface GitHubRenderResult {
  workflowPath: string;
  lockPath: string;
  workflow: string;
  lock: GitHubLock;
}

export interface GitHubEventContext {
  eventName: string;
  ref?: string;
  baseRef?: string;
  headRef?: string;
  schedule?: string;
  payload?: unknown;
}

export async function renderGitHubWorkflow(pipeline: NormalizedPipeline, options: GitHubRenderOptions): Promise<GitHubRenderResult> {
  const workflowPath = options.workflowPath ?? GITHUB_WORKFLOW_PATH;
  const lockPath = options.lockPath ?? GITHUB_LOCK_PATH;
  const packageInfo = await readPackageInfo(options.cwd);
  const renderModel = buildRenderModel(pipeline, {
    configPath: relativePath(options.cwd, options.configPath),
    workflowPath,
    packageManager: packageInfo.packageManager,
    buildCommand: packageInfo.buildCommand
  });
  const workflow = renderWorkflow(renderModel);
  const hash = hashJson({
    version: GENERATOR_VERSION,
    config: renderModel.configPath,
    workflow: renderModel.workflowPath,
    triggers: renderModel.triggers,
    jobs: renderModel.jobs,
    packageManager: renderModel.packageManager,
    buildCommand: renderModel.buildCommand
  });
  const lock: GitHubLock = {
    version: GENERATOR_VERSION,
    generator: "@async/pipeline",
    config: renderModel.configPath,
    workflow: renderModel.workflowPath,
    hash,
    generatedAt: new Date().toISOString(),
    triggers: renderModel.triggers,
    jobs: renderModel.jobs,
    packageManager: renderModel.packageManager,
    buildCommand: renderModel.buildCommand
  };
  return {
    workflowPath,
    lockPath,
    workflow,
    lock
  };
}

export async function writeGitHubWorkflow(result: GitHubRenderResult, cwd: string): Promise<void> {
  const workflowFile = resolve(cwd, result.workflowPath);
  const lockFile = resolve(cwd, result.lockPath);
  await mkdir(dirname(workflowFile), { recursive: true });
  await mkdir(dirname(lockFile), { recursive: true });
  await writeFile(workflowFile, result.workflow, "utf8");
  await writeFile(lockFile, `${JSON.stringify(result.lock, null, 2)}\n`, "utf8");
}

export async function checkGitHubWorkflow(result: GitHubRenderResult, cwd: string): Promise<string[]> {
  const issues: string[] = [];
  const workflowFile = resolve(cwd, result.workflowPath);
  const lockFile = resolve(cwd, result.lockPath);

  if (!existsSync(workflowFile)) {
    issues.push(`Missing generated workflow ${result.workflowPath}. Run async-pipeline github generate.`);
  } else {
    const existingWorkflow = await readFile(workflowFile, "utf8");
    if (existingWorkflow !== result.workflow) {
      issues.push(`Generated workflow ${result.workflowPath} is stale. Run async-pipeline github generate.`);
    }
  }

  if (!existsSync(lockFile)) {
    issues.push(`Missing GitHub generation lock ${result.lockPath}. Run async-pipeline github generate.`);
  } else {
    const existingLock = JSON.parse(await readFile(lockFile, "utf8")) as GitHubLock;
    if (existingLock.hash !== result.lock.hash || existingLock.workflow !== result.lock.workflow || existingLock.config !== result.lock.config) {
      issues.push(`GitHub generation lock ${result.lockPath} is stale. Run async-pipeline github generate.`);
    }
  }

  return issues;
}

export async function readGitHubEventContext(env: NodeJS.ProcessEnv): Promise<GitHubEventContext> {
  const eventName = env.ASYNC_PIPELINE_GITHUB_EVENT_NAME ?? env.GITHUB_EVENT_NAME ?? "workflow_dispatch";
  const eventPath = env.GITHUB_EVENT_PATH;
  let payload: unknown;
  if (eventPath && existsSync(eventPath)) {
    payload = JSON.parse(await readFile(eventPath, "utf8"));
  }
  return {
    eventName,
    ref: env.ASYNC_PIPELINE_GITHUB_REF ?? env.GITHUB_REF,
    baseRef: env.ASYNC_PIPELINE_GITHUB_BASE_REF ?? env.GITHUB_BASE_REF,
    headRef: env.ASYNC_PIPELINE_GITHUB_HEAD_REF ?? env.GITHUB_HEAD_REF,
    schedule: env.ASYNC_PIPELINE_GITHUB_SCHEDULE,
    payload
  };
}

export function jobsForGitHubEvent(pipeline: NormalizedPipeline, context: GitHubEventContext): NormalizedJob[] {
  if (context.eventName === "workflow_dispatch") {
    return Object.values(pipeline.jobs).sort((left, right) => left.id.localeCompare(right.id));
  }

  const matches: NormalizedJob[] = [];
  for (const job of Object.values(pipeline.jobs)) {
    for (const triggerId of job.trigger) {
      const trigger = pipeline.triggers[triggerId];
      if (trigger && triggerMatches(triggerId, trigger, context)) {
        matches.push(job);
        break;
      }
    }
  }
  return matches.sort((left, right) => left.id.localeCompare(right.id));
}

function buildRenderModel(
  pipeline: NormalizedPipeline,
  options: { configPath: string; workflowPath: string; packageManager: string; buildCommand?: string }
) {
  const usedTriggerIds = new Set<TriggerId>(Object.values(pipeline.jobs).flatMap((job) => job.trigger));
  const usedTriggers = Object.fromEntries([...usedTriggerIds].sort().map((triggerId) => [triggerId, pipeline.triggers[triggerId]]));
  return {
    name: "Async Pipeline",
    configPath: options.configPath,
    workflowPath: options.workflowPath,
    triggers: normalizeGitHubTriggers(usedTriggers),
    jobs: Object.values(pipeline.jobs)
      .map((job) => ({ id: job.id, target: [...job.target], trigger: [...job.trigger] }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    packageManager: options.packageManager,
    buildCommand: options.buildCommand
  };
}

function normalizeGitHubTriggers(triggers: Record<string, TriggerDefinition | undefined>): Record<string, unknown> {
  const events: Record<string, unknown> = {};
  const schedules: Array<{ cron: string; timezone?: string; id: string }> = [];

  for (const [id, trigger] of Object.entries(triggers)) {
    if (!trigger) continue;
    if (trigger.type === "github") {
      for (const event of trigger.events ?? []) {
        const existing = events[event] && typeof events[event] === "object" ? events[event] as Record<string, unknown> : {};
        events[event] = mergeEventFilters(existing, trigger);
      }
    }
    if (trigger.type === "schedule" && trigger.cron) {
      schedules.push({ id, cron: trigger.cron, timezone: trigger.timezone });
    }
  }

  if (schedules.length > 0) {
    events.schedule = schedules.sort((left, right) => left.cron.localeCompare(right.cron));
  }
  events.workflow_dispatch = {};
  return sortObject(events);
}

function renderWorkflow(model: ReturnType<typeof buildRenderModel>): string {
  const lines = [
    "# Generated by async-pipeline. Do not edit by hand.",
    "# Run: async-pipeline github generate",
    "",
    `name: ${model.name}`,
    "",
    "on:"
  ];
  renderOn(lines, model.triggers);
  lines.push(
    "",
    "permissions:",
    "  contents: read",
    "",
    "jobs:",
    "  pipeline:",
    "    name: async-pipeline",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - name: Checkout",
    "        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "",
    "      - name: Setup Node",
    "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6",
    "        with:",
    "          node-version: 24",
    "",
    "      - name: Enable pnpm",
    "        run: |",
    "          corepack enable",
    "          corepack prepare pnpm@10.20.0 --activate",
    "",
    "      - name: Install dependencies",
    `        run: ${model.packageManager} install --frozen-lockfile`
  );
  if (model.buildCommand) {
    lines.push(
      "",
      "      - name: Build pipeline CLI",
      `        run: ${model.buildCommand}`
    );
  }
  lines.push(
    "",
    "      - name: Check generated workflow",
    `        run: ${model.packageManager} async-pipeline github check`,
    "",
    "      - name: Run matching pipeline jobs",
    `        run: ${model.packageManager} async-pipeline github run`,
    "        env:",
    "          CI: true",
    "          ASYNC_PIPELINE_GITHUB_EVENT_NAME: ${{ github.event_name }}",
    "          ASYNC_PIPELINE_GITHUB_REF: ${{ github.ref }}",
    "          ASYNC_PIPELINE_GITHUB_BASE_REF: ${{ github.base_ref }}",
    "          ASYNC_PIPELINE_GITHUB_HEAD_REF: ${{ github.head_ref }}",
    "          ASYNC_PIPELINE_GITHUB_SCHEDULE: ${{ github.event.schedule }}",
    ""
  );
  return `${lines.join("\n")}`;
}

function renderOn(lines: string[], triggers: Record<string, unknown>): void {
  for (const [event, value] of Object.entries(triggers)) {
    if (event === "schedule" && Array.isArray(value)) {
      lines.push("  schedule:");
      for (const schedule of value as Array<{ cron: string; timezone?: string }>) {
        lines.push(`    - cron: ${JSON.stringify(schedule.cron)}`);
        if (schedule.timezone) lines.push(`      timezone: ${JSON.stringify(schedule.timezone)}`);
      }
      continue;
    }
    if (event === "workflow_dispatch") {
      lines.push("  workflow_dispatch:");
      continue;
    }
    const filters = value as Record<string, unknown>;
    if (Object.keys(filters).length === 0) {
      lines.push(`  ${event}:`);
      continue;
    }
    lines.push(`  ${event}:`);
    for (const [key, values] of Object.entries(filters)) {
      if (!Array.isArray(values) || values.length === 0) continue;
      lines.push(`    ${key}:`);
      for (const item of values) lines.push(`      - ${JSON.stringify(item)}`);
    }
  }
}

function mergeEventFilters(existing: Record<string, unknown>, trigger: TriggerDefinition): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...existing };
  for (const key of ["branches", "paths", "tags"] as const) {
    if (!trigger[key]) continue;
    merged[key] = [...new Set([...(Array.isArray(merged[key]) ? merged[key] as string[] : []), ...trigger[key]])].sort();
  }
  return merged;
}

function triggerMatches(triggerId: string, trigger: TriggerDefinition, context: GitHubEventContext): boolean {
  if (trigger.type === "manual") return context.eventName === "workflow_dispatch";
  if (trigger.type === "schedule") {
    return context.eventName === "schedule" && (!trigger.cron || !context.schedule || trigger.cron === context.schedule);
  }
  if (trigger.type !== "github") return false;
  if (!(trigger.events ?? []).includes(context.eventName)) return false;
  const branch = branchForEvent(context);
  if (trigger.branches && branch && !matchesAnyPattern(branch, trigger.branches)) return false;
  if (trigger.tags && context.ref?.startsWith("refs/tags/")) {
    const tag = context.ref.slice("refs/tags/".length);
    if (!matchesAnyPattern(tag, trigger.tags)) return false;
  }
  return Boolean(triggerId);
}

function branchForEvent(context: GitHubEventContext): string | undefined {
  if (context.baseRef) return context.baseRef;
  if (context.ref?.startsWith("refs/heads/")) return context.ref.slice("refs/heads/".length);
  if (context.payload && typeof context.payload === "object") {
    const pullRequest = (context.payload as { pull_request?: { base?: { ref?: string } } }).pull_request;
    if (pullRequest?.base?.ref) return pullRequest.base.ref;
  }
  return undefined;
}

function matchesAnyPattern(value: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => globToRegExp(pattern).test(value));
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (const char of pattern) {
    source += char === "*" ? ".*" : char.replaceAll(/[\\^$+?.()|[\]{}]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

async function readPackageInfo(cwd: string): Promise<{ packageManager: string; buildCommand?: string }> {
  const packagePath = join(cwd, "package.json");
  if (!existsSync(packagePath)) return { packageManager: "pnpm" };
  const packageJson = JSON.parse(await readFile(packagePath, "utf8")) as {
    packageManager?: string;
    scripts?: Record<string, string>;
  };
  const packageManager = packageJson.packageManager?.startsWith("npm@") ? "npm" : packageJson.packageManager?.startsWith("yarn@") ? "yarn" : "pnpm";
  const asyncPipelineScript = packageJson.scripts?.["async-pipeline"] ?? "";
  const buildCommand = asyncPipelineScript.includes("dist/cli.js") && packageJson.scripts?.build ? `${packageManager} build` : undefined;
  return { packageManager, buildCommand };
}

function sortObject(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).sort(([left], [right]) => left.localeCompare(right)));
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function relativePath(cwd: string, path: string): string {
  const relativeConfig = relative(cwd, resolve(path));
  if (relativeConfig.startsWith("..")) {
    throw pipelineError("ASYNC_PIPELINE_GITHUB_CONFIG_OUTSIDE_ROOT", `Pipeline config "${path}" must be inside ${cwd}.`);
  }
  return relativeConfig || "pipeline.ts";
}
