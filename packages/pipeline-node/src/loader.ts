import { pathToFileURL } from "node:url";
import type { NormalizedPipeline } from "@async/pipeline-core";

export async function loadPipeline(configPath: string): Promise<NormalizedPipeline> {
  const moduleUrl = `${pathToFileURL(configPath).href}?t=${Date.now()}`;
  const loaded = await import(moduleUrl) as { default?: unknown };
  if (!loaded.default || typeof loaded.default !== "object") {
    throw new Error(`Pipeline config "${configPath}" must default-export definePipeline(...).`);
  }
  return loaded.default as NormalizedPipeline;
}
