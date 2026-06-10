import {
  defaultRuntimeCache,
  isCacheDirective,
  parseCacheRef,
  type CacheDirective,
  type CacheRef,
  type CacheRegistryDefinition
} from "./cache.js";
import { pipelineError } from "./errors.js";

export { defineCache, fileCache, memoryCache } from "./cache.js";
export const cache = defaultRuntimeCache();

export type RuntimeStatus = "idle" | "running" | "passed" | "failed" | "started" | "stopped";
export type RuntimeNext = () => Promise<unknown>;

export interface RuntimeContext<Input = unknown> {
  input: Input;
  state: Record<string, unknown>;
  taskId: string;
  path: string[];
  signal?: AbortSignal;
  output?: unknown;
  cacheHit?: boolean;
}

export type RuntimeMiddleware<Input = unknown> = (context: RuntimeContext<Input>, next: RuntimeNext) => unknown | Promise<unknown>;
export type RuntimeRunItem<Input = unknown> = RuntimeMiddleware<Input> | CacheDirective;
export type RuntimeRunDefinition<Input = unknown> = RuntimeRunItem<Input> | readonly RuntimeRunItem<Input>[];

export interface RuntimeTaskConfig<Input = unknown> {
  id?: string;
  description?: string;
  dependsOn?: string[];
  cache?: false | CacheRef;
  run?: RuntimeRunDefinition<Input>;
}

export interface RuntimeTaskDefinition<Input = unknown> extends RuntimeTaskConfig<Input> {
  children: RuntimeTaskDefinition<Input>[];
}

export interface RuntimeDefinition<Input = unknown> {
  kind: "runtime-definition";
  tasks: RuntimeTaskDefinition<Input>[];
  cache: CacheRegistryDefinition;
}

export interface RuntimeTaskResult {
  id: string;
  status: "passed" | "failed" | "cached";
  cacheHit: boolean;
  error?: string;
}

export interface RuntimeExecution {
  status: "passed" | "failed";
  tasks: RuntimeTaskResult[];
  output?: unknown;
}

export interface Runtime<Input = unknown> {
  inspect(): RuntimeDefinition<Input>;
  run(input?: Input, options?: { task?: string; signal?: AbortSignal }): Promise<RuntimeExecution>;
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
}

export function task<Input = unknown>(config: RuntimeTaskConfig<Input>): RuntimeTaskDefinition<Input>;
export function task<Input = unknown>(config: RuntimeTaskConfig<Input>, runOrChildren: RuntimeRunDefinition<Input> | readonly RuntimeTaskDefinition<Input>[]): RuntimeTaskDefinition<Input>;
export function task<Input = unknown>(
  config: RuntimeTaskConfig<Input>,
  runOrChildren?: RuntimeRunDefinition<Input> | readonly RuntimeTaskDefinition<Input>[]
): RuntimeTaskDefinition<Input> {
  if (config.run !== undefined && runOrChildren !== undefined) {
    throw pipelineError("ASYNC_PIPELINE_TASK_ARGUMENT_CONFLICT", "Do not pass a second task argument when config.run is defined.");
  }

  if (isRuntimeTaskArray(runOrChildren)) {
    return { ...config, children: [...runOrChildren] };
  }

  return {
    ...config,
    run: runOrChildren === undefined ? config.run : runOrChildren as RuntimeRunDefinition<Input>,
    children: []
  };
}

export function defineRuntime<Input = unknown>(
  definition: readonly RuntimeTaskDefinition<Input>[] | { tasks: readonly RuntimeTaskDefinition<Input>[]; cache?: CacheRegistryDefinition }
): RuntimeDefinition<Input> {
  const objectDefinition = definition as { tasks: readonly RuntimeTaskDefinition<Input>[]; cache?: CacheRegistryDefinition };
  const tasks = Array.isArray(definition) ? definition : objectDefinition.tasks;
  const cache = Array.isArray(definition) ? defaultRuntimeCache() : (objectDefinition.cache ?? defaultRuntimeCache());
  return {
    kind: "runtime-definition",
    tasks: normalizeRuntimeTasks(tasks),
    cache
  };
}

export function createRuntime<Input = unknown>(
  definition: RuntimeDefinition<Input> | readonly RuntimeTaskDefinition<Input>[],
  options: { cache?: CacheRegistryDefinition } = {}
): Runtime<Input> {
  const runtimeDefinition: RuntimeDefinition<Input> = Array.isArray(definition)
    ? defineRuntime({ tasks: definition, cache: options.cache })
    : definition as RuntimeDefinition<Input>;
  const memoryCacheEntries = new Map<string, unknown>();
  let status: RuntimeStatus = "idle";

  return {
    inspect() {
      return runtimeDefinition;
    },
    async run(input?: Input, runOptions: { task?: string; signal?: AbortSignal } = {}) {
      status = "running";
      const state: Record<string, unknown> = {};
      const results: RuntimeTaskResult[] = [];
      try {
        const plan = createRuntimePlan(runtimeDefinition.tasks, runOptions.task);
        if (runOptions.task && plan.length === 0) {
          throw pipelineError("ASYNC_PIPELINE_RUNTIME_UNKNOWN_TASK", `Unknown runtime task "${runOptions.task}".`);
        }
        let output: unknown;
        for (const entry of plan) {
          output = await runRuntimeTask(entry.task, {
            input: input as Input,
            state,
            taskId: entry.task.id ?? entry.path.join("."),
            path: entry.path,
            signal: runOptions.signal
          }, runtimeDefinition.cache, results, memoryCacheEntries);
        }
        status = "passed";
        return { status: "passed", tasks: results, output };
      } catch (error) {
        status = "failed";
        return {
          status: "failed",
          tasks: results,
          output: undefined
        };
      }
    },
    async start() {
      status = "started";
    },
    async stop() {
      status = "stopped";
    },
    async close() {
      status = "stopped";
    }
  };
}

async function runRuntimeTask<Input>(
  taskDefinition: RuntimeTaskDefinition<Input>,
  context: RuntimeContext<Input>,
  registry: CacheRegistryDefinition,
  results: RuntimeTaskResult[],
  memoryCacheEntries: Map<string, unknown>
): Promise<unknown> {
  try {
    const middlewares = runtimeMiddlewares(taskDefinition, registry, memoryCacheEntries);
    const output = await composeRuntimeMiddleware(middlewares, context);
    results.push({ id: context.taskId, status: context.cacheHit ? "cached" : "passed", cacheHit: context.cacheHit ?? false });
    return output;
  } catch (error) {
    results.push({ id: context.taskId, status: "failed", cacheHit: false, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

function runtimeMiddlewares<Input>(
  taskDefinition: RuntimeTaskDefinition<Input>,
  registry: CacheRegistryDefinition,
  memoryCacheEntries: Map<string, unknown>
): RuntimeMiddleware<Input>[] {
  const items = taskDefinition.run === undefined
    ? []
    : Array.isArray(taskDefinition.run) ? taskDefinition.run : [taskDefinition.run];
  const middlewares: RuntimeMiddleware<Input>[] = [];
  if (taskDefinition.cache) {
    middlewares.push(cacheMiddleware(taskDefinition.cache, registry, memoryCacheEntries));
  }
  for (const item of items) {
    if (isCacheDirective(item)) {
      middlewares.push(cacheMiddleware(item.ref, registry, memoryCacheEntries));
      continue;
    }
    middlewares.push(item);
  }
  return middlewares;
}

function cacheMiddleware<Input>(ref: CacheRef, registry: CacheRegistryDefinition, memoryCacheEntries: Map<string, unknown>): RuntimeMiddleware<Input> {
  const parsed = parseCacheRef(ref);
  return async (context, next) => {
    const cacheKey = JSON.stringify([parsed.store, parsed.strategy, context.taskId, context.input]);
    if (parsed.store === "memory" && memoryCacheEntries.has(cacheKey)) {
      context.cacheHit = true;
      context.output = memoryCacheEntries.get(cacheKey);
      return context.output;
    }
    if (!registry.stores[parsed.store]) {
      throw pipelineError("ASYNC_PIPELINE_UNKNOWN_CACHE_STORE", `Unknown cache store "${parsed.store}" in "${ref}".`);
    }
    const output = await next();
    if (parsed.store === "memory") memoryCacheEntries.set(cacheKey, output);
    context.output = output;
    return output;
  };
}

async function composeRuntimeMiddleware<Input>(middlewares: RuntimeMiddleware<Input>[], context: RuntimeContext<Input>): Promise<unknown> {
  let index = -1;
  const dispatch = async (position: number): Promise<unknown> => {
    if (position <= index) {
      throw pipelineError("ASYNC_PIPELINE_RUNTIME_NEXT_CALLED_TWICE", `Runtime task "${context.taskId}" called next() more than once.`);
    }
    index = position;
    const middleware = middlewares[position];
    if (!middleware) return context.output;
    const output = await middleware(context, () => dispatch(position + 1));
    if (output !== undefined) context.output = output;
    return context.output;
  };
  return dispatch(0);
}

function normalizeRuntimeTasks<Input>(tasks: readonly RuntimeTaskDefinition<Input>[], prefix: string[] = []): RuntimeTaskDefinition<Input>[] {
  return tasks.map((taskDefinition, index) => {
    const id = taskDefinition.id ?? [...prefix, `task-${index + 1}`].join(".");
    return {
      ...taskDefinition,
      id,
      children: normalizeRuntimeTasks(taskDefinition.children, [...prefix, id])
    };
  });
}

function flattenTasks<Input>(tasks: readonly RuntimeTaskDefinition<Input>[], path: string[] = []): Array<{ task: RuntimeTaskDefinition<Input>; path: string[] }> {
  const flattened: Array<{ task: RuntimeTaskDefinition<Input>; path: string[] }> = [];
  for (const taskDefinition of tasks) {
    const taskPath = [...path, taskDefinition.id ?? String(flattened.length + 1)];
    flattened.push({ task: taskDefinition, path: taskPath });
    flattened.push(...flattenTasks(taskDefinition.children, taskPath));
  }
  return flattened;
}

function createRuntimePlan<Input>(
  tasks: readonly RuntimeTaskDefinition<Input>[],
  target?: string
): Array<{ task: RuntimeTaskDefinition<Input>; path: string[] }> {
  const entries = flattenTasks(tasks);
  const byId = new Map<string, { task: RuntimeTaskDefinition<Input>; path: string[]; index: number; dependsOn: string[] }>();

  entries.forEach((entry, index) => {
    const id = entry.task.id ?? entry.path.join(".");
    if (byId.has(id)) {
      throw pipelineError("ASYNC_PIPELINE_RUNTIME_DUPLICATE_TASK", `Duplicate runtime task id "${id}".`);
    }
    const parentId = entry.path.length > 1 ? entry.path.at(-2) : undefined;
    byId.set(id, {
      ...entry,
      index,
      dependsOn: [...(entry.task.dependsOn ?? []), ...(parentId ? [parentId] : [])]
    });
  });

  const selected = target ? collectRuntimeDependencies(target, byId) : new Set(byId.keys());
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const order: string[] = [];

  const visit = (id: string, path: string[]): void => {
    if (!selected.has(id) || visited.has(id)) return;
    if (visiting.has(id)) {
      const start = path.indexOf(id);
      const cycle = [...path.slice(start), id].join(" -> ");
      throw pipelineError("ASYNC_PIPELINE_RUNTIME_DEPENDENCY_CYCLE", `Runtime task dependency cycle detected: ${cycle}.`);
    }
    const entry = byId.get(id);
    if (!entry) throw pipelineError("ASYNC_PIPELINE_RUNTIME_UNKNOWN_TASK", `Unknown runtime task "${id}".`);
    visiting.add(id);
    for (const dependency of [...entry.dependsOn].sort()) {
      if (!byId.has(dependency)) {
        throw pipelineError("ASYNC_PIPELINE_RUNTIME_MISSING_DEPENDENCY", `Runtime task "${id}" depends on missing task "${dependency}".`);
      }
      visit(dependency, [...path, id]);
    }
    visiting.delete(id);
    visited.add(id);
    order.push(id);
  };

  for (const id of [...selected].sort((left, right) => (byId.get(left)?.index ?? 0) - (byId.get(right)?.index ?? 0))) {
    visit(id, []);
  }

  return order.map((id) => {
    const entry = byId.get(id);
    if (!entry) throw pipelineError("ASYNC_PIPELINE_RUNTIME_UNKNOWN_TASK", `Unknown runtime task "${id}".`);
    return { task: entry.task, path: entry.path };
  });
}

function collectRuntimeDependencies<Input>(
  target: string,
  byId: Map<string, { task: RuntimeTaskDefinition<Input>; path: string[]; index: number; dependsOn: string[] }>
): Set<string> {
  if (!byId.has(target)) return new Set();
  const selected = new Set<string>();
  const visit = (id: string): void => {
    if (selected.has(id)) return;
    const entry = byId.get(id);
    if (!entry) throw pipelineError("ASYNC_PIPELINE_RUNTIME_UNKNOWN_TASK", `Unknown runtime task "${id}".`);
    selected.add(id);
    for (const dependency of entry.dependsOn) visit(dependency);
  };
  visit(target);
  return selected;
}

function isRuntimeTaskArray<Input>(value: unknown): value is readonly RuntimeTaskDefinition<Input>[] {
  return Array.isArray(value) && value.every((entry) => Boolean(entry) && typeof entry === "object" && "children" in entry);
}
