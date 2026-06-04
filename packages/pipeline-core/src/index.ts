export type TaskId = string;
export type JobId = string;
export type TriggerId = string;
export type EnvironmentBackend = "host" | "lima";
export type ExecutionMode = "manual" | "ci";
export type CacheSharing = "shared" | "private" | "locked";
export type TaskStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "cached";

export interface ShellCommand {
  kind: "shell";
  command: string;
}

export type TaskRunFunction = (context: TaskContext) => void | Promise<void>;
export type TaskStep = ShellCommand | TaskRunFunction;

export interface TaskContext {
  taskId: TaskId;
  runId: string;
  cwd: string;
  env: Record<string, string | undefined>;
  meta(metadata: Record<string, string | number | boolean | null>): void;
  log(message: string): void;
  sh(strings: TemplateStringsArray, ...values: unknown[]): ShellCommand;
}

export interface RetryPolicy {
  attempts: number;
  delayMs?: number;
}

export interface CacheDirectory {
  path: string;
  sharing?: CacheSharing;
}

export interface TaskCacheOptions {
  enabled?: boolean;
  directories?: CacheDirectory[];
}

export interface TaskRequirements {
  tools?: string[];
  secrets?: string[];
  runtime?: "node" | "deno" | "shell";
}

export interface PipelineEnvironment {
  backend: EnvironmentBackend;
  vm?: string;
  image?: string;
}

export interface TriggerDefinition {
  type: "manual" | "github" | "schedule";
  events?: string[];
  cron?: string;
}

export interface TaskDefinition {
  description?: string;
  dependsOn?: TaskId[];
  inputs?: string[];
  outputs?: string[];
  cache?: boolean | TaskCacheOptions;
  retry?: number | RetryPolicy;
  timeout?: string | number;
  requires?: TaskRequirements;
  environment?: PipelineEnvironment;
  run?: TaskStep;
  steps?: TaskStep[];
  continuous?: boolean;
  with?: TaskId[];
}

export interface NormalizedTask extends Omit<TaskDefinition, "dependsOn" | "steps" | "run"> {
  id: TaskId;
  dependsOn: TaskId[];
  steps: TaskStep[];
  cache: TaskCacheOptions;
  retry: RetryPolicy;
  timeoutMs?: number;
  inputs: string[];
  outputs: string[];
}

export interface JobDefinition {
  description?: string;
  target: TaskId | TaskId[];
  trigger?: TriggerId[];
  mode?: ExecutionMode;
}

export interface NormalizedJob extends Omit<JobDefinition, "target" | "trigger"> {
  id: JobId;
  target: TaskId[];
  trigger: TriggerId[];
}

export interface PipelineDefinition {
  name: string;
  namedInputs?: Record<string, string[]>;
  taskDefaults?: Record<string, Partial<TaskDefinition>>;
  triggers?: Record<TriggerId, TriggerDefinition>;
  tasks: Record<TaskId, TaskDefinition>;
  jobs: Record<JobId, JobDefinition>;
}

export interface NormalizedPipeline {
  name: string;
  namedInputs: Record<string, string[]>;
  triggers: Record<TriggerId, TriggerDefinition>;
  tasks: Record<TaskId, NormalizedTask>;
  jobs: Record<JobId, NormalizedJob>;
}

export interface TaskResult {
  id: TaskId;
  status: TaskStatus;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  attempts: number;
  cacheKey?: string;
  cacheHit?: boolean;
  error?: string;
  metadata?: Record<string, string | number | boolean | null>;
}

export interface ExecutionRecord {
  id: string;
  pipelineName: string;
  jobId: JobId;
  cwd: string;
  startedAt: string;
  finishedAt?: string;
  status: "running" | "passed" | "failed";
  mode: ExecutionMode;
  tasks: TaskResult[];
}

export interface TaskGraphNode {
  id: TaskId;
  dependsOn: TaskId[];
  dependents: TaskId[];
}

export interface PipelineGraph {
  tasks: TaskGraphNode[];
  executionOrder: TaskId[];
}

export function sh(strings: TemplateStringsArray, ...values: unknown[]): ShellCommand {
  let command = "";
  for (let index = 0; index < strings.length; index += 1) {
    command += strings[index] ?? "";
    if (index < values.length) {
      command += String(values[index]);
    }
  }
  return { kind: "shell", command };
}

export function task(definition: TaskDefinition): TaskDefinition {
  return definition;
}

export function job(definition: JobDefinition): JobDefinition {
  return definition;
}

export const trigger = {
  manual(): TriggerDefinition {
    return { type: "manual" };
  },
  github(options: { events: string[] }): TriggerDefinition {
    return { type: "github", events: [...options.events] };
  },
  schedule(cron: string): TriggerDefinition {
    return { type: "schedule", cron };
  }
};

export function linux(environment: Omit<PipelineEnvironment, "backend"> & { backend?: EnvironmentBackend } = {}): PipelineEnvironment {
  return { backend: environment.backend ?? "host", vm: environment.vm, image: environment.image };
}

export function definePipeline(definition: PipelineDefinition): NormalizedPipeline {
  return normalizePipeline(definition);
}

export function normalizePipeline(definition: PipelineDefinition): NormalizedPipeline {
  const namedInputs = definition.namedInputs ?? {};
  const tasks: Record<TaskId, NormalizedTask> = {};

  for (const [id, taskDefinition] of Object.entries(definition.tasks)) {
    const defaults = definition.taskDefaults?.[id] ?? definition.taskDefaults?.[taskName(id)] ?? {};
    const merged = { ...defaults, ...taskDefinition };
    const steps = merged.steps ? [...merged.steps] : merged.run ? [merged.run] : [];
    const cache = normalizeCache(merged.cache);
    const retry = normalizeRetry(merged.retry);
    const timeoutMs = normalizeTimeout(merged.timeout);

    tasks[id] = {
      ...merged,
      id,
      dependsOn: [...(merged.dependsOn ?? [])],
      inputs: [...(merged.inputs ?? [])],
      outputs: [...(merged.outputs ?? [])],
      steps,
      cache,
      retry,
      timeoutMs
    };
  }

  const jobs: Record<JobId, NormalizedJob> = {};
  for (const [id, jobDefinition] of Object.entries(definition.jobs)) {
    jobs[id] = {
      ...jobDefinition,
      id,
      target: Array.isArray(jobDefinition.target) ? [...jobDefinition.target] : [jobDefinition.target],
      trigger: [...(jobDefinition.trigger ?? [])]
    };
  }

  const pipeline: NormalizedPipeline = {
    name: definition.name,
    namedInputs,
    triggers: definition.triggers ?? {},
    tasks,
    jobs
  };

  validatePipeline(pipeline);
  return pipeline;
}

export function validatePipeline(pipeline: NormalizedPipeline): void {
  for (const taskDefinition of Object.values(pipeline.tasks)) {
    for (const dependency of taskDefinition.dependsOn) {
      if (!pipeline.tasks[dependency]) {
        throw new Error(`Task "${taskDefinition.id}" depends on missing task "${dependency}".`);
      }
    }
    for (const companion of taskDefinition.with ?? []) {
      if (!pipeline.tasks[companion]) {
        throw new Error(`Task "${taskDefinition.id}" references missing companion task "${companion}".`);
      }
    }
  }

  for (const jobDefinition of Object.values(pipeline.jobs)) {
    for (const target of jobDefinition.target) {
      if (!pipeline.tasks[target]) {
        throw new Error(`Job "${jobDefinition.id}" targets missing task "${target}".`);
      }
    }
    for (const triggerId of jobDefinition.trigger) {
      if (!pipeline.triggers[triggerId]) {
        throw new Error(`Job "${jobDefinition.id}" references missing trigger "${triggerId}".`);
      }
    }
  }

  buildGraph(pipeline);
}

export function buildGraph(pipeline: NormalizedPipeline, targets?: TaskId[]): PipelineGraph {
  const selected = collectRequiredTasks(pipeline, targets ?? Object.keys(pipeline.tasks));
  const nodes = new Map<TaskId, TaskGraphNode>();

  for (const id of selected) {
    const definition = pipeline.tasks[id];
    if (!definition) {
      throw new Error(`Cannot build graph for missing task "${id}".`);
    }
    nodes.set(id, { id, dependsOn: definition.dependsOn.filter((dependency) => selected.has(dependency)), dependents: [] });
  }

  for (const node of nodes.values()) {
    for (const dependency of node.dependsOn) {
      nodes.get(dependency)?.dependents.push(node.id);
    }
  }

  const visiting = new Set<TaskId>();
  const visited = new Set<TaskId>();
  const order: TaskId[] = [];

  const visit = (id: TaskId, path: TaskId[]): void => {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      const cycle = [...path.slice(start), id].join(" -> ");
      throw new Error(`Task dependency cycle detected: ${cycle}.`);
    }
    visiting.add(id);
    const node = nodes.get(id);
    if (!node) return;
    for (const dependency of [...node.dependsOn].sort()) {
      visit(dependency, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };

  for (const id of [...nodes.keys()].sort()) {
    visit(id, []);
  }

  return {
    tasks: [...nodes.values()].map((node) => ({
      id: node.id,
      dependsOn: [...node.dependsOn].sort(),
      dependents: [...node.dependents].sort()
    })).sort((left: TaskGraphNode, right: TaskGraphNode) => left.id.localeCompare(right.id)),
    executionOrder: order
  };
}

export function tasksForJob(pipeline: NormalizedPipeline, jobId: JobId): PipelineGraph {
  const selectedJob = pipeline.jobs[jobId];
  if (!selectedJob) {
    throw new Error(`Unknown job "${jobId}".`);
  }
  return buildGraph(pipeline, selectedJob.target);
}

export function expandInputs(pipeline: NormalizedPipeline, inputs: string[]): string[] {
  const expanded: string[] = [];
  for (const input of inputs) {
    if (pipeline.namedInputs[input]) {
      expanded.push(...expandInputs(pipeline, pipeline.namedInputs[input]));
    } else {
      expanded.push(input);
    }
  }
  return expanded;
}

function collectRequiredTasks(pipeline: NormalizedPipeline, targets: TaskId[]): Set<TaskId> {
  const selected = new Set<TaskId>();
  const visit = (id: TaskId): void => {
    if (selected.has(id)) return;
    const definition = pipeline.tasks[id];
    if (!definition) {
      throw new Error(`Missing task "${id}".`);
    }
    selected.add(id);
    for (const dependency of definition.dependsOn) {
      visit(dependency);
    }
  };

  for (const target of targets) {
    visit(target);
  }
  return selected;
}

function normalizeCache(cache: TaskDefinition["cache"]): TaskCacheOptions {
  if (cache === true) return { enabled: true, directories: [] };
  if (cache === false || cache === undefined) return { enabled: false, directories: [] };
  return { enabled: cache.enabled ?? true, directories: [...(cache.directories ?? [])] };
}

function normalizeRetry(retry: TaskDefinition["retry"]): RetryPolicy {
  if (retry === undefined) return { attempts: 1 };
  if (typeof retry === "number") return { attempts: retry };
  return { attempts: retry.attempts, delayMs: retry.delayMs };
}

function normalizeTimeout(timeout: TaskDefinition["timeout"]): number | undefined {
  if (timeout === undefined) return undefined;
  if (typeof timeout === "number") return timeout;

  const trimmed = timeout.trim();
  const match = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid timeout "${timeout}". Use milliseconds or a duration like 500ms, 30s, 5m, or 1h.`);
  }

  const value = Number(match[1]);
  const unit = match[2] ?? "ms";
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid timeout "${timeout}". Timeout must be a positive duration.`);
  }

  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  return Math.round(value * multiplier);
}

function taskName(id: string): string {
  const delimiterIndex = id.lastIndexOf(":");
  return delimiterIndex >= 0 ? id.slice(delimiterIndex + 1) : id;
}
