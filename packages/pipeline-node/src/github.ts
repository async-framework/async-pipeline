import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import type { EnvValue, GitHubJobConfig, JobEnvironment, JobRequirements, JobId, NormalizedJob, NormalizedPipeline, TriggerDefinition, TriggerId } from "@async/pipeline-core";
import { pipelineError } from "@async/pipeline-core";

export const GITHUB_WORKFLOW_PATH = ".github/workflows/async-pipeline.yml";
export const GITHUB_LOCK_PATH = ".github/async-pipeline.lock.json";
const GENERATOR_VERSION = 2;
const DEFAULT_NODE_VERSION = "24";

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
  jobs: Array<{ id: string; target: string[]; trigger: string[]; env: Record<string, EnvValue>; environment?: JobEnvironment; requires?: JobRequirements; github?: GitHubJobConfig; if?: string }>;
  packageManager: string;
  buildCommand?: string;
  nodeVersion: string;
  taskCache: boolean;
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
  const workflowPath = options.workflowPath ?? pipeline.sync.github.workflow ?? GITHUB_WORKFLOW_PATH;
  const lockPath = options.lockPath ?? pipeline.sync.github.lock ?? GITHUB_LOCK_PATH;
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
    buildCommand: renderModel.buildCommand,
    nodeVersion: renderModel.nodeVersion,
    taskCache: renderModel.taskCache
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
    buildCommand: renderModel.buildCommand,
    nodeVersion: renderModel.nodeVersion,
    taskCache: renderModel.taskCache
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
    // Dispatch is not "run everything": only jobs that declare a manual trigger
    // run implicitly. Anything else must be selected explicitly (github run --job).
    return Object.values(pipeline.jobs)
      .filter((job) => job.trigger.some((triggerId) => pipeline.triggers[triggerId]?.type === "manual"))
      .sort((left, right) => left.id.localeCompare(right.id));
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
      .map((job) => ({
        id: job.id,
        target: [...job.target],
        trigger: [...job.trigger],
        env: { ...pipeline.env, ...(job.env ?? {}) },
        environment: job.environment,
        requires: job.requires,
        github: job.github,
        if: renderGitHubJobCondition(job, pipeline.triggers)
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    packageManager: options.packageManager,
    buildCommand: options.buildCommand,
    nodeVersion: pipeline.sync.github.nodeVersion ?? DEFAULT_NODE_VERSION,
    taskCache: pipeline.sync.github.cache ?? true
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
    "jobs:"
  );
  for (const job of model.jobs) renderJob(lines, model, job);
  return `${lines.join("\n")}`;
}

function renderJob(lines: string[], model: ReturnType<typeof buildRenderModel>, job: ReturnType<typeof buildRenderModel>["jobs"][number]): void {
  const runnerMatrix = job.github?.runsOnMatrix;
  lines.push(
    `  ${yamlKey(job.id)}:`,
    runnerMatrix && runnerMatrix.length > 0
      ? `    name: ${job.id} (\${{ join(matrix.runner, ' ') }})`
      : `    name: ${job.id}`
  );
  if (job.if) {
    lines.push(`    if: ${job.if}`);
  }
  if (runnerMatrix && runnerMatrix.length > 0) {
    lines.push(
      "    strategy:",
      "      fail-fast: false",
      "      matrix:",
      "        runner:"
    );
    for (const entry of runnerMatrix) {
      const labels = Array.isArray(entry) ? entry : [entry];
      lines.push(`          - ${JSON.stringify(labels)}`);
    }
    lines.push("    runs-on: ${{ matrix.runner }}");
  } else {
    const runsOn = job.github?.runsOn ?? "ubuntu-latest";
    lines.push(`    runs-on: ${Array.isArray(runsOn) ? JSON.stringify(runsOn) : runsOn}`);
  }
  const environment = job.environment ?? job.github?.environment;
  if (environment) {
    renderGitHubEnvironment(lines, environment);
  }
  const idToken = job.github?.permissions?.idToken ?? (job.requires?.provenance ? "write" as const : undefined);
  const contents = job.github?.permissions?.contents ?? (idToken ? "read" : undefined);
  if (contents || idToken) {
    lines.push("    permissions:");
    if (contents) lines.push(`      contents: ${contents}`);
    if (idToken) lines.push(`      id-token: ${idToken}`);
  }
  lines.push(
    "    steps:",
    "      - name: Checkout",
    "        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2",
    "",
    ...(model.taskCache
      ? [
          "      - name: Restore task cache",
          "        uses: actions/cache@0057852bfaa89a56745cba8c7296529d2fc39830 # v4",
          "        with:",
          "          path: .async/cache",
          "          key: async-pipeline-${{ runner.os }}-${{ github.sha }}",
          "          restore-keys: |",
          "            async-pipeline-${{ runner.os }}-",
          ""
        ]
      : []),
    "      - name: Setup Node",
    "        uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e # v6",
    "        with:",
    `          node-version: ${model.nodeVersion}`,
    "          registry-url: https://registry.npmjs.org/",
    "          package-manager-cache: false",
    "",
    ...(idToken === "write"
      ? [
          "      - name: Use current npm",
          "        run: npm install -g npm@11.16.0",
          ""
        ]
      : []),
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
    "      - name: Run pipeline job",
    `        run: ${model.packageManager} async-pipeline run ${shellWord(job.id)}`,
    "        env:",
    "          CI: true"
  );
  for (const [name, value] of Object.entries(job.env).sort(([left], [right]) => left.localeCompare(right))) {
    const rendered = renderGitHubEnvValue(value);
    if (rendered !== undefined) {
      lines.push(`          ${name}: ${rendered}`);
    }
  }
  lines.push("");
}

function renderGitHubEnvironment(lines: string[], environment: JobEnvironment): void {
  if (typeof environment === "string") {
    lines.push(`    environment: ${JSON.stringify(environment)}`);
    return;
  }
  lines.push(
    "    environment:",
    `      name: ${JSON.stringify(environment.name)}`
  );
  if (environment.url) {
    lines.push(`      url: ${JSON.stringify(environment.url)}`);
  }
}

function renderGitHubEnvValue(value: EnvValue): string | undefined {
  if (typeof value === "string") return JSON.stringify(value);
  if (value.kind === "async-pipeline.env.secret") return `\${{ secrets.${value.name} }}`;
  if (value.kind === "async-pipeline.env.var" && !value.values) return `\${{ vars.${value.name} }}`;
  return undefined;
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

function renderGitHubJobCondition(job: NormalizedJob, triggers: Record<TriggerId, TriggerDefinition>): string | undefined {
  const clauses = job.trigger.flatMap((triggerId) => {
    const trigger = triggers[triggerId];
    if (!trigger) return [];
    if (trigger.type === "manual") return ["github.event_name == 'workflow_dispatch'"];
    if (trigger.type === "schedule") {
      return trigger.cron
        ? [`github.event_name == 'schedule' && github.event.schedule == '${escapeExpressionString(trigger.cron)}'`]
        : ["github.event_name == 'schedule'"];
    }
    if (trigger.type === "github") {
      return (trigger.events ?? []).map((event) => {
        const filters: string[] = [`github.event_name == '${escapeExpressionString(event)}'`];
        if (trigger.branches?.length) {
          filters.push(`(${trigger.branches.map((branch) => `github.ref == 'refs/heads/${escapeExpressionString(branch)}'`).join(" || ")})`);
        }
        if (trigger.tags?.length) {
          filters.push(`(${trigger.tags.map((tag) => `github.ref == 'refs/tags/${escapeExpressionString(tag)}'`).join(" || ")})`);
        }
        return filters.join(" && ");
      });
    }
    return [];
  });
  if (clauses.length === 0) return undefined;
  return clauses.length === 1 ? clauses[0] : clauses.map((clause) => `(${clause})`).join(" || ");
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

function yamlKey(value: string): string {
  return /^[A-Za-z_][A-Za-z0-9_-]*$/.test(value) ? value : JSON.stringify(value);
}

function shellWord(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : JSON.stringify(value);
}

function escapeExpressionString(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("'", "\\'");
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
