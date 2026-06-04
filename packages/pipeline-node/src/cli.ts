#!/usr/bin/env node
import { existsSync } from "node:fs";
import { basename, resolve } from "node:path";
import { buildGraph, tasksForJob } from "@async/pipeline-core";
import { runDoctor } from "./doctor.js";
import { loadPipeline } from "./loader.js";
import { runJob, runSingleTask } from "./runner.js";

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

  if (command === "list") {
    console.log("Jobs:");
    for (const jobId of Object.keys(pipeline.jobs).sort()) {
      console.log(`  ${jobId}`);
    }
    console.log("Tasks:");
    for (const taskId of Object.keys(pipeline.tasks).sort()) {
      console.log(`  ${taskId}`);
    }
    return;
  }

  if (command === "graph") {
    const formatIndex = args.indexOf("--format");
    const format = formatIndex >= 0 ? args[formatIndex + 1] : "json";
    const graph = buildGraph(pipeline);
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
    const task = pipeline.tasks[taskId];
    if (!task) throw new Error(`Unknown task "${taskId}".`);
    console.log(JSON.stringify(task, jsonReplacer, 2));
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
  ${program} doctor`);
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
  return typeof value === "function" ? "[function]" : value;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
