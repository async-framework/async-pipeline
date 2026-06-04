import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ExecutionRecord, NormalizedPipeline, NormalizedTask, ShellCommand, TaskContext, TaskResult, TaskRunFunction } from "@async/pipeline-core";
import { sh, tasksForJob } from "@async/pipeline-core";
import { computeTaskCacheKey, createStore, readCacheEntry, writeCacheEntry, writeExecution, writeTaskLog, type PipelineStore } from "./store.js";

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export interface RunnerAdapter {
  name: string;
  runShell(command: string, options: { cwd: string; env: NodeJS.ProcessEnv; task: NormalizedTask; timeoutMs?: number }): Promise<CommandResult>;
  checkTool?(tool: string): Promise<boolean>;
}

export class HostRunnerAdapter implements RunnerAdapter {
  name = "host";

  runShell(command: string, options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<CommandResult> {
    return runProcess(command, { cwd: options.cwd, env: options.env, timeoutMs: options.timeoutMs });
  }

  async checkTool(tool: string): Promise<boolean> {
    const result = await runProcess(`command -v ${shellEscape(tool)}`, { cwd: process.cwd(), env: process.env, echo: false });
    return result.code === 0;
  }
}

export interface RunOptions {
  cwd: string;
  jobId: string;
  mode?: "manual" | "ci";
  adapter?: RunnerAdapter;
}

export async function runJob(pipeline: NormalizedPipeline, options: RunOptions): Promise<ExecutionRecord> {
  const adapter = options.adapter ?? new HostRunnerAdapter();
  const store = await createStore(options.cwd);
  const graph = tasksForJob(pipeline, options.jobId);
  const record: ExecutionRecord = {
    id: `${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    pipelineName: pipeline.name,
    jobId: options.jobId,
    cwd: options.cwd,
    startedAt: new Date().toISOString(),
    status: "running",
    mode: options.mode ?? "manual",
    tasks: []
  };

  await writeExecution(store, record);

  for (const taskId of graph.executionOrder) {
    const taskDefinition = pipeline.tasks[taskId];
    if (!taskDefinition) continue;
    const result = await runTask(pipeline, taskDefinition, { adapter, cwd: options.cwd, runId: record.id, store });
    record.tasks.push(result);
    await writeExecution(store, record);
    if (result.status === "failed") {
      record.status = "failed";
      record.finishedAt = new Date().toISOString();
      await writeExecution(store, record);
      return record;
    }
  }

  record.status = "passed";
  record.finishedAt = new Date().toISOString();
  await writeExecution(store, record);
  return record;
}

export async function runSingleTask(pipeline: NormalizedPipeline, taskId: string, options: Omit<RunOptions, "jobId">): Promise<ExecutionRecord> {
  const syntheticJobId = `task:${taskId}`;
  const syntheticPipeline: NormalizedPipeline = {
    ...pipeline,
    jobs: {
      ...pipeline.jobs,
      [syntheticJobId]: { id: syntheticJobId, target: [taskId], trigger: [], mode: options.mode }
    }
  };
  return runJob(syntheticPipeline, { ...options, jobId: syntheticJobId });
}

async function runTask(
  pipeline: NormalizedPipeline,
  taskDefinition: NormalizedTask,
  options: { adapter: RunnerAdapter; cwd: string; runId: string; store: PipelineStore }
): Promise<TaskResult> {
  const started = Date.now();
  const startedAt = new Date().toISOString();
  const cacheKey = await computeTaskCacheKey(pipeline, taskDefinition, options.cwd);

  if (taskDefinition.cache.enabled) {
    const cached = await readCacheEntry(options.store, cacheKey);
    if (cached?.status === "passed") {
      const result: TaskResult = {
        ...cached,
        id: taskDefinition.id,
        status: "cached",
        startedAt,
        finishedAt: new Date().toISOString(),
        attempts: 0,
        cacheKey,
        cacheHit: true,
        durationMs: Date.now() - started
      };
      await writeTaskLog(options.store, options.runId, taskDefinition.id, `[cache hit] ${cacheKey}\n`);
      return result;
    }
  }

  const metadata: Record<string, string | number | boolean | null> = {};
  let combinedLog = "";
  let attempts = 0;
  let lastError = "";

  const maxAttempts = Math.max(1, taskDefinition.retry.attempts);
  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      for (const requirement of taskDefinition.requires?.tools ?? []) {
        const ok = await options.adapter.checkTool?.(requirement);
        if (ok === false) {
          throw new Error(`Required tool "${requirement}" is not available for task "${taskDefinition.id}".`);
        }
      }

      const context = {
        taskId: taskDefinition.id,
        runId: options.runId,
        cwd: options.cwd,
        env: process.env,
        meta(values: Record<string, string | number | boolean | null>) {
          Object.assign(metadata, values);
        },
        log(message: string) {
          combinedLog += `${message}\n`;
        },
        sh
      };

      for (const step of taskDefinition.steps) {
        if (typeof step === "function") {
          await runFunctionStep(step, context, taskDefinition.timeoutMs);
          continue;
        }
        const result = await runShellStep(step, taskDefinition, options);
        combinedLog += result.stdout;
        combinedLog += result.stderr;
        if (result.timedOut) {
          throw new Error(`Task "${taskDefinition.id}" timed out after ${taskDefinition.timeoutMs}ms.`);
        }
        if (result.code !== 0) {
          throw new Error(`Command failed with exit code ${result.code}: ${step.command}`);
        }
      }

      const finishedAt = new Date().toISOString();
      const result: TaskResult = {
        id: taskDefinition.id,
        status: "passed",
        startedAt,
        finishedAt,
        durationMs: Date.now() - started,
        attempts,
        cacheKey,
        cacheHit: false,
        metadata
      };
      await writeTaskLog(options.store, options.runId, taskDefinition.id, combinedLog);
      if (taskDefinition.cache.enabled) {
        await writeCacheEntry(options.store, cacheKey, result);
      }
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      combinedLog += `[attempt ${attempts}] ${lastError}\n`;
      if (attempts < maxAttempts && taskDefinition.retry.delayMs) {
        await delay(taskDefinition.retry.delayMs);
      }
    }
  }

  const result: TaskResult = {
    id: taskDefinition.id,
    status: "failed",
    startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    attempts,
    cacheKey,
    cacheHit: false,
    error: lastError,
    metadata
  };
  await writeTaskLog(options.store, options.runId, taskDefinition.id, combinedLog);
  return result;
}

async function runShellStep(
  step: ShellCommand,
  taskDefinition: NormalizedTask,
  options: { adapter: RunnerAdapter; cwd: string }
): Promise<CommandResult> {
  return options.adapter.runShell(step.command, { cwd: options.cwd, env: process.env, task: taskDefinition, timeoutMs: taskDefinition.timeoutMs });
}

async function runFunctionStep(step: TaskRunFunction, context: TaskContext, timeoutMs?: number): Promise<void> {
  if (!timeoutMs) {
    await step(context);
    return;
  }

  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      Promise.resolve(step(context)),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Task "${context.taskId}" timed out after ${timeoutMs}ms.`)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function runProcess(command: string, options: { cwd: string; env: NodeJS.ProcessEnv; echo?: boolean; timeoutMs?: number }): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      cwd: options.cwd,
      env: options.env,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forceKillTimeout: NodeJS.Timeout | undefined;

    if (options.timeoutMs) {
      timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKillTimeout = setTimeout(() => child.kill("SIGKILL"), 500);
      }, options.timeoutMs);
    }

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (options.echo !== false) process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (options.echo !== false) process.stderr.write(chunk);
    });
    child.on("close", (code) => {
      if (timeout) clearTimeout(timeout);
      if (forceKillTimeout) clearTimeout(forceKillTimeout);
      if (timedOut) {
        const timeoutMessage = `[timeout] Command timed out after ${options.timeoutMs}ms.\n`;
        resolve({ code: 124, stdout, stderr: `${stderr}${timeoutMessage}`, timedOut: true });
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
