#!/usr/bin/env node
// Compatibility wrapper for the self pipeline. The shared implementation ships
// in @async/pipeline so consumer repos can use:
//   async-pipeline publish github <pr|main|release> --package <path>
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { publishGitHubPackage, runLifecycleCli } from "../packages/pipeline-node/dist/package-lifecycle.js";

const mode = process.argv[2];
if (!["pr", "main", "release"].includes(mode ?? "")) {
  console.error("Usage: node scripts/publish-github.mjs <pr|main|release>");
  process.exit(2);
}

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const code = await runLifecycleCli(
  () => publishGitHubPackage(mode, {
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
