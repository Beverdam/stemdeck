// Which Playwright specs CI runs for a pull request (scripts/ci/select-e2e.mjs).
//
// Run:  node --test tests/js/select-e2e.test.mjs   (or plain node, as CI does)

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { globToRegExp, loadMap, select } from "../../scripts/ci/select-e2e.mjs";

const map = loadMap();
const pr = (files, base = "big-release") => select({ event: "pull_request", base, files, map, exists: () => true });
const spec = (name) => `tests/e2e/${name}.spec.mjs`;
const smoke = map.smoke.map(spec);

test("a pull request to main runs everything", () => {
  assert.equal(pr(["static/js/queue.js"], "main").full, true);
});

test("a push runs everything", () => {
  assert.equal(select({ event: "push", base: "", files: [], map }).full, true);
});

test("a diff that could not be computed runs everything", () => {
  assert.equal(pr(null).full, true);
});

test("an empty diff runs the smoke set only", () => {
  const r = pr([]);
  assert.equal(r.full, false);
  assert.deepEqual(r.specs, [...smoke].sort());
});

test("a changed spec is selected", () => {
  const r = pr(["tests/e2e/zoom.spec.mjs"]);
  assert.equal(r.full, false);
  assert.ok(r.specs.includes(spec("zoom")));
});

test("a deleted spec is not passed to playwright", () => {
  const r = select({ event: "pull_request", base: "big-release", files: [spec("gone")], map, exists: () => false });
  assert.equal(r.full, false);
  assert.ok(!r.specs.includes(spec("gone")));
});

test("queue.js selects queue-progress, the untouched spec #806 broke", () => {
  const r = pr(["static/js/queue.js"]);
  assert.equal(r.full, false);
  assert.ok(r.specs.includes(spec("queue-progress")));
});

test("modeUi.js selects modes and help-mode", () => {
  const r = pr(["static/js/modeUi.js"]);
  assert.equal(r.full, false);
  assert.ok(r.specs.includes(spec("modes")));
  assert.ok(r.specs.includes(spec("help-mode")));
});

test("an unmapped file under static/ or app/ runs everything", () => {
  assert.equal(pr(["static/js/brandNewModule.js"]).full, true);
  assert.equal(pr(["app/pipeline/separate.py"]).full, true);
  assert.equal(pr(["tests/e2e/new-helper.mjs"]).full, true);
});

test("shared e2e infrastructure runs everything", () => {
  for (const f of ["playwright.config.mjs", "tests/e2e/helpers.mjs", "tests/e2e/serve.sh", "tests/e2e/seed.py",
    "package.json", "package-lock.json", ".github/workflows/ci.yml", "tests/e2e/spec-map.json", "scripts/ci/select-e2e.mjs"]) {
    assert.equal(pr([f]).full, true, f);
  }
});

test("files outside static/, app/ and tests/e2e/ add nothing to the smoke set", () => {
  const r = pr(["README.md", "desktop/src-tauri/src/main.rs", "tests/test_jobs.py"]);
  assert.equal(r.full, false);
  assert.deepEqual(r.specs, [...smoke].sort());
});

test("windows separators are normalised", () => {
  const r = pr(["static\\js\\queue.js"]);
  assert.ok(r.specs.includes(spec("queue-progress")));
});

test("globs: * stays in one folder, ** crosses folders", () => {
  assert.ok(globToRegExp("static/js/eq/**").test("static/js/eq/a/b.js"));
  assert.ok(globToRegExp("app/pipeline/lyrics_*.py").test("app/pipeline/lyrics_sync.py"));
  assert.ok(!globToRegExp("tests/e2e/helpers*").test("tests/e2e/sub/helpers.mjs"));
});

test("every spec named in the map exists", () => {
  const named = new Set([...map.smoke, ...map.rules.flatMap((r) => r.specs)]);
  for (const name of named) assert.ok(existsSync(new URL(`../e2e/${name}.spec.mjs`, import.meta.url)), name);
});
