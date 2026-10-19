import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  CONTROL_ITEMS,
  createVisibilityStore,
  defaultVisibilityFile,
} from "./visibility.js";

const roots = [];
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "control-visibility-"));
  roots.push(dir);
  return dir;
}

test.after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

// An in-memory `context.kv`, so the host path is exercised without a file.
function fakeKv(initial) {
  const map = new Map(Object.entries(initial ?? {}));
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

// The real filesystem calls, so one failing call can be injected in isolation.
function realIo() {
  return { mkdirSync, readFileSync, renameSync, writeFileSync };
}

test("the four plugin controls are declared once, with stable ids", () => {
  assert.deepEqual(
    CONTROL_ITEMS.map((item) => item.id),
    ["commit", "push", "stop-all", "log"],
    "the control ids are also the keys of rows().controls",
  );
  assert.ok(CONTROL_ITEMS.every((item) => typeof item.label === "string" && item.label));
});

test("everything is visible on a first run and nothing is written", () => {
  const file = path.join(tempDir(), "nested", "visibility.json");
  const store = createVisibilityStore({ file });
  assert.equal(store.ready, true, "a missing file is a first run, not an error");
  assert.equal(store.isVisible("build-mobile"), true);
  assert.equal(store.isVisible("commit"), true);
  assert.deepEqual(store.hiddenIds(), []);
  assert.equal(store.writes(), 0, "loading never writes");
  // The directory was not even created: setup leaves no trace.
  assert.throws(() => readdirSync(path.dirname(file)), { code: "ENOENT" });
});

test("setVisible only accepts an explicit boolean and reports a change", () => {
  const kv = fakeKv();
  const store = createVisibilityStore({ kv });
  assert.equal(store.setVisible("build-mobile", false), true);
  assert.equal(store.isVisible("build-mobile"), false);
  assert.equal(store.setVisible("build-mobile", false), false, "the same value is a no-op");
  assert.equal(store.setVisible("build-mobile", true), true);
  assert.equal(store.isVisible("build-mobile"), true);
  assert.equal(store.setVisible("build-mobile", "yes"), false, "only a boolean hides a button");
  assert.equal(store.setVisible("", false), false, "an empty id is ignored");
  assert.equal(store.setVisible(undefined, false), false);
  assert.equal(store.isVisible(undefined), true, "an unknown id is visible by default");
});

test("the hidden set is persisted to the host kv and read back", () => {
  const kv = fakeKv();
  const first = createVisibilityStore({ kv });
  first.setVisible("push", false);
  first.setVisible("commit", false);
  assert.deepEqual(kv.stored("control.visibility"), {
    version: 1,
    hidden: ["commit", "push"],
  });

  const second = createVisibilityStore({ kv });
  assert.equal(second.isVisible("commit"), false);
  assert.equal(second.isVisible("push"), false);
  assert.equal(second.isVisible("log"), true);
  assert.deepEqual(second.hiddenIds(), ["commit", "push"]);
});

test("showAll restores every button and reports how many came back", () => {
  const kv = fakeKv();
  const store = createVisibilityStore({ kv });
  store.setVisible("commit", false);
  store.setVisible("push", false);
  assert.equal(store.showAll(), 2);
  assert.deepEqual(store.hiddenIds(), []);
  assert.equal(store.isVisible("commit"), true);
  assert.equal(store.showAll(), 0, "nothing to restore the second time");
});

test("subscribers are notified on a change and a disposer unsubscribes", () => {
  const kv = fakeKv();
  const store = createVisibilityStore({ kv });
  let seen = 0;
  const dispose = store.subscribe(() => {
    seen += 1;
  });
  store.setVisible("commit", false);
  assert.equal(seen, 1, "a real change notifies");
  store.setVisible("commit", false);
  assert.equal(seen, 1, "a no-op does not notify");
  store.showAll();
  assert.equal(seen, 2, "show all notifies");
  store.showAll();
  assert.equal(seen, 2, "an empty show all does not notify");
  dispose();
  store.setVisible("push", false);
  assert.equal(seen, 2, "the disposer removed the listener");
});

test("a throwing subscriber cannot break the toggle", () => {
  const kv = fakeKv();
  const store = createVisibilityStore({ kv });
  let seen = 0;
  store.subscribe(() => {
    throw new Error("subscriber exploded");
  });
  store.subscribe(() => {
    seen += 1;
  });
  assert.equal(store.setVisible("commit", false), true);
  assert.equal(seen, 1, "the healthy subscriber still ran");
  assert.equal(store.isVisible("commit"), false);
});

test("the fallback file is written atomically and reloaded", () => {
  const file = path.join(tempDir(), "control", "visibility.json");
  const first = createVisibilityStore({ file });
  assert.equal(first.setVisible("log", false), true);
  assert.equal(first.writes(), 1);

  const stored = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(stored, { version: 1, hidden: ["log"] });
  // No temporary file is left behind by the atomic rename.
  assert.deepEqual(readdirSync(path.dirname(file)), ["visibility.json"]);

  const second = createVisibilityStore({ file });
  assert.equal(second.isVisible("log"), false);
  assert.equal(second.isVisible("commit"), true);
});

test("a corrupt file degrades to everything visible instead of throwing", () => {
  const file = path.join(tempDir(), "visibility.json");
  writeFileSync(file, "{ this is not json");
  const store = createVisibilityStore({ file });
  assert.equal(store.ready, false, "a corrupt file is reported, not fatal");
  assert.equal(store.isVisible("commit"), true, "the sidebar still works");
  assert.equal(store.setVisible("push", false), true, "and a toggle still persists");
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).hidden, ["push"]);
});

test("an unreadable path is reported and a failed write never breaks a toggle", () => {
  const file = path.join(tempDir(), "visibility.json");
  const exploding = () => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  };
  const store = createVisibilityStore({
    file,
    io: {
      readFileSync: exploding,
      writeFileSync: exploding,
      renameSync: exploding,
      mkdirSync: exploding,
    },
  });
  assert.equal(store.ready, false);
  assert.equal(store.setVisible("push", false), true, "the in-memory toggle still applies");
  assert.equal(store.isVisible("push"), false);
  assert.equal(store.writes(), 0, "a failed write is not counted");
  assert.equal(store.ready, false, "ready must not stay true after a failed save");
  assert.equal(store.error().code, "save-failed", "the failure is available to report");
});

test("a throwing kv write is reported instead of claiming success", () => {
  const kv = {
    get: () => [],
    set: () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    },
  };
  const store = createVisibilityStore({ kv });
  assert.equal(store.ready, true);
  assert.equal(store.setVisible("push", false), true, "the click still applies immediately");
  assert.equal(store.isVisible("push"), false);
  assert.equal(store.writes(), 0, "nothing was saved");
  assert.equal(store.ready, false);
  assert.equal(store.error().code, "save-failed");
});

test("a rejected durable update is reported only once the host answers", async () => {
  const settings = { hidden: [] };
  const store = createVisibilityStore({
    storage: {
      store: () => [
        settings,
        async () => {
          throw Object.assign(new Error("EROFS: read-only file system"), { code: "EROFS" });
        },
      ],
    },
  });
  assert.equal(store.ready, true);
  assert.equal(store.setVisible("commit", false), true);
  assert.equal(store.isVisible("commit"), false, "the click applies before the host answers");
  assert.equal(store.writes(), 0);
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(settings.hidden, [], "the host never accepted the change");
  assert.equal(store.writes(), 0, "a rejected write is not counted as saved");
  assert.equal(store.ready, false, "the rejection reaches the caller");
  assert.deepEqual(store.error(), { code: "save-failed", message: "EROFS: read-only file system" });
  assert.equal(store.isVisible("commit"), false, "the sidebar keeps the user's choice visible");
});

test("a store without an update function is read-only and says so", () => {
  const settings = { hidden: [] };
  const store = createVisibilityStore({
    storage: { store: () => [settings, undefined] },
  });
  assert.equal(store.ready, false, "settings cannot be saved here, so ready is false");
  assert.equal(store.error().code, "persist-unavailable");
  assert.equal(store.setVisible("commit", false), true);
  assert.deepEqual(settings.hidden, [], "nothing was persisted, nothing threw");
  assert.equal(store.isVisible("commit"), false, "the in-memory view still applies");
});

test("another writer's durable change is honoured without restarting the store", () => {
  const map = new Map();
  const kv = {
    get: (key, fallback) => (map.has(key) ? map.get(key) : fallback),
    set: (key, value) => map.set(key, value),
  };
  const store = createVisibilityStore({ kv, refreshMs: 0 });
  assert.equal(store.isVisible("commit"), true);
  // As if another TUI instance hid it.
  map.set("control.visibility", { version: 1, hidden: ["commit"] });
  assert.equal(store.isVisible("commit"), false, "a change made elsewhere is read");
  assert.deepEqual(store.hiddenIds(), ["commit"]);
  assert.equal(store.showAll(), 1, "and show all clears it");
  assert.deepEqual(map.get("control.visibility").hidden, []);
});

test("a change another store wrote to the same file is picked up", () => {
  const file = path.join(tempDir(), "control", "visibility.json");
  const first = createVisibilityStore({ file });
  const second = createVisibilityStore({ file, refreshMs: 0 });
  assert.equal(second.isVisible("log"), true);
  first.setVisible("log", false);
  assert.equal(second.isVisible("log"), false, "the second store sees the written change");
  assert.deepEqual(second.hiddenIds(), ["log"]);
});

test("a read that fails is reported while the sidebar keeps working", () => {
  const file = path.join(tempDir(), "control", "visibility.json");
  const read = () => {
    throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  };
  const store = createVisibilityStore({ file, io: { ...realIo(), readFileSync: read } });
  assert.equal(store.ready, false, "an unreadable config is reported, not silently ignored");
  assert.equal(store.error().code, "read-failed");
  assert.equal(store.isVisible("commit"), true, "the sidebar still works");
  assert.equal(store.setVisible("commit", false), true, "and a toggle still saves");
  assert.equal(store.writes(), 1);
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).hidden, ["commit"]);
});

test("an externally removed file is a first run again, not a failure", () => {
  const file = path.join(tempDir(), "control", "visibility.json");
  const store = createVisibilityStore({ file, refreshMs: 0 });
  store.setVisible("commit", false);
  assert.equal(store.ready, true);
  rmSync(file);
  assert.equal(store.isVisible("commit"), true, "with no file every button is visible");
  assert.equal(store.ready, true, "a missing file is not an error");
});

test("ids are the hidden set, never the labels", () => {
  const kv = fakeKv();
  const store = createVisibilityStore({ kv });
  const label = CONTROL_ITEMS[0].label;
  assert.equal(store.setVisible(label, false), true, "a label is not an id, so it is just stored");
  // The real control stays visible: renaming a button never unhides it.
  assert.equal(store.isVisible(CONTROL_ITEMS[0].id), true);
  assert.equal(store.isVisible(label), false);
});

test("the default file follows XDG_CONFIG_HOME when it is set", () => {
  assert.equal(
    defaultVisibilityFile({ XDG_CONFIG_HOME: "/xdg", HOME: "/home/x" }),
    path.join("/xdg", "opencode", "control", "visibility.json"),
  );
  assert.equal(
    defaultVisibilityFile({ HOME: "/home/x" }),
    path.join("/home/x", ".config", "opencode", "control", "visibility.json"),
  );
});

test("a broken kv falls back to no persistence without throwing", () => {
  const kv = {
    get() {
      throw new Error("kv exploded");
    },
    set() {
      throw new Error("kv exploded");
    },
  };
  const store = createVisibilityStore({ kv });
  assert.equal(store.ready, false);
  assert.equal(store.setVisible("commit", false), true, "the toggle still applies in memory");
  assert.equal(store.isVisible("commit"), false);
});

test("dispose drops every subscriber", () => {
  const kv = fakeKv();
  const store = createVisibilityStore({ kv });
  let seen = 0;
  store.subscribe(() => {
    seen += 1;
  });
  store.dispose();
  store.setVisible("commit", false);
  assert.equal(seen, 0);
});

test("a directory that exists but has no file is still a first run", () => {
  const dir = path.join(tempDir(), "control");
  mkdirSync(dir, { recursive: true });
  const store = createVisibilityStore({ file: path.join(dir, "visibility.json") });
  assert.equal(store.ready, true);
  assert.equal(store.isVisible("commit"), true);
});

// --------------------------------------------------------------------------
// The V2 durable store: context.storage.store(key, { initial })
// --------------------------------------------------------------------------

// `[reactiveSettings, asyncUpdate]`, as the V2 CLI plugin guide documents it.
function fakeStorage(initialHidden = []) {
  const settings = { hidden: [...initialHidden] };
  const calls = [];
  const update = async (updater) => {
    calls.push("update");
    updater(settings);
  };
  return {
    calls,
    settings,
    store(key, options) {
      calls.push(["store", key, options]);
      return [settings, update];
    },
  };
}

test("the durable host store is used when the host offers one", async () => {
  const storage = fakeStorage();
  const store = createVisibilityStore({ storage });
  assert.equal(store.ready, true);
  assert.deepEqual(storage.calls[0], [
    "store",
    "control.visibility",
    { initial: { hidden: [] } },
  ]);
  assert.equal(store.isVisible("commit"), true);
  assert.equal(store.writes(), 0, "loading never writes");

  assert.equal(store.setVisible("commit", false), true);
  await Promise.resolve();
  assert.deepEqual(storage.settings.hidden, ["commit"], "the change reached the host store");
  assert.equal(store.isVisible("commit"), false);

  // A second TUI instance reads the same durable value back.
  const second = createVisibilityStore({ storage });
  assert.equal(second.isVisible("commit"), false);
  assert.equal(second.isVisible("push"), true);
});

test("a toggle keeps another TUI instance's change", async () => {
  const storage = fakeStorage(["commit"]);
  const store = createVisibilityStore({ storage });
  assert.equal(store.isVisible("commit"), false, "the stored value is read back");
  assert.equal(store.setVisible("push", false), true);
  await Promise.resolve();
  assert.deepEqual(
    storage.settings.hidden,
    ["commit", "push"],
    "read-modify-write inside the draft, never a clobber",
  );
});

test("show all clears the durable value", async () => {
  const storage = fakeStorage(["commit", "push"]);
  const store = createVisibilityStore({ storage });
  assert.equal(store.showAll(), 2);
  await Promise.resolve();
  assert.deepEqual(storage.settings.hidden, []);
  assert.equal(store.isVisible("commit"), true);
});

test("the durable store wins over kv and the fallback file", async () => {
  const storage = fakeStorage();
  const kv = fakeKv();
  const file = path.join(tempDir(), "control", "visibility.json");
  const store = createVisibilityStore({ storage, kv, file });
  assert.equal(store.setVisible("log", false), true);
  await Promise.resolve();
  assert.deepEqual(storage.settings.hidden, ["log"]);
  assert.deepEqual(kv.calls.filter((call) => call[0] === "set"), [], "kv is not written");
  assert.throws(() => readdirSync(path.dirname(file)), { code: "ENOENT" }, "no file is written");
});

test("a broken durable store degrades instead of throwing", () => {
  const storage = {
    store() {
      throw new Error("storage exploded");
    },
  };
  const store = createVisibilityStore({ storage });
  assert.equal(store.ready, false);
  assert.equal(store.error().code, "store-unavailable", "the caller learns what went wrong");
  assert.equal(store.isVisible("commit"), true, "the sidebar still works");
  assert.equal(store.setVisible("commit", false), true, "and the toggle still applies in memory");
  assert.equal(store.writes(), 0);
});
