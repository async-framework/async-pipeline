import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const cliPath = join(repoRoot, "packages/pipeline-node/dist/cli.js");
const manifest = JSON.parse(readFileSync(join(repoRoot, "packages", "pipeline", "package.json"), "utf8"));
const HEAD_SHA = "a".repeat(40);
const TOKEN = "fake-lifecycle-token-do-not-echo";

let server;
let apiUrl;
let apiState;

function resetApi() {
  apiState = {
    requests: [],
    branchSha: HEAD_SHA
  };
}

before(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      apiState.requests.push({ method: request.method, url: request.url, body });
      const respond = (status, payload) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.url.includes("/branches/main")) return respond(200, { commit: { sha: apiState.branchSha } });
      if (request.url.includes(`/releases/tags/v${manifest.version}`)) return respond(200, { tag_name: `v${manifest.version}` });
      respond(404, { message: "unexpected route" });
    });
  });
  await new Promise((ready) => server.listen(0, "127.0.0.1", ready));
  apiUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
    server.closeAllConnections?.();
  });
});

function makeNpmShim(dir) {
  const shim = join(dir, "npm");
  writeFileSync(
    shim,
    [
      "#!/usr/bin/env node",
      "const { appendFileSync, readFileSync } = require(\"node:fs\");",
      "const { join } = require(\"node:path\");",
      "const args = process.argv.slice(2);",
      "const record = { args, cwd: process.cwd() };",
      "try { record.userconfig = readFileSync(process.env.NPM_CONFIG_USERCONFIG, \"utf8\"); } catch {}",
      "try { record.manifest = JSON.parse(readFileSync(join(process.cwd(), \"package.json\"), \"utf8\")); } catch {}",
      "appendFileSync(process.env.NPM_SHIM_LOG, JSON.stringify(record) + \"\\n\");",
      "if (args[0] === \"view\") {",
      "  const exit = Number(process.env.NPM_SHIM_VIEW_EXIT ?? 1);",
      "  if (exit === 0) console.log(process.env.NPM_SHIM_VIEW_VERSION ?? \"0.0.0\");",
      "  else console.error(process.env.NPM_SHIM_VIEW_ERROR === \"1\" ? \"npm error network ECONNRESET\" : \"npm error code E404\\nnpm error 404 Not Found\");",
      "  process.exit(exit);",
      "}",
      "if (args[0] === \"publish\") process.exit(Number(process.env.NPM_SHIM_PUBLISH_EXIT ?? 0));",
      "if (args[0] === \"access\") process.exit(Number(process.env.NPM_SHIM_ACCESS_EXIT ?? 0));",
      "process.exit(Number(process.env.NPM_SHIM_DISTTAG_EXIT ?? 0));"
    ].join("\n"),
    "utf8"
  );
  chmodSync(shim, 0o755);
}

async function runCli(args, { env = {} } = {}) {
  resetApi();
  const dir = mkdtempSync(join(tmpdir(), "async-pipeline-lifecycle-test-"));
  try {
    makeNpmShim(dir);
    const logPath = join(dir, "npm-calls.jsonl");
    writeFileSync(logPath, "", "utf8");
    const child = spawn(process.execPath, [cliPath, ...args], {
      cwd: repoRoot,
      env: {
        PATH: `${dir}:${process.env.PATH}`,
        HOME: process.env.HOME,
        NPM_SHIM_LOG: logPath,
        GITHUB_REPOSITORY: "async/pipeline",
        GITHUB_REPOSITORY_OWNER: "async",
        GITHUB_API_URL: apiUrl,
        GITHUB_TOKEN: TOKEN,
        ...env
      }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const status = await new Promise((resolveExit, rejectExit) => {
      child.on("error", rejectExit);
      child.on("close", resolveExit);
    });
    const calls = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    return { status, stdout, stderr, calls, api: apiState };
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
}

test("lifecycle CLI publishes GitHub Packages snapshots from a package path", async () => {
  const run = await runCli(["publish", "github", "main", "--package", "packages/pipeline"], {
    env: { GITHUB_SHA: HEAD_SHA }
  });

  assert.equal(run.status, 0, run.stderr);
  const publish = run.calls.find((call) => call.args[0] === "publish");
  assert.ok(publish, "expected npm publish to run");
  assert.equal(publish.manifest.name, "@async/pipeline");
  assert.equal(publish.manifest.version, `0.0.0-main.sha.${HEAD_SHA}`);
  assert.deepEqual(publish.args.slice(0, 3), ["publish", "--tag", "main"]);
  assert.equal(run.calls.some((call) => call.args[0] === "dist-tag"), true);
  assert.equal(run.api.requests.some((request) => request.url.includes("/branches/main")), true);
});

test("lifecycle CLI skips npm publish for an already published package and keeps public access", async () => {
  const run = await runCli(["publish", "npm", "--package", "packages/pipeline"], {
    env: {
      NPM_SHIM_VIEW_EXIT: "0",
      NPM_SHIM_VIEW_VERSION: manifest.version
    }
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.calls.some((call) => call.args[0] === "publish"), false);
  assert.equal(run.calls.some((call) => call.args[0] === "access"), true);
  assert.match(run.stdout, /already published to npm/);
});

test("lifecycle CLI release doctor verifies npm, GitHub Packages, and GitHub Release", async () => {
  const run = await runCli(["release", "doctor", "--package", "packages/pipeline"], {
    env: {
      NPM_SHIM_VIEW_EXIT: "0",
      NPM_SHIM_VIEW_VERSION: manifest.version
    }
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.calls.filter((call) => call.args[0] === "view").length, 2);
  assert.equal(run.calls.some((call) => call.userconfig?.includes("_authToken")), true, "GitHub Packages check must use token auth");
  assert.equal(run.api.requests.some((request) => request.url.includes(`/releases/tags/v${manifest.version}`)), true);
  assert.match(run.stdout, /Release doctor passed/);
});
