import { pipelineError } from "./errors.js";

export type CacheStrategy = "cache-first";
export type CacheRef = `${string}:${CacheStrategy}` | string;

export interface CacheStoreDefinition {
  kind: "cache-store";
  type: "memory" | "file" | "custom";
  root?: string;
  config?: Record<string, unknown>;
}

export interface CacheUseOptions {
  ttlMs?: number;
  key?: unknown;
}

export interface CacheDirective {
  kind: "async-pipeline.directive.cache";
  ref: CacheRef;
  options?: CacheUseOptions;
}

export interface CacheRegistryInput {
  default?: CacheRef;
  stores?: Record<string, CacheStoreDefinition>;
}

export interface CacheRegistryDefinition {
  kind: "cache-registry";
  default: CacheRef;
  stores: Record<string, CacheStoreDefinition>;
  use(ref?: CacheRef, options?: CacheUseOptions): CacheDirective;
}

export interface ParsedCacheRef {
  ref: CacheRef;
  store: string;
  strategy: CacheStrategy;
}

const knownStrategies = new Set<CacheStrategy>(["cache-first"]);

export function memoryCache(): CacheStoreDefinition {
  return { kind: "cache-store", type: "memory" };
}

export function fileCache(options: { root?: string } = {}): CacheStoreDefinition {
  return { kind: "cache-store", type: "file", root: options.root };
}

export function customCache(config: Record<string, unknown> = {}): CacheStoreDefinition {
  return { kind: "cache-store", type: "custom", config };
}

export function redisCache(config: Record<string, unknown> = {}): CacheStoreDefinition {
  return { kind: "cache-store", type: "custom", config: { ...config, adapter: "redis" } };
}

export function defineCache(input: CacheRegistryInput | Record<string, CacheStoreDefinition> = {}): CacheRegistryDefinition {
  const hasStoresEnvelope = "stores" in input || "default" in input;
  const stores = hasStoresEnvelope
    ? { ...((input as CacheRegistryInput).stores ?? {}) }
    : { ...(input as Record<string, CacheStoreDefinition>) };
  const defaultRef = hasStoresEnvelope ? ((input as CacheRegistryInput).default ?? "memory:cache-first") : "memory:cache-first";

  return makeCacheRegistry(defaultRef, stores);
}

export function defaultPipelineCache(): CacheRegistryDefinition {
  return makeCacheRegistry("file:cache-first", {
    memory: memoryCache(),
    file: fileCache({ root: ".async/cache/tasks" })
  });
}

export function defaultRuntimeCache(): CacheRegistryDefinition {
  return makeCacheRegistry("memory:cache-first", {
    memory: memoryCache(),
    file: fileCache({ root: ".async/cache/runtime" })
  });
}

export const cache = defaultPipelineCache();

export function parseCacheRef(ref: CacheRef): ParsedCacheRef {
  const [store, strategy = "cache-first", extra] = String(ref).split(":");
  if (!store || extra !== undefined) {
    throw pipelineError("ASYNC_PIPELINE_INVALID_CACHE_REF", `Invalid cache reference "${ref}". Use "store:strategy".`, { ref });
  }
  if (!knownStrategies.has(strategy as CacheStrategy)) {
    throw pipelineError("ASYNC_PIPELINE_UNKNOWN_CACHE_STRATEGY", `Unknown cache strategy "${strategy}" in "${ref}".`, { ref, strategy });
  }
  return { ref, store, strategy: strategy as CacheStrategy };
}

export function isCacheDirective(value: unknown): value is CacheDirective {
  return Boolean(value)
    && typeof value === "object"
    && (value as { kind?: unknown }).kind === "async-pipeline.directive.cache";
}

export function assertCacheStore(registry: CacheRegistryDefinition, ref: ParsedCacheRef): void {
  if (!registry.stores[ref.store]) {
    throw pipelineError("ASYNC_PIPELINE_UNKNOWN_CACHE_STORE", `Unknown cache store "${ref.store}" in "${ref.ref}".`, {
      ref: ref.ref,
      store: ref.store,
      availableStores: Object.keys(registry.stores).sort()
    });
  }
}

export function mergeWithDefaultCacheStores(registry: CacheRegistryDefinition): CacheRegistryDefinition {
  return makeCacheRegistry(registry.default, {
    memory: memoryCache(),
    file: fileCache({ root: ".async/cache/tasks" }),
    ...registry.stores
  });
}

function makeCacheRegistry(defaultRef: CacheRef, stores: Record<string, CacheStoreDefinition>): CacheRegistryDefinition {
  return {
    kind: "cache-registry",
    default: defaultRef,
    stores,
    use(ref: CacheRef = defaultRef, options?: CacheUseOptions): CacheDirective {
      return {
        kind: "async-pipeline.directive.cache",
        ref,
        options
      };
    }
  };
}
