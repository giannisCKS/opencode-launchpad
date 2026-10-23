import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

test("managed TUI entrypoint resolves through the package exports", () => {
  assert.equal(pkg.exports?.["./tui"], "./tui.js");
  assert.equal(
    fileURLToPath(import.meta.resolve("opencode-launchpad/tui")),
    path.join(root, "tui.js"),
  );
});

test("root package import remains the TUI entrypoint", () => {
  assert.equal(pkg.exports?.["."], "./tui.js");
  assert.equal(
    fileURLToPath(import.meta.resolve("opencode-launchpad")),
    path.join(root, "tui.js"),
  );
});

test("the exported TUI entrypoint is included in the package files", () => {
  assert.ok(pkg.files.includes("tui.js"));
});
