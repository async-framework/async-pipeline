export type TaskId = string;
export type JobId = string;
export type TriggerId = string;
export type SourceId = string;
export type SourceType = "git" | "path";
export type EnvironmentBackend = "host" | "lima";
export type ExecutionMode = "manual" | "ci";
export type CacheSharing = "shared" | "private" | "locked";
export type TaskStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "cached";

export interface ShellCommand {
  kind: "shell";
  command: string;
}

export type DeferredShellCommandFactory = (context: TaskContext) => ShellCommand | Promise<ShellCommand>;

export interface DeferredShellCommand {
  kind: "deferred-shell";
  command: DeferredShellCommandFactory;
}

export type TaskRunFunction = (context: TaskContext) => void | Promise<void>;
export type TaskStep = ShellCommand | DeferredShellCommand | TaskRunFunction;

export interface CandidateContext {
  dir: string;
  fingerprint: string;
  commit?: string;
  ref?: string;
  dirty?: boolean;
}

export interface TaskSourceContext {
  name: SourceId;
  dir: string;
  type: SourceType;
  ref?: string;
  commit?: string;
}

export interface TaskContext {
  taskId: TaskId;
  runId: string;
  cwd: string;
  env: Record<string, string | undefined>;
  root: {
    dir: string;
  };
  candidate: CandidateContext;
  source?: TaskSourceContext;
  meta(metadata: Record<string, string | number | boolean | null>): void;
  log(message: string): void;
  sh: typeof sh;
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
  source?: TaskSourceContext;
}

export interface SourceBaseDefinition {
  pipeline?: string;
  prepare?: TaskStep[];
}

export interface GitSourceDefinition extends SourceBaseDefinition {
  type: "git";
  url: string;
  ref: string;
}

export interface PathSourceDefinition extends SourceBaseDefinition {
  type: "path";
  path: string;
  writable?: boolean;
}

export type SourceDefinition = GitSourceDefinition | PathSourceDefinition;

export type NormalizedSource =
  | (Omit<GitSourceDefinition, "prepare" | "pipeline"> & {
    id: SourceId;
    pipeline: string;
    prepare: TaskStep[];
  })
  | (Omit<PathSourceDefinition, "prepare" | "pipeline"> & {
    id: SourceId;
    pipeline: string;
    prepare: TaskStep[];
  });

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
  sources?: Record<SourceId, SourceDefinition>;
  tasks: Record<TaskId, TaskDefinition>;
  jobs: Record<JobId, JobDefinition>;
}

export interface NormalizedPipeline {
  name: string;
  namedInputs: Record<string, string[]>;
  triggers: Record<TriggerId, TriggerDefinition>;
  sources: Record<SourceId, NormalizedSource>;
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
  sources?: Record<SourceId, ExecutionSourceRecord>;
}

export interface ExecutionSourceRecord {
  id: SourceId;
  type: SourceType;
  dir: string;
  pipeline: string;
  url?: string;
  path?: string;
  ref?: string;
  commit?: string;
  dirty?: boolean;
  prepare?: string[];
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

export interface ParsedTaskRef {
  source?: SourceId;
  taskId: TaskId;
}

export interface ComposeSourcePipeline {
  pipeline: NormalizedPipeline;
  context?: TaskSourceContext;
}

export function sh(factory: DeferredShellCommandFactory): DeferredShellCommand;
export function sh(strings: TemplateStringsArray, ...values: unknown[]): ShellCommand;
export function sh(first: TemplateStringsArray | DeferredShellCommandFactory, ...values: unknown[]): ShellCommand | DeferredShellCommand {
  if (typeof first === "function") {
    return { kind: "deferred-shell", command: first };
  }

  let command = "";
  for (let index = 0; index < first.length; index += 1) {
    command += first[index] ?? "";
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

export const source = {
  git(definition: Omit<GitSourceDefinition, "type">): GitSourceDefinition {
    return { ...definition, type: "git" };
  },
  path(definition: Omit<PathSourceDefinition, "type">): PathSourceDefinition {
    return { ...definition, type: "path" };
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
  const sources: Record<SourceId, NormalizedSource> = {};

  for (const [id, sourceDefinition] of Object.entries(definition.sources ?? {})) {
    validateSourceId(id);
    sources[id] = normalizeSource(id, sourceDefinition);
  }

  const tasks: Record<TaskId, NormalizedTask> = {};

  for (const [id, taskDefinition] of Object.entries(definition.tasks)) {
    validateLocalTaskId(id);
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
    sources,
    tasks,
    jobs
  };

  validatePipeline(pipeline);
  return pipeline;
}

export function validatePipeline(pipeline: NormalizedPipeline): void {
  for (const taskDefinition of Object.values(pipeline.tasks)) {
    for (const dependency of taskDefinition.dependsOn) {
      if (!pipeline.tasks[dependency] && !isKnownExternalTaskRef(pipeline, dependency)) {
        throw new Error(`Task "${taskDefinition.id}" depends on missing task "${dependency}".`);
      }
    }
    for (const companion of taskDefinition.with ?? []) {
      if (!pipeline.tasks[companion] && !isKnownExternalTaskRef(pipeline, companion)) {
        throw new Error(`Task "${taskDefinition.id}" references missing companion task "${companion}".`);
      }
    }
  }

  for (const jobDefinition of Object.values(pipeline.jobs)) {
    for (const target of jobDefinition.target) {
      if (!pipeline.tasks[target] && !isKnownExternalTaskRef(pipeline, target)) {
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

export function composePipelines(
  root: NormalizedPipeline,
  sourcePipelines: Record<SourceId, ComposeSourcePipeline>
): NormalizedPipeline {
  const tasks: Record<TaskId, NormalizedTask> = { ...root.tasks };

  for (const [sourceId, input] of Object.entries(sourcePipelines)) {
    const sourceDefinition = root.sources[sourceId];
    if (!sourceDefinition) {
      throw new Error(`Cannot compose undeclared source "${sourceId}".`);
    }

    for (const taskDefinition of Object.values(input.pipeline.tasks)) {
      validateLocalTaskId(taskDefinition.id);
      const namespacedId = namespaceTaskRef(sourceId, taskDefinition.id);
      if (tasks[namespacedId]) {
        throw new Error(`Composed task "${namespacedId}" already exists.`);
      }

      tasks[namespacedId] = {
        ...taskDefinition,
        id: namespacedId,
        dependsOn: taskDefinition.dependsOn.map((dependency) => namespaceTaskRef(sourceId, dependency)),
        with: taskDefinition.with?.map((companion) => namespaceTaskRef(sourceId, companion)),
        steps: [...taskDefinition.steps],
        inputs: [...taskDefinition.inputs],
        outputs: [...taskDefinition.outputs],
        source: input.context ?? {
          name: sourceId,
          dir: "",
          type: sourceDefinition.type,
          ref: sourceDefinition.type === "git" ? sourceDefinition.ref : undefined
        }
      };
    }
  }

  const composed: NormalizedPipeline = {
    ...root,
    tasks,
    jobs: { ...root.jobs },
    sources: { ...root.sources }
  };

  validateComposedPipeline(composed, new Set(Object.keys(sourcePipelines)));
  return composed;
}

export function parseTaskRef(taskRef: TaskId): ParsedTaskRef {
  const delimiterIndex = taskRef.indexOf(":");
  if (delimiterIndex < 0) return { taskId: taskRef };
  return {
    source: taskRef.slice(0, delimiterIndex),
    taskId: taskRef.slice(delimiterIndex + 1)
  };
}

export function isNamespacedTaskRef(taskRef: TaskId): boolean {
  return parseTaskRef(taskRef).source !== undefined;
}

export function namespaceTaskRef(sourceId: SourceId, taskId: TaskId): TaskId {
  validateSourceId(sourceId);
  validateLocalTaskId(taskId);
  return `${sourceId}:${taskId}`;
}

export function buildGraph(pipeline: NormalizedPipeline, targets?: TaskId[]): PipelineGraph {
  const selected = collectRequiredTasks(pipeline, targets ?? Object.keys(pipeline.tasks));
  const nodes = new Map<TaskId, TaskGraphNode>();

  for (const id of selected) {
    const definition = pipeline.tasks[id];
    if (!definition && !isKnownExternalTaskRef(pipeline, id)) {
      throw new Error(`Cannot build graph for missing task "${id}".`);
    }
    nodes.set(id, { id, dependsOn: (definition?.dependsOn ?? []).filter((dependency) => selected.has(dependency)), dependents: [] });
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
      if (isKnownExternalTaskRef(pipeline, id)) {
        selected.add(id);
        return;
      }
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

function normalizeSource(id: SourceId, sourceDefinition: SourceDefinition): NormalizedSource {
  const prepare = [...(sourceDefinition.prepare ?? [])];
  const pipeline = sourceDefinition.pipeline ?? "pipeline.ts";
  if (sourceDefinition.type === "git") {
    return {
      ...sourceDefinition,
      id,
      pipeline,
      prepare
    };
  }
  return {
    ...sourceDefinition,
    id,
    pipeline,
    prepare
  };
}

function validateComposedPipeline(pipeline: NormalizedPipeline, loadedSources: Set<SourceId>): void {
  for (const taskDefinition of Object.values(pipeline.tasks)) {
    for (const dependency of taskDefinition.dependsOn) {
      if (!pipeline.tasks[dependency] && !isAllowedUnloadedTaskRef(pipeline, dependency, loadedSources)) {
        throw new Error(`Task "${taskDefinition.id}" depends on missing task "${dependency}".`);
      }
    }
  }
  for (const jobDefinition of Object.values(pipeline.jobs)) {
    for (const target of jobDefinition.target) {
      if (!pipeline.tasks[target] && !isAllowedUnloadedTaskRef(pipeline, target, loadedSources)) {
        throw new Error(`Job "${jobDefinition.id}" targets missing task "${target}".`);
      }
    }
  }
  buildGraph(pipeline);
}

function isAllowedUnloadedTaskRef(pipeline: NormalizedPipeline, taskRef: TaskId, loadedSources: Set<SourceId>): boolean {
  const parsed = parseTaskRef(taskRef);
  return parsed.source !== undefined && Boolean(pipeline.sources[parsed.source]) && !loadedSources.has(parsed.source);
}

function isKnownExternalTaskRef(pipeline: NormalizedPipeline, taskRef: TaskId): boolean {
  const parsed = parseTaskRef(taskRef);
  return parsed.source !== undefined && Boolean(pipeline.sources[parsed.source]);
}

function validateLocalTaskId(id: TaskId): void {
  if (id.includes(":")) {
    throw new Error(`Local task id "${id}" cannot contain ":". Use source namespaces through dependsOn instead.`);
  }
  if (!id.trim()) {
    throw new Error("Task id cannot be empty.");
  }
}

function validateSourceId(id: SourceId): void {
  if (id.includes(":")) {
    throw new Error(`Source id "${id}" cannot contain ":".`);
  }
  if (!id.trim()) {
    throw new Error("Source id cannot be empty.");
  }
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
