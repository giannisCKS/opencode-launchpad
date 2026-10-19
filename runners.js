// Project runners: detect a project's dev commands and supervise the child processes.
// Node builtins only so `node --test` can load this file without the TUI host.
import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

// `label` is the compact sidebar button name. `title` is the descriptive form
// used in palette entries, the log dialog and toasts, and names the zsh alias
// the button mirrors: vet-build, vet-live, vet-live-web. Action ids, commands
// and aliases are unchanged by the short labels.
export const ACTIONS = [
  { id: "build-mobile", label: "Build", title: "Build mobile (vet-build)" },
  { id: "mobile-live", label: "Live mobile", title: "Live mobile (vet-live)" },
  { id: "web-live", label: "Live web", title: "Live web, Flutter (vet-live-web)" },
  { id: "next-live", label: "Next live", title: "Next.js server live" },
  { id: "adb-install", label: "ADB install", title: "ADB install (release APK)" },
  // Static analysis only: the project's own script when it has one, otherwise
  // `flutter analyze`. Never a build and never the validation umbrella.
  { id: "analyze", label: "Analyze", title: "Analyze mobile (mobile:analyze)" },
];

// Rust commands are buttons of their own, not package scripts. `cargo run` is
// offered even for a library-only manifest: cargo prints its own explanation in
// the log, and no binary target is guessed. Nothing is executed to discover it.
const CARGO_ACTIONS = [
  { id: "cargo-build", label: "Cargo build", title: "Cargo build", args: ["build"] },
  { id: "cargo-run", label: "Cargo run", title: "Cargo run", args: ["run"] },
  { id: "cargo-test", label: "Cargo test", title: "Cargo test", args: ["test"] },
  { id: "cargo-check", label: "Cargo check", title: "Cargo check", args: ["check"] },
  { id: "cargo-clippy", label: "Cargo clippy", title: "Cargo clippy", args: ["clippy"] },
  { id: "cargo-fmt", label: "Cargo fmt", title: "Cargo fmt --check", args: ["fmt", "--check"] },
];

const SCRIPT_CANDIDATES = {
  "build-mobile": ["build:mobile:hosted", "build:mobile"],
  "mobile-live": ["live"],
  "web-live": ["live:web"],
  "next-live": ["dev:web", "dev"],
  // No such script exists in the Vetory workspace today; a project that adds one
  // is called through the package manager instead of the built-APK fallback.
  "adb-install": ["install:adb", "mobile:install:adb", "adb:install"],
  // Vetory's `mobile:analyze` is Flutter static analysis. `analyze` is only
  // used when a project defines it itself.
  analyze: ["mobile:analyze", "analyze"],
};

// Built APK names in preference order, relative to the Flutter project. The
// button is hidden until one of them exists, so it never guesses a path.
const APK_CANDIDATES = ["app-release.apk", "app-debug.apk"];
const APK_DIR = path.join("build", "app", "outputs", "flutter-apk");
// Scripts that accept a defines file in this workspace; only set when the file exists.
const DEFINES_FILE = "local-public-defines.json";
const DEFINES_SCRIPTS = new Set(["build:mobile:hosted", "live", "live:web"]);

const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["bun.lockb", "bun"],
  ["bun.lock", "bun"],
  ["yarn.lock", "yarn"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

const LIVE_ACTIONS = new Set(["mobile-live", "web-live"]);

// Theme paths in preference order. text.action.primary.* is deliberately absent:
// in the host theme it is a light interactive hue meant for accent fills and it
// reads as near-black on the sidebar. text.base is the foreground the sidebar
// itself draws with, so it is always readable against the sidebar background.
const TEXT_TOKENS = {
  textBase: ["text.base"],
  textMuted: ["text.muted", "text.base"],
  textError: ["text.feedback.error.base", "text.error", "text.base"],
  borderBase: ["border.base", "text.muted", "text.base"],
};

function readToken(theme, path) {
  let node = theme;
  for (const key of path.split(".")) {
    if (node === undefined || node === null) return undefined;
    try {
      node = node[key];
    } catch {
      return undefined;
    }
  }
  return node ?? undefined;
}

export function token(theme, name) {
  for (const path of TEXT_TOKENS[name] ?? []) {
    const value = readToken(theme, path);
    if (value !== undefined) return value;
  }
  return undefined;
}

// A button paints no background, so the button background is always the sidebar
// background. Every label uses text.base, so no state can dim a label into the
// background. The frame carries the state:
//   idle             mid-grey single frame
//   hover            bright single frame
//   running          bright double frame
//   finished/stopped the idle frame again; the log dialog shows the result
//   failed           red heavy frame
// Hover only brightens an idle frame: a running or failed button keeps its own
// frame so the state stays visible while the pointer rests on it.
export function buttonVisual(theme, row, hovered) {
  const border = token(theme, "borderBase");
  const text = token(theme, "textBase");
  const base = { border, style: "single", text };
  if (!row) return base;

  const run = row.run;
  if (run?.running) return { border: text, style: "double", text };
  if (run && run.status !== "exited" && run.status !== "stopped") {
    return { border: token(theme, "textError"), style: "heavy", text };
  }
  if (hovered) return { border: text, style: "single", text };
  return base;
}

// Dialog controls: an enabled control always uses text.base; only a disabled
// control is muted, and the fallback chain keeps even that readable.
export function controlVisual(theme, state = {}) {
  if (state.disabled) {
    return { border: token(theme, "borderBase"), style: "single", text: token(theme, "textMuted") };
  }
  return {
    border: state.hovered ? token(theme, "textBase") : token(theme, "borderBase"),
    style: "single",
    text: token(theme, "textBase"),
  };
}

// Elapsed seconds for the status line: `42s`, then `1m07s`.
export function elapsedText(ms) {
  const seconds = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

// Status text for the log dialog. A stop that was refused, a stop that is still
// waiting for descendants, and a group left behind by a leader that exited on
// its own are each stated as they are instead of being folded into "stopped".
export function statusLine(snapshot) {
  if (!snapshot) return "";
  const parts = [];
  if (snapshot.lineCount) parts.push(`${snapshot.lineCount} lines`);
  // A refused stop signal is a real error and must not vanish from the line.
  if (snapshot.stopError) parts.push(snapshot.stopError);
  const tail = parts.length ? ` · ${parts.join(" · ")}` : "";
  const time = elapsedText(snapshot.elapsedMs);

  if (snapshot.orphaned) return `leftovers still stopping${tail}`;
  if (snapshot.stopping && snapshot.running) return `stopping after ${time}${tail}`;
  if (snapshot.stopping) return `stopped after ${time}, leftovers still stopping${tail}`;
  if (snapshot.running) return `running ${time}${tail}`;
  if (snapshot.status === "exited") return `finished in ${time}${tail}`;
  if (snapshot.status === "stopped") return `stopped after ${time}${tail}`;
  if (snapshot.error) return `failed: ${snapshot.error}${tail}`;
  const code = snapshot.exitCode === undefined ? "" : ` (exit ${snapshot.exitCode})`;
  const signal = snapshot.signal ? ` (${snapshot.signal})` : "";
  return `failed after ${time}${code}${signal}${tail}`;
}

// Only a failed run or a stop that did not go through is painted as an error.
export function statusTone(theme, snapshot) {
  if (!snapshot) return token(theme, "textMuted");
  const ok = snapshot.running || snapshot.status === "exited" || snapshot.status === "stopped";
  return ok && !snapshot.stopError ? token(theme, "textMuted") : token(theme, "textError");
}

// The dialog's layer is registered by the dialog itself, so its keys exist only
// while the popup is mounted. Each command calls the runtime the view already
// holds, so no module state stands between a key and the run it drives.
// `mode: "modal"` keeps them inside the popup. Escape hides the dialog and never
// touches the runner; the host's own modal layer also closes on Escape, so a
// lost layer never traps the popup.
export function dialogKeyLayer(context, close, runtime, runKey) {
  let disposed = false;
  // The dialog advertises these keys, so a mounted popup consumes them instead
  // of leaking them to the host mid-dialog. A refusal is reported by the
  // runtime call, which never pretends the key reached the child.
  const command = (run) => () => {
    // Already unmounted: let the host handle the key instead.
    if (disposed) return false;
    run?.();
    return true;
  };
  const dispose = context?.keymap?.layer?.(() => ({
    mode: "modal",
    commands: [
      { bind: "escape", title: "Hide log", group: "Dialog", run: command(close) },
      {
        bind: "r",
        title: "Reload (hot reload)",
        group: "Dialog",
        run: command(() => runtime?.send?.(runKey, "r")),
      },
      {
        // Upper-case keys are spelled shift+<key>; a bare "R" matches no key.
        bind: "shift+r",
        title: "Restart (hot restart)",
        group: "Dialog",
        run: command(() => runtime?.send?.(runKey, "R")),
      },
      {
        // Stop is the runner's stop path, never a byte for Flutter to read.
        bind: "s",
        title: "Stop runner",
        group: "Dialog",
        run: command(() => runtime?.requestStop?.(runKey)),
      },
    ],
  }));
  return () => {
    disposed = true;
    try {
      dispose?.();
    } catch {
      // the host already dropped the layer
    }
  };
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function findUp(start, name) {
  let dir = path.resolve(start || ".");
  for (;;) {
    const file = path.join(dir, name);
    if (existsSync(file)) return { file, dir };
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

// Nearest Cargo.toml above `start`, stopping at the repository/workspace
// boundary so a manifest outside the session's own project cannot be adopted.
// A nested crate wins over its workspace root because the walk returns the
// first manifest it meets.
function findCargoManifest(start) {
  let dir = path.resolve(start || ".");
  for (;;) {
    const file = path.join(dir, "Cargo.toml");
    if (existsSync(file)) return { file, dir };
    if (isBoundary(dir, undefined)) return undefined;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function packageManagerFor(root) {
  for (const [lockfile, manager] of LOCKFILES) {
    if (existsSync(path.join(root, lockfile))) return manager;
  }
  return "npm";
}

function hasDependency(pkg, name) {
  for (const field of ["dependencies", "devDependencies"]) {
    const deps = pkg?.[field];
    if (deps && Object.prototype.hasOwnProperty.call(deps, name)) return true;
  }
  return false;
}

// A workspace or repository root: the walk up stops here, so an unrelated
// project above it can never donate its scripts.
function isBoundary(dir, pkg) {
  if (existsSync(path.join(dir, ".git"))) return true;
  if (pkg && pkg.workspaces !== undefined) return true;
  if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) return true;
  if (existsSync(path.join(dir, "lerna.json"))) return true;
  return false;
}

// Nearest-first package.json chain. Without a workspace or repository boundary
// the chain keeps only the nearest package: a plain parent folder is not a
// project to inherit from.
export function packageChain(start) {
  const chain = [];
  let dir = path.resolve(start || ".");
  let bounded = false;
  for (;;) {
    const file = path.join(dir, "package.json");
    if (existsSync(file)) {
      const parsed = readJson(file);
      const pkg = parsed && typeof parsed === "object" ? parsed : {};
      chain.push({
        dir,
        scripts: pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {},
        hasNext: hasDependency(pkg, "next"),
      });
      if (isBoundary(dir, pkg)) {
        bounded = true;
        break;
      }
    } else if (isBoundary(dir, undefined)) {
      bounded = true;
      break;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return bounded ? chain : chain.slice(0, 1);
}

// Reads the package chain and the nearest pubspec.yaml above `dir`.
export function detectProject(dir) {
  const start = path.resolve(dir || ".");
  const packages = packageChain(start);
  const nearest = packages[0];
  const outermost = packages[packages.length - 1];
  const flutter = findUp(start, "pubspec.yaml");
  const cargo = findCargoManifest(start);
  return {
    dir: start,
    // Nearest package names the project; the outermost one carries the lockfile.
    root: nearest ? nearest.dir : start,
    packages,
    // Rust manifests work with or without package.json; cargo cwd is its owner.
    cargo,
    packageManager: packageManagerFor(outermost ? outermost.dir : start),
    flutterDir: flutter ? flutter.dir : undefined,
    hasFlutterWeb: flutter ? existsSync(path.join(flutter.dir, "web")) : false,
    apk: findApk(flutter?.dir, [nearest ? nearest.dir : start, outermost ? outermost.dir : start]),
  };
}

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter(
        (entry) =>
          entry.isDirectory() && !entry.name.startsWith(".") && entry.name !== "node_modules",
      )
      .map((entry) => entry.name)
      .sort()
      .slice(0, 50);
  } catch {
    return [];
  }
}

// The built APK of the Flutter project this session belongs to. The nearest
// pubspec.yaml above the session is checked first; next the app one level down
// from the session's own package and from the workspace root (apps/<name>, then
// any child), so the button also appears from a nested package or the
// repository root. Only an APK that already exists on disk counts, so a path is
// never guessed.
function findApk(flutterDir, roots) {
  const dirs = [];
  const add = (dir) => {
    if (dir && !dirs.includes(dir)) dirs.push(dir);
  };
  add(flutterDir);
  for (const root of roots) {
    for (const base of [path.join(root, "apps"), root]) {
      for (const name of listDirs(base)) add(path.join(base, name));
    }
  }
  for (const dir of dirs) {
    if (!existsSync(path.join(dir, "pubspec.yaml"))) continue;
    for (const name of APK_CANDIDATES) {
      const file = path.join(dir, APK_DIR, name);
      if (existsSync(file)) return { dir, file };
    }
  }
  return undefined;
}

function unsupported(actionId, label, reason, project) {
  return { actionId, label, ok: false, reason, cwd: project.root, env: {} };
}

// Runs the script from the package that owns it, so a nested package can borrow
// a workspace root command without the run losing its working directory.
function scriptRun(actionId, label, project, owner, script) {
  const env = {};
  if (DEFINES_SCRIPTS.has(script) && existsSync(path.join(owner.dir, DEFINES_FILE))) {
    env.BUILD_DEFINES_FILE = path.join(owner.dir, DEFINES_FILE);
  }
  const command = project.packageManager;
  const args = ["run", script];
  return {
    actionId,
    label,
    ok: true,
    command,
    args,
    cwd: owner.dir,
    env,
    stdin: LIVE_ACTIONS.has(actionId),
    display: `${command} run ${script}`,
    // The owning package and the script name let discovery claim the script so
    // no specialized button and no generic one point at the same package+script.
    script,
    ownerDir: owner.dir,
  };
}

function flutterRun(actionId, label, project) {
  const args =
    actionId === "web-live"
      ? ["run", "-d", "web-server"]
      : actionId === "analyze"
        ? ["analyze"]
        : ["run"];
  return {
    actionId,
    label,
    ok: true,
    command: "flutter",
    args,
    cwd: project.flutterDir,
    env: {},
    // `flutter analyze` is one-shot; it never reads hot-reload keys.
    stdin: actionId !== "analyze",
    display: `flutter ${args.join(" ")}`,
  };
}

// `adb install -r` reinstalls the app on the device adb is talking to. No -s is
// passed: with several devices adb prints its own error, which lands in the log
// panel, so the button never picks a device on the user's behalf.
function adbRun(actionId, label, project, apk) {
  return {
    actionId,
    label,
    ok: true,
    command: "adb",
    args: ["install", "-r", apk.file],
    cwd: apk.dir,
    env: {},
    stdin: false,
    display: `adb install -r ${apk.file}`,
  };
}

// A specialized action keeps its fixed id, label, title and resolution rules.
// Any other id is a discovered per-script action: it is resolved freshly against
// the project each call, so a script that has since been removed is unsupported.
export function resolveAction(actionId, project) {
  const action = ACTIONS.find((entry) => entry.id === actionId);
  if (action) {
    return { ...resolveActionFor(actionId, action, project), title: action.title };
  }
  const cargo = CARGO_ACTIONS.find((entry) => entry.id === actionId);
  if (cargo) {
    return { ...cargoRun(actionId, cargo, project), title: cargo.title };
  }
  const entry = discoverEntries(project).find((candidate) => candidate.id === actionId);
  if (!entry) {
    return { ...unsupported(actionId, actionId, "Unknown action", project), title: actionId };
  }
  return {
    ...scriptRun(actionId, entry.label, project, entry.owner, entry.script),
    title: entry.title,
  };
}

// A Cargo button runs a fixed cargo subcommand in the manifest's own directory.
// No binary target is guessed for `cargo run`: a library-only manifest simply
// lets cargo explain itself in the log.
function cargoRun(actionId, action, project) {
  if (!project.cargo) {
    return unsupported(actionId, action.label, "no Cargo.toml above this folder", project);
  }
  const args = [...action.args];
  return {
    actionId,
    label: action.label,
    ok: true,
    command: "cargo",
    args,
    cwd: project.cargo.dir,
    env: {},
    stdin: false,
    display: `cargo ${args.join(" ")}`,
  };
}

function resolveActionFor(actionId, action, project) {
  if (!action) return unsupported(actionId, actionId, "Unknown action", project);

  // Nearest package first: a nested package's own script beats a workspace root
  // command. The walk never leaves the workspace/repository boundary.
  const candidates = SCRIPT_CANDIDATES[actionId] ?? [];
  for (const owner of project.packages ?? []) {
    for (const script of candidates) {
      if (typeof owner.scripts[script] !== "string") continue;
      // A bare `dev` script is only a Next.js server when that package has Next.
      if (script === "dev" && !owner.hasNext) continue;
      return scriptRun(actionId, action.label, project, owner, script);
    }
  }

  if (actionId === "adb-install") {
    // Only a built APK, or an install script added by the project, can run this.
    if (!project.apk) {
      return unsupported(
        actionId,
        action.label,
        "no release or debug APK under build/app/outputs/flutter-apk",
        project,
      );
    }
    return adbRun(actionId, action.label, project, project.apk);
  }

  if (actionId === "next-live") {
    const bare = (project.packages ?? []).find(
      (owner) => typeof owner.scripts.dev === "string" && !owner.hasNext,
    );
    if (bare) {
      return unsupported(actionId, action.label, "dev script found but Next.js is not a dependency", project);
    }
    // A Next.js server is never started through Flutter.
    return unsupported(actionId, action.label, "no dev:web or dev script", project);
  }

  if (actionId === "build-mobile") {
    return unsupported(actionId, action.label, "no build:mobile:hosted or build:mobile script", project);
  }
  if (!project.flutterDir) {
    return unsupported(actionId, action.label, "no Flutter project above this folder", project);
  }
  if (actionId === "web-live" && !project.hasFlutterWeb) {
    return unsupported(actionId, action.label, "Flutter project has no web/ target", project);
  }
  return flutterRun(actionId, action.label, project);
}

const SCRIPT_ACTION_PREFIX = "script:";

// Identity of one script on one package. The owning directory carries the
// identity, never the package name, so two packages that define the same script
// name stay apart.
function scriptOwnerKey(dir, script) {
  return `${dir}\u0000${script}`;
}

// A per-script action id names the owning package by path, so the same script
// name in two packages gets two distinct ids. Both halves are percent-encoded:
// a ':' inside a POSIX directory name or a script name never merges the two
// fields, so the id decodes back to exactly one (ownerDir, script) pair.
function scriptActionId(ownerDir, script) {
  return `${SCRIPT_ACTION_PREFIX}${encodeURIComponent(ownerDir)}:${encodeURIComponent(script)}`;
}

function scriptEntry(project, owner, script, shared) {
  const rel = path.relative(project.root ?? owner.dir, owner.dir) || ".";
  return {
    id: scriptActionId(owner.dir, script),
    label: shared ? `${script} (${rel})` : script,
    title: shared
      ? `Script ${script} (${project.packageManager} run ${script}) · ${owner.dir}`
      : `Script ${script} (${project.packageManager} run ${script})`,
    kind: "script",
    owner,
    script,
  };
}

// Every action this project supports: the specialized ACTIONS first, then the
// fixed Cargo commands when a manifest was detected, then one action per
// remaining defined script in the bounded package chain (including a bare
// `test`). A script a specialized action already runs is claimed, so a
// package+script never yields two buttons. Discovery reads the same bounded
// chain detection produced and never scans child directories, so a plain parent
// folder still cannot donate a script.
function discoverEntries(project) {
  const entries = [];
  const claimed = new Set();
  for (const action of ACTIONS) {
    const resolution = resolveActionFor(action.id, action, project);
    if (!resolution.ok) continue;
    entries.push({ id: action.id, label: action.label, title: action.title, kind: "special" });
    if (resolution.ownerDir && resolution.script) {
      claimed.add(scriptOwnerKey(resolution.ownerDir, resolution.script));
    }
  }

  if (project.cargo) {
    for (const action of CARGO_ACTIONS) {
      entries.push({ id: action.id, label: action.label, title: action.title, kind: "cargo" });
    }
  }

  const owners = project.packages ?? [];
  const nameCounts = new Map();
  for (const owner of owners) {
    for (const [script, command] of Object.entries(owner.scripts ?? {})) {
      if (typeof command !== "string") continue;
      nameCounts.set(script, (nameCounts.get(script) ?? 0) + 1);
    }
  }

  for (const owner of owners) {
    for (const script of Object.keys(owner.scripts ?? {}).sort()) {
      if (typeof owner.scripts[script] !== "string") continue;
      if (claimed.has(scriptOwnerKey(owner.dir, script))) continue;
      entries.push(scriptEntry(project, owner, script, (nameCounts.get(script) ?? 0) > 1));
    }
  }
  return entries;
}

// Supported actions for a project, in display order. Specialized actions keep
// their existing ids, labels and titles; a detected Cargo manifest adds the six
// fixed Cargo commands; every other defined script becomes a per-script action.
// A specialized action is resolved only to decide whether it is supported and
// which script it claims; no process is started or signalled.
export function discoverActions(project) {
  return discoverEntries(project).map(({ id, label, title }) => ({ id, label, title }));
}

// Detection is cheap but stats many files; cache briefly per directory.
export function createProjectDetector(options = {}) {
  const ttlMs = options.ttlMs ?? 4000;
  const now = options.now ?? Date.now;
  const cache = new Map();
  return {
    detect(dir, { fresh = false } = {}) {
      const key = path.resolve(dir || ".");
      const hit = cache.get(key);
      if (!fresh && hit && now() - hit.at < ttlMs) return hit.project;
      if (!fresh && hit && cache.size > 32) cache.delete(key);
      const project = detectProject(key);
      cache.set(key, { at: now(), project });
      if (cache.size > 64) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      return project;
    },
    clear() {
      cache.clear();
    },
  };
}

function readSession(context, sessionID) {
  if (typeof sessionID !== "string" || !sessionID) return undefined;
  try {
    return context?.data?.session?.get?.(sessionID);
  } catch {
    return undefined;
  }
}

// Session directory wins so switching tabs never runs the previous project.
export function resolveSessionDirectory(context, sessionID) {
  const session = readSession(context, sessionID);
  for (const candidate of [session?.directory, session?.worktree]) {
    if (typeof candidate === "string" && candidate) return candidate;
  }
  const location = context?.location?.directory;
  if (typeof location === "string" && location) return location;
  return process.cwd();
}

const ANSI_OSC = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const ANSI_CSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OTHER = /\u001b[@-_]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

export function cleanOutput(text) {
  return String(text)
    .replace(ANSI_OSC, "")
    .replace(ANSI_CSI, "")
    .replace(ANSI_OTHER, "")
    .replace(CONTROL, "");
}

function createLineBuffer({ maxLines, maxLineChars }) {
  const lines = [];
  let partial = "";
  // The latest carriage-return line. Tools use it for counters and progress
  // bars: it is rewritten in place, so it stays one line instead of hundreds.
  let progress = "";
  const pushLine = (line) => {
    if (!line) return;
    lines.push(line.length > maxLineChars ? `${line.slice(0, maxLineChars)}…` : line);
    while (lines.length > maxLines) lines.shift();
  };
  return {
    push(chunk) {
      const text = cleanOutput(chunk);
      for (let index = 0; index < text.length; index += 1) {
        const char = text[index];
        if (char === "\r") {
          // Overwrite the current line. A counter that redraws itself must not
          // append a line every tick.
          const current = partial.trimEnd();
          if (current) progress = current;
          partial = "";
          continue;
        }
        if (char === "\n") {
          // A progress line finished by a newline becomes history, not a loss.
          const line = partial.trimEnd() || progress;
          partial = "";
          progress = "";
          pushLine(line);
          continue;
        }
        partial += char;
      }
      if (partial.length > 4000) {
        pushLine(partial);
        partial = "";
      }
    },
    flush() {
      const line = partial.trimEnd();
      partial = "";
      pushLine(line);
    },
    tail(count) {
      return count > 0 ? lines.slice(-count) : [];
    },
    all() {
      return lines.slice();
    },
    get progress() {
      return progress;
    },
    get size() {
      return lines.length;
    },
  };
}

// Linux process identity for a pid, read from /proc/<pid>/stat. `comm` may hold
// spaces and parentheses, so only the fields after the last ')' are parsed.
// Field layout after the state field (field 3): ppid, pgrp, session, ...,
// starttime (field 22). Returns undefined on any other platform or a dead pid.
export function readProcessStat(pid) {
  if (process.platform !== "linux") return undefined;
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    const close = raw.lastIndexOf(")");
    if (close === -1) return undefined;
    const parts = raw.slice(close + 2).trim().split(/\s+/);
    return {
      state: parts[0],
      ppid: Number(parts[1]),
      pgrp: Number(parts[2]),
      sid: Number(parts[3]),
      starttime: Number(parts[19]),
    };
  } catch {
    return undefined;
  }
}

// Liveness of a process group: a signal-0 probe. EPERM means the group exists
// but is not ours to signal; ESRCH (or any other failure) means it is gone.
function probeProcessGroup(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function createRunnerManager(options = {}) {
  const spawn = options.spawn ?? nodeSpawn;
  const env = options.env ?? process.env;
  const now = options.now ?? Date.now;
  // Injected so a test never signals a real process group.
  const killProcessGroup = options.killProcessGroup ?? ((pid, signal) => process.kill(-pid, signal));
  // The identity guard for a group whose leader has exited. Both are injectable
  // so a test never reads a real /proc entry or probes a real group.
  const probeGroup = options.probeGroup ?? probeProcessGroup;
  const readStat = options.readProcessStat ?? readProcessStat;
  const maxLines = options.maxLines ?? 200;
  const maxLineChars = options.maxLineChars ?? 400;
  const killGraceMs = options.killGraceMs ?? 5000;
  const notifyMs = options.notifyMs ?? 120;

  const runs = new Map();
  const listeners = new Set();
  let notifyTimer;
  let lastNotify = 0;

  const emitNow = () => {
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        // a broken view must not break the runner
      }
    }
  };
  const emit = () => {
    if (notifyMs <= 0) return emitNow();
    const elapsed = now() - lastNotify;
    if (elapsed >= notifyMs) {
      lastNotify = now();
      emitNow();
      return;
    }
    if (notifyTimer) return;
    notifyTimer = setTimeout(() => {
      notifyTimer = undefined;
      lastNotify = now();
      emitNow();
    }, notifyMs - elapsed);
    notifyTimer.unref?.();
  };

  const keyFor = (actionId, cwd) => `${actionId}\u0000${path.resolve(cwd || ".")}`;

  function start(spec) {
    const cwd = path.resolve(spec.cwd || ".");
    const key = keyFor(spec.actionId, cwd);
    const existing = runs.get(key);
    if (existing && existing.status === "running") {
      return { ok: false, code: "already-running", message: `${spec.label} already running`, key };
    }

    const args = [...(spec.args ?? [])];
    const run = {
      key,
      actionId: spec.actionId,
      label: spec.label,
      cwd,
      command: spec.command,
      args,
      display: spec.display ?? [spec.command, ...args].join(" "),
      stdin: spec.stdin === true,
      status: "running",
      stopped: false,
      stopping: false,
      stoppingSince: undefined,
      orphaned: false,
      startedAt: now(),
      endedAt: undefined,
      exitCode: undefined,
      signal: undefined,
      error: undefined,
      signalError: undefined,
      killTimer: undefined,
      pgid: undefined,
      leaderStart: undefined,
      groupGone: false,
      child: undefined,
      lines: createLineBuffer({ maxLines, maxLineChars }),
    };
    runs.set(key, run);

    let child;
    try {
      child = spawn(run.command, run.args, {
        cwd,
        env: { ...env, ...(spec.env ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        // An owned process group: stopping a run must reach the descendants
        // pnpm spawns (flutter, next) instead of only the direct child.
        detached: process.platform !== "win32",
      });
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message : String(error);
      run.endedAt = now();
      emit();
      return { ok: false, code: "spawn-failed", message: run.error, key };
    }

    run.child = child;
    run.pid = typeof child.pid === "number" ? child.pid : undefined;
    run.detached = process.platform !== "win32";
    // Detached makes the child a session and group leader, so its pid is also
    // the group id. The start time lets a later signal prove the leader pid was
    // not recycled onto an unrelated process.
    if (run.detached && typeof run.pid === "number" && run.pid > 0) {
      run.pgid = run.pid;
      run.leaderStart = readStat(run.pid)?.starttime;
    }
    const settle = (status) => {
      if (run.status !== "running") return;
      run.lines.flush();
      run.status = status;
      run.endedAt = now();
      // A stop grace timer must outlive the leader when descendants are still
      // in the group, so it is only dropped once the group is provably gone.
      if (run.killTimer && (!run.stopping || !groupOwned(run))) {
        clearTimeout(run.killTimer);
        run.killTimer = undefined;
      }
      // A leader can also exit on its own while the descendants it spawned keep
      // the group alive (a wrapper script that backgrounds a server). Take over
      // that lingering group here, inside a bounded grace window, instead of
      // losing ownership silently: SIGTERM now, the scheduled grace SIGKILL
      // after. A stop that already owns the group is left alone.
      if (status !== "stopped" && !run.stopping && groupOwned(run)) {
        run.stopping = true;
        run.stoppingSince = run.endedAt;
        run.orphaned = true;
        const result = sendSignal(run, "SIGTERM");
        if (!result.ok) {
          if (result.code === "ESRCH") run.groupGone = true;
          else run.signalError = describeSignalFailure(result.code, result.message);
        }
        scheduleKill(run);
      }
      emit();
    };

    child.stdout?.on("data", (chunk) => {
      run.lines.push(chunk);
      emit();
    });
    child.stderr?.on("data", (chunk) => {
      run.lines.push(chunk);
      emit();
    });
    child.stdin?.on?.("error", () => {
      // child closed stdin early; ignore
    });
    child.on?.("error", (error) => {
      run.error = error instanceof Error ? error.message : String(error);
      settle("failed");
    });
    child.on?.("exit", (code, signal) => {
      run.exitCode = typeof code === "number" ? code : undefined;
      run.signal = signal ?? undefined;
      settle(run.stopped ? "stopped" : code === 0 ? "exited" : "failed");
    });
    emit();
    return { ok: true, run, key };
  }

  // Ownership of the run's own process group. While the leader is alive its
  // recorded start time proves the pid was not recycled. Once the leader exits
  // the group id stays reserved for as long as any member is left, so a
  // non-empty probe is still our group; an empty group ends ownership and is
  // never signalled again. There is no lookup by name or port.
  function groupOwned(run) {
    if (run.groupGone) return false;
    const pgid = run.pgid;
    if (typeof pgid !== "number" || pgid <= 0) return false;
    const leader = readStat(pgid);
    if (leader) {
      if (leader.pgrp !== pgid) {
        run.groupGone = true;
        return false;
      }
      if (typeof run.leaderStart === "number" && leader.starttime !== run.leaderStart) {
        run.groupGone = true;
        return false;
      }
      return true;
    }
    if (probeGroup(pgid)) return true;
    run.groupGone = true;
    return false;
  }

  // Sends `signal` to the run's group (detached) or its direct child. The
  // outcome is reported, never swallowed: ESRCH means the target is already
  // gone; any other failure is a real error the caller must surface.
  function sendSignal(run, signal) {
    if (run.detached && typeof run.pgid === "number" && run.pgid > 0) {
      try {
        killProcessGroup(run.pgid, signal);
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          code: error?.code ?? "UNKNOWN",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    }
    const child = run.child;
    if (!child?.kill) return { ok: false, code: "ESRCH", message: "no child process" };
    try {
      return child.kill(signal) === false
        ? { ok: false, code: "ESRCH", message: "process already gone" }
        : { ok: true };
    } catch (error) {
      return {
        ok: false,
        code: error?.code ?? "UNKNOWN",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  function describeSignalFailure(code, message) {
    return `stop signal failed (${code}${message ? `: ${message}` : ""})`;
  }

  function scheduleKill(run) {
    if (run.killTimer) return;
    run.killTimer = setTimeout(() => {
      run.killTimer = undefined;
      escalate(run);
    }, killGraceMs);
    run.killTimer.unref?.();
  }

  // The grace SIGKILL. It runs even after the leader exited, but only while the
  // group is still provably ours, so a recycled group id is never hit.
  function escalate(run) {
    if (!run.stopping) return;
    if (!groupOwned(run)) return;
    const result = sendSignal(run, "SIGKILL");
    if (!result.ok && result.code !== "ESRCH") {
      run.signalError = describeSignalFailure(result.code, result.message);
      emit();
    }
  }

  function stop(key) {
    const run = runs.get(key);
    if (!run || run.status !== "running") return false;
    // A repeated stop is a no-op: it must not schedule a second grace timer.
    if (run.stopping) return false;
    run.stopping = true;
    run.stoppingSince = now();
    // Mark the stop intent before signalling, so a child that exits inside the
    // signal call is labelled stopped rather than failed.
    run.stopped = true;
    const result = sendSignal(run, "SIGTERM");
    if (!result.ok && result.code === "ESRCH") {
      // The process/group is already gone; nothing to escalate.
      run.groupGone = true;
      emit();
      return true;
    }
    if (!result.ok) {
      // A refused signal is not a stop. Record a diagnostic and let the caller
      // report the failure instead of a silent success.
      run.stopped = false;
      run.stopping = false;
      run.stoppingSince = undefined;
      run.signalError = describeSignalFailure(result.code, result.message);
      emit();
      return false;
    }
    if (run.status === "running") scheduleKill(run);
    emit();
    return true;
  }

  function stopAll() {
    let stopped = 0;
    let failed = 0;
    for (const run of runs.values()) {
      if (run.status !== "running") continue;
      if (stop(run.key)) stopped += 1;
      else failed += 1;
    }
    return { stopped, failed };
  }

  function send(key, data) {
    const run = runs.get(key);
    if (!run || run.status !== "running" || !run.stdin) return false;
    if (!run.child?.stdin?.writable) return false;
    try {
      run.child.stdin.write(data);
      return true;
    } catch {
      return false;
    }
  }

  function find(actionId, cwd) {
    return runs.get(keyFor(actionId, cwd));
  }

  // Without a tail count the whole retained history is returned, so the log
  // dialog can scroll back past the newest lines. A sidebar row asks for none.
  function snapshot(key, tailCount) {
    const run = runs.get(key);
    if (!run) return undefined;
    return {
      key: run.key,
      actionId: run.actionId,
      label: run.label,
      display: run.display,
      cwd: run.cwd,
      pid: run.pid,
      stdin: run.stdin,
      status: run.status,
      running: run.status === "running",
      exitCode: run.exitCode,
      signal: run.signal,
      error: run.error,
      stopError: run.signalError,
      stopping: run.stopping,
      orphaned: run.orphaned,
      startedAt: run.startedAt,
      elapsedMs: (run.endedAt ?? now()) - run.startedAt,
      lineCount: run.lines.size,
      progress: run.lines.progress,
      lines: typeof tailCount === "number" ? run.lines.tail(tailCount) : run.lines.all(),
    };
  }

  // Unloading the plugin must not leave an owned group behind. Unref'd timers
  // do not survive the host exiting, so every owned run is signalled directly:
  // a running group gets SIGTERM, and a group already past a stop request is
  // escalated to SIGKILL at once. Completed runs are never signalled.
  function dispose() {
    for (const run of runs.values()) {
      if (run.status !== "running" || run.stopping) continue;
      run.stopping = true;
      run.stoppingSince = run.stoppingSince ?? now();
      const result = sendSignal(run, "SIGTERM");
      if (result.ok || result.code === "ESRCH") {
        run.stopped = true;
        if (result.code === "ESRCH") run.groupGone = true;
      } else {
        run.signalError = describeSignalFailure(result.code, result.message);
      }
    }
    for (const run of runs.values()) {
      // Escalate anything still waiting on a stop, including an orphaned group
      // whose leader already exited, since its unref'd timer dies with us.
      if (!run.stopping || !groupOwned(run)) continue;
      sendSignal(run, "SIGKILL");
    }
    for (const run of runs.values()) {
      if (run.killTimer) {
        clearTimeout(run.killTimer);
        run.killTimer = undefined;
      }
    }
    if (notifyTimer) {
      clearTimeout(notifyTimer);
      notifyTimer = undefined;
    }
    runs.clear();
    listeners.clear();
  }

  return {
    start,
    stop,
    stopAll,
    send,
    find,
    snapshot,
    dispose,
    keyFor,
    list: () => [...runs.values()],
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
