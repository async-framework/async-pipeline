#!/usr/bin/env node
// Docs-drift checks. The docs are plain markdown that must work in two
// places: rendered on GitHub (relative .md links) and built for GitHub
// Pages by .github/workflows/pages.yml (jekyll-relative-links rewrites the
// same .md links to .html). This check fails when either would break:
// 1. Every relative link in README.md and docs/**/*.md resolves to a file.
// 2. Every same-file or cross-file #anchor matches a real heading.
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = process.cwd();
const failures = [];
const publicReadmes = ["README.md", "packages/pipeline/README.md"];
const privateWorkspacePackages = [
  "@async/pipeline-core",
  "@async/pipeline-node",
  "@async/pipeline-adapter-lima"
];

function fail(message) {
  failures.push(message);
}

async function markdownFiles() {
  const files = ["README.md"];
  async function walk(dir) {
    for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".md")) files.push(path);
    }
  }
  await walk("docs");
  return files;
}

async function checkPublicReadmes() {
  for (const file of publicReadmes) {
    const text = await readFile(join(root, file), "utf8");
    for (const packageName of privateWorkspacePackages) {
      if (text.includes(packageName)) {
        fail(`${file}: public README mentions private workspace package ${packageName}`);
      }
    }
  }
}

// GitHub-style heading slugs: lowercase, drop punctuation, spaces to dashes.
function slugify(heading) {
  return heading
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/[^\w\- ]/g, "")
    .trim()
    .replace(/ +/g, "-");
}

const headingCache = new Map();
async function headingSlugs(path) {
  if (!headingCache.has(path)) {
    const slugs = new Set();
    const text = await readFile(path, "utf8");
    for (const match of text.matchAll(/^#{1,6} +(.+)$/gm)) {
      slugs.add(slugify(match[1]));
    }
    headingCache.set(path, slugs);
  }
  return headingCache.get(path);
}

for (const file of await markdownFiles()) {
  const filePath = join(root, file);
  const text = await readFile(filePath, "utf8");
  // Strip fenced code blocks so example links are not checked.
  const withoutCode = text.replace(/```[\s\S]*?```/g, "");
  for (const match of withoutCode.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = match[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, https:, mailto:
    const [pathPart, anchor] = target.split("#");

    let targetPath = filePath;
    if (pathPart) {
      targetPath = resolve(dirname(filePath), pathPart);
      if (!existsSync(targetPath)) {
        fail(`${file}: broken link -> ${target}`);
        continue;
      }
    }
    if (anchor && targetPath.endsWith(".md")) {
      const slugs = await headingSlugs(targetPath);
      if (!slugs.has(anchor)) {
        fail(`${file}: broken anchor -> ${target}`);
      }
    }
  }
}
await checkPublicReadmes();

if (failures.length > 0) {
  for (const message of failures) console.error(`DOCS ${message}`);
  process.exit(1);
}
console.log(`Docs checks passed: ${headingCache.size ? "links and anchors" : "links"} resolve across README.md and docs/.`);
