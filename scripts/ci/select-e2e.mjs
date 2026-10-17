#!/usr/bin/env node
// Which Playwright specs CI runs. Prints the spec paths, space separated, for
// `npx playwright test`. Prints nothing when the whole suite should run.
//
//   node scripts/ci/select-e2e.mjs --event pull_request --base big-release
//   node scripts/ci/select-e2e.mjs --event pull_request --base big-release --files a b c
//
// The whole suite runs on every push, on a pull request to main, and whenever
// the diff cannot be worked out. A pull request to any other branch runs the
// specs it adds or changes, the smoke set, and the specs mapped to its changed
// files in tests/e2e/spec-map.json. A changed file in that map's "full" list,
// or one under static/, app/ or tests/e2e/ that no rule maps, runs everything.
// Why the reduced set must never miss a mapped spec: #806 broke an untouched
// spec (queue-progress) by changing static/js/queue.js.
//
// The reason for the choice goes to stderr, so the CI log shows it.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SPEC_DIR = "tests/e2e/";
const WATCHED = ["static/", "app/", SPEC_DIR];

export function loadMap(path = join(ROOT, SPEC_DIR, "spec-map.json")) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// * matches inside one path segment, ** across segments.
export function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
    } else if (c === "*") re += "[^/]*";
    else re += c.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

const specPath = (name) => `${SPEC_DIR}${name}.spec.mjs`;
const isSpec = (p) => p.startsWith(SPEC_DIR) && p.endsWith(".spec.mjs");

// Returns { full: true, reason } or { full: false, specs: [...], reason }.
// `exists` is injectable so the tests do not depend on the working tree.
export function select({ event, base, files, map = loadMap(), exists = (p) => existsSync(join(ROOT, p)) }) {
  if (event !== "pull_request") return { full: true, reason: `event ${event || "unknown"} runs everything` };
  if (!base || base === "main") return { full: true, reason: `pull request to ${base || "unknown base"} runs everything` };
  if (files === null) return { full: true, reason: "could not compute the diff" };

  const norm = files.map((p) => p.split("\\").join("/"));
  const fullGlobs = map.full.map(globToRegExp);
  const rules = map.rules.map((r) => ({ ...r, res: r.paths.map(globToRegExp) }));
  const picked = new Set(map.smoke);
  const changedSpecs = new Set();

  for (const f of norm) {
    if (fullGlobs.some((re) => re.test(f))) return { full: true, reason: `${f} is shared, runs everything` };
    if (isSpec(f)) {
      if (exists(f)) changedSpecs.add(f);
      continue;
    }
    const hits = rules.filter((r) => r.res.some((re) => re.test(f)));
    if (hits.length === 0) {
      if (WATCHED.some((w) => f.startsWith(w))) return { full: true, reason: `${f} matches no rule in spec-map.json, runs everything` };
      continue;
    }
    for (const r of hits) for (const s of r.specs) picked.add(s);
  }

  const specs = [...new Set([...[...picked].map(specPath), ...changedSpecs])].sort();
  return { full: false, specs, reason: `${norm.length} changed files, ${specs.length} specs` };
}

export function changedFiles(base) {
  try {
    const out = execFileSync("git", ["diff", "--name-only", "--no-renames", `origin/${base}...HEAD`], { cwd: ROOT, encoding: "utf8" });
    return out.split(/\r?\n/).filter(Boolean);
  } catch {
    return null;
  }
}

function main() {
  const argv = process.argv.slice(2);
  let event = "";
  let base = "";
  let files;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--event") event = argv[++i];
    else if (argv[i] === "--base") base = argv[++i];
    else if (argv[i] === "--files") files = argv.slice(i + 1);
  }
  if (event === "pull_request" && base && base !== "main" && files === undefined) files = changedFiles(base);
  // null (the diff failed) is kept, so select() falls back to everything.
  const r = select({ event, base, files: files === undefined ? [] : files });
  console.error(`select-e2e: ${r.full ? "FULL" : "SCOPED"}: ${r.reason}`);
  if (!r.full) {
    for (const s of r.specs) console.error(`  ${s}`);
    console.log(r.specs.join(" "));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
