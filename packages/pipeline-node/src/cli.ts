#!/usr/bin/env node
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { buildGraph, composePipelines, tasksForJob } from "@async/pipeline-core";
import { runDoctor } from "./doctor.js";
import { checkGitHubWorkflow, jobsForGitHubEvent, readGitHubEventContext, renderGitHubWorkflow, writeGitHubWorkflow } from "./github.js";
import { loadPipeline } from "./loader.js";
import { runJob, runSingleTask } from "./runner.js";
import { createStore } from "./store.js";
import { matrixForJob, readPipelineMetadata, resolveSources, sourceContext } from "./sources.js";
import { checkTaskSync, describeTaskSync, renderTaskSync, writeTaskSync } from "./sync.js";

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  const program = programName();
  const cwd = process.cwd();
  const configPath = findPipelineConfig(cwd);

  if (command === "doctor") {
    const checks = await runDoctor();
    for (const check of checks) {
      console.log(`${check.status.toUpperCase()} ${check.name}: ${check.message}`);
    }
    process.exitCode = checks.some((check) => check.status === "fail") ? 1 : 0;
    return;
  }

  if (!command || command === "help" || command === "--help") {
    printHelp(program);
    return;
  }

  if (!configPath) {
    throw new Error(`No pipeline.ts, pipeline.mjs, or pipeline.js found in ${cwd}.`);
  }

  const pipeline = await loadPipeline(configPath);

  if (command === "sync") {
    await handleSyncCommand(args, { cwd, configPath, pipeline });
    return;
  }

  if (command === "github") {
    const subcommand = args[0] ?? "help";
    const paths = githubGenerationPaths(args.slice(1));
    const rendered = await renderGitHubWorkflow(pipeline, { cwd, configPath, ...paths });
    if (subcommand === "generate") {
      await writeGitHubWorkflow(rendered, cwd);
      console.log(`Generated ${rendered.workflowPath}`);
      console.log(`Generated ${rendered.lockPath}`);
      return;
    }
    if (subcommand === "check") {
      const issues = await checkGitHubWorkflow(rendered, cwd);
      if (issues.length > 0) {
        for (const issue of issues) console.error(issue);
        process.exitCode = 1;
        return;
      }
      console.log("GitHub workflow is current.");
      return;
    }
    if (subcommand === "run") {
      const context = await readGitHubEventContext(process.env);
      const jobs = jobsForGitHubEvent(pipeline, context);
      if (jobs.length === 0) {
        console.log(`No pipeline jobs matched GitHub event "${context.eventName}".`);
        return;
      }
      let failed = false;
      for (const selectedJob of jobs) {
        const graph = tasksForJob(pipeline, selectedJob.id);
        console.log(`Running ${pipeline.name}:${selectedJob.id} (${graph.executionOrder.join(" -> ")})`);
        const result = await runJob(pipeline, { cwd, jobId: selectedJob.id, mode: "ci" });
        console.log(`Pipeline ${result.status}: ${result.id}`);
        if (result.status !== "passed") failed = true;
      }
      process.exitCode = failed ? 1 : 0;
      return;
    }
    throw new Error(`Unknown github command "${subcommand}".`);
  }

  if (command === "list") {
    console.log("Jobs:");
    for (const jobId of Object.keys(pipeline.jobs).sort()) {
      console.log(`  ${jobId}`);
    }
    console.log("Tasks:");
    for (const taskId of Object.keys(pipeline.tasks).sort()) {
      console.log(`  ${taskId}`);
    }
    if (Object.keys(pipeline.sources).length > 0) {
      console.log("Sources:");
      for (const sourceId of Object.keys(pipeline.sources).sort()) {
        console.log(`  ${sourceId}`);
      }
    }
    return;
  }

  if (command === "graph") {
    const formatIndex = args.indexOf("--format");
    const format = formatIndex >= 0 ? args[formatIndex + 1] : "json";
    const store = virtualStore(cwd);
    const graphPipeline = await loadAvailableSourceGraph(pipeline, cwd, store);
    const graph = buildGraph(graphPipeline);
    if (format === "json") {
      console.log(JSON.stringify(graph, null, 2));
      return;
    }
    if (format === "dot") {
      console.log("digraph pipeline {");
      for (const task of graph.tasks) {
        if (task.dependsOn.length === 0) console.log(`  "${task.id}";`);
        for (const dependency of task.dependsOn) {
          console.log(`  "${dependency}" -> "${task.id}";`);
        }
      }
      console.log("}");
      return;
    }
    throw new Error(`Unsupported graph format "${format}".`);
  }

  if (command === "explain") {
    const taskId = args[0];
    if (!taskId) throw new Error(`Usage: ${program} explain <task>`);
    const store = virtualStore(cwd);
    const explainPipeline = await loadAvailableSourceGraph(pipeline, cwd, store);
    const task = explainPipeline.tasks[taskId];
    if (!task) throw new Error(`Unknown task "${taskId}".`);
    console.log(JSON.stringify(task, jsonReplacer, 2));
    return;
  }

  if (command === "sources") {
    const subcommand = args[0] ?? "list";
    if (subcommand === "list") {
      const store = virtualStore(cwd);
      const sources = await resolveSources(pipeline, cwd, store, { sync: false, loadPipelines: false });
      for (const source of Object.values(sources)) {
        const detail = source.definition.type === "git"
          ? `${source.definition.url}#${source.definition.ref}`
          : source.definition.path;
        console.log(`${source.id}\t${source.definition.type}\t${detail}\t${source.dir}`);
      }
      return;
    }
    if (subcommand === "sync") {
      const store = await createStore(cwd);
      const sources = await resolveSources(pipeline, cwd, store, { sync: true, loadPipelines: true });
      for (const source of Object.values(sources)) {
        console.log(`${source.id}\t${source.record.commit ?? "unknown"}\t${source.dir}`);
      }
      return;
    }
    throw new Error(`Unknown sources command "${subcommand}".`);
  }

  if (command === "metadata") {
    const formatIndex = args.indexOf("--format");
    const format = formatIndex >= 0 ? args[formatIndex + 1] : "json";
    if (format !== "json") throw new Error(`Unsupported metadata format "${format}".`);
    const includeSources = args.includes("--include-sources");
    const store = virtualStore(cwd);
    const metadata = await readPipelineMetadata(configPath, { cwd, includeSources, store });
    console.log(JSON.stringify(metadata, jsonReplacer, 2));
    return;
  }

  if (command === "matrix") {
    const jobId = args[0];
    if (!jobId) throw new Error(`Usage: ${program} matrix <job> --format github`);
    const formatIndex = args.indexOf("--format");
    const format = formatIndex >= 0 ? args[formatIndex + 1] : "github";
    if (format !== "github") throw new Error(`Unsupported matrix format "${format}".`);
    console.log(JSON.stringify(matrixForJob(pipeline, jobId)));
    return;
  }

  if (command === "run") {
    const jobId = args[0];
    if (!jobId) throw new Error(`Usage: ${program} run <job>`);
    const graph = tasksForJob(pipeline, jobId);
    console.log(`Running ${pipeline.name}:${jobId} (${graph.executionOrder.join(" -> ")})`);
    const result = await runJob(pipeline, { cwd, jobId, mode: process.env.CI ? "ci" : "manual" });
    console.log(`Pipeline ${result.status}: ${result.id}`);
    process.exitCode = result.status === "passed" ? 0 : 1;
    return;
  }

  if (command === "run-task") {
    const taskId = args[0];
    if (!taskId) throw new Error(`Usage: ${program} run-task <task>`);
    const result = await runSingleTask(pipeline, taskId, { cwd, mode: process.env.CI ? "ci" : "manual" });
    console.log(`Task run ${result.status}: ${result.id}`);
    process.exitCode = result.status === "passed" ? 0 : 1;
    return;
  }

  throw new Error(`Unknown command "${command}".`);
}

function printHelp(program: string): void {
  console.log(`Usage:
  ${program} run <job>
  ${program} run-task <task>
  ${program} list
  ${program} graph --format json|dot
  ${program} explain <task>
  ${program} sources list
  ${program} sources sync
  ${program} metadata --format json [--include-sources]
  ${program} matrix <job> --format github
  ${program} sync list
  ${program} sync generate
  ${program} sync check
  ${program} sync github list
  ${program} sync github generate [--workflow <path>] [--lock <path>]
  ${program} sync github check [--workflow <path>] [--lock <path>]
  ${program} sync tasks list
  ${program} sync tasks generate
  ${program} sync tasks check
  ${program} github generate [--workflow <path>] [--lock <path>]
  ${program} github check [--workflow <path>] [--lock <path>]
  ${program} github run
  ${program} doctor`);
}

async function handleSyncCommand(
  args: string[],
  context: { cwd: string; configPath: string; pipeline: Awaited<ReturnType<typeof loadPipeline>> }
): Promise<void> {
  const targetNames = new Set(["github", "tasks"]);
  const maybeTarget = args[0];
  const target = targetNames.has(maybeTarget ?? "") ? maybeTarget : undefined;
  const subcommand = target ? args[1] ?? "list" : args[0] ?? "list";
  const rest = target ? args.slice(2) : args.slice(1);

  if (target === "github") {
    await handleSyncGitHubCommand(subcommand, rest, context, { requireConfigured: true });
    return;
  }
  if (target === "tasks") {
    await handleSyncTasksCommand(subcommand, context, { requireConfigured: true });
    return;
  }

  if (subcommand === "list") {
    let listed = false;
    if (context.pipeline.sync.github.enabled) {
      console.log(`GitHub workflow: ${context.pipeline.sync.github.workflow}`);
      console.log(`GitHub lock: ${context.pipeline.sync.github.lock}`);
      listed = true;
    }
    if (context.pipeline.sync.tasks.enabled) {
      for (const line of describeTaskSync(await renderTaskSync(context.pipeline, context))) console.log(line);
      listed = true;
    }
    if (!listed) console.log("No sync targets configured.");
    return;
  }

  if (subcommand === "generate") {
    let generated = false;
    if (context.pipeline.sync.github.enabled) {
      await handleSyncGitHubCommand("generate", rest, context, { requireConfigured: false });
      generated = true;
    }
    if (context.pipeline.sync.tasks.enabled) {
      await handleSyncTasksCommand("generate", context, { requireConfigured: false });
      generated = true;
    }
    if (!generated) throw new Error("No sync targets configured.");
    return;
  }

  if (subcommand === "check") {
    const issues: string[] = [];
    let checked = false;
    if (context.pipeline.sync.github.enabled) {
      const paths = githubGenerationPaths(rest);
      const rendered = await renderGitHubWorkflow(context.pipeline, { ...context, ...paths });
      issues.push(...await checkGitHubWorkflow(rendered, context.cwd));
      checked = true;
    }
    if (context.pipeline.sync.tasks.enabled) {
      const rendered = await renderTaskSync(context.pipeline, context);
      issues.push(...await checkTaskSync(rendered, context.cwd));
      checked = true;
    }
    if (!checked) throw new Error("No sync targets configured.");
    if (issues.length > 0) {
      for (const issue of issues) console.error(issue);
      process.exitCode = 1;
      return;
    }
    console.log("Sync targets are current.");
    return;
  }

  throw new Error(`Unknown sync command "${subcommand}".`);
}

async function handleSyncGitHubCommand(
  subcommand: string,
  args: string[],
  context: { cwd: string; configPath: string; pipeline: Awaited<ReturnType<typeof loadPipeline>> },
  options: { requireConfigured: boolean }
): Promise<void> {
  if (options.requireConfigured && !context.pipeline.sync.github.enabled) {
    throw new Error("GitHub sync is not configured. Add sync.github to pipeline.ts.");
  }
  const paths = githubGenerationPaths(args);
  const rendered = await renderGitHubWorkflow(context.pipeline, { ...context, ...paths });
  if (subcommand === "list") {
    console.log(`GitHub workflow: ${rendered.workflowPath}`);
    console.log(`GitHub lock: ${rendered.lockPath}`);
    return;
  }
  if (subcommand === "generate") {
    await writeGitHubWorkflow(rendered, context.cwd);
    console.log(`Generated ${rendered.workflowPath}`);
    console.log(`Generated ${rendered.lockPath}`);
    return;
  }
  if (subcommand === "check") {
    const issues = await checkGitHubWorkflow(rendered, context.cwd);
    if (issues.length > 0) {
      for (const issue of issues) console.error(issue);
      process.exitCode = 1;
      return;
    }
    console.log("GitHub workflow is current.");
    return;
  }
  throw new Error(`Unknown sync github command "${subcommand}".`);
}

async function handleSyncTasksCommand(
  subcommand: string,
  context: { cwd: string; configPath: string; pipeline: Awaited<ReturnType<typeof loadPipeline>> },
  options: { requireConfigured: boolean }
): Promise<void> {
  const rendered = await renderTaskSync(context.pipeline, context);
  if (subcommand === "list") {
    for (const line of describeTaskSync(rendered)) console.log(line);
    if (options.requireConfigured && !rendered.enabled) process.exitCode = 1;
    return;
  }
  if (subcommand === "generate") {
    if (options.requireConfigured && !rendered.enabled) throw new Error("Task sync is not configured. Add sync.tasks to pipeline.ts.");
    await writeTaskSync(rendered, context.cwd);
    for (const manifest of rendered.manifests) console.log(`Generated ${manifest.path}`);
    console.log(`Generated ${rendered.lockPath}`);
    return;
  }
  if (subcommand === "check") {
    const issues = await checkTaskSync(rendered, context.cwd, { requireConfigured: options.requireConfigured });
    if (issues.length > 0) {
      for (const issue of issues) console.error(issue);
      process.exitCode = 1;
      return;
    }
    console.log("Task sync is current.");
    return;
  }
  throw new Error(`Unknown sync tasks command "${subcommand}".`);
}

function findPipelineConfig(cwd: string): string | null {
  for (const fileName of ["pipeline.ts", "pipeline.mjs", "pipeline.js"]) {
    const configPath = resolve(cwd, fileName);
    if (existsSync(configPath)) return configPath;
  }
  return null;
}

function programName(): string {
  const name = basename(process.argv[1] ?? "async-pipeline");
  return name === "cli.js" ? "async-pipeline" : name;
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === "function") return "[function]";
  return value;
}

function githubGenerationPaths(args: string[]): { workflowPath?: string; lockPath?: string } {
  const workflowIndex = args.indexOf("--workflow");
  const lockIndex = args.indexOf("--lock");
  const workflowPath = workflowIndex >= 0 ? args[workflowIndex + 1] : undefined;
  const lockPath = lockIndex >= 0 ? args[lockIndex + 1] : undefined;
  if (workflowIndex >= 0 && !workflowPath) throw new Error("Usage: async-pipeline github <generate|check> --workflow <path>");
  if (lockIndex >= 0 && !lockPath) throw new Error("Usage: async-pipeline github <generate|check> --lock <path>");
  return { workflowPath, lockPath };
}

async function loadAvailableSourceGraph(pipeline: Awaited<ReturnType<typeof loadPipeline>>, cwd: string, store: Awaited<ReturnType<typeof createStore>>) {
  const sources = await resolveSources(pipeline, cwd, store, { sync: false, loadPipelines: true });
  const sourcePipelines: Parameters<typeof composePipelines>[1] = {};
  for (const [sourceId, resolved] of Object.entries(sources)) {
    if (!resolved.pipeline) continue;
    sourcePipelines[sourceId] = {
      pipeline: resolved.pipeline,
      context: sourceContext(resolved)
    };
  }
  return composePipelines(pipeline, sourcePipelines);
}

function virtualStore(root: string): Awaited<ReturnType<typeof createStore>> {
  return {
    root,
    asyncDir: resolve(root, ".async"),
    runsDir: resolve(root, ".async", "runs"),
    cacheDir: resolve(root, ".async", "cache", "tasks"),
    sourcesDir: resolve(root, ".async", "sources")
  };
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
