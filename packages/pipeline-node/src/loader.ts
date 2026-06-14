import { pathToFileURL } from "node:url";
import type { NormalizedPipeline } from "@async/pipeline-core";

export async function loadPipeline(configPath: string): Promise<NormalizedPipeline> {
  if ((configPath.endsWith(".ts") || configPath.endsWith(".mts")) && !(process.features as { typescript?: unknown }).typescript) {
    throw new Error(
      `Loading "${configPath}" requires Node 24 or newer with native TypeScript type stripping (current: ${process.version}). ` +
      "Upgrade Node, or use a pipeline.js/pipeline.mjs config."
    );
  }
  const moduleUrl = `${pathToFileURL(configPath).href}?t=${Date.now()}`;
  const loaded = await import(moduleUrl) as { default?: unknown };
  if (!loaded.default || typeof loaded.default !== "object") {
    throw new Error(`Pipeline config "${configPath}" must default-export definePipeline(...).`);
  }
  return loaded.default as NormalizedPipeline;
}
