import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ACTIONS,
  buttonVisual,
  cleanOutput,
  controlVisual,
  createProjectDetector,
  createRunnerManager,
  detectProject,
  discoverActions,
  resolveAction,
  resolveSessionDirectory,
  statusLine,
  statusTone,
  token,
} from "./runners.js";

const NODE = process.execPath;
const roots = [];

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "project-runners-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

function removeFixtures() {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
}

// The stable id of a discovered per-script action. Each component is encoded, so
// a ':' in either half can never be read as the separator.
function scriptId(dir, script) {
  return `script:${encodeURIComponent(dir)}:${encodeURIComponent(script)}`;
}

const VETORY_SCRIPTS = {
  "build:mobile:hosted": "bash scripts/build-mobile-hosted.sh",
  live: "bash scripts/build-mobile-hosted.sh run",
  "live:web": "bash scripts/run-web-live.sh",
  "dev:web": "pnpm --dir apps/web dev",
};

function vetoryLike({ defines = true } = {}) {
  const files = {
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": { name: "vetory-like", private: true, scripts: VETORY_SCRIPTS },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "docs/deep/.keep": "",
  };
  if (defines) files["local-public-defines.json"] = "{}";
  return fixture(files);
}

async function waitFor(predicate, label, timeout = 6000) {
  const started = Date.now();
  for (;;) {
    if (predicate()) return;
    if (Date.now() - started > timeout) throw new Error(`timeout waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// A parent that spawns a grandchild, so the test can prove the whole process
// group dies and not just the direct child.
const NESTED_CHILD_SCRIPT = `
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  process.stdout.write("grandchild " + child.pid + "\\n");
  setInterval(() => {}, 1000);
`;

async function startNested(manager) {
  const { key } = manager.start({
    actionId: "mobile-live",
    label: "Live mobile",
    command: NODE,
    args: ["-e", NESTED_CHILD_SCRIPT],
    cwd: tmpdir(),
    stdin: true,
  });
  await waitFor(() => manager.snapshot(key).lines.length > 0, "grandchild pid");
  const pid = Number(manager.snapshot(key).lines[0].split(" ")[1]);
  assert.ok(pid > 0, "grandchild pid was reported");
  assert.equal(isAlive(pid), true, "grandchild is running");
  return { key, pid };
}

test.after(removeFixtures);

test("resolves workspace scripts from a nested session directory", () => {
  const root = vetoryLike();
  const project = detectProject(path.join(root, "docs/deep"));
  assert.equal(project.root, root);

  const build = resolveAction("build-mobile", project);
  assert.equal(build.ok, true);
  assert.equal(build.command, "pnpm");
  assert.deepEqual(build.args, ["run", "build:mobile:hosted"]);
  assert.equal(build.cwd, root);
  assert.equal(build.stdin, false);
  assert.equal(build.env.BUILD_DEFINES_FILE, path.join(root, "local-public-defines.json"));

  const mobileLive = resolveAction("mobile-live", project);
  assert.equal(mobileLive.ok, true);
  assert.deepEqual(mobileLive.args, ["run", "live"]);
  assert.equal(mobileLive.stdin, true);

  const webLive = resolveAction("web-live", project);
  assert.equal(webLive.ok, true);
  assert.deepEqual(webLive.args, ["run", "live:web"]);

  const nextLive = resolveAction("next-live", project);
  assert.equal(nextLive.ok, true);
  assert.deepEqual(nextLive.args, ["run", "dev:web"]);
  assert.equal(nextLive.env.BUILD_DEFINES_FILE, undefined);
});

// A workspace or repository boundary keeps a nested package on the same
// scripts; a plain parent folder must not donate anything.
test("a nested package borrows workspace commands without leaving the repository", () => {
  const root = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": { name: "vetory", private: true, scripts: VETORY_SCRIPTS },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "local-public-defines.json": "{}",
    "apps/web/package.json": {
      name: "web",
      scripts: { dev: "next dev" },
      devDependencies: { next: "^15.0.0" },
    },
  });
  const web = path.join(root, "apps/web");
  const project = detectProject(web);
  assert.deepEqual(project.packages.map((entry) => entry.dir), [web, root]);
  assert.equal(project.root, web);
  assert.equal(project.packageManager, "pnpm", "the workspace lockfile decides the manager");

  // The nearest package wins, and it runs from its own directory.
  const nextLive = resolveAction("next-live", project);
  assert.equal(nextLive.ok, true);
  assert.deepEqual(nextLive.args, ["run", "dev"]);
  assert.equal(nextLive.cwd, web);

  // Scripts only the workspace root owns run from the workspace root.
  const build = resolveAction("build-mobile", project);
  assert.equal(build.cwd, root);
  assert.deepEqual(build.args, ["run", "build:mobile:hosted"]);
  assert.equal(build.env.BUILD_DEFINES_FILE, path.join(root, "local-public-defines.json"));
  assert.equal(resolveAction("web-live", project).cwd, root);
  assert.equal(resolveAction("mobile-live", project).cwd, root);
});

test("a project without a workspace boundary never inherits a parent package", () => {
  const root = fixture({
    "package.json": { name: "vetory-like", private: true, scripts: VETORY_SCRIPTS },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "local-public-defines.json": "{}",
    "child/package.json": { name: "child", scripts: {} },
  });
  const child = path.join(root, "child");
  const project = detectProject(child);
  assert.deepEqual(project.packages.map((entry) => entry.dir), [child]);
  for (const id of ["build-mobile", "mobile-live", "web-live", "next-live", "adb-install", "analyze"]) {
    const resolution = resolveAction(id, project);
    assert.equal(resolution.ok, false, `${id} is not inherited`);
    assert.ok(resolution.reason.length > 0, id);
  }
});

test("does not inject a defines file that is absent", () => {
  const root = vetoryLike({ defines: false });
  const build = resolveAction("build-mobile", detectProject(root));
  assert.equal(build.ok, true);
  assert.deepEqual(build.env, {});
});

test("detects the package manager from the lockfile", () => {
  const root = fixture({
    "package.json": { scripts: { "build:mobile": "echo build" } },
    "yarn.lock": "",
  });
  const build = resolveAction("build-mobile", detectProject(root));
  assert.equal(build.command, "yarn");
  assert.deepEqual(build.args, ["run", "build:mobile"]);
});

test("enables next-live only for a Next dependency when using the generic dev script", () => {
  const withNext = fixture({
    "package.json": { scripts: { dev: "next dev" }, devDependencies: { next: "^15.0.0" } },
  });
  const enabled = resolveAction("next-live", detectProject(withNext));
  assert.equal(enabled.ok, true);
  assert.equal(enabled.command, "npm");
  assert.deepEqual(enabled.args, ["run", "dev"]);

  const withoutNext = fixture({ "package.json": { scripts: { dev: "node server.js" } } });
  const disabled = resolveAction("next-live", detectProject(withoutNext));
  assert.equal(disabled.ok, false);
  assert.match(disabled.reason, /Next\.js is not a dependency/);
});

test("falls back to Flutter for live rows and requires a web target", () => {
  const flutter = fixture({
    "apps/mobile/pubspec.yaml": "name: demo\n",
    "apps/mobile/lib/main.dart": "void main() {}\n",
    "apps/mobile/web/index.html": "<html></html>\n",
  });
  const project = detectProject(path.join(flutter, "apps/mobile/lib"));

  const live = resolveAction("mobile-live", project);
  assert.equal(live.ok, true);
  assert.equal(live.command, "flutter");
  assert.deepEqual(live.args, ["run"]);
  assert.equal(live.cwd, path.join(flutter, "apps/mobile"));
  assert.equal(live.stdin, true);

  const web = resolveAction("web-live", project);
  assert.equal(web.ok, true);
  assert.deepEqual(web.args, ["run", "-d", "web-server"]);

  assert.equal(resolveAction("build-mobile", project).ok, false);
  assert.equal(resolveAction("next-live", project).ok, false);

  const noWeb = fixture({ "pubspec.yaml": "name: demo\n" });
  const blocked = resolveAction("web-live", detectProject(noWeb));
  assert.equal(blocked.ok, false);
  assert.match(blocked.reason, /no web\/ target/);
});

test("installs the built release APK and never picks a device", () => {
  const root = fixture({
    "apps/mobile/pubspec.yaml": "name: demo\n",
    "apps/mobile/build/app/outputs/flutter-apk/app-release.apk": "release",
    "apps/mobile/build/app/outputs/flutter-apk/app-debug.apk": "debug",
  });
  const project = detectProject(path.join(root, "apps/mobile/lib"));
  const resolution = resolveAction("adb-install", project);
  const apk = path.join(root, "apps/mobile/build/app/outputs/flutter-apk/app-release.apk");

  assert.equal(resolution.ok, true);
  assert.equal(resolution.command, "adb");
  assert.deepEqual(resolution.args, ["install", "-r", apk]);
  assert.equal(resolution.cwd, path.join(root, "apps/mobile"));
  assert.equal(resolution.stdin, false);
  assert.equal(resolution.env.BUILD_DEFINES_FILE, undefined);
  assert.ok(!resolution.args.includes("-s"), "the button never selects a device itself");
  assert.equal(resolution.display, `adb install -r ${apk}`);
});

test("falls back to the debug APK and hides the row when no APK exists", () => {
  const debug = fixture({
    "apps/mobile/pubspec.yaml": "name: demo\n",
    "apps/mobile/build/app/outputs/flutter-apk/app-debug.apk": "debug",
  });
  const resolution = resolveAction("adb-install", detectProject(path.join(debug, "apps/mobile")));
  assert.equal(resolution.ok, true);
  assert.deepEqual(resolution.args.slice(0, 2), ["install", "-r"]);
  assert.match(resolution.args[2], /app-debug\.apk$/);

  const empty = fixture({ "apps/mobile/pubspec.yaml": "name: demo\n" });
  const hidden = resolveAction("adb-install", detectProject(path.join(empty, "apps/mobile")));
  assert.equal(hidden.ok, false);
  assert.match(hidden.reason, /no release or debug APK/);
});

test("finds the app APK from a workspace root session", () => {
  const root = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": { name: "repo", private: true, scripts: {} },
    "apps/mobile/pubspec.yaml": "name: demo\n",
    "apps/mobile/build/app/outputs/flutter-apk/app-release.apk": "release",
  });
  const resolution = resolveAction("adb-install", detectProject(root));
  assert.equal(resolution.ok, true);
  assert.equal(resolution.cwd, path.join(root, "apps/mobile"));
  assert.match(resolution.args[2], /app-release\.apk$/);

  const other = fixture({ "package.json": { name: "other", scripts: {} }, "src/index.js": "" });
  assert.equal(resolveAction("adb-install", detectProject(other)).ok, false);

  // A nested package session borrows the workspace commands and still finds the
  // app APK one level down from the workspace root.
  const nested = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": { name: "repo", private: true, scripts: {} },
    "pnpm-lock.yaml": "",
    "apps/web/package.json": { name: "web", dependencies: { next: "1.0.0" } },
    "apps/mobile/pubspec.yaml": "name: demo\n",
    "apps/mobile/build/app/outputs/flutter-apk/app-release.apk": "release",
  });
  const nestedResolution = resolveAction("adb-install", detectProject(path.join(nested, "apps/web")));
  assert.equal(nestedResolution.ok, true);
  assert.equal(nestedResolution.cwd, path.join(nested, "apps", "mobile"));
  assert.match(nestedResolution.args[2], /app-release\.apk$/);
});

test("a project install script wins over the built APK", () => {
  const root = fixture({
    "package.json": { name: "app", scripts: { "install:adb": "bash scripts/install-apk.sh" } },
    "pnpm-lock.yaml": "",
    "pubspec.yaml": "name: demo\n",
    "build/app/outputs/flutter-apk/app-release.apk": "release",
  });
  const resolution = resolveAction("adb-install", detectProject(root));
  assert.equal(resolution.ok, true);
  assert.equal(resolution.command, "pnpm");
  assert.deepEqual(resolution.args, ["run", "install:adb"]);
  assert.equal(resolution.cwd, root);
});

test("analyze prefers the project script and needs no defines file", () => {
  const root = fixture({
    "pnpm-lock.yaml": "",
    "local-public-defines.json": "{}",
    "package.json": { name: "vetory", scripts: { "mobile:analyze": "flutter analyze" } },
  });
  const resolution = resolveAction("analyze", detectProject(root));
  assert.equal(resolution.ok, true);
  assert.equal(resolution.command, "pnpm");
  assert.deepEqual(resolution.args, ["run", "mobile:analyze"]);
  assert.equal(resolution.cwd, root);
  assert.equal(resolution.stdin, false, "static analysis never reads hot-reload keys");
  assert.deepEqual(resolution.env, {}, "analysis is not one of the defines scripts");
  assert.equal(resolution.display, "pnpm run mobile:analyze");
});

test("analyze falls back to flutter analyze in a Flutter project", () => {
  const root = fixture({ "pubspec.yaml": "name: app\n" });
  const resolution = resolveAction("analyze", detectProject(root));
  assert.equal(resolution.ok, true);
  assert.equal(resolution.command, "flutter");
  assert.deepEqual(resolution.args, ["analyze"]);
  assert.equal(resolution.cwd, root);
  assert.equal(resolution.stdin, false);
  assert.equal(resolution.display, "flutter analyze");
});

test("a project's own analyze script works without Flutter", () => {
  const root = fixture({
    "package.json": { name: "web", scripts: { analyze: "eslint ." } },
  });
  const resolution = resolveAction("analyze", detectProject(root));
  assert.equal(resolution.ok, true);
  assert.equal(resolution.command, "npm");
  assert.deepEqual(resolution.args, ["run", "analyze"]);
});

test("analyze is hidden without a script or a Flutter project", () => {
  const root = fixture({ "package.json": { name: "web", scripts: { dev: "next dev" } } });
  const resolution = resolveAction("analyze", detectProject(root));
  assert.equal(resolution.ok, false);
  assert.match(resolution.reason, /Flutter/);
});

test("reports every action as unsupported when nothing is detected", () => {
  const root = fixture({ "notes.txt": "empty\n" });
  const project = detectProject(root);
  assert.deepEqual(project.packages, []);
  for (const id of ["build-mobile", "mobile-live", "web-live", "next-live", "adb-install", "analyze"]) {
    const resolution = resolveAction(id, project);
    assert.equal(resolution.ok, false, id);
    assert.ok(resolution.reason.length > 0, id);
  }
});

// Discovery lists the specialized buttons plus one button per remaining script.
// A script a specialized action already runs is claimed, never listed twice.
test("discovers every remaining defined script without duplicating claimed ones", () => {
  const root = fixture({
    "package.json": { name: "app", scripts: { test: "node --test", lint: "eslint .", "build:mobile:hosted": "x" } },
  });
  const project = detectProject(root);
  const actions = discoverActions(project);

  assert.deepEqual(
    actions.map((action) => action.id),
    ["build-mobile", scriptId(root, "lint"), scriptId(root, "test")],
    "specialized buttons come first, then the remaining scripts in order",
  );
  assert.deepEqual(
    actions.map((action) => action.label),
    ["Build", "lint", "test"],
    "a unique script name is its own label",
  );
  assert.ok(
    !actions.some((action) => action.id.endsWith(":build:mobile:hosted")),
    "the script behind build-mobile is not offered a second time",
  );
  // The specialized resolution reports the script it runs, which is what lets
  // discovery claim it.
  assert.equal(resolveAction("build-mobile", project).script, "build:mobile:hosted");

  const test = resolveAction(scriptId(root, "test"), project);
  assert.equal(test.ok, true);
  assert.equal(test.command, "npm");
  assert.deepEqual(test.args, ["run", "test"]);
  assert.equal(test.cwd, root);
  assert.equal(test.stdin, false, "a plain script never reads hot-reload keys");
  assert.deepEqual(test.env, {});
  assert.equal(test.script, "test");
  assert.equal(test.title, "Script test (npm run test)");
});

// The owner's path is the identity: the same script name in two packages gets
// two ids and two labels instead of colliding on the bare name.
test("same-named scripts on different packages get distinct ids and labels", () => {
  const root = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": { name: "repo", private: true, scripts: { test: "echo root" } },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "apps/web/package.json": { name: "web", scripts: { test: "echo web" } },
  });
  const web = path.join(root, "apps/web");
  const project = detectProject(web);
  const rootId = scriptId(root, "test");
  const webId = scriptId(web, "test");

  const tests = discoverActions(project).filter((action) => action.id.includes(":test"));
  assert.deepEqual(tests.map((action) => action.id).sort(), [rootId, webId].sort());
  assert.equal(new Set(tests.map((action) => action.label)).size, 2, "labels stay distinct");

  assert.equal(resolveAction(webId, project).cwd, web, "the nested package runs its own script");
  assert.equal(resolveAction(rootId, project).cwd, root);
});

// A dynamic id is resolved against the project on every call, so a script that
// has been removed since discovery becomes unsupported instead of running stale.
test("resolveAction resolves a discovered script freshly and drops it when removed", () => {
  const root = fixture({ "package.json": { name: "app", scripts: { test: "node --test" } } });
  const id = scriptId(root, "test");
  assert.ok(discoverActions(detectProject(root)).some((action) => action.id === id));
  assert.equal(resolveAction(id, detectProject(root)).ok, true);

  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "app", scripts: { dev: "node server.js" } }),
  );
  const project = detectProject(root);
  const resolution = resolveAction(id, project);
  assert.equal(resolution.ok, false);
  assert.match(resolution.reason, /Unknown action/);
  assert.ok(!discoverActions(project).some((action) => action.id === id));
});

// A raw `ownerDir:script` join cannot tell a directory named "pkg:x" from a
// script named "x:build:web". The encoded id keeps the two pairs apart.
test("per-script ids encode the colon so path and script never merge", () => {
  const root = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": { name: "outer", scripts: { lint: "eslint ." } },
    "pkg:x/package.json": { name: "inner", scripts: { "build:web": "vite build" } },
  });
  const inner = path.join(root, "pkg:x");
  const project = detectProject(inner);

  // Two different (ownerDir, script) pairs that a raw join would collapse.
  const rawA = `script:${path.join(root, "pkg")}:x:build:web`;
  const rawB = `script:${inner}:build:web`;
  assert.equal(rawA, rawB, "the raw join really does collide");
  const encodedA = scriptId(path.join(root, "pkg"), "x:build:web");
  const encodedB = scriptId(inner, "build:web");
  assert.notEqual(encodedA, encodedB, "the encoded ids stay distinct");

  const entry = discoverActions(project).find((action) => action.id === encodedB);
  assert.ok(entry, "discovery emits the encoded id");
  assert.ok(entry.id.includes("%3A"), "the ':' in the path and script name is encoded");
  assert.ok(!entry.id.includes(`${inner}:`), "the raw directory never appears as the separator");

  const resolved = resolveAction(encodedB, project);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.cwd, inner);
  assert.equal(resolved.script, "build:web");
});

const CARGO_IDS = [
  ["cargo-build", ["build"]],
  ["cargo-run", ["run"]],
  ["cargo-test", ["test"]],
  ["cargo-check", ["check"]],
  ["cargo-clippy", ["clippy"]],
  ["cargo-fmt", ["fmt", "--check"]],
];

// Rust buttons do not need package.json: the manifest alone is the project.
test("a Cargo-only project gets the six Cargo commands", () => {
  const root = fixture({
    "Cargo.toml": "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
    "src/lib.rs": "",
  });
  const project = detectProject(root);
  assert.deepEqual(project.packages, [], "no package.json is required");
  assert.equal(project.cargo.dir, root);

  const actions = discoverActions(project);
  assert.deepEqual(
    actions.map((action) => action.id),
    CARGO_IDS.map(([id]) => id),
    "only the six Cargo commands are supported",
  );
  assert.deepEqual(actions.map((action) => action.label), [
    "Cargo build",
    "Cargo run",
    "Cargo test",
    "Cargo check",
    "Cargo clippy",
    "Cargo fmt",
  ]);

  // Resolution is a plain command spec; no cargo process is started here.
  for (const [id, args] of CARGO_IDS) {
    const resolution = resolveAction(id, project);
    assert.equal(resolution.ok, true, id);
    assert.equal(resolution.command, "cargo", id);
    assert.deepEqual(resolution.args, args, id);
    assert.equal(resolution.cwd, root, id);
    assert.deepEqual(resolution.env, {}, id);
    assert.equal(resolution.stdin, false, id);
    assert.equal(resolution.display, `cargo ${args.join(" ")}`, id);
  }
});

test("cargo run is offered for a library-only manifest without guessing a bin", () => {
  const root = fixture({
    "Cargo.toml": "[package]\nname = \"lib\"\n\n[lib]\npath = \"src/lib.rs\"\n",
    "src/lib.rs": "",
  });
  const resolution = resolveAction("cargo-run", detectProject(root));
  assert.equal(resolution.ok, true);
  assert.deepEqual(resolution.args, ["run"], "no --bin and no target is invented");
  assert.equal(resolution.display, "cargo run");
});

test("the nearest Cargo manifest inside a workspace owns the cargo cwd", () => {
  const root = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "Cargo.toml": "[workspace]\nmembers = [\"crates/a\"]\n",
    "crates/a/Cargo.toml": "[package]\nname = \"a\"\n",
    "crates/a/src/main.rs": "",
  });
  const crate = path.join(root, "crates/a");

  const deep = detectProject(path.join(crate, "src"));
  assert.equal(deep.cargo.dir, crate, "the nested crate wins over the workspace root");
  assert.equal(resolveAction("cargo-test", deep).cwd, crate);

  const atRoot = detectProject(root);
  assert.equal(atRoot.cargo.dir, root, "the workspace manifest is the nearest one here");
  assert.equal(resolveAction("cargo-build", atRoot).cwd, root);
});

test("mixed JS and Rust keep package scripts and Cargo commands distinct", () => {
  const root = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": { name: "app", scripts: { test: "node --test", lint: "eslint ." } },
    "Cargo.toml": "[package]\nname = \"app\"\n",
  });
  const project = detectProject(root);
  const actions = discoverActions(project);
  assert.deepEqual(
    actions.slice(0, 6).map((action) => action.id),
    CARGO_IDS.map(([id]) => id),
    "Cargo commands follow the specialized buttons",
  );
  const labels = new Map(actions.map((action) => [action.id, action.label]));
  assert.equal(labels.get("cargo-test"), "Cargo test");
  assert.equal(labels.get(scriptId(root, "test")), "test", "software scripts read as before");

  const cargo = resolveAction("cargo-test", project);
  assert.equal(cargo.command, "cargo");
  assert.deepEqual(cargo.args, ["test"]);
  assert.equal(cargo.cwd, root);

  const script = resolveAction(scriptId(root, "test"), project);
  assert.equal(script.command, "npm");
  assert.deepEqual(script.args, ["run", "test"]);
  assert.equal(script.cwd, root);
});

test("no Cargo manifest above the folder means no Cargo action", () => {
  const root = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": { name: "js", scripts: {} },
  });
  const project = detectProject(root);
  assert.equal(project.cargo, undefined);
  assert.ok(!discoverActions(project).some((action) => action.id.startsWith("cargo-")));
  const resolution = resolveAction("cargo-build", project);
  assert.equal(resolution.ok, false);
  assert.match(resolution.reason, /Cargo/);
});

test("a removed Cargo manifest drops the buttons on fresh detection", () => {
  const root = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "Cargo.toml": "[package]\nname = \"gone\"\n",
  });
  assert.ok(discoverActions(detectProject(root)).some((action) => action.id === "cargo-build"));

  rmSync(path.join(root, "Cargo.toml"));
  const fresh = detectProject(root);
  assert.equal(fresh.cargo, undefined);
  assert.ok(!discoverActions(fresh).some((action) => action.id.startsWith("cargo-")));
  const resolution = resolveAction("cargo-build", fresh);
  assert.equal(resolution.ok, false);
  assert.match(resolution.reason, /Cargo/);
});

test("detector caches until asked for a fresh read", () => {
  const root = fixture({ "package.json": { name: "cache", scripts: {} } });
  const detector = createProjectDetector({ ttlMs: 60_000 });
  assert.equal(resolveAction("next-live", detector.detect(root)).ok, false);

  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ scripts: { "dev:web": "pnpm --dir apps/web dev" } }),
  );

  assert.equal(resolveAction("next-live", detector.detect(root)).ok, false);
  assert.equal(resolveAction("next-live", detector.detect(root, { fresh: true })).ok, true);
});

test("session directory wins over the configured location", () => {
  const other = "/tmp/project-runners-session";
  const context = {
    location: { directory: "/tmp/project-runners-location" },
    data: {
      session: {
        get(id) {
          if (id === "s1") return { directory: other };
          return undefined;
        },
      },
    },
  };
  assert.equal(resolveSessionDirectory(context, "s1"), other);
  assert.equal(resolveSessionDirectory(context, "missing"), "/tmp/project-runners-location");
  assert.equal(
    resolveSessionDirectory({ data: { session: { get() { throw new Error("boom"); } } } }, "s1"),
    process.cwd(),
  );
});

test("strips terminal escapes before buffering output", () => {
  assert.equal(cleanOutput("\u001b[31mred\u001b[0m plain"), "red plain");
  assert.equal(cleanOutput("\u001b[2K\u001b]0;title\u0007done"), "done");
});

test("captures output and reports a clean exit", async () => {
  const manager = createRunnerManager({ notifyMs: 0 });
  try {
    const result = manager.start({
      actionId: "build-mobile",
      label: "Build mobile",
      command: NODE,
      args: ["-e", "console.log('hello from runner')"],
      cwd: tmpdir(),
    });
    assert.equal(result.ok, true);
    const key = result.key;
    await waitFor(() => manager.snapshot(key).running === false, "clean exit");
    const snapshot = manager.snapshot(key);
    assert.equal(snapshot.status, "exited");
    assert.equal(snapshot.exitCode, 0);
    assert.deepEqual(snapshot.lines, ["hello from runner"]);
  } finally {
    manager.dispose();
  }
});

test("surfaces a nonzero exit code and stderr", async () => {
  const manager = createRunnerManager({ notifyMs: 0 });
  try {
    const { key } = manager.start({
      actionId: "next-live",
      label: "Next.js server live",
      command: NODE,
      args: ["-e", "console.error('boom'); process.exit(3)"],
      cwd: tmpdir(),
    });
    await waitFor(() => !manager.snapshot(key).running, "failure exit");
    const snapshot = manager.snapshot(key);
    assert.equal(snapshot.status, "failed");
    assert.equal(snapshot.exitCode, 3);
    assert.ok(snapshot.lines.includes("boom"));
  } finally {
    manager.dispose();
  }
});

test("reports a missing binary as a failed run", async () => {
  const manager = createRunnerManager({ notifyMs: 0 });
  try {
    const { key } = manager.start({
      actionId: "build-mobile",
      label: "Build mobile",
      command: "project-runners-missing-binary",
      args: [],
      cwd: tmpdir(),
    });
    await waitFor(() => !manager.snapshot(key).running, "spawn error");
    const snapshot = manager.snapshot(key);
    assert.equal(snapshot.status, "failed");
    assert.match(snapshot.error, /ENOENT/);
  } finally {
    manager.dispose();
  }
});

test("refuses a second run of the same action in the same directory", async () => {
  const manager = createRunnerManager({ notifyMs: 0 });
  try {
    const first = manager.start({
      actionId: "web-live",
      label: "Web live (Flutter)",
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tmpdir(),
      stdin: true,
    });
    assert.equal(first.ok, true);
    const second = manager.start({
      actionId: "web-live",
      label: "Web live (Flutter)",
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tmpdir(),
      stdin: true,
    });
    assert.equal(second.ok, false);
    assert.equal(second.code, "already-running");
    assert.equal(second.key, first.key);
    assert.equal(manager.list().length, 1);
  } finally {
    manager.dispose();
  }
});

test("bounds buffered output and keeps the newest lines", async () => {
  const manager = createRunnerManager({ notifyMs: 0, maxLines: 20, maxLineChars: 40 });
  try {
    const { key } = manager.start({
      actionId: "build-mobile",
      label: "Build mobile",
      command: NODE,
      args: [
        "-e",
        "for (let i = 0; i < 300; i += 1) console.log('\\u001b[31mline ' + i + '\\u001b[0m')",
      ],
      cwd: tmpdir(),
    });
    await waitFor(() => !manager.snapshot(key).running, "bulk output");
    const snapshot = manager.snapshot(key, 200);
    assert.ok(snapshot.lines.length <= 20);
    assert.equal(snapshot.lines.at(-1), "line 299");
    assert.ok(snapshot.lines.every((line) => !line.includes("\u001b")));
  } finally {
    manager.dispose();
  }
});

test("keeps a carriage-return counter on one line and commits it on a newline", async () => {
  const manager = createRunnerManager({ notifyMs: 0 });
  try {
    const { key } = manager.start({
      actionId: "build-mobile",
      label: "Build mobile",
      command: NODE,
      args: [
        "-e",
        "const w = (text) => process.stdout.write(text);" +
          "w('first\\r\\n');" +
          "w('step 1\\r');" +
          "setTimeout(() => w('step 2\\r'), 150);" +
          "setTimeout(() => w('done\\n'), 600);",
      ],
      cwd: tmpdir(),
    });
    await waitFor(() => manager.snapshot(key).progress.length > 0, "progress line");
    const live = manager.snapshot(key);
    // A redrawn counter is one live line, never a line per tick.
    assert.ok(["step 1", "step 2"].includes(live.progress), live.progress);
    assert.deepEqual(live.lines, ["first"]);
    await waitFor(() => !manager.snapshot(key).running, "progress exit");
    const snapshot = manager.snapshot(key);
    // The carriage-return line that ends with a newline survives as history.
    assert.deepEqual(snapshot.lines, ["first", "done"]);
    assert.equal(snapshot.lineCount, 2);
  } finally {
    manager.dispose();
  }
});

test("keeps the whole retained history and still honors a tail request", async () => {
  const manager = createRunnerManager({ notifyMs: 0, maxLines: 60 });
  try {
    const { key } = manager.start({
      actionId: "build-mobile",
      label: "Build mobile",
      command: NODE,
      args: ["-e", "for (let i = 0; i < 50; i += 1) console.log('line ' + i)"],
      cwd: tmpdir(),
    });
    await waitFor(() => !manager.snapshot(key).running, "history");
    const snapshot = manager.snapshot(key);
    assert.equal(snapshot.lineCount, 50);
    assert.equal(snapshot.lines.length, 50);
    assert.equal(snapshot.lines.at(-1), "line 49");
    assert.deepEqual(manager.snapshot(key, 3).lines, ["line 47", "line 48", "line 49"]);
    assert.deepEqual(manager.snapshot(key, 0).lines, []);
  } finally {
    manager.dispose();
  }
});

test("reports elapsed time from the injected clock and freezes it at exit", async () => {
  let clock = 1_000;
  const manager = createRunnerManager({ notifyMs: 0, now: () => clock });
  try {
    const { key } = manager.start({
      actionId: "web-live",
      label: "Web live (Flutter)",
      command: NODE,
      args: ["-e", "setTimeout(() => {}, 300)"],
      cwd: tmpdir(),
    });
    clock = 4_000;
    assert.equal(manager.snapshot(key).elapsedMs, 3_000);
    await waitFor(() => !manager.snapshot(key).running, "clock exit");
    assert.equal(manager.snapshot(key).elapsedMs, 3_000);
    // A finished run keeps its final duration instead of counting forever.
    clock = 90_000;
    assert.equal(manager.snapshot(key).elapsedMs, 3_000);
  } finally {
    manager.dispose();
  }
});

test("stops the owned process and marks it stopped", async () => {
  const manager = createRunnerManager({ notifyMs: 0, killGraceMs: 2000 });
  try {
    const { key } = manager.start({
      actionId: "mobile-live",
      label: "Mobile live",
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tmpdir(),
      stdin: true,
    });
    assert.equal(manager.stop(key), true);
    await waitFor(() => !manager.snapshot(key).running, "stop");
    const snapshot = manager.snapshot(key);
    assert.equal(snapshot.status, "stopped");
    assert.equal(snapshot.signal, "SIGTERM");
    assert.equal(manager.stop(key), false);
  } finally {
    manager.dispose();
  }
});

test("a stopped run drops its pending-stop flags once the group is gone", async () => {
  const manager = createRunnerManager({ notifyMs: 0, killGraceMs: 2000 });
  try {
    const { key } = manager.start({
      actionId: "mobile-live",
      label: "Mobile live",
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tmpdir(),
    });
    assert.equal(manager.stop(key), true);
    await waitFor(() => !manager.snapshot(key).running, "stop");
    await waitFor(() => manager.snapshot(key).stopping === false, "pending stop cleared");
    const snapshot = manager.snapshot(key);
    assert.equal(snapshot.status, "stopped");
    assert.equal(snapshot.stopping, false);
    assert.equal(snapshot.orphaned, false);
    assert.equal(snapshot.stopError, undefined);
  } finally {
    manager.dispose();
  }
});

test("the final SIGKILL eventually clears pending-stop flags", async () => {
  const signals = [];
  let groupExists = true;
  const manager = createRunnerManager({
    notifyMs: 0,
    killGraceMs: 30,
    gonePollMs: 5,
    gonePollLimit: 50,
    probeGroup: () => groupExists,
    readProcessStat: () => undefined,
    killProcessGroup: (pgid, signal) => {
      signals.push(signal);
    },
  });
  let pid;
  try {
    const { key, run } = manager.start({
      actionId: "mobile-live",
      label: "Async kill",
      command: NODE,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      cwd: tmpdir(),
    });
    pid = run.pid;
    assert.equal(manager.stop(key), true);
    await waitFor(() => signals.includes("SIGKILL"), "grace SIGKILL");
    assert.equal(manager.snapshot(key).stopping, true);
    // The leader ignores signals in this test, so only the bounded probe can
    // report the truth once the group is gone.
    groupExists = false;
    await waitFor(() => manager.snapshot(key).stopping === false, "gone confirmation");
    assert.equal(manager.snapshot(key).orphaned, false);
  } finally {
    manager.dispose();
    if (pid) {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // group already gone
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
});

test("a successful stop retry clears the previous stop error", async () => {
  let refuse = true;
  const manager = createRunnerManager({
    notifyMs: 0,
    killGraceMs: 1000,
    killProcessGroup: (pgid, signal) => {
      if (refuse && signal === "SIGTERM") {
        refuse = false;
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      return process.kill(-pgid, signal);
    },
  });
  try {
    const { key } = manager.start({
      actionId: "mobile-live",
      label: "Retry stop",
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tmpdir(),
    });
    assert.equal(manager.stop(key), false);
    assert.match(manager.snapshot(key).stopError, /EPERM/);
    assert.equal(manager.stop(key), true);
    await waitFor(() => !manager.snapshot(key).running, "retry stop");
    assert.equal(manager.snapshot(key).stopError, undefined);
    assert.deepEqual(manager.stopAll(), { stopped: 0, failed: 0 });
  } finally {
    manager.dispose();
  }
});

test("dispose stops every owned child", async () => {
  const manager = createRunnerManager({ notifyMs: 0, killGraceMs: 2000 });
  const { run } = manager.start({
    actionId: "next-live",
    label: "Next.js server live",
    command: NODE,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: tmpdir(),
  });
  manager.dispose();
  await waitFor(() => run.status !== "running", "dispose stop");
  assert.equal(run.status, "stopped");
});

test("stop reaches the descendants of the owned process group", async () => {
  const manager = createRunnerManager({ notifyMs: 0, killGraceMs: 1000 });
  try {
    const { key, pid } = await startNested(manager);
    assert.equal(manager.stop(key), true);
    await waitFor(() => !manager.snapshot(key).running, "stop");
    await waitFor(() => !isAlive(pid), "grandchild exit");
  } finally {
    manager.dispose();
  }
});

test("dispose leaves no descendant behind", async () => {
  const manager = createRunnerManager({ notifyMs: 0, killGraceMs: 1000 });
  const { pid } = await startNested(manager);
  manager.dispose();
  await waitFor(() => !isAlive(pid), "grandchild exit after dispose");
});

// A leader that dies on SIGTERM but leaves a descendant that ignores SIGTERM,
// so only the grace SIGKILL can clear the group.
const LEADER_EXITS_SCRIPT = `
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
  process.stdout.write("descendant " + child.pid + "\\n");
  setInterval(() => {}, 1000);
`;

test("the grace SIGKILL outlives a leader that exits before its group", async () => {
  const manager = createRunnerManager({ notifyMs: 0, killGraceMs: 300 });
  let pid;
  try {
    const { key } = manager.start({
      actionId: "mobile-live",
      label: "Leader exits",
      command: NODE,
      args: ["-e", LEADER_EXITS_SCRIPT],
      cwd: tmpdir(),
    });
    await waitFor(() => manager.snapshot(key).lines.length > 0, "descendant pid");
    pid = Number(manager.snapshot(key).lines[0].split(" ")[1]);
    assert.ok(pid > 0, "descendant pid was reported");
    assert.equal(isAlive(pid), true, "descendant survives the leader's SIGTERM");

    assert.equal(manager.stop(key), true);
    await waitFor(() => !isAlive(pid), "descendant killed after the grace period");
    assert.equal(manager.snapshot(key).status, "stopped");
  } finally {
    manager.dispose();
    if (pid) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  }
});

test("a group that is already gone receives no late signal", async () => {
  const signals = [];
  const manager = createRunnerManager({
    notifyMs: 0,
    killGraceMs: 100,
    probeGroup: () => false,
    readProcessStat: () => undefined,
    killProcessGroup: (pgid, signal) => signals.push(signal),
  });
  const { key, run } = manager.start({
    actionId: "mobile-live",
    label: "Gone group",
    command: NODE,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: tmpdir(),
  });
  try {
    assert.equal(manager.stop(key), true);
    await new Promise((resolve) => setTimeout(resolve, 260));
    assert.deepEqual(signals, ["SIGTERM"]);
    assert.equal(manager.snapshot(key).running, true);
  } finally {
    manager.dispose();
    try {
      process.kill(-run.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

test("a refused SIGTERM is reported instead of a silent success", async () => {
  const manager = createRunnerManager({
    notifyMs: 0,
    killGraceMs: 100,
    killProcessGroup: (pgid, signal) => {
      if (signal === "SIGTERM") {
        const error = new Error("operation not permitted");
        error.code = "EPERM";
        throw error;
      }
      return process.kill(-pgid, signal);
    },
  });
  try {
    const { key, run } = manager.start({
      actionId: "mobile-live",
      label: "Refused stop",
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tmpdir(),
    });
    assert.equal(manager.stop(key), false);
    const snapshot = manager.snapshot(key);
    assert.match(snapshot.stopError, /EPERM/);
    assert.equal(snapshot.running, true);
    assert.equal(isAlive(run.pid), true);
  } finally {
    manager.dispose();
  }
});

test("a repeated stop schedules no second grace timer", async () => {
  const signals = [];
  const manager = createRunnerManager({
    notifyMs: 0,
    killGraceMs: 120,
    probeGroup: () => true,
    readProcessStat: () => undefined,
    killProcessGroup: (pgid, signal) => {
      signals.push(signal);
      if (signal === "SIGKILL") process.kill(-pgid, signal);
    },
  });
  try {
    const { key } = manager.start({
      actionId: "mobile-live",
      label: "Repeated stop",
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tmpdir(),
    });
    assert.equal(manager.stop(key), true);
    assert.equal(manager.stop(key), false);
    await new Promise((resolve) => setTimeout(resolve, 320));
    assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
  } finally {
    manager.dispose();
  }
});

test("dispose kills a group that is already waiting on the grace timer", async () => {
  const manager = createRunnerManager({ notifyMs: 0, killGraceMs: 60_000 });
  let pid;
  try {
    const { key } = manager.start({
      actionId: "mobile-live",
      label: "Pending stop",
      command: NODE,
      args: ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"],
      cwd: tmpdir(),
    });
    pid = manager.snapshot(key).pid;
    assert.equal(manager.stop(key), true);
    await waitFor(() => manager.snapshot(key).stopping === true, "stopping");
    assert.equal(isAlive(pid), true, "leader ignores SIGTERM and waits out the timer");
  } finally {
    manager.dispose();
  }
  await waitFor(() => !isAlive(pid), "dispose escalated the pending group");
});

test("dispose leaves an already completed run untouched", async () => {
  const signals = [];
  const manager = createRunnerManager({
    notifyMs: 0,
    killProcessGroup: (pgid, signal) => signals.push(signal),
  });
  const { key } = manager.start({
    actionId: "mobile-live",
    label: "Finished run",
    command: NODE,
    args: ["-e", "process.exit(0)"],
    cwd: tmpdir(),
  });
  await waitFor(() => !manager.snapshot(key).running, "run exit");
  manager.dispose();
  assert.deepEqual(signals, []);
});

// A leader that exits on its own right after spawning a descendant that ignores
// SIGTERM, leaving a group with no leader.
const ORPHAN_SCRIPT = `
  const { spawn } = require("node:child_process");
  const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"], { stdio: "ignore" });
  child.unref();
  // Give the descendant time to install its SIGTERM handler before this leader
  // exits and the plugin starts reaping the orphaned group.
  setTimeout(() => process.stdout.write("descendant " + child.pid + "\\n", () => process.exit(0)), 250);
`;

test("a leader that exits with a live descendant keeps ownership of the group", async () => {
  const manager = createRunnerManager({ notifyMs: 0, killGraceMs: 400 });
  let pid;
  try {
    const { key } = manager.start({
      actionId: "next-live",
      label: "Wrapper exits",
      command: NODE,
      args: ["-e", ORPHAN_SCRIPT],
      cwd: tmpdir(),
    });
    await waitFor(() => manager.snapshot(key).lines.length > 0, "descendant pid");
    pid = Number(manager.snapshot(key).lines[0].split(" ")[1]);
    assert.ok(pid > 0, "descendant pid was reported");
    await waitFor(() => !manager.snapshot(key).running, "leader exit");
    assert.equal(isAlive(pid), true, "descendant outlives the leader");
    await waitFor(() => !isAlive(pid), "orphaned group reaped after the grace period");
  } finally {
    manager.dispose();
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

test("stopAll reports truthful stopped and failed counts", async () => {
  const manager = createRunnerManager({ notifyMs: 0, killGraceMs: 1000 });
  try {
    const first = manager.start({
      actionId: "mobile-live",
      label: "First",
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tmpdir(),
    });
    const second = manager.start({
      actionId: "web-live",
      label: "Second",
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tmpdir(),
    });

    assert.equal(manager.stop(first.key), true);
    await waitFor(() => !manager.snapshot(first.key).running, "first stopped");
    assert.deepEqual(manager.stopAll(), { stopped: 1, failed: 0 });
    await waitFor(() => !manager.snapshot(second.key).running, "second stopped");
  } finally {
    manager.dispose();
  }
});

test("stopAll counts a refused signal as failed", async () => {
  const manager = createRunnerManager({
    notifyMs: 0,
    killGraceMs: 100,
    killProcessGroup: (pgid, signal) => {
      if (signal === "SIGTERM") {
        throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
      }
      return process.kill(-pgid, signal);
    },
  });
  try {
    const run = manager.start({
      actionId: "mobile-live",
      label: "Refused stop all",
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tmpdir(),
    });
    assert.deepEqual(manager.stopAll(), { stopped: 0, failed: 1 });
    assert.equal(manager.snapshot(run.key).running, true);
  } finally {
    manager.dispose();
  }
});

test("writes to stdin only for live runs that requested it", async () => {
  const manager = createRunnerManager({ notifyMs: 0 });
  try {
    const live = manager.start({
      actionId: "mobile-live",
      label: "Mobile live",
      command: NODE,
      args: ["-e", "process.stdin.resume(); process.stdin.on('data', (d) => console.log('got ' + d.toString().trim()))"],
      cwd: tmpdir(),
      stdin: true,
    });
    assert.equal(manager.send(live.key, "r\n"), true);
    await waitFor(() => manager.snapshot(live.key).lines.some((line) => line === "got r"), "stdin echo");

    const build = manager.start({
      actionId: "build-mobile",
      label: "Build mobile",
      command: NODE,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tmpdir(),
    });
    assert.equal(manager.send(build.key, "r"), false);
  } finally {
    manager.dispose();
  }
});

test("action labels stay short and keep the alias in the title", () => {
  assert.deepEqual(
    ACTIONS.map((action) => action.label),
    ["Build", "Live mobile", "Live web", "Next live", "ADB install", "Analyze"],
  );
  assert.deepEqual(
    ACTIONS.map((action) => action.id),
    ["build-mobile", "mobile-live", "web-live", "next-live", "adb-install", "analyze"],
  );
  for (const action of ACTIONS) {
    assert.ok(!action.label.includes("Vet"), `${action.label} drops the Vet prefix`);
    assert.ok(!action.label.includes("-"), `${action.label} keeps no dash`);
    assert.ok(action.label.length <= 12, `${action.label} fits a narrow cell`);
    assert.ok(
      action.title.length > action.label.length,
      `${action.id} keeps a descriptive title for the palette`,
    );
  }
});

test("resolutions carry the descriptive title next to the compact label", () => {
  const root = fixture({
    "pnpm-lock.yaml": "",
    "package.json": {
      name: "vetory",
      scripts: { "build:mobile:hosted": "x", live: "y", "live:web": "z", "dev:web": "w" },
    },
  });
  const project = detectProject(root);
  for (const action of ACTIONS) {
    const resolution = resolveAction(action.id, project);
    assert.equal(resolution.label, action.label);
    assert.equal(resolution.title, action.title);
  }
});

// Visual decisions are pure, so they are asserted as values rather than as
// markup: a wrong colour here is a wrong colour on screen.
const THEME = {
  text: { base: "#e6e6e6", muted: "#8a8a8a", feedback: { error: { base: "#ff6b6b" } } },
  border: { base: "#484848" },
  // The hue the accent resolves to in the host theme: light, and meant for
  // accent fills. It reads as near-black on the sidebar, so it must never
  // colour a label or a border.
  action: { primary: { focused: "#101010" } },
};

function row(run) {
  return { action: { id: "build-mobile", label: "Build" }, run };
}

test("no button state can dim its label or resolve a dark accent", () => {
  const states = [
    row(undefined),
    row({ running: true, status: "running" }),
    row({ running: false, status: "exited" }),
    row({ running: false, status: "stopped" }),
    row({ running: false, status: "failed", error: "boom" }),
  ];
  for (const entry of states) {
    for (const hovered of [false, true]) {
      const visual = buttonVisual(THEME, entry, hovered);
      assert.equal(visual.text, THEME.text.base, "labels stay at the sidebar foreground");
      assert.notEqual(visual.text, THEME.action.primary.focused);
      assert.notEqual(visual.border, THEME.action.primary.focused);
      assert.notEqual(visual.text, THEME.text.muted, "an enabled button is never muted");
      assert.ok(["single", "double", "heavy"].includes(visual.style));
    }
  }
});

test("button frames tell the run states apart without touching the label", () => {
  const idle = buttonVisual(THEME, row(undefined), false);
  const hover = buttonVisual(THEME, row(undefined), true);
  const running = buttonVisual(THEME, row({ running: true, status: "running" }), false);
  const failed = buttonVisual(THEME, row({ running: false, status: "failed" }), false);

  assert.deepEqual(idle, { border: THEME.border.base, style: "single", text: THEME.text.base });
  // Hover brightens the frame; the label colour never changes.
  assert.equal(hover.border, THEME.text.base);
  assert.equal(hover.style, "single");
  assert.equal(hover.text, idle.text);
  // A running button keeps its own bright double frame while hovered.
  assert.deepEqual(buttonVisual(THEME, row({ running: true, status: "running" }), true), running);
  assert.equal(running.border, THEME.text.base);
  assert.equal(running.style, "double");
  // Failure is a red heavy frame, still with a readable label.
  assert.equal(failed.border, THEME.text.feedback.error.base);
  assert.equal(failed.style, "heavy");
  assert.equal(failed.text, THEME.text.base);
  // A finished run looks like an idle button again: it stays clickable, and the
  // log dialog carries the result.
  assert.deepEqual(buttonVisual(THEME, row({ running: false, status: "exited" }), false), idle);
  assert.deepEqual(buttonVisual(THEME, row({ running: false, status: "stopped" }), false), idle);
});

test("dialog controls keep an enabled label readable and mute only a disabled one", () => {
  const enabled = controlVisual(THEME, { disabled: false, hovered: false });
  const hovered = controlVisual(THEME, { disabled: false, hovered: true });
  const disabled = controlVisual(THEME, { disabled: true, hovered: true });

  assert.deepEqual(enabled, { border: THEME.border.base, style: "single", text: THEME.text.base });
  assert.equal(hovered.border, THEME.text.base);
  assert.equal(hovered.text, THEME.text.base);
  // A disabled control is muted, and hovering it changes nothing.
  assert.equal(disabled.text, THEME.text.muted);
  assert.equal(disabled.border, THEME.border.base);
  assert.deepEqual(disabled, controlVisual(THEME, { disabled: true, hovered: false }));
});

test("status text states a pending, refused, or leftover stop as it is", () => {
  const base = { lineCount: 12, elapsedMs: 3000 };
  assert.equal(statusLine({ ...base, running: true, status: "running" }), "running 3s · 12 lines");
  assert.equal(
    statusLine({ ...base, running: true, status: "running", stopping: true }),
    "stopping after 3s · 12 lines",
    "a pending stop is not reported as a plain running state",
  );
  assert.equal(
    statusLine({ ...base, running: false, status: "stopped", stopping: true }),
    "stopped after 3s, leftovers still stopping · 12 lines",
  );
  assert.equal(
    statusLine({ ...base, running: false, status: "exited", stopping: true, orphaned: true }),
    "leftovers still stopping · 12 lines",
    "a group taken over after its leader exited says so",
  );
  // A refused stop keeps its diagnostic instead of reading as a clean stop.
  assert.equal(
    statusLine({
      ...base,
      running: true,
      status: "running",
      stopError: "stop signal failed (EPERM: not permitted)",
    }),
    "running 3s · 12 lines · stop signal failed (EPERM: not permitted)",
  );
  assert.equal(
    statusLine({ ...base, running: false, status: "stopped", stopError: "stop signal failed (EPERM)" }),
    "stopped after 3s · 12 lines · stop signal failed (EPERM)",
  );
});

test("status text reports finished runs, exit details, and long durations", () => {
  assert.equal(
    statusLine({ running: true, status: "running", elapsedMs: 70000, lineCount: 3 }),
    "running 1m10s · 3 lines",
  );
  assert.equal(statusLine({ running: false, status: "exited", elapsedMs: 2000, lineCount: 0 }), "finished in 2s");
  assert.equal(
    statusLine({
      running: false,
      status: "failed",
      elapsedMs: 3000,
      exitCode: 1,
      signal: "SIGTERM",
      lineCount: 4,
    }),
    "failed after 3s (exit 1) (SIGTERM) · 4 lines",
  );
  assert.equal(
    statusLine({ running: false, status: "failed", elapsedMs: 1000, error: "spawn adb ENOENT", lineCount: 2 }),
    "failed: spawn adb ENOENT · 2 lines",
  );
  assert.equal(statusLine(undefined), "");
});

test("only a failed run or a refused stop is painted as an error", () => {
  const error = THEME.text.feedback.error.base;
  assert.equal(statusTone(THEME, { running: true, status: "running" }), THEME.text.muted);
  assert.equal(statusTone(THEME, { running: false, status: "exited" }), THEME.text.muted);
  assert.equal(statusTone(THEME, { running: false, status: "stopped" }), THEME.text.muted);
  assert.equal(statusTone(THEME, { running: false, status: "failed" }), error);
  assert.equal(
    statusTone(THEME, { running: true, status: "running", stopError: "stop signal failed (EPERM)" }),
    error,
    "a refused stop is an error even while the runner is alive",
  );
  assert.equal(statusTone(THEME, undefined), THEME.text.muted);
});

test("token lookups fall back instead of resolving a missing path", () => {
  const sparse = { text: { base: "#fff" } };
  assert.equal(token(sparse, "textBase"), "#fff");
  // Missing muted falls back to the readable foreground, never to undefined.
  assert.equal(token(sparse, "textMuted"), "#fff");
  assert.equal(token(sparse, "textError"), "#fff");
  assert.equal(token(sparse, "borderBase"), "#fff");
  assert.equal(token({}, "textBase"), undefined);
  assert.equal(token(undefined, "textBase"), undefined);
  // The accent hue is not part of the table at all.
  assert.deepEqual(
    buttonVisual({ text: { base: "#fff" } }, row({ running: true, status: "running" }), false),
    { border: "#fff", style: "double", text: "#fff" },
  );
});
