#!/usr/bin/env node
// Compatibility wrapper for the self pipeline. The shared implementation ships
// in @async/pipeline so consumer repos can use:
//   async-pipeline publish npm --package <path>
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishNpmPackage, runLifecycleCli } from "../packages/pipeline-node/dist/package-lifecycle.js";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const code = await runLifecycleCli(
  () => publishNpmPackage({
    cwd: repoRoot,
    packagePath: "packages/pipeline",
    env: process.env,
    io: {
      stdout(text) { process.stdout.write(text); },
      stderr(text) { process.stderr.write(text); }
    }
  }),
  {
    stdout(text) { process.stdout.write(text); },
    stderr(text) { process.stderr.write(text); }
  }
);
process.exit(code);
