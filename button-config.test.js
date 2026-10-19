import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  applyButtonOps,
  createButtonConfigStore,
  defaultButtonConfigFile,
  validateButtonPatch,
} from "./button-config.js";

const roots = [];
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "control-buttons-"));
  roots.push(dir);
  return dir;
}

test.after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// An in-memory `context.kv`, so the legacy host path is exercised without a file.
function fakeKv(initial) {
  const map = new Map();
  if (initial !== undefined) map.set("control.buttons", initial);
  return {
    calls: [],
    get(key, fallback) {
      this.calls.push(["get", key]);
      return map.has(key) ? map.get(key) : fallback;
    },
    set(key, value) {
      this.calls.push(["set", key, value]);
      map.set(key, value);
    },
    stored(key) {
      return map.get(key);
    },
  };
}

// The V2 durable store: `store(key, { initial })` returns `[settings, update]`.
function fakeDurableStore({ initial = {}, reject = false } = {}) {
  const settings = { version: 1, projects: {}, custom: [], ...initial };
  const calls = { store: 0, update: 0 };
  const storage = {
    calls,
    settings,
    store(key, options) {
      calls.store += 1;
      assert.equal(key, "control.buttons");
      assert.deepEqual(options.initial, { version: 1, projects: {}, custom: [] });
      return [settings, storage.update];
    },
    update(mutate) {
      calls.update += 1;
      if (reject) return Promise.reject(new Error("store is read-only"));
      mutate(settings);
      return Promise.resolve();
    },
  };
  return storage;
}

const realIo = { mkdirSync, readFileSync, renameSync, writeFileSync };

// ------------------------------------------------------------------ validation

test("a button patch needs a name, an executable and a string array", () => {
  assert.deepEqual(validateButtonPatch({ label: "Deploy", command: "bash", args: ["ship.sh"] }), {
    ok: true,
    value: { label: "Deploy", command: "bash", args: ["ship.sh"] },
  });
  const rejects = [
    [{ label: "  ", command: "bash", args: [] }, "invalid-label"],
    [{ label: "Deploy", command: " ", args: [] }, "invalid-command"],
    [{ label: "Deploy", command: "bash", args: "ship.sh" }, "invalid-args"],
    [{ label: "Deploy", command: "bash", args: [7] }, "invalid-args"],
    [{ label: "Deploy", command: "bash", args: ["a\u0000b"] }, "invalid-args"],
    [{ label: "a\u0000b", command: "bash", args: [] }, "invalid-label"],
    [{ label: "Deploy", command: "ba\u0000sh", args: [] }, "invalid-command"],
  ];
  for (const [patch, code] of rejects) {
    const result = validateButtonPatch(patch);
    assert.equal(result.ok, false, `${code} is refused`);
    assert.equal(result.code, code);
    assert.ok(result.reason.length > 0, "a refusal explains itself");
  }
});

test("the label, the executable and the arguments are bounded", () => {
  assert.equal(validateButtonPatch({ label: "x".repeat(121), command: "bash", args: [] }).code, "invalid-label");
  assert.equal(validateButtonPatch({ label: "x", command: "y".repeat(513), args: [] }).code, "invalid-command");
  assert.equal(
    validateButtonPatch({ label: "x", command: "y", args: Array.from({ length: 65 }, () => "a") }).code,
    "invalid-args",
  );
  assert.equal(validateButtonPatch({ label: "x", command: "y", args: ["a".repeat(513)] }).code, "invalid-args");
  assert.equal(validateButtonPatch({ label: "x".repeat(120), command: "bash", args: [] }).ok, true);
});

// ------------------------------------------------------------------ first run

test("a first run loads nothing and writes nothing", () => {
  const file = path.join(tempDir(), "nested", "buttons.json");
  const store = createButtonConfigStore({ file });
  assert.equal(store.ready, true, "a missing file is a first run, not an error");
  assert.equal(store.error(), null);
  assert.deepEqual(store.overridesFor("/tmp/nowhere"), new Map());
  assert.deepEqual(store.customFor("/tmp/nowhere"), []);
  assert.equal(store.writes(), 0, "loading never writes");
  // The directory was not even created: setup leaves no trace behind.
  assert.throws(() => readdirSync(path.dirname(file)), { code: "ENOENT" });
});

// ------------------------------------------------------------------ overrides

test("an override is stored per project and survives a reload", () => {
  const file = path.join(tempDir(), "buttons.json");
  const dir = tempDir();
  const store = createButtonConfigStore({ file });
  const saved = store.saveOverride(dir, "build-mobile", {
    label: "Ship it",
    command: "bash",
    args: ["scripts/build.sh", "--release"],
  });
  assert.deepEqual(saved, { ok: true, id: "build-mobile" });
  assert.equal(store.writes(), 1);
  const onDisk = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(onDisk.projects[dir].overrides["build-mobile"], {
    label: "Ship it",
    command: "bash",
    args: ["scripts/build.sh", "--release"],
  });

  // A fresh store reads what the first one wrote.
  const reloaded = createButtonConfigStore({ file });
  assert.deepEqual(reloaded.overridesFor(dir).get("build-mobile").command, "bash");
  assert.deepEqual(reloaded.overridesFor(dir).get("build-mobile").args, ["scripts/build.sh", "--release"]);
  assert.deepEqual([...reloaded.overridesFor(dir).keys()], ["build-mobile"]);
});

test("a refused override changes nothing and is not written", () => {
  const file = path.join(tempDir(), "buttons.json");
  const store = createButtonConfigStore({ file });
  const result = store.saveOverride(tempDir(), "build-mobile", { label: "Ship it", command: "bash", args: "no" });
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid-args");
  assert.equal(store.writes(), 0, "a refused edit never reaches the disk");
  assert.equal(store.error(), null, "and it is not a save failure");
  assert.deepEqual(store.overridesFor(tempDir()), new Map());
});

test("reset clears an override only, never the action or its visibility", () => {
  const file = path.join(tempDir(), "buttons.json");
  const dir = tempDir();
  const store = createButtonConfigStore({ file });
  store.saveOverride(dir, "build-mobile", { label: "Ship it", command: "bash", args: [] });
  assert.equal(store.resetOverride(dir, "build-mobile").removed, true);
  assert.deepEqual(store.overridesFor(dir), new Map());
  assert.equal(store.resetOverride(dir, "build-mobile").removed, false, "resetting twice is a no-op");
  const reloaded = createButtonConfigStore({ file });
  assert.deepEqual(reloaded.overridesFor(dir), new Map());
});

// ------------------------------------------------------------------ custom buttons

test("a custom button keeps its id while its label changes", () => {
  const file = path.join(tempDir(), "buttons.json");
  const dir = tempDir();
  let counter = 0;
  const store = createButtonConfigStore({ file, newId: () => `custom:test-${(counter += 1)}` });
  const added = store.addCustom(dir, { label: "Deploy", command: "bash", args: ["ship.sh"] });
  assert.deepEqual(added, { ok: true, id: "custom:test-1" });
  const before = store.customFor(dir);
  assert.equal(before.length, 1);
  assert.equal(before[0].project, dir, "a custom button remembers where it was added");

  assert.deepEqual(store.updateCustom("custom:test-1", { label: "Deploy faster", command: "bash", args: ["ship.sh", "-f"] }), {
    ok: true,
    id: "custom:test-1",
  });
  const after = store.customFor(dir);
  assert.equal(after[0].id, "custom:test-1", "the id is immutable");
  assert.equal(after[0].label, "Deploy faster");
  assert.deepEqual(after[0].args, ["ship.sh", "-f"]);

  assert.deepEqual(store.deleteCustom("custom:test-1"), { ok: true, removed: true });
  assert.deepEqual(store.customFor(dir), []);
  assert.equal(store.customById("custom:test-1"), undefined);
  assert.equal(store.deleteCustom("custom:test-1").code, "not-found");
});

test("only a hand-added button can be updated", () => {
  const store = createButtonConfigStore({ file: path.join(tempDir(), "buttons.json") });
  const result = store.updateCustom("build-mobile", { label: "x", command: "y", args: [] });
  assert.equal(result.ok, false);
  assert.equal(result.code, "not-found");
  assert.equal(store.writes(), 0);
});

test("two projects never share an override or a custom button", () => {
  const file = path.join(tempDir(), "buttons.json");
  const first = tempDir();
  const second = tempDir();
  const store = createButtonConfigStore({ file, newId: () => "custom:shared" });
  store.saveOverride(first, "build-mobile", { label: "First", command: "bash", args: [] });
  store.addCustom(first, { label: "Only here", command: "bash", args: [] });

  assert.deepEqual([...store.overridesFor(second).keys()], [], "the second project has no override");
  assert.deepEqual(store.customFor(second), [], "and no custom button");
  assert.equal(store.overridesFor(first).get("build-mobile").label, "First");
  assert.equal(store.customFor(first).length, 1);
  // The custom button is still addressable by id from anywhere, which is what
  // lets its own project edit or delete it.
  assert.equal(store.customById("custom:shared").project, first);
});

// ------------------------------------------------------------------ durability

test("a stored document that is malformed is dropped, never trusted", () => {
  const kv = fakeKv({
    version: 1,
    projects: { "/tmp/a": { overrides: { "build-mobile": { label: "ok", command: "bash", args: [] }, bad: { label: "x" } } } },
    custom: [
      { id: "custom:good", project: "/tmp/a", label: "Good", command: "bash", args: [] },
      { id: "custom:bad", project: "/tmp/a", label: "", command: "bash", args: [] },
      { project: "/tmp/a", label: "No id", command: "bash", args: [] },
      null,
    ],
  });
  const store = createButtonConfigStore({ kv });
  assert.deepEqual([...store.overridesFor("/tmp/a").keys()], ["build-mobile"]);
  assert.deepEqual(store.customFor("/tmp/a").map((item) => item.id), ["custom:good"]);
  assert.equal(store.ready, true);
});

test("an unreadable file is reported, not swallowed", () => {
  const file = path.join(tempDir(), "buttons.json");
  writeFileSync(file, "{ this is not json");
  const store = createButtonConfigStore({ file });
  assert.equal(store.ready, false);
  assert.equal(store.error().code, "read-failed");
  assert.deepEqual(store.customFor("/tmp/a"), [], "an unreadable store degrades to empty");
});

test("a failed write keeps the edit visible and reports the failure", () => {
  const file = path.join(tempDir(), "buttons.json");
  const io = {
    ...realIo,
    writeFileSync() {
      throw Object.assign(new Error("read-only file system"), { code: "EROFS" });
    },
  };
  const store = createButtonConfigStore({ file, io });
  const result = store.saveOverride("/tmp/a", "build-mobile", { label: "Ship it", command: "bash", args: [] });
  assert.deepEqual(result, { ok: true, id: "build-mobile" }, "the local edit applies");
  assert.equal(store.ready, false);
  assert.equal(store.error().code, "save-failed");
  assert.equal(store.error().message, "read-only file system");
  assert.equal(store.overridesFor("/tmp/a").get("build-mobile").label, "Ship it", "the user's edit is not lost");
  assert.ok(readdirSync(tempDir()).length >= 0);
});

test("the durable host store carries buttons and reports a refused update", async () => {
  const storage = fakeDurableStore();
  const store = createButtonConfigStore({ storage, newId: () => "custom:durable" });
  store.saveOverride("/tmp/a", "build-mobile", { label: "Ship it", command: "bash", args: [] });
  store.addCustom("/tmp/a", { label: "Mine", command: "bash", args: ["x"] });
  assert.equal(storage.calls.update, 2);
  assert.equal(storage.settings.projects["/tmp/a"].overrides["build-mobile"].label, "Ship it");
  assert.equal(storage.settings.custom[0].id, "custom:durable");
  await Promise.resolve();
  assert.equal(store.writes(), 2, "a resolved update is a saved write");
  assert.equal(store.error(), null);

  const failing = fakeDurableStore({ reject: true });
  const broken = createButtonConfigStore({ storage: failing });
  broken.saveOverride("/tmp/a", "build-mobile", { label: "Ship it", command: "bash", args: [] });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(broken.error().code, "save-failed");
  assert.equal(broken.ready, false);
  assert.equal(broken.overridesFor("/tmp/a").get("build-mobile").label, "Ship it", "the edit stays visible");
});

test("a host store with no way to save says so", () => {
  const settings = { version: 1, projects: {}, custom: [] };
  const store = createButtonConfigStore({ storage: { store: () => [settings, undefined] } });
  assert.equal(store.error().code, "persist-unavailable");
  assert.deepEqual(store.saveOverride("/tmp/a", "build-mobile", { label: "x", command: "y", args: [] }), {
    ok: true,
    id: "build-mobile",
  });
  assert.equal(store.error().code, "persist-unavailable");
});

test("a write reads the durable value first, so two instances never clobber", () => {
  const file = path.join(tempDir(), "buttons.json");
  const first = createButtonConfigStore({ file });
  const second = createButtonConfigStore({ file });
  first.saveOverride("/tmp/a", "build-mobile", { label: "One", command: "bash", args: [] });
  // `second` was created before that write and still has its own opinion.
  second.saveOverride("/tmp/a", "web-live", { label: "Two", command: "bash", args: [] });
  const onDisk = JSON.parse(readFileSync(file, "utf8")).projects["/tmp/a"].overrides;
  assert.deepEqual(Object.keys(onDisk).sort(), ["build-mobile", "web-live"]);
  assert.equal(onDisk["build-mobile"].label, "One");
  assert.equal(onDisk["web-live"].label, "Two");
});

test("applying the same operation twice cannot duplicate a custom button", () => {
  const op = { op: "custom-add", dir: "/tmp/a", id: "custom:1", value: { label: "x", command: "y", args: [] } };
  const once = applyButtonOps({ version: 1, projects: {}, custom: [] }, [op]);
  const twice = applyButtonOps(once, [op]);
  assert.deepEqual(twice.custom, [{ id: "custom:1", project: "/tmp/a", label: "x", command: "y", args: [] }]);
  const override = { op: "override", dir: "/tmp/a", id: "build-mobile", value: { label: "x", command: "y", args: [] } };
  assert.deepEqual(applyButtonOps(applyButtonOps(once, [override]), [override]), applyButtonOps(once, [override]));
});

test("subscribe reports a change, a failure, and detaches cleanly", () => {
  const file = path.join(tempDir(), "buttons.json");
  const store = createButtonConfigStore({ file, io: { ...realIo, renameSync() { throw new Error("nope"); } } });
  const seen = [];
  const off = store.subscribe((reason) => seen.push(reason));
  store.saveOverride("/tmp/a", "build-mobile", { label: "x", command: "y", args: [] });
  assert.deepEqual(seen, ["error", "change"], "a failed save is reported once, then the change");
  off();
  store.saveOverride("/tmp/a", "web-live", { label: "x", command: "y", args: [] });
  assert.equal(seen.length, 2, "a detached listener hears nothing");
});

test("the fallback file lives under XDG_CONFIG_HOME", () => {
  assert.equal(
    defaultButtonConfigFile({ XDG_CONFIG_HOME: "/tmp/xdg", HOME: "/home/someone" }),
    path.join("/tmp/xdg", "opencode", "control", "buttons.json"),
  );
  assert.equal(
    defaultButtonConfigFile({ HOME: "/home/someone" }),
    path.join("/home/someone", ".config", "opencode", "control", "buttons.json"),
  );
});

// ------------------------------------------------ unreadable / unwritable store

// A store that can be read at setup but not afterwards: the state a config file
// with the wrong permissions, or a failed mount, produces.
function flakyIo({ failReadsAfter = 1, failWrites = false } = {}) {
  let reads = 0;
  const calls = { writes: [], renames: [] };
  return {
    calls,
    mkdirSync(...args) {
      return mkdirSync(...args);
    },
    readFileSync(p, enc) {
      reads += 1;
      if (reads > failReadsAfter) {
        const error = new Error("EACCES: permission denied");
        error.code = "EACCES";
        throw error;
      }
      return readFileSync(p, enc);
    },
    writeFileSync(p, data, opts) {
      calls.writes.push(p);
      if (failWrites) {
        const error = new Error("EROFS: read-only file system");
        error.code = "EROFS";
        throw error;
      }
      return writeFileSync(p, data, opts);
    },
    renameSync(from, to) {
      calls.renames.push(to);
      return renameSync(from, to);
    },
  };
}

test("a save refuses to overwrite a config it could no longer read", () => {
  const dir = tempDir();
  const file = path.join(dir, "buttons.json");
  const original = `${JSON.stringify({ version: 1, projects: {}, custom: [] }, null, 2)}\n`;
  writeFileSync(file, original);

  const io = flakyIo({ failReadsAfter: 1 });
  const store = createButtonConfigStore({ file, io });
  assert.equal(store.ready, true, "the setup read succeeded");

  const saved = store.saveOverride("/repo", "build-mobile", {
    label: "Ship it",
    command: "bash",
    args: ["ship.sh"],
  });
  assert.deepEqual(saved, { ok: true, id: "build-mobile" }, "the edit is not silently dropped");
  assert.equal(store.overridesFor("/repo").get("build-mobile").label, "Ship it", "and stays visible");

  // Fail closed: the unreadable value was never replaced.
  assert.deepEqual(io.calls.writes, [], "nothing was written");
  assert.deepEqual(io.calls.renames, [], "nothing was renamed over the file");
  assert.equal(readFileSync(file, "utf8"), original, "the saved file is untouched");
  assert.equal(store.writes(), 0, "a refused write is not a save");
  assert.equal(store.error().code, "read-failed");
  assert.equal(store.ready, false);
});

test("a corrupt config is never replaced by an edit", () => {
  const dir = tempDir();
  const file = path.join(dir, "buttons.json");
  const corrupt = "{ this is not json";
  writeFileSync(file, corrupt);

  const io = flakyIo();
  const store = createButtonConfigStore({ file, io });
  assert.equal(store.error().code, "read-failed", "the corrupt file is reported at setup");

  const saved = store.saveOverride("/repo", "build-mobile", { label: "Ship it", command: "bash", args: [] });
  assert.equal(saved.ok, true, "the user's edit is kept locally");
  assert.deepEqual(io.calls.writes, [], "the corrupt file is not overwritten");
  assert.deepEqual(io.calls.renames, []);
  assert.equal(readFileSync(file, "utf8"), corrupt, "the original bytes survive");
  assert.equal(store.writes(), 0);
  assert.equal(store.error().code, "read-failed");
});

test("a failed update is retried with the next edit, in order, and never claims success", async () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const settings = { version: 1, projects: {}, custom: [] };
  let attempts = 0;
  const storage = {
    store() {
      return [
        settings,
        (mutate) => {
          attempts += 1;
          // The first two updates are rejected: the store is read-only for a while.
          if (attempts <= 2) return Promise.reject(new Error("store is read-only"));
          mutate(settings);
          return Promise.resolve();
        },
      ];
    },
  };
  let counter = 0;
  const store = createButtonConfigStore({ storage, newId: () => `custom:${++counter}` });

  store.addCustom("/repo", { label: "One", command: "bash", args: [] });
  await tick();
  assert.equal(store.error().code, "save-failed", "the rejection is reported");
  assert.equal(store.writes(), 0, "a rejected update is not a save");
  assert.deepEqual(settings.custom, [], "nothing reached the store");
  assert.equal(store.customFor("/repo").length, 1, "the edit stays visible");

  store.addCustom("/repo", { label: "Two", command: "bash", args: [] });
  await tick();
  assert.equal(store.error().code, "save-failed", "an unsaved edit keeps the failure visible");
  assert.equal(store.writes(), 0);
  assert.deepEqual(settings.custom, [], "still nothing stored");
  assert.equal(store.customFor("/repo").length, 2);

  // The next update succeeds, and it carries every unsaved operation with it.
  store.saveOverride("/repo", "build-mobile", { label: "Ship it", command: "bash", args: [] });
  await tick();
  assert.equal(store.error(), null, "once every edit is stored the failure clears");
  assert.equal(store.writes(), 1);
  assert.deepEqual(
    settings.custom.map((entry) => entry.label),
    ["One", "Two"],
    "the unsaved edits were replayed in the order they were made",
  );
  assert.equal(settings.projects["/repo"].overrides["build-mobile"].label, "Ship it");
  assert.deepEqual(store.customFor("/repo").map((entry) => entry.id), ["custom:1", "custom:2"]);
});

test("a kv read failure after setup blocks the write instead of clearing the store", () => {
  let reads = 0;
  const map = new Map();
  const kv = {
    get(key, fallback) {
      reads += 1;
      if (reads > 1) {
        const error = new Error("EACCES: permission denied");
        error.code = "EACCES";
        throw error;
      }
      return map.has(key) ? map.get(key) : fallback;
    },
    set(key, value) {
      map.set(key, value);
    },
  };
  const store = createButtonConfigStore({ kv });
  assert.equal(store.ready, true, "the setup read succeeded");

  const saved = store.saveOverride("/repo", "build-mobile", { label: "Ship it", command: "bash", args: [] });
  assert.equal(saved.ok, true, "the edit is kept locally");
  assert.equal(store.error().code, "read-failed");
  assert.equal(store.writes(), 0, "nothing was saved");
  assert.equal(map.size, 0, "the host kv was not overwritten with a value read from nowhere");
});

test("a save that lands later never marks a newer unsaved edit as saved", async () => {
  const tick = () => new Promise((resolve) => setImmediate(resolve));
  const settings = { version: 1, projects: {}, custom: [] };
  const deferred = [];
  const storage = {
    store() {
      return [
        settings,
        (mutate) => {
          mutate(settings);
          return new Promise((resolve, reject) => deferred.push({ resolve, reject }));
        },
      ];
    },
  };
  let counter = 0;
  const store = createButtonConfigStore({ storage, newId: () => `custom:${++counter}` });

  store.addCustom("/repo", { label: "One", command: "bash", args: [] });
  store.addCustom("/repo", { label: "Two", command: "bash", args: [] });
  assert.equal(deferred.length, 2, "each edit issued one update");
  assert.equal(store.writes(), 0, "an unresolved update is not a save yet");

  // The second edit is refused; the first is still in flight.
  deferred[1].reject(new Error("store is read-only"));
  await tick();
  assert.equal(store.error().code, "save-failed");
  assert.equal(store.writes(), 0);

  // The first one lands, but the refused second edit is still unsaved, so the
  // failure must not be cleared.
  deferred[0].resolve();
  await tick();
  assert.equal(store.writes(), 1);
  assert.equal(store.error().code, "save-failed", "an unsaved edit keeps the failure visible");
  assert.equal(store.customFor("/repo").length, 2, "both edits stay visible");

  // The next edit carries the unsaved one and clears the failure for both.
  store.addCustom("/repo", { label: "Three", command: "bash", args: [] });
  deferred[2].resolve();
  await tick();
  assert.equal(store.error(), null);
  assert.equal(store.writes(), 2);
  assert.deepEqual(store.customFor("/repo").map((entry) => entry.label), ["One", "Two", "Three"]);
});

// --------------------------------------------------------------- button order

test("a saved order persists, reloads, and stays per project", () => {
  const file = path.join(tempDir(), "buttons.json");
  const store = createButtonConfigStore({ file });
  assert.deepEqual(store.orderFor("/tmp/a"), [], "no order before one is saved");
  assert.deepEqual(store.saveOrder("/tmp/a", ["b", "a", "c"]), { ok: true, order: ["b", "a", "c"] });

  const onDisk = JSON.parse(readFileSync(file, "utf8")).projects["/tmp/a"];
  assert.deepEqual(onDisk.order, ["b", "a", "c"], "the order is written beside the overrides");

  const reloaded = createButtonConfigStore({ file });
  assert.deepEqual(reloaded.orderFor("/tmp/a"), ["b", "a", "c"], "and read back");
  assert.deepEqual(reloaded.orderFor("/tmp/b"), [], "another project has no order of its own");
});

test("an order is normalized: only non-empty strings, first occurrence kept", () => {
  const file = path.join(tempDir(), "buttons.json");
  const store = createButtonConfigStore({ file });
  store.saveOrder("/tmp/a", ["a", "", "a", 7, "b", null, "b"]);
  assert.deepEqual(store.orderFor("/tmp/a"), ["a", "b"]);

  assert.deepEqual(store.saveOrder("/tmp/a", []).code, "invalid-order", "an empty order is refused");
  assert.deepEqual(store.saveOrder("/tmp/a", "nope").code, "invalid-order", "a non-list is refused");
  assert.deepEqual(store.orderFor("/tmp/a"), ["a", "b"], "and a refused save changes nothing");
});

test("an old document with no order still reads, overrides intact", () => {
  const file = path.join(tempDir(), "buttons.json");
  writeFileSync(
    file,
    `${JSON.stringify({
      version: 1,
      projects: { "/tmp/a": { overrides: { "build-mobile": { label: "Ship it", command: "bash", args: [] } } } },
      custom: [],
    })}\n`,
  );
  const store = createButtonConfigStore({ file });
  assert.equal(store.overridesFor("/tmp/a").get("build-mobile").label, "Ship it");
  assert.deepEqual(store.orderFor("/tmp/a"), [], "a missing order is simply empty");
  assert.equal(store.error(), null);
});

test("an order survives an override, a reset and a custom edit unchanged", () => {
  const store = createButtonConfigStore({ storage: fakeDurableStore(), newId: () => "custom:1" });
  store.saveOrder("/repo", ["b", "a", "custom:1"]);
  store.saveOverride("/repo", "b", { label: "Bee", command: "bash", args: [] });
  assert.deepEqual(store.orderFor("/repo"), ["b", "a", "custom:1"], "an override keeps the order");
  store.addCustom("/repo", { label: "Mine", command: "bash", args: ["x"] });
  assert.deepEqual(store.orderFor("/repo"), ["b", "a", "custom:1"], "a custom edit keeps the order");
  store.resetOverride("/repo", "b");
  assert.deepEqual(store.orderFor("/repo"), ["b", "a", "custom:1"], "a reset keeps the order");
  assert.deepEqual([...store.overridesFor("/repo").keys()], [], "and only the override was cleared");
});

test("replaying an order operation is idempotent and ignores unknown ids", () => {
  const base = { version: 1, projects: { "/tmp/a": { overrides: {} } }, custom: [] };
  const op = { op: "order", dir: "/tmp/a", ids: ["b", "gone", "a"] };
  const once = applyButtonOps(base, [op]);
  const twice = applyButtonOps(once, [op]);
  assert.deepEqual(twice, once, "applying it twice changes nothing");
  assert.deepEqual(twice.projects["/tmp/a"].order, ["b", "gone", "a"], "an id with no button is stored, not guessed at");
});
