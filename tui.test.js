import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createProjectDetector, dialogKeyLayer, discoverActions } from "./runners.js";
import { PLUGIN_ID, setupWith } from "./tui.js";

const roots = [];

// Slices a top-level function declaration out of a source file so the view
// markup can be asserted without a JSX runtime.
function functionBody(source, marker) {
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `${marker} exists in view.jsx`);
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end === -1 ? source.length : end);
}

function fixture(files) {
  const root = mkdtempSync(path.join(tmpdir(), "project-runners-tui-"));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(root, rel);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content, null, 2));
  }
  return root;
}

test.after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createFakeSpawn() {
  const calls = [];
  const children = new Map();
  let nextPid = 900000;
  const spawn = (command, args, options) => {
    if (spawn.fail) throw new Error("spawn exploded");
    const child = new EventEmitter();
    const writes = [];
    child.pid = (nextPid += 1);
    children.set(child.pid, child);
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = {
      writable: true,
      write(data) {
        writes.push(String(data));
        return true;
      },
    };
    child.writes = writes;
    child.signals = [];
    child.kill = (signal) => {
      child.signals.push(signal);
      child.emit("exit", null, signal);
      return true;
    };
    calls.push({ command, args, options, child });
    return child;
  };
  spawn.calls = calls;
  // Stands in for `process.kill(-pid, signal)`: the fake pids are never real.
  spawn.killProcessGroup = (pid, signal) => {
    const child = children.get(pid);
    if (!child) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    child.kill(signal);
    return true;
  };
  return spawn;
}

function createContext({
  locationDirectory,
  sessions = {},
  route,
  diffFiles = {},
  diffThrows = false,
  messageItems = null,
  messagesMissing = false,
  messagesThrows = false,
  messagesMalformed = false,
  messageDiffFiles = {},
  messageDiffThrows = false,
  snapshotFiles = null,
  promptAnswers = [],
}) {
  const calls = {
    slots: [],
    dialogs: [],
    toasts: [],
    layers: [],
    diffs: [],
    messages: [],
    invalid: [],
    snapshots: [],
    prompts: [],
  };
  const context = {
    theme: {
      text: { base: "#ffffff", muted: "#888888", error: "#ff0000" },
      background: { action: { primary: { focused: "#333333" } }, raised: { base: "#222222" } },
    },
    location: { directory: locationDirectory },
    // Legacy v1 host snapshot fallback; the current host has no `state`. It is
    // absent unless a test provides one, which keeps the client path exercised.
    state: {
      session: {
        diff(sessionID) {
          if (!snapshotFiles) return undefined;
          calls.snapshots.push(sessionID);
          return (snapshotFiles[sessionID] ?? []).map((file) => ({ file, additions: 1, deletions: 0 }));
        },
      },
    },
    ui: {
      slot(spec) {
        calls.slots.push(spec);
        return () => calls.slots.push({ disposed: true });
      },
      router: { current: () => route() },
      dialog: {
        set(options) {
          calls.dialogs.push({ set: options });
        },
        show(render, onClose) {
          calls.dialogs.push({ render, onClose });
        },
        clear() {
          calls.dialogs.push({ clear: true });
        },
        async prompt(options) {
          calls.prompts.push(options);
          const answer = promptAnswers.shift();
          return typeof answer === "function" ? answer(options) : answer;
        },
      },
      toast: {
        show(payload) {
          calls.toasts.push(payload);
        },
      },
    },
    // Session attribution follows the installed `@opencode/client` 2.0.32
    // contract, not `@opencode-ai/sdk`:
    //   - `client.message.list({ sessionID, limit?, order?, cursor?, type? })`
    //     resolves `{ data: SessionMessageInfo[], cursor: { previous, next } }`;
    //     a user entry is `{ type: "user", id, time, text }`.
    //   - `client.session.diff({ sessionID, from?, to?, context? })` resolves a
    //     bare `FileDiffInfo[]`.
    // Any request on the fabricated `session.messages`/`before`/`directory`/
    // `messageID` shape throws, so a regression fails instead of passing.
    client: {
      message: messagesMissing
        ? undefined
        : {
            async list(options) {
              calls.messages.push(options);
              if (
                options?.path !== undefined ||
                options?.before !== undefined ||
                options?.directory !== undefined
              ) {
                throw new Error(
                  "unsupported message list request: expected { sessionID, limit, order, cursor, type }",
                );
              }
              if (typeof options?.sessionID !== "string" || options.type !== "user") {
                throw new Error("message list requires sessionID and type: 'user'");
              }
              if (options.cursor !== undefined && options.order !== undefined) {
                throw new Error("order must not be combined with cursor");
              }
              if (messagesThrows) throw new Error("message list failed");
              if (messagesMalformed) return { data: "not-a-list" };
              const source = messageItems?.[options.sessionID] ?? [];
              const ordered = [...source].sort(
                (a, b) => (a?.time?.created ?? 0) - (b?.time?.created ?? 0),
              );
              if (options.order === "desc") ordered.reverse();
              const at = typeof options.cursor === "string" ? Number(options.cursor.slice(1)) : 0;
              if (typeof options.cursor === "string" && !Number.isInteger(at)) {
                throw new Error("bad cursor");
              }
              const limit = typeof options.limit === "number" ? options.limit : ordered.length;
              const page = ordered.slice(at, at + limit);
              const next = at + limit < ordered.length ? `c${at + limit}` : null;
              return { data: page, cursor: { previous: null, next } };
            },
          },
      session: {
        // A fabricated route: calling it is a regression.
        async messages() {
          calls.invalid.push("session.messages");
          throw new Error("session.messages is not part of the @opencode/client contract");
        },
        async diff(options) {
          calls.diffs.push(options);
          for (const key of ["path", "directory", "messageID", "before"]) {
            if (options?.[key] !== undefined) {
              throw new Error(`unsupported session diff request key: ${key}`);
            }
          }
          if (diffThrows) throw new Error("session diff failed");
          if (options?.from !== undefined && messageDiffThrows) throw new Error("message diff failed");
          const files =
            options?.from !== undefined
              ? (messageDiffFiles[options.from] ?? [])
              : (diffFiles[options.sessionID] ?? []);
          return files.map((file) => ({
            file,
            patch: "",
            additions: 1,
            deletions: 0,
            status: "modified",
          }));
        },
      },
    },
    data: {
      session: {
        get(id) {
          return sessions[id];
        },
      },
    },
    keymap: {
      // The host calls the layer factory inside a tracked computation, so the
      // layer's contents are read through the factory, not frozen at
      // registration. Registration itself is what `calls.layers` counts.
      layer(factory) {
        const handle = {};
        for (const key of ["mode", "commands", "bindings"]) {
          Object.defineProperty(handle, key, { get: () => factory()?.[key] });
        }
        calls.layers.push(handle);
      },
    },
  };
  return { context, calls };
}

const view = {
  Sidebar: (props) => ({ kind: "sidebar", props }),
  LogDialog: (props) => ({ kind: "log", props }),
  GitDialog: (props) => ({ kind: "git", props }),
  SettingsDialog: (props) => ({ kind: "settings", props }),
};

// Poll a predicate instead of guessing how long a flow takes.
async function until(predicate, label = "condition", timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

// A user-message entry as `client.message.list({ type: "user" })` returns it:
// `{ type: "user", id, time, text }`. It carries no diff - the turn's files come
// from `session.diff({ sessionID, from: id })`.
function messageTurn(id, created) {
  return { id, type: "user", time: { created }, text: "" };
}

// A scripted `git` (and `copilot`) so the real service runs end to end without a
// repository, a network call, or a Copilot invocation. Every command is answered
// by shape, and anything unexpected fails the test loudly.
function fakeGit(options = {}) {
  const root = options.root ?? "/repo";
  const branch = options.branch ?? "main";
  const upstream = options.upstream ?? "origin/main";
  const pushUrl = options.pushUrl ?? "git@github.com:acme/repo.git";
  const status = options.status ?? "";
  const patch = options.patch ?? "diff --git a/src/a.ts b/src/a.ts\n+one line\n";
  const stat = options.stat ?? " src/a.ts | 1 +\n 1 file changed, 1 insertion(+)\n";
  const message = options.message ?? "feat(web): tidy the header\n";
  const calls = [];
  let head = options.head ?? "head1";
  let committedOnce = false;
  const ok = (stdout) => ({ ok: true, code: 0, spawnError: null, timedOut: false, stdout, stderr: "" });
  const bad = (code, stderr) => ({ ok: false, code, spawnError: null, timedOut: false, stdout: "", stderr });

  const exec = async ({ file, args, cwd, env, input }) => {
    const line = args.join(" ");
    calls.push({ file, args, cwd, env, input });
    if (file !== "git") return ok(message);
    if (line === "rev-parse --show-toplevel") {
      if (options.notARepo) return bad(128, "fatal: not a git repository");
      return ok(`${root}\n`);
    }
    if (line === "status --porcelain=v2 -z --untracked-files=all") return ok(status);
    if (line === "symbolic-ref --quiet --short HEAD") return ok(`${branch}\n`);
    if (line === "rev-parse --verify --quiet HEAD") return ok(`${head}\n`);
    if (line === "rev-parse --abbrev-ref --symbolic-full-name @{upstream}") return ok(`${upstream}\n`);
    if (line === "rev-parse --abbrev-ref --symbolic-full-name @{push}") {
      if (options.noPushTarget) return bad(1, "");
      return ok(`${upstream}\n`);
    }
    if (line.startsWith("rev-list --count")) return ok(`${options.outgoing ?? "0"}\n`);
    if (line.startsWith("rev-list -n")) return ok(options.hashes?.join("\n") ?? "");
    if (line.startsWith("check-ref-format")) return ok("");
    if (line.startsWith("config --bool")) return bad(1, "");
    if (line.startsWith("remote get-url")) return ok(`${pushUrl}\n`);
    if (line === "write-tree") return ok(`${env?.GIT_INDEX_FILE ? "tree1" : "index1"}\n`);
    if (line.startsWith("read-tree")) return ok("");
    if (line.startsWith("add -A")) return ok("");
    if (line.startsWith("diff --cached --name-only")) return ok("");
    if (line.startsWith("diff --cached") && line.includes("--patch")) return ok(patch);
    if (line.startsWith("diff --cached") && line.includes("--stat")) return ok(stat);
    if (line.startsWith("diff --quiet")) return ok("");
    if (line.startsWith("commit -m")) {
      head = options.headAfter ?? "head2";
      committedOnce = true;
      return ok("");
    }
    if (line.includes("^{tree}")) {
      // A hook can rewrite what the commit actually contains; the service compares
      // the committed tree with the reviewed one.
      const tree = committedOnce && options.treeAfterCommit ? options.treeAfterCommit : options.tree ?? "tree1";
      return ok(`${tree}\n`);
    }
    if (line.startsWith("reset -q")) return ok("");
    if (line.includes(" push ")) return ok("To github.com:acme/repo.git\n   head1..head2  HEAD -> main\n");
    return bad(1, `unexpected git command: ${line}`);
  };

  exec.calls = calls;
  exec.commands = () => calls.map((call) => call.args.join(" "));
  return exec;
}

// The real manager signals the run's own process group; the fake spawn supplies
// a stand-in so a test never touches a real group.
// Every started plugin gets its own visibility file, so a test never reads or
// writes the real user config even when it toggles a button.
function tempVisibilityFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "project-runners-visibility-"));
  roots.push(dir);
  return path.join(dir, "visibility.json");
}

// Same rule for the button configuration: one file per started plugin, so no
// test reads or writes the real user config while editing a command.
function tempButtonConfigFile() {
  const dir = mkdtempSync(path.join(tmpdir(), "project-runners-buttons-"));
  roots.push(dir);
  return path.join(dir, "buttons.json");
}

function startPlugin(context, pluginView, options = {}) {
  return setupWith(context, pluginView, {
    ...options,
    visibilityFile: options.visibilityFile ?? tempVisibilityFile(),
    buttonConfigFile: options.buttonConfigFile ?? tempButtonConfigFile(),
    killProcessGroup: options.spawn?.killProcessGroup,
  });
}

function scriptsFixture() {
  return fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": {
      name: "vetory-like",
      scripts: {
        "build:mobile:hosted": "bash scripts/build-mobile-hosted.sh",
        live: "bash scripts/build-mobile-hosted.sh run",
        "live:web": "bash scripts/run-web-live.sh",
        "dev:web": "pnpm --dir apps/web dev",
      },
    },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "local-public-defines.json": "{}",
  });
}

test("places one sidebar block after every sidebar.content contribution", async () => {
  const { context, calls } = createContext({ locationDirectory: tmpdir() });
  const cleanup = await startPlugin(context, view, { spawn: createFakeSpawn(), notifyMs: 0 });
  assert.equal(calls.slots.length, 1);
  assert.equal(calls.slots[0].after, "sidebar.content");
  assert.equal("append" in calls.slots[0], false);
  assert.equal("prepend" in calls.slots[0], false);
  assert.equal(typeof calls.slots[0].render, "function");
  const element = calls.slots[0].render({ sessionID: "s1" });
  assert.equal(element.kind, "sidebar");
  assert.equal(element.props.sessionID, "s1");
  await cleanup();
  assert.ok(calls.slots.some((entry) => entry.disposed === true));
});

test("registers palette commands for every discovered action plus the controls", async () => {
  const dir = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, { spawn: createFakeSpawn(), notifyMs: 0 });
  assert.equal(calls.layers.length, 1);
  const layer = calls.layers[0];
  assert.equal(layer.mode, "global");
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const ids = layer.commands.map((command) => command.id);
  // The palette is built from the same discovery the sidebar uses, so a
  // script-generated action is runnable even before it has a row.
  for (const descriptor of runtime.actionDescriptors()) {
    assert.ok(ids.includes(`${PLUGIN_ID}.${descriptor.id}`), descriptor.id);
  }
  for (const id of ["build-mobile", "mobile-live", "web-live", "next-live"]) {
    assert.ok(ids.includes(`${PLUGIN_ID}.${id}`), id);
  }
  assert.ok(ids.includes(`${PLUGIN_ID}.stop-all`));
  assert.ok(ids.includes(`${PLUGIN_ID}.log`));
  assert.ok(ids.includes(`${PLUGIN_ID}.settings`));
  assert.ok(ids.includes(`${PLUGIN_ID}.show-all`));
  assert.ok(layer.commands.every((command) => command.palette === true));
  // The visible name of the section is `Launchpad`; the plugin id and the command
  // ids stay internal and unchanged.
  assert.ok(
    layer.commands.every((command) => command.group === "Launchpad"),
    "every palette command is grouped under the visible section name",
  );
  assert.ok(
    layer.commands.every((command) => command.title.startsWith("Launchpad: ")),
    "every palette title uses the visible section name",
  );
  assert.equal(PLUGIN_ID, "local.control");
  await cleanup();
});

test("stop-all reports a refused signal and warns when nothing runs", async () => {
  const dir = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  spawn.killProcessGroup = (pid, signal) => {
    if (signal === "SIGTERM") {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    }
    const entry = spawn.calls.find((call) => call.child.pid === pid);
    if (!entry) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
    entry.child.kill(signal);
    return true;
  };
  const cleanup = await startPlugin(context, view, {
    spawn,
    notifyMs: 0,
    probeGroup: () => false,
    readProcessStat: () => undefined,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const stopAll = calls.layers[0].commands.find((command) => command.id === `${PLUGIN_ID}.stop-all`);
  assert.ok(stopAll, "stop-all command is registered");

  stopAll.run();
  assert.equal(calls.toasts.at(-1).variant, "warning");
  assert.match(calls.toasts.at(-1).message, /No runner is running/);

  const started = runtime.startAction("build-mobile");
  assert.equal(started.ok, true);
  stopAll.run();
  const toast = calls.toasts.at(-1);
  assert.equal(toast.variant, "error");
  assert.match(toast.message, /could not be stopped/);
  assert.equal(runtime.snapshot(started.key).running, true);

  await cleanup();
});

test("click resolution follows the session that is active at click time", async () => {
  const first = scriptsFixture();
  const second = fixture({
    "package.json": { scripts: { "build:mobile": "echo other" } },
    "package-lock.json": "{}",
    "local-public-defines.json": "{}",
  });
  let session = "s1";
  const { context, calls } = createContext({
    locationDirectory: first,
    sessions: { s1: { directory: first }, s2: { directory: second } },
    route: () => ({ type: "session", sessionID: session }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const started = runtime.startAction("build-mobile");
  assert.equal(started.ok, true);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].command, "pnpm");
  assert.deepEqual(spawn.calls[0].args, ["run", "build:mobile:hosted"]);
  assert.equal(spawn.calls[0].options.cwd, first);
  assert.equal(spawn.calls[0].options.shell, false);
  assert.equal(
    spawn.calls[0].options.env.BUILD_DEFINES_FILE,
    path.join(first, "local-public-defines.json"),
  );

  session = "s2";
  const other = runtime.startAction("build-mobile");
  assert.equal(other.ok, true);
  assert.equal(spawn.calls.length, 2);
  assert.equal(spawn.calls[1].command, "npm");
  assert.equal(spawn.calls[1].options.cwd, second);

  runtime.startAction("build-mobile");
  assert.equal(spawn.calls.length, 2, "duplicate start is refused");
  assert.ok(calls.toasts.some((toast) => /already running/.test(toast.message)));

  await cleanup();
});

test("unsupported actions toast and spawn nothing", async () => {
  const empty = fixture({ "notes.txt": "nothing here\n" });
  const { context, calls } = createContext({
    locationDirectory: empty,
    sessions: { s1: { directory: empty } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const result = runtime.startAction("next-live");
  assert.equal(result.ok, false);
  assert.equal(result.code, "unsupported");
  assert.equal(spawn.calls.length, 0);
  assert.equal(calls.dialogs.length, 0);
  const toast = calls.toasts.at(-1);
  assert.equal(toast.variant, "warning");
  assert.match(toast.message, /Next live: no dev:web or dev script/);

  await cleanup();
});

test("reports spawn failures instead of crashing", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  spawn.fail = true;
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const result = runtime.startAction("build-mobile");
  assert.equal(result.ok, false);
  assert.equal(result.code, "spawn-failed");
  const toast = calls.toasts.at(-1);
  assert.equal(toast.variant, "error");
  assert.match(toast.message, /spawn exploded/);

  await cleanup();
});

test("log dialog reads snapshots and drives stop, reload, and restart", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const started = runtime.startAction("mobile-live");
  const key = started.key;
  const child = spawn.calls[0].child;
  child.stdout.emit("data", "\u001b[32mflutter: hot reload ready\u001b[0m\n");

  const sizeEntry = calls.dialogs.find((entry) => entry.set);
  assert.equal(sizeEntry.set.size, "large");
  const dialog = calls.dialogs.find((entry) => typeof entry.render === "function");
  const element = dialog.render();
  assert.equal(element.kind, "log");
  assert.equal(element.props.runKey, key);

  const snapshot = runtime.snapshot(key);
  assert.deepEqual(snapshot.lines, ["flutter: hot reload ready"]);
  assert.equal(snapshot.running, true);
  assert.equal(snapshot.stdin, true);

  assert.equal(runtime.send(key, "r"), true);
  assert.equal(runtime.send(key, "R"), true);
  assert.deepEqual(child.writes, ["r", "R"]);

  assert.equal(runtime.stop(key), true);
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(runtime.snapshot(key).status, "stopped");
  assert.equal(runtime.send(key, "r"), false);

  await cleanup();
});

test("rows list only supported actions, in grid order", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, { spawn: createFakeSpawn(), notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const rows = runtime.rows("s1");
  assert.equal(rows.items.length, 4);
  assert.equal(rows.projectName, path.basename(root));
  assert.ok(rows.items.every((item) => item.resolution.ok));
  // Grid order: row 1 Build | Live mobile, row 2 Live web | Next live.
  assert.deepEqual(
    rows.items.map((item) => item.action.id),
    ["build-mobile", "mobile-live", "web-live", "next-live"],
  );
  assert.deepEqual(
    rows.items.map((item) => item.action.label),
    ["Build", "Live mobile", "Live web", "Next live"],
  );

  await cleanup();
});

test("hides unsupported actions instead of listing them", async () => {
  const partial = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": { scripts: { "build:mobile": "echo build", live: "echo live" } },
  });
  const { context, calls } = createContext({
    locationDirectory: partial,
    sessions: { s1: { directory: partial } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, { spawn: createFakeSpawn(), notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const partialRows = runtime.rows("s1");
  assert.deepEqual(
    partialRows.items.map((item) => item.action.id),
    ["build-mobile", "mobile-live"],
    "two supported actions pack into the first row",
  );
  assert.ok(
    !partialRows.items.some((item) => item.action.id === "adb-install"),
    "no built APK keeps the install row hidden",
  );
  const blocked = runtime.startAction("adb-install");
  assert.equal(blocked.ok, false);
  assert.equal(blocked.code, "unsupported");
  assert.match(calls.toasts.at(-1).message, /ADB install: no release or debug APK/);

  const empty = fixture({ "notes.txt": "nothing\n" });
  const second = createContext({
    locationDirectory: empty,
    sessions: { s2: { directory: empty } },
    route: () => ({ type: "session", sessionID: "s2" }),
  });
  const secondCleanup = await startPlugin(second.context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
  });
  const secondRuntime = second.calls.slots[0].render({ sessionID: "s2" }).props.runtime;
  assert.deepEqual(secondRuntime.rows("s2").items, [], "no supported action hides the section");
  assert.equal(secondRuntime.rows("s2").projectName, path.basename(empty));

  await cleanup();
  await secondCleanup();
});

test("the adb row appears only with a built APK and installs one-shot", async () => {
  const root = scriptsFixture();
  const app = path.join(root, "apps", "mobile");
  const apkDir = path.join(app, "build", "app", "outputs", "flutter-apk");
  mkdirSync(apkDir, { recursive: true });
  writeFileSync(path.join(app, "pubspec.yaml"), "name: vetory\n");
  const apk = path.join(apkDir, "app-release.apk");
  writeFileSync(apk, "apk");

  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  // Three rows: Build | Live mobile, Live web | Next live, ADB install | spare.
  const rows = runtime.rows("s1");
  assert.equal(rows.items.length, 5);
  assert.deepEqual(
    rows.items.map((item) => item.action.id),
    ["build-mobile", "mobile-live", "web-live", "next-live", "adb-install"],
  );
  assert.equal(rows.items.at(-1).action.label, "ADB install");
  assert.equal(rows.items.at(-1).run, undefined);

  const started = runtime.startAction("adb-install");
  assert.equal(started.ok, true);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].command, "adb");
  assert.deepEqual(spawn.calls[0].args, ["install", "-r", apk]);
  assert.equal(spawn.calls[0].options.cwd, app);
  assert.equal(spawn.calls[0].options.shell, false);
  assert.equal(spawn.calls[0].options.env.BUILD_DEFINES_FILE, undefined);
  const snapshot = runtime.snapshot(started.key);
  assert.equal(snapshot.stdin, false, "an install is one-shot");
  assert.equal(runtime.send(started.key, "r"), false, "reload stays disabled for a one-shot run");
  assert.ok(
    calls.dialogs.some((entry) => typeof entry.render === "function"),
    "the log dialog opens for the install",
  );

  await cleanup();
});

test("a nested package borrows root commands and runs them from the owning folder", async () => {
  const root = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": {
      name: "vetory",
      private: true,
      scripts: {
        "build:mobile:hosted": "bash scripts/build-mobile-hosted.sh",
        live: "bash scripts/build-mobile-hosted.sh run",
        "live:web": "bash scripts/run-web-live.sh",
        "dev:web": "pnpm --dir apps/web dev",
      },
    },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
    "local-public-defines.json": "{}",
    "apps/web/package.json": {
      name: "web",
      scripts: { dev: "next dev" },
      devDependencies: { next: "^15.0.0" },
    },
  });
  const web = path.join(root, "apps/web");
  const { context, calls } = createContext({
    locationDirectory: web,
    sessions: { s1: { directory: web } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const rows = runtime.rows("s1");
  assert.deepEqual(
    rows.items.slice(0, 4).map((item) => item.action.id),
    ["build-mobile", "mobile-live", "web-live", "next-live"],
    "the workspace root scripts are still offered first",
  );
  // Discovery also offers every other defined script, including the root
  // `dev:web` the specialized actions did not claim for this nested package.
  const extra = rows.items.slice(4).map((item) => item.action);
  assert.deepEqual(
    extra.map((action) => action.label),
    ["dev:web"],
    "unclaimed scripts become per-script actions",
  );
  assert.equal(extra[0].id.startsWith("script:"), true);
  const nextLive = rows.items.find((item) => item.action.id === "next-live");
  assert.equal(nextLive.resolution.cwd, web, "the nearest package owns next-live");

  runtime.startAction("next-live");
  assert.equal(spawn.calls[0].options.cwd, web);
  assert.deepEqual(spawn.calls[0].args, ["run", "dev"]);

  const afterStart = runtime.rows("s1");
  const build = afterStart.items.find((item) => item.action.id === "build-mobile");
  assert.equal(build.resolution.cwd, root, "root scripts run from the workspace root");
  assert.equal(
    build.resolution.env.BUILD_DEFINES_FILE,
    path.join(root, "local-public-defines.json"),
  );

  await cleanup();
});

test("the log command shows the active project's run, never another project's", async () => {
  const first = scriptsFixture();
  const second = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": { scripts: { "build:mobile": "echo other" } },
  });
  let session = "s1";
  const { context, calls } = createContext({
    locationDirectory: first,
    sessions: { s1: { directory: first }, s2: { directory: second } },
    route: () => ({ type: "session", sessionID: session }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  runtime.startAction("build-mobile");
  const firstKey = runtime.manager.keyFor("build-mobile", first);
  assert.equal(runtime.logKey(), firstKey);

  session = "s2";
  assert.equal(runtime.logKey(), undefined, "another project's history is never offered");

  runtime.startAction("build-mobile");
  const secondKey = runtime.manager.keyFor("build-mobile", second);
  assert.equal(runtime.logKey(), secondKey, "the active project wins over the older run");

  runtime.stop(secondKey);
  assert.equal(runtime.logKey(), secondKey, "a finished run of this project is still openable");

  await cleanup();
});

test("stop all reports only the runners it actually stopped", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  runtime.startAction("build-mobile");
  const second = runtime.startAction("mobile-live");
  // The second child survives its signal, like a real process group that needs
  // the grace period, so the in-flight stop state is exercised too.
  const stubborn = spawn.calls[1].child;
  stubborn.kill = (signal) => {
    stubborn.signals.push(signal);
    return true;
  };
  assert.equal(runtime.rows("s1").canStop, true);

  const result = runtime.stopAllRunners();
  assert.deepEqual(result, { stopped: 2, failed: 0 });
  assert.equal(calls.toasts.at(-1).variant, "info");
  assert.equal(calls.toasts.at(-1).message, "Stopped 2 runners");
  // Only the plugin's own children were signalled, and only by signal.
  assert.deepEqual(
    spawn.calls.map((call) => call.child.signals),
    [["SIGTERM"], ["SIGTERM"]],
  );
  assert.equal(runtime.snapshot(second.key).stopping, true);

  // The second child is still on its way out: say so instead of counting it as
  // stopped again or reporting a failure.
  runtime.stopAllRunners();
  assert.equal(calls.toasts.at(-1).variant, "info");
  assert.equal(calls.toasts.at(-1).message, "1 already stopping");

  await cleanup();
});

test("show logs reopens this project's output without spawning", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  // Nothing has run yet: the control is off and the command explains itself.
  assert.equal(runtime.rows("s1").canLog, false);
  assert.equal(runtime.showLog(), false);
  assert.equal(calls.toasts.at(-1).variant, "warning");
  assert.match(calls.toasts.at(-1).message, /No runner output for this project/);

  const started = runtime.startAction("build-mobile");
  const spawned = spawn.calls.length;
  calls.dialogs.length = 0;

  assert.equal(runtime.rows("s1").canLog, true);
  assert.equal(runtime.showLog(), true);
  const dialog = calls.dialogs.find((entry) => typeof entry.render === "function");
  assert.equal(dialog.render().props.runKey, started.key);
  assert.equal(spawn.calls.length, spawned, "showing logs never starts a command");

  await cleanup();
});

test("a stop request for a runner that is gone is explained", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  assert.equal(runtime.requestStop("build-mobile\u0000/gone"), false);
  assert.equal(calls.toasts.at(-1).variant, "warning");
  assert.match(calls.toasts.at(-1).message, /no longer tracked/);

  // A live runner is stopped once; the second request is answered, not ignored.
  const started = runtime.startAction("build-mobile");
  assert.equal(runtime.requestStop(started.key), true);
  assert.equal(runtime.requestStop(started.key), false);
  assert.match(calls.toasts.at(-1).message, /already stopping/);

  await cleanup();
});

test("a failing child stays visible with its exit code", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  runtime.startAction("web-live");
  const started = spawn.calls[0];
  started.child.emit("exit", 2, null);

  const rows = runtime.rows("s1");
  const row = rows.items.find((item) => item.action.id === "web-live");
  assert.equal(row.run.status, "failed");
  assert.equal(row.run.exitCode, 2);

  await cleanup();
});

test("cleanup stops owned children and leaves no exit listener", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const before = process.listenerCount("exit");
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  assert.equal(process.listenerCount("exit"), before + 1);

  runtime.startAction("next-live");
  const child = spawn.calls[0].child;
  await cleanup();

  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(process.listenerCount("exit"), before);
  assert.equal(runtime.manager.list().length, 0);
});

test("falls back to the last rendered session when the router has no session route", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: tmpdir(),
    sessions: { s1: { directory: root } },
    route: () => undefined,
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  runtime.rows("s1");
  const result = runtime.startAction("build-mobile");
  assert.equal(result.ok, true);
  assert.equal(spawn.calls[0].options.cwd, root);

  await cleanup();
});

test("sidebar buttons are frames with no fill and a readable label", () => {
  const source = readFileSync(new URL("./view.jsx", import.meta.url), "utf8");
  const sidebar = functionBody(source, "export function Sidebar");
  const button = functionBody(source, "function RunnerButton");
  const dialogButton = functionBody(source, "function Button");

  // The section appears while there is something to show: commands, or a
  // runner this project can still stop or read.
  assert.match(sidebar, /items\(\)\.length > 0 \|\|\s*board\(\)\.canStop \|\|\s*board\(\)\.canLog \|\|\s*board\(\)\.canCommit \|\|\s*board\(\)\.canPush/);
  // Row-major pairs, two columns, one node per slot.
  assert.match(sidebar, /index \+= 2/);
  assert.match(sidebar, /pairs\.push\(\[list\[index\], list\[index \+ 1\]\]\)/);
  assert.match(sidebar, /<Index each=\{rows\(\)\}>/);
  assert.match(sidebar, /<Index each=\{cells\(\)\}>/);
  // A lone button fills the row and centers its label, without an empty slot.
  assert.match(sidebar, /centered=\{cells\(\)\.length === 1\}/);
  assert.doesNotMatch(sidebar, /fallback=\{<box flexGrow=\{1\} flexBasis=\{0\} \/>\}/);
  // Nothing paints a background: the sidebar background is the button background.
  assert.doesNotMatch(source, /backgroundColor=/);

  // Cells split the row width and keep a visible rectangle.
  assert.match(button, /flexGrow=\{1\}/);
  assert.match(button, /flexBasis=\{0\}/);
  assert.match(button, /border\b/);
  assert.match(button, /borderStyle=/);
  assert.match(button, /borderColor=/);
  assert.match(button, /justifyContent="center"/);

  // Accessor props: a fresh row object updates the node instead of remounting.
  assert.match(button, /const row = \(\) => props\.cell\(\);/);
  assert.doesNotMatch(button, /const \{ cell \}/);

  // Label only: no status prefix or suffix stealing width, and it wraps
  // instead of clipping.
  assert.match(button, /wrapMode="word"/);
  assert.match(button, /\{row\(\)\?\.action\.label \?\? ""\}/);
  assert.doesNotMatch(button, /truncate/);
  assert.doesNotMatch(button, /wrapMode="none"/);
  assert.doesNotMatch(button, /elapsedText|suffix|\bdot\b/);

  // The colours come from the pure helpers in runners.js, which the unit tests
  // cover directly. The view must not carry a colour table of its own.
  assert.match(
    source,
    /import \{\s*buttonVisual,\s*controlVisual,\s*dialogKeyLayer,\s*statusLine,\s*statusTone,\s*token,\s*\} from "\.\/runners\.js";/,
  );
  assert.match(button, /buttonVisual\(theme, row\(\), props\.hovered\(\) === row\(\)\?\.action\.id\)/);
  assert.match(dialogButton, /controlVisual\(theme, \{ disabled: props\.disabled, hovered: hover\(\) \}\)/);
  // No direct foreground choice in the dialog control: the helper owns it.
  assert.doesNotMatch(dialogButton, /token\(theme,/);
  assert.doesNotMatch(source, /rowVisual|TOKENS|readToken|textAccent/);
  assert.doesNotMatch(source, /"rounded"/);
  assert.doesNotMatch(source, /fillWeak|fillButton/);
  assert.doesNotMatch(source, /"background\.action/);
  assert.doesNotMatch(source, /background\.raised/);

  // Plugin-level controls sit in rows of their own. Each one is disabled
  // by its own fact, never by a shared guess. Every row uses the exact same box
  // as an action row and the section adds no vertical padding, so the gap
  // between rows is identical everywhere.
  assert.equal(
    sidebar.split('<box flexDirection="row" flexShrink={0} gap={1}>').length - 1,
    3,
    "the two control rows and the grid rows share one row box",
  );
  assert.doesNotMatch(sidebar, /paddingTop|paddingBottom|marginTop|marginBottom/);
  assert.match(sidebar, /<box flexDirection="column" flexShrink=\{0\}>/);
  // The Git controls are the first row inside the section: above the command
  // grid and above the plugin-level controls, still under the header. They stay
  // disabled while no service is available.
  assert.match(sidebar, /label="Commit"[\s\S]*?disabled=\{!board\(\)\.canCommit\}[\s\S]*?onPress=\{\(\) => runtime\.openGit\("commit"\)\}/);
  assert.match(sidebar, /label="Push"[\s\S]*?disabled=\{!board\(\)\.canPush\}[\s\S]*?onPress=\{\(\) => runtime\.openGit\("push"\)\}/);
  const gitAt = sidebar.indexOf('label="Commit"');
  const gridAt = sidebar.indexOf("<Index each={rows()}>");
  const stopAt = sidebar.indexOf('label="Stop all"');
  const headerAt = sidebar.indexOf("<b>Launchpad</b>");
  assert.ok(
    headerAt >= 0 && headerAt < gitAt && gitAt < gridAt && gridAt < stopAt,
    "the Git row is the first row of the section, under the header and above the grid and the controls",
  );
  assert.match(sidebar, /label="Stop all"/);
  assert.match(sidebar, /disabled=\{!board\(\)\.canStop\}/);
  assert.match(sidebar, /onPress=\{\(\) => runtime\.stopAllRunners\(\)\}/);
  assert.match(sidebar, /label="Show logs"/);
  assert.match(sidebar, /disabled=\{!board\(\)\.canLog\}/);
  assert.match(sidebar, /onPress=\{\(\) => runtime\.showLog\(\)\}/);
  const utility = functionBody(source, "function UtilityButton");
  assert.match(utility, /controlVisual\(theme, \{ disabled: props\.disabled, hovered: hover\(\) \}\)/);
  assert.doesNotMatch(utility, /buttonVisual/);
});

test("the git dialog drives both flows through the runtime, never through git", () => {
  const source = readFileSync(new URL("./view.jsx", import.meta.url), "utf8");
  const dialog = functionBody(source, "export function GitDialog");

  // The state lives in the runtime, so a host prompt that replaces this dialog
  // cannot lose the flow: the view only subscribes and reads.
  assert.match(dialog, /onCleanup\(flow\.subscribe\(/);
  assert.match(dialog, /flow\.state\(\)/);
  assert.doesNotMatch(dialog, /context\.ui/);

  // Commit steps.
  assert.match(dialog, /step\("files"\)/);
  assert.match(dialog, /step\("preview"\)/);
  assert.match(dialog, /step\("egress"\)/);
  assert.match(dialog, /step\("confirm"\)/);
  assert.match(dialog, /step\("blocked"\)/);
  // A commit that already exists ends the flow: the hash is shown and the only
  // control left is Close.
  assert.match(dialog, /step\("committed"\)/);
  assert.match(dialog, /state\(\)\?\.error\?\.hash/);
  assert.match(dialog, /commit \$\{state\(\)\.error\.hash\} already exists — do not retry/);
  const committedBlocks = [...dialog.matchAll(/<Show when=\{step\("committed"\)\}>[\s\S]*?<\/Show>/g)].map(
    (match) => match[0],
  );
  assert.equal(committedBlocks.length, 2, "a body and a control block for the committed step");
  assert.match(committedBlocks[1], /label="Close esc"/);
  assert.doesNotMatch(
    committedBlocks[1],
    /label="Commit"|label="Back"|flow\.confirm\(\)/,
    "a commit that exists offers no way to commit again",
  );
  // Push steps, reviewed and confirmed separately.
  assert.match(dialog, /step\("push-review"\)/);
  assert.match(dialog, /step\("push-confirm"\)/);

  // Every control goes through the runtime API.
  assert.match(dialog, /flow\.toggle\(file\.path\)/);
  assert.match(dialog, /flow\.previewSelection\(\)/);
  assert.match(dialog, /flow\.askEgress\(\)/);
  assert.match(dialog, /flow\.approveEgress\(\)/);
  assert.match(dialog, /flow\.editMessage\(\)/);
  assert.match(dialog, /flow\.confirm\(\)/);
  assert.match(dialog, /flow\.confirmPush\(\)/);
  assert.match(dialog, /flow\.pushNow\(\)/);
  assert.match(dialog, /flow\.back\(\)/);
  assert.match(dialog, /flow\.cancel\(\)/);

  // The reviewed patch and the push target are what the user approves.
  assert.match(dialog, /state\(\)\?\.preview\?\.diff/);
  assert.match(dialog, /state\(\)\.push\.destination/);
  assert.match(dialog, /state\(\)\.push\.hashes/);
  assert.match(dialog, /state\(\)\.selection\.join\(", "\)/);

  // Manual selection: the candidate list is marked, and nothing is pre-checked.
  assert.match(dialog, /file\.session \? "session change" : "unattributed"/);
  assert.match(dialog, /file\.blocked\) return `cannot commit/);
  assert.doesNotMatch(dialog, /selectAll|select-all|\.every\(/);

  // The dialog never runs git, never sends anything itself, and never sizes or
  // clears the popup: the runtime owns both.
  assert.doesNotMatch(dialog, /from "\.\/git\.js"/);
  assert.doesNotMatch(dialog, /execFile|child_process|spawn|fetch\(|copilotBin|buildCopilotArgs/);
  assert.doesNotMatch(dialog, /dialog\.(show|set|clear|prompt)/);
});

test("the section header collapses the rows without touching a run", () => {
  const source = readFileSync(new URL("./view.jsx", import.meta.url), "utf8");
  const sidebar = functionBody(source, "export function Sidebar");

  // Expanded by default, and the toggle is view state only.
  assert.match(sidebar, /const \[collapsed, setCollapsed\] = createSignal\(false\)/);
  assert.match(sidebar, /onMouseUp=\{\(\) => setCollapsed\(\(value\) => !value\)\}/);
  assert.match(sidebar, /<Show when=\{!collapsed\(\)\}>/);
  // The collapse arrow is a full triangle in explicit white, while the title
  // keeps the sidebar foreground.
  assert.match(sidebar, /<text fg="#ffffff" wrapMode="none">\s*\{collapsed\(\) \? "▶" : "▼"\}\s*<\/text>/);
  assert.match(sidebar, /<b>Launchpad<\/b>/);

  // The header, and only the header, stays outside the collapsed branch.
  const collapsedStart = sidebar.indexOf("<Show when={!collapsed()}>");
  assert.ok(collapsedStart > -1, "the collapsed branch exists");
  const header = sidebar.slice(0, collapsedStart);
  assert.match(header, /<b>Launchpad<\/b>/);
  assert.match(header, /board\(\)\.projectName/);

  // The toggle handler never reaches a run: no stop, no send, no manager call.
  const toggleStart = header.indexOf("onMouseUp={() => setCollapsed");
  const toggle = header.slice(toggleStart);
  assert.ok(toggleStart > -1, "the header is clickable");
  assert.doesNotMatch(toggle, /runtime\.|manager\.|stop|send/);

  // Collapsing hides the grid and the utility row, and nothing else.
  const collapsed = sidebar.slice(collapsedStart);
  assert.match(collapsed, /<Index each=\{rows\(\)\}>/);
  assert.match(collapsed, /label="Stop all"/);
  assert.match(collapsed, /label="Show logs"/);
  assert.ok(
    collapsed.lastIndexOf("</Show>") > collapsed.indexOf('label="Show logs"'),
    "both rows sit inside the collapsed branch",
  );
});

test("the log dialog scrolls the retained output with fixed controls", () => {
  const source = readFileSync(new URL("./view.jsx", import.meta.url), "utf8");
  const dialog = functionBody(source, "export function LogDialog");

  // A bounded viewport that follows the newest line only while it is at the end.
  assert.match(dialog, /<scrollbox/);
  assert.match(dialog, /scrollY\b/);
  assert.match(dialog, /stickyScroll\b/);
  assert.match(dialog, /stickyStart="bottom"/);
  assert.match(dialog, /flexGrow=\{1\}/);
  assert.match(dialog, /minHeight=\{3\}/);
  assert.match(dialog, /maxHeight=\{16\}/);
  // Keyboard scrolling is best effort: the box is focusable and focused on open.
  assert.match(dialog, /node\?\.focus\?\.\(\)/);

  // The controls stay outside the scroll area, below the output.
  const scrollStart = dialog.indexOf("<scrollbox");
  const scrollEnd = dialog.indexOf("</scrollbox>");
  const controls = dialog.indexOf('label="Stop s"');
  assert.ok(scrollStart > -1, "scrollbox opens");
  assert.ok(scrollEnd > scrollStart, "scrollbox closes");
  assert.ok(controls > scrollEnd, "controls sit below the scroll area");
  // Every control advertises the key it answers to.
  assert.match(dialog, /label="Stop s"/);
  assert.match(dialog, /label="Reload r"/);
  assert.match(dialog, /label="Restart R"/);
  assert.match(dialog, /label="Close esc"/);

  // Counters: the live elapsed time, the child's redrawn line, and the history.
  assert.match(dialog, /statusLine\(value\(\)\)/);
  assert.match(dialog, /statusTone\(theme, value\(\)\)/);
  assert.match(dialog, /value\(\)\.progress/);
  assert.match(dialog, /<For each=\{value\(\)\.lines\}>/);

  // Stop tells the truth: it is disabled while a stop is already in flight and
  // reports a refusal instead of swallowing it.
  assert.match(dialog, /disabled=\{!value\(\)\.running \|\| value\(\)\.stopping\}/);
  assert.match(dialog, /onPress=\{\(\) => runtime\.requestStop\(runKey\)\}/);
  assert.doesNotMatch(dialog, /runtime\.stop\(runKey\)/);
});

test("escape hides the log dialog and leaves the runner running", async () => {
  const dir = scriptsFixture();
  const { context, calls } = createContext({ locationDirectory: dir });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const started = runtime.startAction("build-mobile");
  assert.equal(started.ok, true);
  const layersBefore = calls.layers.length;

  // The real LogDialog registers this layer while it is mounted.
  const dispose = dialogKeyLayer(context, () => context.ui.dialog.clear(), runtime, started.key);
  assert.equal(calls.layers.length, layersBefore + 1);
  const layer = calls.layers.at(-1);
  assert.equal(layer.mode, "modal");
  const escape = layer.commands.find((command) => command.bind === "escape");
  assert.ok(escape, "escape is bound");
  assert.equal(escape.group, "Dialog");
  assert.equal(escape.title, "Hide log");

  assert.equal(escape.run(), true);
  assert.equal(calls.dialogs.at(-1).clear, true, "the popup is cleared");
  assert.equal(runtime.snapshot(started.key).running, true, "the runner keeps running");
  assert.deepEqual(spawn.calls[0].child.signals, [], "escape never signals the child");

  // Once the dialog is gone the host owns the key again.
  dispose();
  assert.equal(escape.run(), false, "a disposed layer lets the host handle escape");
  assert.equal(runtime.snapshot(started.key).running, true);

  await cleanup();
});

test("the log dialog claims its keys only while it is mounted", () => {
  const source = readFileSync(new URL("./view.jsx", import.meta.url), "utf8");
  const dialog = functionBody(source, "export function LogDialog");

  // The layer is registered by the dialog itself, so the keys are never global
  // and reach the run the dialog was opened for.
  assert.match(dialog, /onCleanup\(dialogKeyLayer\(context, close, runtime, runKey\)\)/);
  // The hint follows the existing "Reload r" / "Restart R" wording.
  assert.match(dialog, /label="Close esc"/);
  // Hiding is not stopping.
  assert.doesNotMatch(dialog, /dialogKeyLayer\([^)]*stop/);
});

test("the log dialog reads the whole history while a sidebar row stays cheap", async () => {
  const dir = scriptsFixture();
  const { context, calls } = createContext({ locationDirectory: dir });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const started = runtime.startAction("build-mobile");
  assert.equal(started.ok, true);
  const { child } = spawn.calls[0];
  for (let index = 0; index < 50; index += 1) child.stdout.emit("data", `line ${index}\n`);

  const log = runtime.snapshot(started.key);
  assert.equal(log.lineCount, 50);
  assert.equal(log.lines.length, 50);
  assert.equal(log.lines.at(-1), "line 49");
  assert.equal(typeof log.elapsedMs, "number");

  // A counter written with a carriage return is one live line, not 50 lines.
  child.stdout.emit("data", "step 1\rstep 2\r");
  const live = runtime.snapshot(started.key);
  assert.equal(live.progress, "step 2");
  assert.equal(live.lineCount, 50);

  // The sidebar row carries the state only: the history stays out of the grid.
  const row = runtime.rows("s1").items[0].run;
  assert.equal(row.running, true);
  assert.equal(row.lineCount, 50);
  assert.deepEqual(row.lines, []);
  await cleanup();
});

// Start a live run and open its log, mirroring what the sidebar click does.
async function liveLog(options = {}) {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0, ...options });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const started = runtime.startAction("mobile-live");
  assert.equal(started.ok, true);
  return { context, runtime, calls, spawn, cleanup, key: started.key };
}

test("the dialog's advertised r and R keys drive reload and restart", async () => {
  const { context, runtime, calls, spawn, cleanup, key } = await liveLog();
  const child = spawn.calls[0].child;

  // The real LogDialog registers this layer while it is mounted.
  const dispose = dialogKeyLayer(context, () => context.ui.dialog.clear(), runtime, key);
  const layer = calls.layers.at(-1);
  assert.equal(layer.mode, "modal");
  const reload = layer.commands.find((command) => command.bind === "r");
  // Upper case is spelled shift+r; a bare "R" never matches a key event.
  const restart = layer.commands.find((command) => command.bind === "shift+r");
  assert.ok(reload, "r is bound");
  assert.ok(restart, "shift+r is bound");
  assert.equal(
    layer.commands.some((command) => command.bind === "R"),
    false,
    "a bare R is never bound",
  );
  assert.equal(reload.group, "Dialog");
  assert.equal(reload.title, "Reload (hot reload)");
  assert.equal(restart.title, "Restart (hot restart)");

  assert.equal(reload.run(), true);
  assert.equal(restart.run(), true);
  assert.deepEqual(child.writes, ["r", "R"], "each key writes its own byte");
  assert.equal(runtime.snapshot(key).running, true, "a reload never stops the run");
  assert.deepEqual(child.signals, [], "a reload never signals the child");

  // Once the dialog is gone the host owns r/R again.
  dispose();
  assert.equal(reload.run(), false, "a disposed layer releases the key");
  assert.deepEqual(child.writes, ["r", "R"], "no write after the dialog closed");
  await cleanup();
});

test("a hotkey on a run that takes no input warns instead of faking a reload", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const started = runtime.startAction("build-mobile");
  assert.equal(started.ok, true);
  const child = spawn.calls[0].child;

  const dispose = dialogKeyLayer(context, () => context.ui.dialog.clear(), runtime, started.key);
  const reload = calls.layers.at(-1).commands.find((command) => command.bind === "r");
  assert.equal(reload.run(), true, "the dialog still consumes the key");
  assert.deepEqual(child.writes, [], "a one-shot build never receives a keystroke");
  assert.equal(calls.toasts.at(-1).variant, "warning");
  assert.match(calls.toasts.at(-1).message, /does not take reload input/);
  dispose();
  await cleanup();
});

test("a keystroke refused because the run finished is reported, not dropped", async () => {
  const { runtime, calls, cleanup, key } = await liveLog();
  assert.equal(runtime.stop(key), true);
  assert.equal(runtime.send(key, "r"), false);
  assert.equal(calls.toasts.at(-1).variant, "info");
  assert.match(calls.toasts.at(-1).message, /already stopped/);
  await cleanup();
});

test("a keystroke on a live run with a closed input reports a delivery failure", async () => {
  const { runtime, calls, spawn, cleanup, key } = await liveLog();
  spawn.calls[0].child.stdin.writable = false;

  assert.equal(runtime.send(key, "r"), false);
  assert.deepEqual(spawn.calls[0].child.writes, []);
  assert.equal(calls.toasts.at(-1).variant, "error");
  assert.match(calls.toasts.at(-1).message, /could not be delivered/);
  await cleanup();
});

test("the dialog's s key stops through the stop path, never as input", async () => {
  const { context, runtime, calls, spawn, cleanup, key } = await liveLog();
  const child = spawn.calls[0].child;

  const dispose = dialogKeyLayer(context, () => context.ui.dialog.clear(), runtime, key);
  const stop = calls.layers.at(-1).commands.find((command) => command.bind === "s");
  assert.ok(stop, "s is bound");
  assert.equal(stop.group, "Dialog");
  assert.equal(stop.title, "Stop runner");

  assert.equal(stop.run(), true);
  assert.deepEqual(child.writes, [], "s is never written to the child's input");
  assert.equal(runtime.snapshot(key).stopping, true, "the stop path ran");
  assert.deepEqual(child.signals, ["SIGTERM"], "the group is signalled, not typed at");

  dispose();
  await cleanup();
});

test("each dialog layer drives the run it was mounted for", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const live = runtime.startAction("mobile-live");
  assert.equal(live.ok, true);
  const liveChild = spawn.calls[0].child;
  const firstLayer = dialogKeyLayer(context, () => context.ui.dialog.clear(), runtime, live.key);

  // The host swaps the dialog onto another run and mounts a second layer.
  const build = runtime.startAction("build-mobile");
  assert.equal(build.ok, true);
  const buildChild = spawn.calls[1].child;
  const secondLayer = dialogKeyLayer(context, () => context.ui.dialog.clear(), runtime, build.key);

  // The old layer unmounts after the new one registered: the live dialog keeps
  // its keys, and the run behind the closed dialog is left alone.
  firstLayer();
  const reload = calls.layers.at(-1).commands.find((command) => command.bind === "r");
  assert.equal(reload.run(), true, "the new dialog keeps its hotkeys");
  assert.deepEqual(buildChild.writes, [], "the one-shot build is the run that is driven");
  assert.match(calls.toasts.at(-1).message, /does not take reload input/);
  assert.deepEqual(liveChild.writes, [], "the closed dialog no longer drives its old run");

  secondLayer();
  await cleanup();
});

test("the git controls are enabled by the built-in service and explain an injected null", async () => {
  const dir = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  // An explicit null is how a host (or a test) says "no service here".
  const cleanup = await startPlugin(context, view, { spawn: createFakeSpawn(), notifyMs: 0, git: null });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  assert.equal(runtime.gitReady(), false);
  assert.equal(runtime.rows("s1").canCommit, false);
  assert.equal(runtime.rows("s1").canPush, false);

  assert.deepEqual(runtime.openGit("commit"), {
    ok: false,
    code: "unavailable",
    message: "the git service is not connected yet",
  });
  assert.equal(calls.toasts.at(-1).variant, "warning");
  assert.equal(calls.toasts.at(-1).message, "Commit: the git service is not connected yet");

  // The palette reaches the same path as the button.
  const push = calls.layers[0].commands.find((command) => command.id === `${PLUGIN_ID}.push`);
  assert.ok(push, "the push command is registered");
  push.run();
  assert.equal(calls.toasts.at(-1).message, "Push: the git service is not connected yet");

  await cleanup();
});

test("a service without the commit steps says which part is missing", async () => {
  const dir = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const git = { reason: "git is not installed on this machine" };
  const cleanup = await startPlugin(context, view, { spawn: createFakeSpawn(), notifyMs: 0, git });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  // A service that reports a reason is still counted as connected: the reason
  // explains a later refusal, it does not hide the controls.
  assert.equal(runtime.rows("s1").canCommit, true);
  assert.equal(runtime.openGit("push").message, "the git service is missing the push steps");
  assert.equal(calls.toasts.at(-1).message, "Push: the git service is missing the push steps");
  assert.equal(runtime.openGit("commit").message, "the git service is missing the commit steps");

  await cleanup();
});

test("a connected service gets the click-time session and folder", async () => {
  const first = scriptsFixture();
  const second = fixture({
    "package.json": { scripts: {} },
    "local-public-defines.json": "{}",
  });
  let session = "s1";
  const { context, calls } = createContext({
    locationDirectory: first,
    sessions: { s1: { directory: first }, s2: { directory: second } },
    route: () => ({ type: "session", sessionID: session }),
  });
  const opened = [];
  const git = {
    status: async (input) => {
      opened.push({ flow: "commit", ...input });
      return { ok: false, error: { code: "not-a-repo", message: "Not a git repository" } };
    },
    preview: async () => ({ ok: false, error: { code: "no-selection", message: "No files were selected" } }),
    previewPush: async (input) => {
      opened.push({ flow: "push", ...input });
      return { ok: false, error: { code: "no-upstream", message: "No push destination is configured" } };
    },
    push: async () => ({ ok: false, error: { code: "unconfirmed", message: "Pushing was not confirmed" } }),
  };
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    git,
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  assert.equal(runtime.gitReady(), true);
  assert.equal(runtime.openGit("commit").ok, true);
  await until(() => opened.length === 1);
  assert.deepEqual(opened[0], { flow: "commit", cwd: first, sessionFiles: [] });

  // Switching tabs afterwards must not widen the flow that already started: the
  // first call keeps its own session and folder, and the next one follows the
  // newly active tab.
  session = "s2";
  runtime.openGit("push");
  await until(() => opened.length === 2);
  assert.deepEqual(opened[0], { flow: "commit", cwd: first, sessionFiles: [] });
  assert.deepEqual(opened[1], { flow: "push", cwd: second });

  await cleanup();
});

test("the commit flow reviews the exact patch before anything is written", async () => {
  const dir = scriptsFixture();
  const tmpRoot = path.join(dir, "git-tmp");
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0? notes.txt\0";
  const exec = fakeGit({ root: dir, status });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    diffFiles: { s1: ["src/a.ts"] },
    promptAnswers: ["tidy the header"],
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  // The built-in service enables the controls; the dialog is mounted and sized.
  assert.equal(runtime.rows("s1").canCommit, true);
  assert.deepEqual(runtime.openGit("commit"), {
    ok: true,
    flow: "commit",
    sessionID: "s1",
    directory: dir,
  });
  assert.deepEqual(calls.dialogs[1].set, { size: "large" });
  assert.equal(calls.dialogs[0].render().kind, "git");
  await until(() => flow.state()?.step === "files", "the file list");

  // The session diff was asked for with the installed SDK's request shape. Its
  // file is a confirmed session change, so it starts checked by default.
  assert.deepEqual(
    calls.diffs,
    [{ sessionID: "s1" }],
    "the no-turn fallback asks the newest-turn diff with the flat shape",
  );
  assert.deepEqual(
    flow.state().files.map((file) => [file.path, file.session, file.unattributed]),
    [
      ["src/a.ts", true, false],
      ["notes.txt", false, true],
    ],
  );
  assert.deepEqual(flow.state().selection, ["src/a.ts"], "only confirmed session changes start checked");

  assert.equal(flow.toggle("src/a.ts"), true);
  assert.deepEqual(flow.state().selection, [], "a preselected file can be unchecked");
  assert.equal(flow.toggle("src/a.ts"), true);
  assert.deepEqual(flow.state().selection, ["src/a.ts"]);

  await flow.previewSelection();
  assert.equal(flow.state().step, "preview");
  assert.equal(flow.state().preview.diff, "diff --git a/src/a.ts b/src/a.ts\n+one line\n");
  assert.match(flow.state().preview.stat, /1 file changed/);
  assert.equal(
    exec.commands().some((line) => line.startsWith("commit")),
    false,
    "the review writes nothing",
  );

  // The egress step is the only place the diff leaves the machine, and it needs
  // its own confirmation: the API cannot generate straight from the review.
  assert.equal(await flow.approveEgress(), null);
  assert.equal(flow.state().step, "preview");
  assert.equal(
    exec.calls.filter((call) => call.file !== "git").length,
    0,
    "the review step never sends the diff",
  );

  assert.equal(flow.askEgress(), true);
  assert.equal(flow.state().step, "egress");
  await flow.approveEgress();
  await until(() => calls.prompts.length === 1, "the message prompt");
  assert.equal(calls.prompts[0].title, "Commit message");
  // Copilot's raw suggestion carries a Conventional Commit prefix, which is
  // stripped before the user reviews it; the confirmed text is what commits.
  assert.equal(calls.prompts[0].value, "tidy the header");
  // The prompt is a plain descriptive subject and never models a type prefix.
  const prompt = calls.prompts[0];
  for (const field of ["title", "description", "placeholder", "value"]) {
    assert.equal(
      /(?:^|\s)(?:feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(?:\([^)]*\))?!?:/i.test(
        prompt[field] ?? "",
      ),
      false,
      `no Conventional Commit prefix in the prompt ${field}`,
    );
  }
  assert.match(prompt.description, /as-is/i, "the draft stays editable");
  assert.equal(flow.state().step, "confirm");
  assert.equal(flow.state().message, "tidy the header");

  const copilot = exec.calls.filter((call) => call.file !== "git");
  assert.equal(copilot.length, 1, "the diff was sent once");
  assert.equal(copilot[0].input, flow.state().preview.diff);
  assert.equal(copilot[0].cwd.startsWith(tmpRoot), true, "sent from the review folder");
  assert.equal(copilot[0].cwd === dir, false);
  assert.equal(copilot[0].env.COPILOT_ALLOW_ALL, undefined);

  await flow.confirm();
  await until(() => flow.state() === null, "the dialog to close");
  const committed = exec.commands().find((line) => line.startsWith("commit -m"));
  assert.equal(committed, "commit -m tidy the header");
  assert.equal(committed.includes("--no-verify"), false, "hooks are never skipped");
  assert.equal(calls.toasts.at(-1).message, "Committed 1 file · head2");
  assert.equal(calls.dialogs.at(-1).clear, true);

  await cleanup();
});

test("the review default checks only confirmed session changes, never unsafe ones", async () => {
  const dir = scriptsFixture();
  const git = {
    async status() {
      return {
        ok: true,
        root: dir,
        branch: "main",
        detached: false,
        head: "h1",
        upstream: null,
        ahead: null,
        files: [
          { path: "src/a.ts", session: true, unattributed: false, blocked: null },
          { path: "src/conflict.ts", session: true, unattributed: false, blocked: "conflicted" },
          { path: "notes.txt", session: false, unattributed: true, blocked: null },
        ],
        candidates: [],
        unattributed: [],
        statusHash: "hash",
      };
    },
    async preview() {
      return { ok: true, token: "t1", files: [], diff: "", diffTruncated: false, diffUnavailable: false, stat: "" };
    },
    discard() {
      return { ok: true };
    },
  };
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    git,
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");

  // The default is exactly the confirmed, safe session change: a blocked session
  // change and an unattributed change are shown but never start checked.
  assert.deepEqual(flow.state().selection, ["src/a.ts"], "only the safe session change is preselected");
  assert.deepEqual(
    flow.state().files.map((file) => [file.path, file.blocked]),
    [
      ["src/a.ts", null],
      ["src/conflict.ts", "conflicted"],
      ["notes.txt", null],
    ],
  );

  // A blocked file cannot be selected even by an explicit toggle.
  assert.equal(flow.toggle("src/conflict.ts"), false, "a blocked file refuses selection");
  assert.deepEqual(flow.state().selection, ["src/a.ts"], "the blocked file stayed out");
  // An unattributed file can be opted in by hand, and back out again.
  assert.equal(flow.toggle("notes.txt"), true);
  assert.deepEqual(flow.state().selection, ["src/a.ts", "notes.txt"]);
  assert.equal(flow.toggle("notes.txt"), true);
  assert.deepEqual(flow.state().selection, ["src/a.ts"]);

  await cleanup();
});

test("a reload returns the selection to the deliberate default, not the user's edits", async () => {
  const dir = scriptsFixture();
  const git = {
    async status() {
      return {
        ok: true,
        root: dir,
        branch: "main",
        detached: false,
        head: "h1",
        upstream: null,
        ahead: null,
        files: [
          { path: "src/a.ts", session: true, unattributed: false, blocked: null },
          { path: "notes.txt", session: false, unattributed: true, blocked: null },
        ],
        candidates: [],
        unattributed: [],
        statusHash: "hash",
      };
    },
    async preview() {
      return { ok: true, token: "t1", files: [], diff: "", diffTruncated: false, diffUnavailable: false, stat: "" };
    },
    discard() {
      return { ok: true };
    },
  };
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    git,
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  assert.deepEqual(flow.state().selection, ["src/a.ts"]);

  // The user makes the selection their own...
  flow.toggle("src/a.ts");
  flow.toggle("notes.txt");
  assert.deepEqual(flow.state().selection, ["notes.txt"]);

  // ...and a reload deliberately rebuilds it from the status default, so the
  // action's own refresh cannot silently widen what a commit would include.
  await flow.reload();
  assert.equal(flow.state().step, "files");
  assert.deepEqual(flow.state().selection, ["src/a.ts"], "the reload restores the default, not the edits");

  await cleanup();
});

test("a patch that cannot be shown in full is dropped, never committed blind", async () => {
  const dir = scriptsFixture();
  const discarded = [];
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    diffFiles: { s1: ["src/a.ts"] },
  });
  const git = {
    async status() {
      return {
        ok: true,
        root: dir,
        branch: "main",
        detached: false,
        head: "h1",
        upstream: null,
        ahead: null,
        files: [{ path: "src/a.ts", session: true, unattributed: false, blocked: null }],
        candidates: [],
        unattributed: [],
        statusHash: "hash",
      };
    },
    async preview() {
      return {
        ok: true,
        token: "t1",
        files: [],
        diff: "a very long patch",
        diffTruncated: true,
        diffUnavailable: false,
        stat: "",
      };
    },
    discard({ token }) {
      discarded.push(token);
      return { ok: true };
    },
    async push() {
      return { ok: false };
    },
    async previewPush() {
      return { ok: false };
    },
  };
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    git,
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  assert.deepEqual(
    flow.state().selection,
    ["src/a.ts"],
    "the confirmed session change starts checked; review needs no toggle first",
  );
  await flow.previewSelection();
  assert.equal(flow.state().step, "blocked");
  assert.match(flow.state().notice, /larger than the review limit/);
  assert.deepEqual(discarded, ["t1"], "the unusable review is dropped");
  assert.equal(flow.state().preview, null);
  assert.equal(flow.state().pushReady, false);

  // Nothing can be committed from the blocked step.
  await flow.confirm();
  assert.equal(flow.state().step, "blocked");
  assert.equal(flow.back(), true);
  assert.equal(flow.state().step, "files");

  await cleanup();
});

test("a commit that already exists is shown with its hash and never retried", async () => {
  const dir = scriptsFixture();
  const tmpRoot = path.join(dir, "git-tmp");
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0";
  // The commit lands, then the committed tree differs from the reviewed one.
  const exec = fakeGit({ root: dir, status, treeAfterCommit: "tree2" });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    promptAnswers: ["fix(web): one line"],
    diffFiles: { s1: ["src/a.ts"] },
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  assert.deepEqual(flow.state().selection, ["src/a.ts"], "the confirmed session change starts checked");
  await flow.previewSelection();
  flow.askEgress();
  await flow.approveEgress();
  await until(() => flow.state()?.step === "confirm", "the confirm step");

  await flow.confirm();
  // The failure carries the hash of the commit that exists.
  assert.equal(flow.state().step, "committed");
  assert.equal(flow.state().error.code, "hook-changed-tree");
  assert.equal(flow.state().error.hash, "head2");
  assert.equal(flow.state().token !== null, true, "the review is still owned for cleanup");
  assert.equal(
    calls.toasts.at(-1).message,
    "Commit exists as head2 — do not retry",
    "the hash is said out loud",
  );
  assert.equal(calls.toasts.at(-1).variant, "error");

  // Nothing can commit twice: the confirm step is gone and a late press is a no-op.
  assert.notEqual(flow.state().step, "confirm");
  assert.equal(await flow.confirm(), null);
  assert.equal(await flow.confirmPush(), false);
  const commits = exec.commands().filter((line) => line.startsWith("commit -m"));
  assert.equal(commits.length, 1, "one commit was attempted");

  // Closing drops the review and leaves the repository alone.
  flow.cancel();
  assert.equal(flow.state(), null);
  assert.equal(readdirSync(tmpRoot).length, 0, "no review folder is left behind");

  await cleanup();
});

test("the push flow shows the exact target and never forces", async () => {
  const dir = scriptsFixture();
  const tmpRoot = path.join(dir, "git-tmp");
  const exec = fakeGit({ root: dir, outgoing: "2", hashes: ["head1", "head0"] });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  assert.equal(runtime.openGit("push").ok, true);
  await until(() => flow.state()?.step === "push-review", "the push review");
  const target = flow.state().push;
  assert.deepEqual(
    [target.branch, target.remote, target.remoteBranch, target.upstream, target.destination, target.outgoing],
    ["main", "origin", "main", "origin/main", "git@github.com:acme/repo.git", 2],
  );
  assert.deepEqual(target.hashes, ["head1", "head0"]);
  assert.equal(flow.state().pushReady, true);
  assert.equal(
    exec.calls.some((call) => call.args.includes("push")),
    false,
    "the review sends nothing",
  );

  // Two explicit steps: review, then a separate confirmation.
  assert.equal(flow.confirmPush(), true);
  assert.equal(flow.state().step, "push-confirm");
  assert.equal(flow.back(), true);
  assert.equal(flow.state().step, "push-review");
  assert.equal(flow.confirmPush(), true);

  await flow.pushNow();
  await until(() => flow.state() === null, "the push dialog to close");
  const pushed = exec.calls.find((call) => call.args.includes("push"));
  assert.ok(pushed, "the confirmed push reached git");
  // The remote and one explicit refspec, last: push.default and a configured
  // refspec cannot pick another destination.
  assert.equal(pushed.args.at(-1), "HEAD:refs/heads/main");
  assert.equal(pushed.args.at(-2), "origin");
  for (const flag of ["--force", "-f", "--mirror", "--all", "--tags", "--force-with-lease", "--delete", "--prune"]) {
    assert.equal(pushed.args.includes(flag), false, `the push must not pass ${flag}`);
  }
  assert.equal(calls.toasts.at(-1).message, "Pushed main to origin/main");
  assert.equal(calls.dialogs.at(-1).clear, true);

  await cleanup();
});

test("a push target that cannot be resolved is reported, not guessed", async () => {
  const dir = scriptsFixture();
  const exec = fakeGit({ root: dir, noPushTarget: true });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("push");
  await until(() => flow.state() === null, "the push flow to close");
  assert.equal(calls.toasts.at(-1).variant, "error");
  assert.match(calls.toasts.at(-1).message, /^Push: /);
  assert.equal(
    exec.calls.some((call) => call.args.includes("push")),
    false,
    "a refused target never reaches git push",
  );

  await cleanup();
});

test("cancelling a review drops it and leaves the repository alone", async () => {
  const dir = scriptsFixture();
  const tmpRoot = path.join(dir, "git-tmp");
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0";
  const exec = fakeGit({ root: dir, status });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    diffFiles: { s1: ["src/a.ts"] },
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  assert.deepEqual(flow.state().selection, ["src/a.ts"], "the confirmed session change starts checked");
  await flow.previewSelection();
  assert.equal(flow.state().step, "preview");
  assert.equal(readdirSync(tmpRoot).length, 1, "the review holds one private index");

  flow.cancel();
  assert.equal(flow.state(), null);
  assert.equal(readdirSync(tmpRoot).length, 0, "cancelling drops the private index");
  assert.equal(
    exec.commands().some((line) => line.startsWith("commit")),
    false,
    "cancelling writes nothing",
  );
  assert.equal(calls.dialogs.at(-1).clear, true);

  await cleanup();
});

test("cancelling a push review releases its token so no stale push can run", async () => {
  const dir = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const discarded = [];
  const pushed = [];
  const git = {
    status: async () => ({ ok: false, error: { code: "not-a-repo", message: "Not a git repository" } }),
    preview: async () => ({ ok: false, error: { code: "no-selection", message: "No files were selected" } }),
    previewPush: async () => ({
      ok: true,
      token: "push-t1",
      branch: "main",
      head: "head1",
      remote: "origin",
      remoteBranch: "main",
      upstream: "origin/main",
      destination: "git@github.com:acme/repo.git",
      outgoing: 1,
      hashes: ["head1"],
    }),
    push: async (input) => {
      pushed.push(input);
      return { ok: true, branch: "main", remote: "origin", remoteBranch: "main" };
    },
    discard: ({ token }) => {
      discarded.push(token);
      return { ok: true };
    },
  };
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    git,
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  assert.equal(runtime.openGit("push").ok, true);
  await until(() => flow.state()?.step === "push-review", "the push review");

  // The API cannot push from the review step, even with a live token: only the
  // confirmation step may reach the network.
  assert.equal(await flow.pushNow(), null);
  assert.equal(pushed.length, 0, "the review step never pushes");

  // Cancelling releases the frozen push target.
  flow.cancel();
  assert.equal(flow.state(), null);
  assert.deepEqual(discarded, ["push-t1"], "the cancelled push token is released");

  // The flow is gone, so no stale action can push with the released token.
  assert.equal(await flow.pushNow(), null);
  assert.equal(pushed.length, 0, "a cancelled push never reaches the service");

  await cleanup();
});

test("a live host snapshot supplies the candidate files without the SDK", async () => {
  const dir = scriptsFixture();
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0? notes.txt\0";
  const exec = fakeGit({ root: dir, status });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    snapshotFiles: { s1: ["src/a.ts"] },
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  assert.deepEqual(calls.snapshots, ["s1"], "the live snapshot was read");
  assert.deepEqual(calls.diffs, [], "the SDK was not needed");
  assert.deepEqual(
    flow.state().files.map((file) => [file.path, file.session, file.unattributed]),
    [
      ["src/a.ts", true, false],
      ["notes.txt", false, true],
    ],
  );

  await cleanup();
});

test("an unreadable session diff leaves every file unattributed", async () => {
  const dir = scriptsFixture();
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0? notes.txt\0";
  const exec = fakeGit({ root: dir, status });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    diffFiles: { s1: ["src/a.ts"] },
    diffThrows: true,
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  // No evidence, no attribution: the user picks by hand instead of trusting a
  // shape the host did not send.
  assert.deepEqual(
    flow.state().files.map((file) => [file.path, file.session, file.unattributed]),
    [
      ["src/a.ts", false, true],
      ["notes.txt", false, true],
    ],
  );

  await cleanup();
});

test("session attribution uses the installed client's message.list and session.diff contract", async () => {
  const dir = scriptsFixture();
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0";
  const exec = fakeGit({ root: dir, status });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    messageItems: { s1: [messageTurn("u1", 100)] },
    messageDiffFiles: { u1: ["src/a.ts"] },
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  // `client.message.list` is filtered to user turns, oldest first.
  assert.deepEqual(calls.messages, [
    { sessionID: "s1", limit: 100, type: "user", order: "asc" },
  ]);
  // Each user turn is diffed by `from`; the fabricated keys never appear.
  assert.deepEqual(calls.diffs, [{ sessionID: "s1", from: "u1" }]);
  for (const request of [...calls.messages, ...calls.diffs]) {
    for (const key of ["path", "before", "directory", "messageID"]) {
      assert.equal(key in request, false, `${key} is not part of the client contract`);
    }
  }
  assert.deepEqual(calls.invalid, [], "the fabricated session.messages route is never called");
  assert.deepEqual(flow.state().selection, ["src/a.ts"]);

  // The mock rejects the fabricated shapes outright, so a regression fails.
  await assert.rejects(
    () => context.client.session.messages(),
    /not part of the @opencode\/client contract/,
  );
  await assert.rejects(
    () => context.client.session.diff({ sessionID: "s1", messageID: "u1" }),
    /unsupported session diff request key: messageID/,
  );
  await assert.rejects(
    () => context.client.message.list({ sessionID: "s1", type: "user", before: "u1" }),
    /unsupported message list request/,
  );
  await assert.rejects(
    () =>
      context.client.message.list({ sessionID: "s1", type: "user", order: "asc", cursor: "c1" }),
    /order must not be combined with cursor/,
  );

  await cleanup();
});

test("an earlier session turn keeps its files attributed when the latest turn changed nothing", async () => {
  const dir = scriptsFixture();
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0? notes.txt\0";
  const exec = fakeGit({ root: dir, status });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    messageItems: { s1: [messageTurn("u2", 200), messageTurn("u1", 100)] },
    messageDiffFiles: { u1: ["src/a.ts"], u2: [] },
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  // The latest turn made no edit; the older turn's file is still a confirmed
  // session change and starts checked.
  assert.deepEqual(flow.state().selection, ["src/a.ts"], "the earlier turn's file starts checked");
  assert.deepEqual(
    flow.state().files.map((file) => [file.path, file.session, file.unattributed]),
    [
      ["src/a.ts", true, false],
      ["notes.txt", false, true],
    ],
  );
  assert.deepEqual(
    calls.diffs,
    [
      { sessionID: "s1", from: "u1" },
      { sessionID: "s1", from: "u2" },
    ],
    "both user turns were diffed, not just the newest",
  );
  assert.deepEqual(calls.messages, [
    { sessionID: "s1", limit: 100, type: "user", order: "asc" },
  ]);
  assert.equal(flow.state().notice, "", "a complete read needs no warning");

  await cleanup();
});

test("a multi-page user history is walked with the opaque cursor", async () => {
  const dir = scriptsFixture();
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0";
  const exec = fakeGit({ root: dir, status });
  const items = [];
  for (let i = 0; i < 150; i += 1) items.push(messageTurn(`u${i}`, i));
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    messageItems: { s1: items },
    messageDiffFiles: { u120: ["src/a.ts"] },
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  assert.deepEqual(
    calls.messages,
    [
      { sessionID: "s1", limit: 100, type: "user", order: "asc" },
      // The cursor is opaque and `order` is not combined with it.
      { sessionID: "s1", limit: 100, type: "user", cursor: "c100" },
    ],
    "the walk follows cursor.next to the older page",
  );
  assert.deepEqual(flow.state().selection, ["src/a.ts"], "a turn from the first page still attributes");
  // More turns than the per-click cap are diffed, and the omission is stated.
  assert.match(flow.state().notice, /could not be read/, "unwalked turns are disclosed");

  await cleanup();
});

test("duplicate files across session turns are attributed once", async () => {
  const dir = scriptsFixture();
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0? b.ts\0";
  const exec = fakeGit({ root: dir, status });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    messageItems: { s1: [messageTurn("u2", 200), messageTurn("u1", 100)] },
    messageDiffFiles: { u2: ["src/a.ts", "b.ts"], u1: ["src/a.ts"] },
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  assert.deepEqual([...flow.state().selection].sort(), ["b.ts", "src/a.ts"]);
  assert.equal(flow.state().files.length, 2, "each path appears once");

  await cleanup();
});

test("each user turn is diffed by its own id", async () => {
  const dir = scriptsFixture();
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0";
  const exec = fakeGit({ root: dir, status });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    messageItems: { s1: [messageTurn("u2", 200), messageTurn("u1", 100)] },
    messageDiffFiles: { u1: ["src/a.ts"], u2: [] },
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  assert.deepEqual(flow.state().selection, ["src/a.ts"]);
  assert.deepEqual(
    calls.diffs,
    [
      { sessionID: "s1", from: "u1" },
      { sessionID: "s1", from: "u2" },
    ],
    "the turn id is the `from` anchor, not a messageID",
  );
  assert.equal(flow.state().notice, "", "every turn diff resolved");

  await cleanup();
});

test("a failed message list read falls back to the flat diff and warns", async () => {
  const dir = scriptsFixture();
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0";
  const exec = fakeGit({ root: dir, status });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    diffFiles: { s1: ["src/a.ts"] },
    messagesThrows: true,
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  assert.deepEqual(flow.state().selection, ["src/a.ts"], "the flat diff still attributes the newest turn");
  assert.deepEqual(calls.diffs, [{ sessionID: "s1" }]);
  assert.match(flow.state().notice, /could not be read/, "the partial read is stated, not hidden");

  await cleanup();
});

test("a malformed message list response falls back to the flat diff and warns", async () => {
  const dir = scriptsFixture();
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0";
  const exec = fakeGit({ root: dir, status });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    diffFiles: { s1: ["src/a.ts"] },
    messagesMalformed: true,
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  assert.deepEqual(flow.state().selection, ["src/a.ts"]);
  assert.equal(calls.messages.length, 1, "the message list is tried once, not retried");
  assert.match(flow.state().notice, /could not be read/);

  await cleanup();
});

test("a failed per-turn diff keeps the confirmed flat subset and warns", async () => {
  const dir = scriptsFixture();
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0";
  const exec = fakeGit({ root: dir, status });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    messageItems: { s1: [messageTurn("u1", 100)] },
    diffFiles: { s1: ["src/a.ts"] },
    messageDiffThrows: true,
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  assert.deepEqual(flow.state().selection, ["src/a.ts"]);
  assert.deepEqual(
    calls.diffs,
    [{ sessionID: "s1", from: "u1" }, { sessionID: "s1" }],
    "the turn diff failed, so the newest-turn diff was the fallback",
  );
  assert.match(flow.state().notice, /could not be read/);

  await cleanup();
});

test("a host without message.list falls back to the newest-turn diff and warns", async () => {
  const dir = scriptsFixture();
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0";
  const exec = fakeGit({ root: dir, status });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    diffFiles: { s1: ["src/a.ts"] },
    messagesMissing: true,
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  assert.deepEqual(flow.state().selection, ["src/a.ts"]);
  assert.equal(calls.messages.length, 0, "an absent route is not called");
  assert.deepEqual(calls.diffs, [{ sessionID: "s1" }]);
  assert.match(flow.state().notice, /could not be read/, "one turn cannot stand for the history");

  await cleanup();
});

test("a history beyond the page cap warns instead of silently dropping turns", async () => {
  const dir = scriptsFixture();
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0";
  const exec = fakeGit({ root: dir, status });
  const items = [];
  for (let i = 0; i < 2100; i += 1) items.push(messageTurn(`u${i}`, i));
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    messageItems: { s1: items },
    messageDiffFiles: { u1999: ["src/a.ts"] },
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  assert.equal(calls.messages.length, 20, "the walk stops at the bounded page cap");
  assert.match(flow.state().notice, /longer than one read/, "the truncation is stated, not hidden");

  await cleanup();
});

test("a confirmed session change that git blocks is never preselected", async () => {
  const dir = scriptsFixture();
  symlinkSync("/etc/hostname", path.join(dir, "escape"));
  const status = "? escape\0";
  const exec = fakeGit({ root: dir, status });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    messageItems: { s1: [messageTurn("u1", 100)] },
    messageDiffFiles: { u1: ["escape"] },
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  assert.deepEqual(
    flow.state().files.map((file) => [file.path, file.session, file.unattributed, file.blocked]),
    [["escape", true, false, "symlink-escape"]],
    "attribution is recorded, but the blocked file stays out of the selection",
  );
  assert.deepEqual(flow.state().selection, []);

  await cleanup();
});

test("reading session attribution performs no git mutation", async () => {
  const dir = scriptsFixture();
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0";
  const exec = fakeGit({ root: dir, status });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    messageItems: { s1: [messageTurn("u1", 100)] },
    messageDiffFiles: { u1: ["src/a.ts"] },
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  const mutating = exec.calls.filter(
    (call) => call.file === "git" && ["add", "commit", "push"].includes(call.args[0]),
  );
  assert.deepEqual(mutating, [], "opening the flow only reads");

  await cleanup();
});

test("escape cancels the flow through the dialog's own close hook", async () => {
  const dir = scriptsFixture();
  const tmpRoot = path.join(dir, "git-tmp");
  const status = "1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts\0";
  const exec = fakeGit({ root: dir, status });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
    diffFiles: { s1: ["src/a.ts"] },
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state()?.step === "files", "the file list");
  assert.deepEqual(flow.state().selection, ["src/a.ts"], "the confirmed session change starts checked");
  await flow.previewSelection();

  // The host closes the top dialog on escape and calls this hook. The flow ends
  // and its review is dropped; the popup is the host's to pop.
  const shown = calls.dialogs.find((entry) => entry.render);
  shown.onClose();
  assert.equal(flow.state(), null);
  assert.equal(readdirSync(tmpRoot).length, 0, "the review is dropped");
  // The host already popped the dialog for escape, so the flow must not ask for
  // a second clear.
  assert.equal(calls.dialogs.at(-1).clear, undefined, "the host pops the dialog itself");
  assert.equal(
    exec.commands().some((line) => line.startsWith("commit")),
    false,
    "escape never commits",
  );

  await cleanup();
});

test("a repository that cannot be read closes the dialog and says why", async () => {
  const dir = scriptsFixture();
  const exec = fakeGit({ root: dir, notARepo: true });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec, tmpRoot: path.join(dir, "git-tmp") },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const flow = runtime.commitFlow;

  runtime.openGit("commit");
  await until(() => flow.state() === null, "the commit flow to close");
  assert.equal(calls.toasts.at(-1).variant, "error");
  assert.match(calls.toasts.at(-1).message, /^Commit: /);
  assert.equal(calls.dialogs.at(-1).clear, true);

  await cleanup();
});


// --------------------------------------------------------------------------
// Settings, visibility and repository detection
// --------------------------------------------------------------------------

test("a hidden button leaves the grid but stays reachable in the palette", async () => {
  const dir = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0, detectTtlMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  assert.equal(runtime.setVisible("build-mobile", false), true);
  const rows = runtime.rows("s1");
  assert.equal(
    rows.items.some((item) => item.action.id === "build-mobile"),
    false,
    "a hidden action draws no row",
  );
  assert.ok(
    rows.items.some((item) => item.action.id === "mobile-live"),
    "the other rows are untouched",
  );

  // Hiding a button never removes it from the palette: the same action must
  // still be runnable, and its run must still be openable in Show logs.
  const ids = calls.layers[0].commands.map((command) => command.id);
  assert.ok(ids.includes(`${PLUGIN_ID}.build-mobile`));
  const command = calls.layers[0].commands.find((entry) => entry.id === `${PLUGIN_ID}.build-mobile`);
  command.run();
  assert.equal(spawn.calls.length, 1);
  // The run of a hidden action is still the active project's log, because the
  // set of openable keys is built from discovery, not from what is drawn.
  assert.equal(runtime.logKey(), runtime.manager.keyFor("build-mobile", dir));
  assert.equal(runtime.rows("s1").canLog, true);

  await cleanup();
});

test("the plugin controls follow visibility and repository presence", async () => {
  const dir = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    // An explicit null drops the built-in service: the repository is there, but
    // there is nothing to run a commit or a push with.
    git: null,
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  // scriptsFixture carries a `.git/HEAD`, so the repository controls are drawn.
  const withRepo = runtime.rows("s1");
  assert.deepEqual(withRepo.controls, { commit: true, push: true, "stop-all": true, log: true });
  assert.equal(withRepo.canCommit, false, "no service means no commit");
  assert.equal(withRepo.canPush, false, "no service means no push");

  runtime.setVisible("commit", false);
  runtime.setVisible("stop-all", false);
  const hidden = runtime.rows("s1").controls;
  assert.equal(hidden.commit, false, "a hidden control is reported hidden");
  assert.equal(hidden["stop-all"], false);

  await cleanup();
});

test("outside a repository the Git controls are hidden, not disabled", async () => {
  const dir = fixture({
    "package.json": { scripts: { live: "bash scripts/run.sh" } },
  });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const git = {
    commit: async () => ({ ok: false, error: { code: "unconfirmed", message: "no" } }),
    push: async () => ({ ok: false, error: { code: "unconfirmed", message: "no" } }),
  };
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    git,
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const rows = runtime.rows("s1");
  assert.equal(rows.controls.commit, false, "no repository, no commit control");
  assert.equal(rows.controls.push, false, "no repository, no push control");
  assert.equal(rows.canCommit, false, "nothing to commit outside a repository");
  assert.equal(rows.canPush, false);
  assert.ok(
    rows.items.some((item) => item.action.id === "mobile-live"),
    "the project's own rows are unaffected",
  );

  await cleanup();
});

test("nested directories resolve to the nearest repository", async () => {
  const inner = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": { scripts: { live: "bash scripts/run.sh" } },
  });
  const nested = path.join(inner, "packages", "app");
  mkdirSync(nested, { recursive: true });

  const { context, calls } = createContext({
    locationDirectory: nested,
    sessions: { s1: { directory: nested } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    git: { commit: async () => ({ ok: false }), push: async () => ({ ok: false }) },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  // The nested folder sits inside its own repository, so the controls exist.
  assert.equal(runtime.rows("s1").controls.commit, true);

  await cleanup();
});

test("settings list, toggle and persist every button", async () => {
  const dir = scriptsFixture();
  const visibilityFile = tempVisibilityFile();
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    detectTtlMs: 0,
    visibilityFile,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const items = runtime.settingsItems();
  const ids = items.map((item) => item.id);
  for (const id of ["build-mobile", "mobile-live", "web-live", "next-live"]) {
    assert.ok(ids.includes(id), id);
  }
  for (const id of ["commit", "push", "stop-all", "log"]) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(items.every((item) => typeof item.label === "string" && item.visible === true));
  assert.deepEqual(
    items.map((item) => item.label),
    [...new Set(items.map((item) => item.label))],
    "labels stay unique in the dialog",
  );

  let notified = 0;
  const unsubscribe = runtime.subscribeSettings(() => {
    notified += 1;
  });
  assert.equal(runtime.setVisible("build-mobile", false), true);
  assert.equal(notified, 1, "a toggle notifies subscribers");
  assert.equal(runtime.setVisible("build-mobile", false), false, "a no-op does not notify");
  assert.equal(
    runtime.settingsItems().find((item) => item.id === "build-mobile").visible,
    false,
  );

  // The file the injected path points at is written atomically and reloadable.
  const stored = JSON.parse(readFileSync(visibilityFile, "utf8"));
  assert.deepEqual(stored.hidden, ["build-mobile"]);

  unsubscribe();
  runtime.setVisible("commit", false);
  assert.equal(notified, 1, "an unsubscribed listener is not called");

  // A restart reads the same file back.
  await cleanup();
  const second = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanupSecond = await startPlugin(second.context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    detectTtlMs: 0,
    visibilityFile,
  });
  const restarted = second.calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const afterRestart = restarted.settingsItems();
  assert.equal(afterRestart.find((item) => item.id === "build-mobile").visible, false);
  assert.equal(afterRestart.find((item) => item.id === "commit").visible, false);
  await cleanupSecond();
});

test("the durable host store carries visibility between TUI instances", async () => {
  const dir = scriptsFixture();
  // The V2 host store, as documented: store(key, { initial }) returns
  // [reactiveSettings, asyncUpdate].
  const settings = { hidden: ["push"] };
  const writes = [];
  const storage = {
    store(key, options) {
      assert.equal(key, "control.visibility");
      assert.deepEqual(options, { initial: { hidden: [] } });
      return [
        settings,
        async (updater) => {
          writes.push("update");
          updater(settings);
        },
      ];
    },
  };
  const strayRoot = mkdtempSync(path.join(tmpdir(), "project-runners-unused-"));
  roots.push(strayRoot);
  const visibilityFile = path.join(strayRoot, "unused", "visibility.json");
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  context.storage = storage;
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    detectTtlMs: 0,
    visibilityFile,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  assert.deepEqual(writes, [], "setup never writes");
  assert.equal(
    runtime.settingsItems().find((item) => item.id === "push").visible,
    false,
    "the stored value is honoured",
  );

  runtime.setVisible("commit", false);
  await Promise.resolve();
  assert.deepEqual(settings.hidden, ["commit", "push"], "read-modify-write, not a clobber");
  assert.throws(
    () => readdirSync(path.dirname(visibilityFile)),
    { code: "ENOENT" },
    "no fallback file is written when the host store is available",
  );

  await cleanup();
});

test("show all buttons restores every hidden button and reports the count", async () => {
  const dir = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  runtime.setVisible("build-mobile", false);
  runtime.setVisible("push", false);
  assert.equal(runtime.showAllButtons(), 2);
  assert.ok(runtime.settingsItems().every((item) => item.visible === true));
  assert.equal(calls.toasts.at(-1).message, "Showing 2 hidden buttons");
  assert.equal(runtime.showAllButtons(), 0, "a second call has nothing to restore");

  await cleanup();
});

test("the settings entry point opens the dialog with the runtime", async () => {
  const dir = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  assert.equal(runtime.openSettings(), true);
  const shown = calls.dialogs.find((entry) => typeof entry.render === "function");
  assert.ok(shown, "the dialog is mounted");
  const element = shown.render();
  assert.equal(element.kind, "settings");
  assert.equal(element.props.runtime, runtime);
  assert.equal(element.props.context, context);

  // The palette exposes the same entry point, plus Show all buttons.
  const commands = calls.layers[0].commands;
  const settingsCommand = commands.find((command) => command.id === `${PLUGIN_ID}.settings`);
  const showAllCommand = commands.find((command) => command.id === `${PLUGIN_ID}.show-all`);
  assert.ok(settingsCommand);
  assert.ok(showAllCommand);

  // The typed host API (replace + setSize) is preferred when the host has it.
  calls.dialogs.length = 0;
  context.ui.dialog = {
    replace: (render) => calls.dialogs.push({ render }),
    setSize: (size) => calls.dialogs.push({ setSize: size }),
    clear: () => calls.dialogs.push({ clear: true }),
  };
  assert.equal(runtime.openSettings(), true);
  assert.equal(typeof calls.dialogs[0].render, "function");
  assert.equal(calls.dialogs[1].setSize, "large");
  assert.equal(calls.dialogs[0].render().kind, "settings");

  // A host with neither API says the dialog is unavailable instead of
  // pretending it opened - and it does not point at the palette, because the
  // palette entry runs this same path.
  context.ui.dialog = {};
  calls.toasts.length = 0;
  assert.equal(runtime.openSettings(), false);
  assert.match(calls.toasts.at(-1).message, /Settings dialog is unavailable in this host/);
  assert.doesNotMatch(calls.toasts.at(-1).message, /palette/);

  await cleanup();

  // A host with no SettingsDialog at all reports the same thing.
  const bare = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const bareCleanup = await startPlugin(
    bare.context,
    { Sidebar: view.Sidebar },
    { spawn: createFakeSpawn(), notifyMs: 0, detectTtlMs: 0 },
  );
  const bareRuntime = bare.calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  assert.equal(bareRuntime.openSettings(), false);
  assert.match(bare.calls.toasts.at(-1).message, /Settings dialog is unavailable in this host/);
  await bareCleanup();
});

test("openSettings falls back across dialog APIs and never fakes success", async () => {
  const dir = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  // A throwing `replace` must not swallow the older API: the dialog still
  // opens, once, through `show`.
  calls.dialogs.length = 0;
  context.ui.dialog = {
    replace: () => {
      throw new Error("replace exploded");
    },
    show: (render) => calls.dialogs.push({ render }),
    set: (options) => calls.dialogs.push({ set: options }),
  };
  assert.equal(runtime.openSettings(), true);
  assert.equal(calls.dialogs.length, 2, "one open and one resize");
  assert.equal(typeof calls.dialogs[0].render, "function");
  assert.equal(calls.dialogs[0].render().kind, "settings");
  assert.equal(calls.dialogs[1].set.size, "large");
  assert.equal(
    calls.toasts.some((toast) => /unavailable/.test(toast.message)),
    false,
    "a fallback that worked reports no failure",
  );

  // Both APIs throwing reports the honest message instead of a silent false.
  calls.dialogs.length = 0;
  calls.toasts.length = 0;
  context.ui.dialog = {
    replace: () => {
      throw new Error("replace exploded");
    },
    show: () => {
      throw new Error("show exploded");
    },
  };
  assert.equal(runtime.openSettings(), false);
  assert.equal(calls.dialogs.length, 0, "nothing was opened");
  assert.match(calls.toasts.at(-1).message, /Settings dialog is unavailable in this host/);

  // A host that cannot resize still has an open dialog: success, no toast, and
  // no second dialog.
  calls.dialogs.length = 0;
  calls.toasts.length = 0;
  context.ui.dialog = {
    replace: (render) => calls.dialogs.push({ render }),
    setSize: () => {
      throw new Error("setSize exploded");
    },
  };
  assert.equal(runtime.openSettings(), true);
  assert.equal(calls.dialogs.length, 1, "the dialog is not opened twice");
  assert.equal(calls.dialogs[0].render().kind, "settings");
  assert.equal(calls.toasts.length, 0);

  await cleanup();
});

test("painting the sidebar never runs git", async () => {
  const dir = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const exec = fakeGit({ root: dir });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    gitOptions: { exec },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  runtime.rows("s1");
  runtime.rows("s1");
  assert.equal(exec.calls.length, 0, "repository detection is filesystem-only");
  const rows = runtime.rows("s1");
  assert.equal(rows.controls.commit, true);
  // The default service is present and the repository exists, so the Git
  // controls are actionable - without any git command having run.
  assert.equal(rows.canCommit, true);
  assert.equal(rows.canPush, true);

  await cleanup();
});

test("the palette follows the active session's project", async () => {
  const first = scriptsFixture();
  const second = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": { scripts: { "build:mobile": "echo other" } },
  });
  let session = "s1";
  const { context, calls } = createContext({
    locationDirectory: first,
    sessions: { s1: { directory: first }, s2: { directory: second } },
    route: () => ({ type: "session", sessionID: session }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const layer = calls.layers.at(-1);
  const before = calls.layers.length;
  const firstIds = layer.commands.map((command) => command.id);
  assert.ok(firstIds.includes(`${PLUGIN_ID}.web-live`), "the first project's actions are listed");

  runtime.rows("s1");
  assert.equal(calls.layers.length, before, "an unchanged directory keeps one layer");
  assert.deepEqual(
    layer.commands.map((command) => command.id),
    firstIds,
    "an unchanged project does not rebuild the palette",
  );

  // The factory is pure: each read returns its own array, so a caller that
  // mutates what it got cannot corrupt the next read.
  const scratch = layer.commands;
  scratch.length = 0;
  assert.deepEqual(layer.commands.map((command) => command.id), firstIds, "reads are independent");

  // The host reads the layer through its factory, which only describes the
  // active session's project - so the palette follows the session switch.
  session = "s2";
  assert.equal(calls.layers.length, before, "the layer is not re-registered on a switch");
  const commands = layer.commands.map((command) => command.id);
  assert.ok(commands.includes(`${PLUGIN_ID}.build-mobile`));
  assert.equal(
    commands.includes(`${PLUGIN_ID}.web-live`),
    false,
    "the previous project's actions are gone",
  );

  await cleanup();
});

test("palette ids stay safe and unique for discovered script actions", async () => {
  // A script no specialized action claims, so discovery produces a `script:`
  // id - the shape that carries percent-encoding and a ':' separator. The id
  // itself is treated as opaque: the test names the script, not its encoding.
  const script = "lint:css";
  const dir = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": { scripts: { [script]: "echo lint" } },
    "pnpm-lock.yaml": "",
    "local-public-defines.json": "{}",
  });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, {
    spawn,
    notifyMs: 0,
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const commands = calls.layers.at(-1).commands;

  const ids = commands.map((command) => command.id);
  assert.equal(new Set(ids).size, ids.length, "every palette id is unique");
  for (const id of ids) {
    // A discovered script id carries percent-encoding and a ':' separator, so
    // the derived command id must be plain and separator-free.
    assert.match(id, /^[A-Za-z0-9._-]+$/, `palette id is safe: ${id}`);
  }

  const scripted = runtime
    .actionDescriptors()
    .find((descriptor) => descriptor.id.startsWith("script:"));
  assert.ok(scripted, "the fixture defines at least one plain script action");
  const command = commands.find(
    (candidate) => candidate.title === `Launchpad: ${scripted.title}`,
  );
  assert.ok(command, "the script action is listed in the palette");
  assert.notEqual(command.id, `${PLUGIN_ID}.${scripted.id}`, "the raw id is not reused");

  // The closure still holds the real id, so the palette runs the exact script.
  command.run();
  assert.equal(spawn.calls.length, 1, "the command started one process");
  assert.deepEqual(spawn.calls[0].args, ["run", script]);

  await cleanup();
});

test("a directory named .git without Git metadata is not offered Git controls", async () => {
  const dir = fixture({
    "package.json": { scripts: { live: "bash scripts/run.sh" } },
  });
  // A folder that merely looks versioned: `.git` exists but holds no Git data.
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    git: { commit: async () => ({ ok: false }), push: async () => ({ ok: false }) },
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const rows = runtime.rows("s1");
  assert.equal(rows.controls.commit, false, "an empty .git is not a repository");
  assert.equal(rows.controls.push, false);
  assert.equal(rows.canCommit, false);
  assert.equal(rows.canPush, false);

  await cleanup();
});

test("a failed settings save is reported instead of silently lost", async () => {
  const dir = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: dir,
    sessions: { s1: { directory: dir } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  // The host offers durable settings but rejects every write.
  const settings = { hidden: [] };
  context.storage = {
    store: () => [
      settings,
      async () => {
        throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
      },
    ],
  };
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  assert.equal(runtime.settingsError(), null, "a healthy store reports no error");
  assert.equal(runtime.setVisible("log", false), true);
  assert.equal(runtime.rows("s1").controls.log, false, "the click still applies immediately");
  assert.equal(runtime.settingsError(), null, "the host has not answered yet");

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(runtime.settingsError().code, "save-failed", "the failure is exposed to the UI");
  const toast = calls.toasts.at(-1);
  assert.equal(toast.variant, "warning");
  assert.match(toast.message, /Settings not saved/);
  assert.match(toast.message, /EROFS/);
  assert.deepEqual(settings.hidden, [], "nothing was written");

  // The same failure is not reported twice in a row.
  const before = calls.toasts.length;
  runtime.setVisible("commit", false);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls.toasts.length, before, "a repeated failure is not re-toasted");

  await cleanup();
});

test("hiddenCount counts buttons hidden in any project, not just the active one", async () => {
  const first = scriptsFixture();
  const second = cargoFixture();
  let session = "s1";
  const { context, calls } = createContext({
    locationDirectory: first,
    sessions: { s1: { directory: first }, s2: { directory: second } },
    route: () => ({ type: "session", sessionID: session }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  assert.equal(runtime.hiddenCount(), 0);
  assert.equal(runtime.setVisible("build-mobile", false), true);
  assert.equal(runtime.hiddenCount(), 1);

  // A second project hides a different id. The count is global because
  // visibility is keyed by stable action id, and Show all restores them all.
  session = "s2";
  assert.equal(runtime.setVisible("cargo-fmt", false), true);
  assert.equal(runtime.hiddenCount(), 2, "an id hidden in another project still counts");
  assert.equal(
    runtime.rows("s2").items.some((item) => item.action.id === "cargo-fmt"),
    false,
  );

  session = "s1";
  assert.equal(
    runtime.rows("s1").items.some((item) => item.action.id === "build-mobile"),
    false,
    "the first project's hiding still applies",
  );
  assert.equal(runtime.hiddenCount(), 2, "a session switch does not change the count");

  assert.equal(runtime.showAllButtons(), 2, "Show all restores both projects");
  assert.equal(runtime.hiddenCount(), 0);
  assert.ok(runtime.rows("s1").items.some((item) => item.action.id === "build-mobile"));
  session = "s2";
  assert.ok(runtime.rows("s2").items.some((item) => item.action.id === "cargo-fmt"));

  await cleanup();
});

// --------------------------------------------------------------------------
// Cargo actions
// --------------------------------------------------------------------------

// A Rust project with no package.json: cargo is the whole project. The spawn is
// always a fake, so no cargo binary is ever needed or run.
const CARGO_IDS = ["cargo-build", "cargo-run", "cargo-test", "cargo-check", "cargo-clippy", "cargo-fmt"];
const CARGO_LABELS = [
  "Cargo build",
  "Cargo run",
  "Cargo test",
  "Cargo check",
  "Cargo clippy",
  "Cargo fmt",
];

function cargoFixture(files = {}) {
  return fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "Cargo.toml": "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
    "Cargo.lock": "version = 3\n",
    "src/main.rs": "fn main() {}\n",
    ...files,
  });
}

test("a Cargo-only project offers one row and one palette entry per cargo command", async () => {
  const root = cargoFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    detectTtlMs: 0,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const rows = runtime.rows("s1");
  assert.deepEqual(
    rows.items.map((item) => item.action.id),
    CARGO_IDS,
    "cargo is the whole project, in a fixed order",
  );
  assert.deepEqual(
    rows.items.map((item) => item.action.label),
    CARGO_LABELS,
  );
  assert.ok(rows.items.every((item) => item.resolution.ok));
  assert.ok(rows.items.every((item) => item.resolution.command === "cargo"));
  assert.equal(rows.items.at(-1).action.title, "Cargo fmt --check");

  const ids = calls.layers[0].commands.map((command) => command.id);
  for (const id of CARGO_IDS) {
    assert.ok(ids.includes(`${PLUGIN_ID}.${id}`), `palette entry for ${id}`);
  }

  await cleanup();
});

test("cargo buttons launch cargo with fixed arguments in the manifest's folder", async () => {
  const root = cargoFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0, detectTtlMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const started = runtime.startAction("cargo-test");
  assert.equal(started.ok, true);
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].command, "cargo");
  assert.deepEqual(spawn.calls[0].args, ["test"]);
  assert.equal(spawn.calls[0].options.cwd, root);
  assert.equal(spawn.calls[0].options.shell, false);
  assert.equal(runtime.snapshot(started.key).running, true);

  const fmt = runtime.startAction("cargo-fmt");
  assert.equal(fmt.ok, true);
  assert.deepEqual(spawn.calls[1].args, ["fmt", "--check"], "fmt is format-checking, not rewriting");
  assert.equal(spawn.calls[1].options.cwd, root);

  // A library-only manifest is not second-guessed: `cargo run` still runs and
  // lets cargo explain itself in the log.
  const run = runtime.startAction("cargo-run");
  assert.equal(run.ok, true);
  assert.deepEqual(spawn.calls[2].args, ["run"]);

  await cleanup();
});

test("a nested crate runs cargo in the crate's own folder, not the workspace root", async () => {
  const root = cargoFixture({
    "Cargo.toml": "[workspace]\nmembers = [\"crates/inner\"]\n",
    "crates/inner/Cargo.toml": "[package]\nname = \"inner\"\nversion = \"0.1.0\"\n",
    "crates/inner/src/lib.rs": "pub fn inner() {}\n",
  });
  const crate = path.join(root, "crates", "inner");
  const { context, calls } = createContext({
    locationDirectory: crate,
    sessions: { s1: { directory: crate } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0, detectTtlMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  assert.equal(runtime.rows("s1").items.at(0).resolution.cwd, crate);
  const started = runtime.startAction("cargo-test");
  assert.equal(started.ok, true);
  assert.equal(spawn.calls[0].options.cwd, crate, "the nearest manifest owns the cwd");

  await cleanup();
});

test("a hidden Cargo button stays in the palette and its run stays trackable", async () => {
  const root = cargoFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0, detectTtlMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  assert.equal(runtime.setVisible("cargo-test", false), true);
  const rows = runtime.rows("s1");
  assert.equal(rows.items.some((item) => item.action.id === "cargo-test"), false, "no row is drawn");
  assert.equal(rows.items.length, CARGO_IDS.length - 1, "the other cargo rows are untouched");

  const command = calls.layers[0].commands.find((entry) => entry.id === `${PLUGIN_ID}.cargo-test`);
  assert.ok(command, "hiding a button never removes it from the palette");
  command.run();
  assert.equal(spawn.calls.length, 1);
  assert.equal(spawn.calls[0].command, "cargo");
  assert.deepEqual(spawn.calls[0].args, ["test"]);

  // Its run is still this project's log and stop target: openable keys come
  // from discovery, not from what the grid draws.
  const key = runtime.manager.keyFor("cargo-test", root);
  assert.equal(runtime.snapshot(key).running, true);
  assert.equal(runtime.logKey(), key);
  assert.equal(runtime.rows("s1").canLog, true);
  assert.equal(runtime.rows("s1").canStop, true);
  assert.equal(runtime.stop(key), true);
  assert.equal(runtime.snapshot(key).running, false);

  await cleanup();
});

// ------------------------------------------------ button configuration (editor)

// The editor's API is the contract the Settings dialog is written against.
test("the button editor exposes one shape for every editable button", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, { spawn: createFakeSpawn(), notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  for (const name of ["buttonEditorItems", "saveButton", "resetButton", "deleteButton", "buttonConfigError"]) {
    assert.equal(typeof runtime[name], "function", name);
  }
  assert.equal(runtime.buttonConfigError(), null);

  const items = runtime.buttonEditorItems();
  const build = items.find((item) => item.id === "build-mobile");
  assert.deepEqual(Object.keys(build).sort(), ["args", "command", "custom", "cwd", "id", "label", "overridden"]);
  assert.equal(build.custom, false);
  assert.equal(build.overridden, false);
  assert.equal(build.label, "Build");
  assert.equal(build.cwd, root, "the working directory is the action's own");
  assert.ok(build.args.length > 0, "the arguments of the button are shown as they run");

  // The four plugin controls have no command behind them, so they are not rows
  // of the editor.
  for (const id of ["commit", "push", "stop-all", "log"]) {
    assert.equal(items.some((item) => item.id === id), false, id);
  }

  await cleanup();
});

test("a saved command replaces exactly what the button runs", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const before = runtime.rows("s1").items.find((item) => item.action.id === "mobile-live");
  const saved = runtime.saveButton({
    id: "build-mobile",
    label: "Ship it",
    command: "bash",
    args: ["scripts/deploy.sh", "--release"],
  });
  assert.deepEqual(saved, { ok: true, id: "build-mobile" });
  assert.equal(spawn.calls.length, 0, "saving a command runs nothing");

  const rows = runtime.rows("s1");
  const build = rows.items.find((item) => item.action.id === "build-mobile");
  assert.equal(build.action.label, "Ship it", "the sidebar uses the saved name");
  assert.equal(build.resolution.command, "bash");
  assert.deepEqual(build.resolution.args, ["scripts/deploy.sh", "--release"]);
  assert.equal(build.resolution.cwd, root, "the project directory is preserved");
  assert.equal(build.resolution.display, "bash scripts/deploy.sh --release");
  assert.deepEqual(build.resolution.env, {}, "the action's own environment is not injected");
  assert.equal(build.resolution.stdin, false, "an arbitrary command never takes live input");

  const editor = runtime.buttonEditorItems().find((item) => item.id === "build-mobile");
  assert.equal(editor.overridden, true);
  assert.equal(editor.label, "Ship it");
  assert.deepEqual(editor.args, ["scripts/deploy.sh", "--release"]);
  assert.equal(editor.cwd, root);

  // A button the user did not touch is unchanged, and the palette follows the
  // saved name too.
  const after = runtime.rows("s1").items.find((item) => item.action.id === "mobile-live");
  assert.deepEqual(after.resolution, before.resolution);
  const command = calls.layers.at(-1).commands.find((entry) => entry.id === `${PLUGIN_ID}.build-mobile`);
  assert.equal(command.title, "Launchpad: Ship it");

  // A click runs the saved command, not the discovered one.
  runtime.startAction("build-mobile");
  assert.equal(spawn.calls[0].command, "bash");
  assert.deepEqual(spawn.calls[0].args, ["scripts/deploy.sh", "--release"]);
  assert.equal(spawn.calls[0].options.cwd, root);
  assert.equal(spawn.calls[0].options.shell, false, "a saved command is never run through a shell");

  await cleanup();
});

test("a renamed button keeps its id, its run and its hidden state", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const started = runtime.startAction("build-mobile");
  const key = runtime.manager.keyFor("build-mobile", root);
  assert.equal(started.key, key);
  assert.equal(runtime.setVisible("build-mobile", false), true);

  assert.deepEqual(runtime.saveButton({ id: "build-mobile", label: "Renamed", command: "bash", args: [] }), {
    ok: true,
    id: "build-mobile",
  });

  // The rename does not resurrect a hidden button...
  assert.equal(runtime.rows("s1").items.some((item) => item.action.id === "build-mobile"), false);
  // ...and the settings list shows the new name, still hidden.
  const listed = runtime.settingsItems().find((item) => item.id === "build-mobile");
  assert.equal(listed.label, "Renamed");
  assert.equal(listed.visible, false);
  // ...and the palette still offers it under the new name.
  const command = calls.layers.at(-1).commands.find((entry) => entry.id === `${PLUGIN_ID}.build-mobile`);
  assert.equal(command.title, "Launchpad: Renamed");

  // The run keeps its identity: same key, same log, still stoppable.
  assert.equal(runtime.manager.find("build-mobile", root).key, key);
  assert.equal(runtime.rows("s1").canLog, true);
  assert.equal(runtime.snapshot(key).running, true);
  assert.equal(runtime.logKey(), key);
  assert.equal(runtime.stop(key), true);
  assert.equal(runtime.snapshot(key).running, false);

  await cleanup();
});

test("a hand-added button runs from the project it was added in", async () => {
  const first = scriptsFixture();
  const second = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": { scripts: { "build:mobile": "echo other" } },
  });
  let session = "s1";
  const { context, calls } = createContext({
    locationDirectory: first,
    sessions: { s1: { directory: first }, s2: { directory: second } },
    route: () => ({ type: "session", sessionID: session }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const added = runtime.saveButton({ label: "Deploy", command: "bash", args: ["scripts/ship.sh"] });
  assert.equal(added.ok, true);
  assert.match(added.id, /^custom:/, "a new button gets its own stable id");
  assert.equal(spawn.calls.length, 0, "adding a button runs nothing");

  const mine = runtime.rows("s1").items.find((item) => item.action.id === added.id);
  assert.equal(mine.action.label, "Deploy");
  assert.equal(mine.resolution.cwd, first, "it runs from the project it belongs to");
  assert.deepEqual(mine.resolution.env, {});
  assert.equal(mine.resolution.stdin, false);
  assert.ok(
    calls.layers
      .at(-1)
      .commands.some((command) => command.id.startsWith(`${PLUGIN_ID}.custom-`)),
    "and it is offered in the palette",
  );

  runtime.startAction(added.id);
  assert.equal(spawn.calls[0].command, "bash");
  assert.deepEqual(spawn.calls[0].args, ["scripts/ship.sh"]);
  assert.equal(spawn.calls[0].options.cwd, first);

  // Another project never sees it, anywhere.
  session = "s2";
  assert.equal(runtime.rows("s2").items.some((item) => item.action.id === added.id), false);
  assert.equal(runtime.buttonEditorItems().some((item) => item.id === added.id), false);
  assert.equal(runtime.settingsItems().some((item) => item.id === added.id), false);
  assert.equal(
    calls.layers.at(-1).commands.some((command) => command.title === "Launchpad: Deploy"),
    false,
    "and its palette entry follows the active project",
  );

  session = "s1";
  assert.equal(runtime.rows("s1").items.some((item) => item.action.id === added.id), true, "back in its project");

  await cleanup();
});

test("editing and deleting never run anything", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const added = runtime.saveButton({ label: "Deploy", command: "bash", args: [] });
  runtime.saveButton({ id: added.id, label: "Deploy again", command: "bash", args: ["-x"] });
  runtime.saveButton({ id: "build-mobile", label: "Ship it", command: "bash", args: [] });
  runtime.resetButton("build-mobile");
  runtime.deleteButton(added.id);
  runtime.buttonEditorItems();
  runtime.settingsItems();
  runtime.openSettings();
  runtime.showAllButtons();

  assert.equal(spawn.calls.length, 0, "only a click starts a command");
  await cleanup();
});

test("a refused edit explains itself and stores nothing", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, { spawn: createFakeSpawn(), notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const nameless = runtime.saveButton({ label: "  ", command: "bash", args: [] });
  assert.equal(nameless.ok, false);
  assert.equal(nameless.code, "invalid-label");
  assert.ok(nameless.reason.length > 0);

  const noCommand = runtime.saveButton({ label: "Deploy", command: "", args: [] });
  assert.equal(noCommand.code, "invalid-command");

  const badArgs = runtime.saveButton({ label: "Deploy", command: "bash", args: "ship.sh" });
  assert.equal(badArgs.code, "invalid-args");
  const nulArg = runtime.saveButton({ label: "Deploy", command: "bash", args: ["a\u0000b"] });
  assert.equal(nulArg.code, "invalid-args");

  // The plugin's own controls are not editable, not resettable and not
  // deletable, and an unknown id cannot be overridden.
  assert.equal(runtime.saveButton({ id: "commit", label: "x", command: "y", args: [] }).code, "control-locked");
  assert.equal(runtime.resetButton("commit").code, "control-locked");
  assert.equal(runtime.deleteButton("log").code, "control-locked");
  assert.equal(runtime.saveButton({ id: "no-such-button", label: "x", command: "y", args: [] }).code, "unknown-action");
  assert.equal(runtime.deleteButton("build-mobile").code, "not-custom");
  assert.equal(runtime.resetButton("no-such-button").code, "unknown-action");

  // A refused edit leaves the button exactly as it was.
  const build = runtime.buttonEditorItems().find((item) => item.id === "build-mobile");
  assert.equal(build.label, "Build");
  assert.equal(build.overridden, false);
  assert.equal(
    calls.layers.at(-1).commands.find((command) => command.id === `${PLUGIN_ID}.build-mobile`).title,
    "Launchpad: Build mobile (vet-build)",
    "the palette is unchanged too",
  );

  await cleanup();
});

test("deleting a running button keeps its log and its stop target", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const added = runtime.saveButton({ label: "Deploy", command: "bash", args: ["scripts/ship.sh"] });
  const started = runtime.startAction(added.id);
  assert.equal(runtime.snapshot(started.key).running, true);
  // A host-held palette entry for the button, captured while it exists.
  const staleEntry = calls.layers
    .at(-1)
    .commands.find((command) => command.id.startsWith(`${PLUGIN_ID}.custom-`));
  assert.ok(staleEntry, "the palette offered the button before it was deleted");

  assert.deepEqual(runtime.deleteButton(added.id), { ok: true, id: added.id });
  assert.equal(runtime.rows("s1").items.some((item) => item.action.id === added.id), false, "the button is gone");
  assert.equal(runtime.buttonEditorItems().some((item) => item.id === added.id), false);

  // The run it already started is still this project's: openable and stoppable,
  // even though the button itself is gone.
  assert.equal(runtime.snapshot(started.key).running, true);
  assert.equal(runtime.rows("s1").canLog, true);
  assert.equal(runtime.rows("s1").canStop, true);
  assert.equal(runtime.logKey(), started.key);
  assert.equal(runtime.showLog(), true);
  assert.equal(runtime.stop(started.key), true);
  assert.equal(runtime.snapshot(started.key).running, false);

  // A palette entry the host still holds for the deleted button re-resolves and
  // refuses safely instead of running something stale.
  const before = spawn.calls.length;
  assert.equal(staleEntry.run().ok, false, "the stale entry is refused");
  assert.equal(spawn.calls.length, before, "a deleted button never runs");

  await cleanup();
});

test("saved commands are read back by the next run of the plugin", async () => {
  const root = scriptsFixture();
  const buttonConfigFile = path.join(fixture({}), "nested", "buttons.json");

  const first = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanupFirst = await startPlugin(first.context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    buttonConfigFile,
  });
  const before = first.calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const added = before.saveButton({ label: "Deploy", command: "bash", args: ["ship.sh"] });
  before.saveButton({ id: "build-mobile", label: "Ship it", command: "bash", args: [] });
  await cleanupFirst();

  const second = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanupSecond = await startPlugin(second.context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    buttonConfigFile,
  });
  const runtime = second.calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  assert.equal(runtime.rows("s1").items.find((item) => item.action.id === "build-mobile").action.label, "Ship it");
  assert.equal(runtime.rows("s1").items.some((item) => item.action.id === added.id), true);
  assert.equal(runtime.buttonConfigError(), null);

  await cleanupSecond();
});

test("a settings subscriber hears a button edit, not only a visibility toggle", async () => {
  const root = scriptsFixture();
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, { spawn: createFakeSpawn(), notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const seen = [];
  const off = runtime.subscribeSettings((reason) => seen.push(reason));
  runtime.saveButton({ id: "build-mobile", label: "Ship it", command: "bash", args: [] });
  runtime.setVisible("build-mobile", false);
  assert.ok(seen.length >= 2, "a label edit and a visibility change both notify");
  const count = seen.length;
  off();
  runtime.setVisible("build-mobile", true);
  assert.equal(seen.length, count, "the disposer detaches the listener");

  await cleanup();
});

test("a button that cannot be saved is reported, and the edit stays visible", async () => {
  const root = scriptsFixture();
  // A read-only config location: the read succeeds (the file is simply not
  // there yet) and the write is refused.
  const file = path.join(fixture({}), "buttons.json");
  const io = {
    mkdirSync,
    readFileSync,
    renameSync,
    writeFileSync() {
      const error = new Error("EROFS: read-only file system, open 'buttons.json'");
      error.code = "EROFS";
      throw error;
    },
  };
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    buttonConfigFile: file,
    buttonConfigIo: io,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const saved = runtime.saveButton({ id: "build-mobile", label: "Ship it", command: "bash", args: [] });
  assert.deepEqual(saved, { ok: true, id: "build-mobile" }, "the click is not silently dropped");
  assert.notEqual(runtime.buttonConfigError(), null, "the failure is queryable");
  assert.equal(runtime.buttonConfigError().code, "save-failed");
  assert.match(calls.toasts.at(-1).message, /Settings not saved:/);
  assert.equal(calls.toasts.at(-1).variant, "warning");
  // The button still shows what the user asked for, so nothing looks lost.
  assert.equal(runtime.rows("s1").items.find((item) => item.action.id === "build-mobile").action.label, "Ship it");

  await cleanup();
});

test("an unreadable button config is reported as a read failure, not as a saved edit", async () => {
  const root = scriptsFixture();
  // `buttonConfigFile` under an existing file: the stored buttons can never be
  // read, so the edit must fail closed instead of replacing what is there.
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    buttonConfigFile: path.join(root, "package.json", "buttons.json"),
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const saved = runtime.saveButton({ id: "build-mobile", label: "Ship it", command: "bash", args: [] });
  assert.equal(saved.ok, true, "the edit is kept locally");
  assert.equal(runtime.buttonConfigError().code, "read-failed", "the real cause is reported");
  assert.match(calls.toasts.at(-1).message, /Settings not saved:/);
  assert.equal(runtime.rows("s1").items.find((item) => item.action.id === "build-mobile").action.label, "Ship it");

  await cleanup();
});

test("the durable host store is preferred over the config file", async () => {
  const root = scriptsFixture();
  const settings = { version: 1, projects: {}, custom: [] };
  const stored = [];
  const storage = {
    store(key, options) {
      stored.push([key, options]);
      // Each key gets its own document, the way the host stores them.
      const doc = key === "control.buttons" ? settings : { hidden: [] };
      return [doc, (mutate) => mutate(doc)];
    },
  };
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  context.storage = storage;
  const cleanup = await startPlugin(context, view, { spawn: createFakeSpawn(), notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  runtime.saveButton({ id: "build-mobile", label: "Ship it", command: "bash", args: [] });
  const keys = stored.map((entry) => entry[0]);
  assert.equal(keys.filter((key) => key === "control.buttons").length, 1, "the buttons document is stored once");
  assert.equal(settings.projects[root].overrides["build-mobile"].label, "Ship it");

  await cleanup();
});

// ------------------------------------- project capture (stale editor guard)

test("an edit prepared in one project cannot be written into the one that replaced it", async () => {
  const first = scriptsFixture();
  const second = scriptsFixture();
  let session = "s1";
  const { context, calls } = createContext({
    locationDirectory: first,
    sessions: { s1: { directory: first }, s2: { directory: second } },
    route: () => ({ type: "session", sessionID: session }),
  });
  const spawn = createFakeSpawn();
  const cleanup = await startPlugin(context, view, { spawn, notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  // The dialog opens in the first project and captures it.
  const captured = runtime.buttonProject();
  assert.equal(captured, first, "the capture is the project key");
  const mine = runtime.saveButton({ label: "Deploy", command: "bash", args: ["ship.sh"] });
  assert.equal(mine.ok, true, "and it can be used while that project is active");

  // The user switches to another project while the dialog is still open.
  session = "s2";
  assert.equal(runtime.buttonProject(), second);
  const spawns = spawn.calls.length;
  const toasts = calls.toasts.length;

  const stale = { ok: false, code: "project-changed", reason: "Project changed. Reopen the button editor." };
  assert.deepEqual(
    runtime.saveButton({ id: "build-mobile", label: "Ship it", command: "bash", args: [], project: captured }),
    stale,
    "an override is refused",
  );
  assert.deepEqual(
    runtime.saveButton({ label: "Added", command: "bash", args: [], project: captured }),
    stale,
    "a hand-added button is refused too",
  );
  assert.deepEqual(runtime.resetButton("build-mobile", captured), stale, "a reset is refused");
  assert.deepEqual(runtime.deleteButton(mine.id, captured), stale, "a delete is refused");

  // Nothing was written anywhere, nothing ran, and nothing was toasted: the
  // dialog is the one that explains this and reopens itself.
  assert.equal(runtime.buttonConfigError(), null);
  assert.equal(spawn.calls.length, spawns, "no command ran");
  assert.equal(calls.toasts.length, toasts, "no toast for the dialog's own refusal");
  const other = runtime.rows("s2").items.find((item) => item.action.id === "build-mobile");
  assert.equal(other.action.label, "Build", "the second project's button is unchanged");
  assert.equal(
    runtime.buttonEditorItems().some((item) => item.label === "Ship it" || item.label === "Added"),
    false,
    "and no edit from the first project landed in it",
  );
  assert.equal(runtime.buttonEditorItems().some((item) => item.id === mine.id), false);

  // A call with no capture keeps editing whatever project is active: the
  // capture is an option, not a new requirement.
  const direct = runtime.saveButton({ id: "build-mobile", label: "Ship it", command: "bash", args: [] });
  assert.equal(direct.ok, true);
  assert.equal(runtime.rows("s2").items.find((item) => item.action.id === "build-mobile").action.label, "Ship it");

  // Back in the project the dialog was opened for, the same capture is accepted.
  session = "s1";
  assert.equal(runtime.buttonProject(), captured);
  assert.deepEqual(
    runtime.saveButton({ id: "build-mobile", label: "Ship it", command: "bash", args: [], project: captured }),
    { ok: true, id: "build-mobile" },
    "a capture that still matches is accepted",
  );
  assert.equal(runtime.rows("s1").items.find((item) => item.action.id === "build-mobile").action.label, "Ship it");
  assert.deepEqual(
    runtime.resetButton("build-mobile", captured),
    { ok: true, id: "build-mobile", reset: true },
    "and the override can be cleared",
  );
  assert.deepEqual(runtime.deleteButton(mine.id, captured), { ok: true, id: mine.id });
  assert.equal(runtime.rows("s1").items.some((item) => item.action.id === mine.id), false);

  await cleanup();
});

test("the editor reports each button's own working directory, not the project key", async () => {
  const root = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "package.json": { scripts: { "build:mobile": "echo root" } },
    "apps/web/package.json": { scripts: { dev: "next dev" } },
  });
  const nested = path.join(root, "apps", "web");
  const { context, calls } = createContext({
    locationDirectory: nested,
    sessions: { s1: { directory: nested }, s2: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const cleanup = await startPlugin(context, view, { spawn: createFakeSpawn(), notifyMs: 0 });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  // The project key is the directory the session is in, which is where a button
  // added now would run from.
  const project = runtime.buttonProject();
  assert.equal(project, nested);

  const custom = runtime.saveButton({ label: "Deploy", command: "bash", args: [] });
  const items = runtime.buttonEditorItems();
  const added = items.find((item) => item.id === custom.id);
  assert.equal(added.custom, true);
  assert.equal(added.cwd, nested, "a hand-added button runs where it was created");
  // A discovered button is not moved to the project key either: it keeps the
  // working directory its action resolved to.
  const dev = items.find((item) => item.id.startsWith("script:"));
  assert.ok(dev, "the nested package's own script is listed");
  assert.equal(dev.cwd, nested);

  await cleanup();
});

// ------------------------------------------------ button order (Move up/down)

// Discovery order for a directory, independent of any saved order, so a test
// can state what the default catalog should be.
function discoveryIds(root) {
  return discoverActions(createProjectDetector().detect(root)).map((action) => action.id);
}

function openRuntime({ root, buttonConfigFile, spawn = createFakeSpawn() } = {}) {
  const { context, calls } = createContext({
    locationDirectory: root,
    sessions: { s1: { directory: root } },
    route: () => ({ type: "session", sessionID: "s1" }),
  });
  const start = () =>
    startPlugin(context, view, { spawn, notifyMs: 0, buttonConfigFile });
  return { context, calls, spawn, start };
}

test("moveButton reorders the sidebar, settings, editor and palette together", async () => {
  const root = scriptsFixture();
  const { calls, spawn, start } = openRuntime({ root });
  const cleanup = await start();
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const before = runtime.actionDescriptors().map((descriptor) => descriptor.id);
  assert.ok(before.length >= 3, "the fixture has several runners");
  const [first, second] = before;

  const moved = runtime.moveButton(second, "up");
  assert.deepEqual(moved, {
    ok: true,
    id: second,
    moved: true,
    order: [second, first, ...before.slice(2)],
  });

  const after = runtime.actionDescriptors().map((descriptor) => descriptor.id);
  assert.deepEqual(after, [second, first, ...before.slice(2)], "the catalog order changed");
  assert.deepEqual(runtime.buttonEditorItems().map((item) => item.id), after, "the editor follows");
  assert.deepEqual(runtime.rows("s1").items.map((item) => item.action.id), after, "the sidebar follows");
  assert.deepEqual(
    runtime.settingsItems().map((item) => item.id).slice(0, after.length),
    after,
    "the settings list follows, before the built-ins",
  );
  const titles = new Map(runtime.actionDescriptors().map((descriptor) => [descriptor.id, descriptor.title]));
  assert.deepEqual(
    calls.layers[0].commands.slice(0, after.length).map((command) => command.title),
    after.map((id) => `Launchpad: ${titles.get(id)}`),
    "the palette follows",
  );
  assert.equal(spawn.calls.length, 0, "reordering never runs anything");

  await cleanup();
});

test("a boundary move, a built-in, a bad direction and an unknown id are refused safely", async () => {
  const root = scriptsFixture();
  const file = path.join(fixture({}), "buttons.json");
  const { calls, start } = openRuntime({ root, buttonConfigFile: file });
  const cleanup = await start();
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const ids = runtime.actionDescriptors().map((descriptor) => descriptor.id);
  const exists = () => {
    try {
      readFileSync(file);
      return true;
    } catch {
      return false;
    }
  };
  assert.equal(exists(), false, "setup writes nothing");

  assert.deepEqual(
    runtime.moveButton(ids[0], "up"),
    { ok: true, id: ids[0], moved: false },
    "the first button cannot move up",
  );
  assert.deepEqual(
    runtime.moveButton(ids[ids.length - 1], "down"),
    { ok: true, id: ids[ids.length - 1], moved: false },
    "the last cannot move down",
  );
  assert.equal(exists(), false, "a boundary move writes nothing");

  assert.deepEqual(
    runtime.moveButton("commit", "up"),
    { ok: false, code: "control-locked", reason: "This button is built in and cannot be reordered." },
    "a built-in is not reorderable",
  );
  assert.deepEqual(runtime.moveButton(ids[0], "sideways"), {
    ok: false,
    code: "invalid-direction",
    reason: "Direction must be up or down.",
  });
  assert.deepEqual(runtime.moveButton("nope", "up"), {
    ok: false,
    code: "unknown-action",
    reason: "That button is not part of this project.",
  });
  assert.equal(exists(), false, "no refusal wrote anything");
  assert.equal(runtime.buttonConfigError(), null);

  await cleanup();
});

test("an order is per project and a stale capture cannot move it", async () => {
  const first = scriptsFixture();
  const second = scriptsFixture();
  const file = path.join(fixture({}), "buttons.json");
  let session = "s1";
  const { context, calls } = createContext({
    locationDirectory: first,
    sessions: { s1: { directory: first }, s2: { directory: second } },
    route: () => ({ type: "session", sessionID: session }),
  });
  const cleanup = await startPlugin(context, view, {
    spawn: createFakeSpawn(),
    notifyMs: 0,
    buttonConfigFile: file,
  });
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const firstIds = runtime.actionDescriptors().map((descriptor) => descriptor.id);
  const captured = runtime.buttonProject();
  assert.equal(captured, first);

  session = "s2";
  const secondBefore = runtime.actionDescriptors().map((descriptor) => descriptor.id);
  assert.deepEqual(
    runtime.moveButton(firstIds[1], "up", captured),
    { ok: false, code: "project-changed", reason: "Project changed. Reopen the button editor." },
    "a move captured in the first project is refused after the switch",
  );
  assert.deepEqual(
    runtime.actionDescriptors().map((descriptor) => descriptor.id),
    secondBefore,
    "the second project is untouched",
  );

  session = "s1";
  assert.equal(runtime.moveButton(firstIds[1], "up", captured).ok, true, "a matching capture is accepted");
  const stored = JSON.parse(readFileSync(file, "utf8")).projects;
  assert.ok(stored[first], "only the first project has an order");
  assert.equal(stored[second], undefined, "the second project was never written");

  await cleanup();
});

test("a saved order survives a restart", async () => {
  const root = scriptsFixture();
  const file = path.join(fixture({}), "buttons.json");
  const firstIds = discoveryIds(root);

  const first = openRuntime({ root, buttonConfigFile: file });
  const cleanupFirst = await first.start();
  const rt1 = first.calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  assert.equal(rt1.moveButton(firstIds[2], "up").ok, true);
  await cleanupFirst();

  const second = openRuntime({ root, buttonConfigFile: file });
  const cleanupSecond = await second.start();
  const rt2 = second.calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  assert.deepEqual(
    rt2.actionDescriptors().map((descriptor) => descriptor.id),
    [firstIds[0], firstIds[2], firstIds[1], ...firstIds.slice(3)],
    "the reordered catalog comes back",
  );
  assert.equal(rt2.buttonConfigError(), null);

  await cleanupSecond();
});

test("an old document with no order reads in discovery order", async () => {
  const root = scriptsFixture();
  const file = path.join(fixture({}), "buttons.json");
  writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      projects: { [root]: { overrides: { "build-mobile": { label: "Ship it", command: "bash", args: [] } } } },
      custom: [],
    })}\n`,
  );
  const { calls, start } = openRuntime({ root, buttonConfigFile: file });
  const cleanup = await start();
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  assert.deepEqual(
    runtime.actionDescriptors().map((descriptor) => descriptor.id),
    discoveryIds(root),
    "no stored order means the discovery order",
  );
  assert.equal(
    runtime.rows("s1").items.find((item) => item.action.id === "build-mobile").action.label,
    "Ship it",
    "the old override still applies",
  );
  assert.equal(runtime.moveButton(discoveryIds(root)[1], "up").ok, true, "and a move still works");

  await cleanup();
});

test("a stored order skips a removed id and appends a newly discovered one", async () => {
  const root = scriptsFixture();
  const file = path.join(fixture({}), "buttons.json");
  const defaultOrder = discoveryIds(root);
  const customId = "custom:keeper";
  // The order names one live button, one that no longer exists, and a custom
  // button. Every other discovered button is "new" and must append.
  writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      projects: { [root]: { overrides: {}, order: [defaultOrder[1], "gone", customId] } },
      custom: [{ id: customId, project: root, label: "Mine", command: "bash", args: ["x"] }],
    })}\n`,
  );
  const { calls, start } = openRuntime({ root, buttonConfigFile: file });
  const cleanup = await start();
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const expected = [defaultOrder[1], customId, ...defaultOrder.filter((id) => id !== defaultOrder[1])];
  assert.deepEqual(runtime.actionDescriptors().map((descriptor) => descriptor.id), expected);
  assert.equal(expected.includes("gone"), false, "the removed id is not a button");

  await cleanup();
});

test("a hidden button keeps its place and the settings list still shows it", async () => {
  const root = scriptsFixture();
  const { calls, start } = openRuntime({ root });
  const cleanup = await start();
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const ids = runtime.actionDescriptors().map((descriptor) => descriptor.id);
  const hidden = ids[1];

  runtime.setVisible(hidden, false);
  assert.equal(runtime.moveButton(ids[2], "up").ok, true, "the button below swaps with the hidden one");

  const after = runtime.actionDescriptors().map((descriptor) => descriptor.id);
  assert.deepEqual(after, [ids[0], ids[2], hidden, ...ids.slice(3)], "the hidden button kept its place");
  const rows = runtime.rows("s1").items.map((item) => item.action.id);
  assert.equal(rows.includes(hidden), false, "the hidden button is not a row");
  assert.deepEqual(rows, after.filter((id) => id !== hidden), "the visible rows keep the order");
  const settings = runtime.settingsItems().map((item) => item.id);
  assert.equal(settings.includes(hidden), true, "the settings list still shows the hidden button");
  assert.equal(settings.indexOf(hidden), after.indexOf(hidden), "in its place");

  await cleanup();
});

test("a hand-added button reorders among discovered scripts and Cargo actions", async () => {
  const root = fixture({
    ".git/HEAD": "ref: refs/heads/main\n",
    "Cargo.toml": "[package]\nname = \"mix\"\n",
    "package.json": { scripts: { test: "node --test", build: "node build.js" } },
  });
  const { calls, start } = openRuntime({ root });
  const cleanup = await start();
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;

  const ids = runtime.actionDescriptors().map((descriptor) => descriptor.id);
  assert.ok(ids.some((id) => id.startsWith("cargo-")), "Cargo actions are discovered");
  assert.ok(ids.some((id) => id.startsWith("script:")), "and so are the scripts");

  const added = runtime.saveButton({ label: "Deploy", command: "bash", args: ["ship.sh"] });
  assert.equal(added.ok, true);
  const withCustom = runtime.actionDescriptors().map((descriptor) => descriptor.id);
  assert.equal(withCustom[withCustom.length - 1], added.id, "a new custom button appends");

  assert.equal(runtime.moveButton(added.id, "up").ok, true);
  const after = runtime.actionDescriptors().map((descriptor) => descriptor.id);
  assert.deepEqual(
    after,
    [...withCustom.slice(0, -2), added.id, withCustom[withCustom.length - 2]],
    "the custom button swaps with its neighbour",
  );

  await cleanup();
});

test("reordering never changes a run's identity or starts anything", async () => {
  const root = scriptsFixture();
  const { calls, spawn, start } = openRuntime({ root });
  const cleanup = await start();
  const runtime = calls.slots[0].render({ sessionID: "s1" }).props.runtime;
  const ids = runtime.actionDescriptors().map((descriptor) => descriptor.id);

  const started = runtime.startAction(ids[0]);
  assert.equal(started.ok, true);
  const spawns = spawn.calls.length;
  assert.equal(runtime.moveButton(ids[0], "down").ok, true);
  assert.equal(spawn.calls.length, spawns, "a move does not spawn");
  assert.ok(runtime.snapshot(started.key), "the run is still tracked under the same key");
  assert.equal(runtime.snapshot(started.key).actionId, ids[0], "its action id is unchanged");

  await cleanup();
});
