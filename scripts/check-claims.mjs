#!/usr/bin/env node
// Claim -> test coverage checks (AGENTS.md rule 2, made executable). Fails when
// documented claims and enforcing tests drift apart:
// 1. Every registered claim anchor still appears verbatim in its source doc.
// 2. Every test a claim points at still exists in tests/*.test.js.
// 3. Every test titled "PROMISE: ..." is registered for at least one claim.
// The registry lives in tests/claims.json. It does not prove a test is
// sufficient — review does that — but it makes silently dropping either side
// of a promise (the claim or the test) a release-blocking error.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const failures = [];

function fail(message) {
  failures.push(message);
}

// Load and shape-check the registry.
const registryPath = "tests/claims.json";
const registry = JSON.parse(await readFile(join(root, registryPath), "utf8"));
const claims = registry.claims ?? [];
if (!Array.isArray(claims) || claims.length === 0) {
  fail(`${registryPath} has no claims; the registry must not be empty.`);
}
const seenIds = new Set();
for (const claim of claims) {
  const label = claim.id ?? "<missing id>";
  if (!claim.id) fail(`${registryPath}: a claim is missing an "id".`);
  if (claim.id && seenIds.has(claim.id)) fail(`${registryPath}: duplicate claim id "${claim.id}".`);
  if (claim.id) seenIds.add(claim.id);
  if (!claim.source) fail(`${registryPath}: claim "${label}" is missing a "source" file.`);
  if (!claim.anchor) fail(`${registryPath}: claim "${label}" is missing an "anchor".`);
  if (!Array.isArray(claim.tests) || claim.tests.length === 0) {
    fail(`${registryPath}: claim "${label}" lists no enforcing tests. Every registered claim needs at least one.`);
  }
}

// 1. Anchors still exist verbatim in their source docs.
const sourceCache = new Map();
async function readSource(path) {
  if (!sourceCache.has(path)) {
    sourceCache.set(path, await readFile(join(root, path), "utf8").catch(() => null));
  }
  return sourceCache.get(path);
}
for (const claim of claims) {
  if (!claim.source || !claim.anchor) continue;
  const text = await readSource(claim.source);
  if (text === null) {
    fail(`claim "${claim.id}": source file ${claim.source} does not exist.`);
    continue;
  }
  if (!text.includes(claim.anchor)) {
    fail(`claim "${claim.id}": anchor no longer appears in ${claim.source}. If the claim was reworded, update the anchor; if the claim was dropped, remove the entry.\n  anchor: ${claim.anchor}`);
  }
}

// 2. Every referenced test exists; 3. every PROMISE test is registered.
const testTitles = new Set();
for (const entry of await readdir(join(root, "tests"), { withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".test.js")) continue;
  const text = await readFile(join(root, "tests", entry.name), "utf8");
  for (const match of text.matchAll(/^\s*test\(\s*"((?:[^"\\]|\\.)*)"/gm)) {
    testTitles.add(match[1]);
  }
}
const referencedTests = new Set();
for (const claim of claims) {
  for (const testName of claim.tests ?? []) {
    referencedTests.add(testName);
    if (!testTitles.has(testName)) {
      fail(`claim "${claim.id}": no test titled "${testName}" exists in tests/*.test.js. The claim is documented but unenforced.`);
    }
  }
}
for (const title of testTitles) {
  if (title.startsWith("PROMISE: ") && !referencedTests.has(title)) {
    fail(`unmapped promise: test "${title}" is not registered in ${registryPath}. Add the claim it enforces.`);
  }
}

if (failures.length > 0) {
  for (const message of failures) console.error(`CLAIMS ${message}`);
  process.exit(1);
}
const promiseCount = [...testTitles].filter((title) => title.startsWith("PROMISE: ")).length;
console.log(`Claims checks passed: ${claims.length} claim(s) anchored across ${sourceCache.size} doc(s), ${referencedTests.size} enforcing test(s) present, ${promiseCount} promise test(s) all registered.`);
