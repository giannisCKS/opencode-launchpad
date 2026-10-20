// Persistent per-project button configuration for the Launchpad sidebar.
//
// Ownership: this module stores only what the user typed - a replacement label,
// executable and argument vector for a discovered runner button, and the same
// three fields for buttons the user added. It never resolves actions, never
// spawns anything and knows nothing about the sidebar, the runners or git, so it
// can be unit tested without a host.
//
// Scope: edits are keyed by the *project directory* the user was looking at, and
// a custom button remembers the directory it was created in. A command saved in
// one project therefore never appears in, or runs from, another. Button
// visibility is a different store with a different meaning: it stays global and
// keyed by stable action id, so it is untouched by anything here.
//
// Ids are immutable. A discovered action keeps its id (so its log, its stop
// target and its hidden/shown state all survive a rename), and a custom button
// gets a `custom:` id that never changes, not even when its label does.
//
// Storage, in order of preference:
//   1. the V2 durable store - `context.storage.store(key, { initial })`, which
//      returns `[reactiveSettings, asyncUpdate]` and persists JSON across
//      restarts while keeping TUI instances in sync,
//   2. the legacy host persistence API (`context.kv`, TuiKV),
//   3. a scoped user config file written atomically.
// The store is feature-detected, not version-checked, because the installed
// typings can lag the host.
//
// Creating the store never writes, so merely running the plugin (or a setup
// test) leaves no file behind. A failed read or write is reported through
// `error()` and `ready`, never swallowed: the user must be able to tell that a
// command they saved will not survive a restart.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// `context.kv` is per plugin, so the key stays short.
const KV_KEY = "control.buttons";
const FILE_VERSION = 1;

// How long a durable read is reused, for the same reason as the visibility
// store: a paint asks about every button, so a short cache keeps the file read
// bounded while still picking up another instance's change.
const REFRESH_MS = 250;

// Deliberately small bounds. A button is a name, an executable and a short
// argument list - anything else is a mistake, and a bounded value cannot turn a
// stray paste into an unbounded settings file.
const MAX_LABEL = 120;
const MAX_COMMAND = 512;
const MAX_ARGS = 64;
const MAX_ARG = 512;

// Where the fallback file lives when the host has no persistence API. Inject a
// path (`buttonConfigFile`) in tests so no test touches a real home directory.
export function defaultButtonConfigFile(env = process.env) {
  const base =
    typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
      ? env.XDG_CONFIG_HOME
      : path.join(env.HOME || ".", ".config");
  return path.join(base, "opencode", "control", "buttons.json");
}

function emptyDoc() {
  return { version: FILE_VERSION, projects: {}, custom: [] };
}

// A project's stored button order: a list of stable action ids. Anything that
// is not a non-empty string is dropped, and a repeat keeps its first place, so
// a hand-edited order can never make the list ambiguous or duplicate a button.
function readOrder(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const order = [];
  for (const id of value) {
    if (typeof id !== "string" || !id || seen.has(id)) continue;
    seen.add(id);
    order.push(id);
  }
  return order;
}

function cloneOrder(order) {
  return Array.isArray(order) ? order.slice() : [];
}

function readEntry(entry) {
  const kept = {};
  const overrides = entry && typeof entry === "object" ? entry.overrides : undefined;
  if (overrides && typeof overrides === "object") {
    for (const [id, patch] of Object.entries(overrides)) {
      const clean = readPatch(patch);
      if (typeof id === "string" && id && clean) kept[id] = clean;
    }
  }
  const order = readOrder(entry && typeof entry === "object" ? entry.order : undefined);
  return { overrides: kept, order };
}

function cloneEntry(entry) {
  const overrides = {};
  for (const [id, patch] of Object.entries(entry.overrides ?? {})) overrides[id] = clonePatch(patch);
  const next = { overrides };
  const order = cloneOrder(entry.order);
  if (order.length) next.order = order;
  return next;
}

function hasNul(value) {
  return value.includes("\u0000");
}

function describe(error, code) {
  const message =
    error && typeof error.message === "string" && error.message
      ? error.message
      : String(error ?? code);
  return { code, message };
}

function sameError(a, b) {
  if (!a || !b) return a === b;
  return a.code === b.code && a.message === b.message;
}

function fail(code, reason) {
  return { ok: false, code, reason };
}

// The user's input, or a reason it cannot be stored. Trimming is the only
// normalization: the command is passed to the runner as one executable name and
// the arguments as separate strings, so nothing here splits or re-joins a shell
// line.
export function validateButtonPatch(patch) {
  if (!patch || typeof patch !== "object") {
    return fail("invalid-label", "A button needs a name, a command and arguments.");
  }
  const label = typeof patch.label === "string" ? patch.label.trim() : "";
  if (!label) return fail("invalid-label", "Give the button a name.");
  if (label.length > MAX_LABEL) {
    return fail("invalid-label", `A name can be at most ${MAX_LABEL} characters.`);
  }
  if (hasNul(label)) return fail("invalid-label", "A name cannot contain a null character.");

  const command = typeof patch.command === "string" ? patch.command.trim() : "";
  if (!command) return fail("invalid-command", "Give the button an executable to run.");
  if (command.length > MAX_COMMAND) {
    return fail("invalid-command", `An executable can be at most ${MAX_COMMAND} characters.`);
  }
  if (hasNul(command)) return fail("invalid-command", "An executable cannot contain a null character.");

  if (!Array.isArray(patch.args)) {
    return fail("invalid-args", "Arguments must be a JSON array of strings, for example [\"test\"].");
  }
  if (patch.args.length > MAX_ARGS) {
    return fail("invalid-args", `At most ${MAX_ARGS} arguments are allowed.`);
  }
  const args = [];
  for (const arg of patch.args) {
    if (typeof arg !== "string") return fail("invalid-args", "Every argument must be a string.");
    if (arg.length > MAX_ARG) {
      return fail("invalid-args", `An argument can be at most ${MAX_ARG} characters.`);
    }
    if (hasNul(arg)) return fail("invalid-args", "An argument cannot contain a null character.");
    args.push(arg);
  }
  return { ok: true, value: { label, command, args } };
}

// A stored entry, or undefined when it is malformed. Corrupt or hand-edited
// entries are dropped on read instead of being trusted and run.
function readPatch(patch) {
  const result = validateButtonPatch(patch);
  return result.ok ? result.value : undefined;
}

// Anything the durable value can be, normalized to the document shape. Unknown
// keys are dropped; a malformed project or button is dropped, never guessed at.
function readDoc(value) {
  const doc = emptyDoc();
  if (!value || typeof value !== "object") return doc;
  const projects = value.projects;
  if (projects && typeof projects === "object") {
    for (const [dir, entry] of Object.entries(projects)) {
      if (typeof dir !== "string" || !dir) continue;
      const clean = readEntry(entry);
      if (Object.keys(clean.overrides).length || clean.order.length) {
        doc.projects[dir] = clean.order.length
          ? { overrides: clean.overrides, order: clean.order }
          : { overrides: clean.overrides };
      }
    }
  }
  if (Array.isArray(value.custom)) {
    for (const entry of value.custom) {
      const clean = readPatch(entry);
      if (!clean) continue;
      if (typeof entry?.id !== "string" || !entry.id) continue;
      if (typeof entry?.project !== "string" || !entry.project) continue;
      doc.custom.push({ id: entry.id, project: entry.project, ...clean });
    }
  }
  return doc;
}

function clonePatch(patch) {
  return { label: patch.label, command: patch.command, args: [...patch.args] };
}

function cloneDoc(doc) {
  const next = emptyDoc();
  for (const [dir, entry] of Object.entries(doc.projects)) {
    next.projects[dir] = cloneEntry(entry);
  }
  next.custom = doc.custom.map((entry) => ({ ...clonePatch(entry), id: entry.id, project: entry.project }));
  return next;
}

// One change, recorded as an operation rather than as a whole document: a
// confirmed write drops its operation, and an unconfirmed one keeps the sidebar
// showing what the user just did. Every operation is idempotent, so applying the
// durable value and an operation twice cannot duplicate a button.
export function applyButtonOps(doc, ops) {
  const next = cloneDoc(readDoc(doc));
  for (const op of ops) {
    if (!op || typeof op !== "object") continue;
    if (op.op === "override") {
      const entry = next.projects[op.dir] ?? { overrides: {} };
      entry.overrides[op.id] = clonePatch(op.value);
      next.projects[op.dir] = entry;
    } else if (op.op === "reset") {
      const entry = next.projects[op.dir];
      if (!entry) continue;
      delete entry.overrides[op.id];
      if (!Object.keys(entry.overrides).length && !cloneOrder(entry.order).length) {
        delete next.projects[op.dir];
      }
    } else if (op.op === "order") {
      // The order is a whole list, written as one operation, so replaying it
      // twice cannot change the result. An empty list clears it rather than
      // storing a document that says nothing.
      const entry = next.projects[op.dir] ?? { overrides: {} };
      const order = readOrder(op.ids);
      if (order.length) entry.order = order;
      else delete entry.order;
      next.projects[op.dir] = entry;
    } else if (op.op === "custom-add") {
      const fresh = { ...clonePatch(op.value), id: op.id, project: op.dir };
      const index = next.custom.findIndex((item) => item.id === op.id);
      if (index >= 0) next.custom[index] = fresh;
      else next.custom.push(fresh);
    } else if (op.op === "custom-update") {
      const index = next.custom.findIndex((item) => item.id === op.id);
      if (index < 0) continue;
      next.custom[index] = { ...next.custom[index], ...clonePatch(op.value) };
    } else if (op.op === "custom-remove") {
      next.custom = next.custom.filter((item) => item.id !== op.id);
    }
  }
  return next;
}

export function createButtonConfigStore(options = {}) {
  const storage = options.storage;
  const kv = options.kv;
  const file = options.file;
  const io = options.io ?? { mkdirSync, readFileSync, renameSync, writeFileSync };
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? REFRESH_MS;
  const newId = options.newId ?? (() => `custom:${randomUUID()}`);
  const hasStorage = Boolean(storage) && typeof storage.store === "function";
  const hasKv =
    !hasStorage && Boolean(kv) && typeof kv.get === "function" && typeof kv.set === "function";
  const hasFile = !hasStorage && !hasKv && typeof file === "string" && Boolean(file);

  const listeners = new Set();
  let ops = [];
  let durable = emptyDoc();
  let durableAt = -Infinity;
  let loaded = false;
  let loadError = null;
  let writeError = null;
  let writes = 0;
  let tmpCounter = 0;
  let settings;
  let update;

  // Read-only load. A missing file is a first run, not an error; an unreadable
  // or corrupt one is reported and degrades to "no saved buttons" rather than
  // throwing into the host's setup.
  if (hasStorage) {
    try {
      const pair = storage.store(KV_KEY, { initial: emptyDoc() });
      settings = pair?.[0];
      update = pair?.[1];
      durable = readDoc(settings);
      durableAt = now();
      loaded = true;
      if (typeof update !== "function") {
        writeError = {
          code: "persist-unavailable",
          message: "the host store did not provide a way to save buttons",
        };
      }
    } catch (error) {
      loadError = describe(error, "store-unavailable");
    }
  } else if (hasKv) {
    try {
      durable = readDoc(kv.get(KV_KEY, emptyDoc()));
      durableAt = now();
      loaded = true;
    } catch (error) {
      loadError = describe(error, "read-failed");
    }
  } else if (hasFile) {
    try {
      durable = readDoc(JSON.parse(io.readFileSync(file, "utf8")));
      loaded = true;
    } catch (error) {
      if (!error || error.code !== "ENOENT") loadError = describe(error, "read-failed");
      else loaded = true;
    }
    durableAt = now();
  } else {
    loaded = true;
  }

  function notify(reason) {
    for (const listener of Array.from(listeners)) {
      try {
        listener(reason);
      } catch {
        // a dead subscriber must not break an edit
      }
    }
  }

  function setWriteError(error) {
    if (sameError(writeError, error)) return;
    writeError = error;
    notify("error");
  }

  function clearWriteError() {
    if (!writeError) return;
    writeError = null;
    notify("error");
  }

  // The durable value as the host currently holds it. `ok` is false when the
  // read failed; the last known value is still returned so the editor works.
  function readDurable(force) {
    if (hasStorage) {
      // The reactive settings object *is* the live value: the host updates it
      // for every instance, so no cache is involved.
      durable = readDoc(settings);
      durableAt = now();
      return { ok: true, doc: durable };
    }
    if (!hasKv && !hasFile) return { ok: true, doc: durable };
    if (!force && loaded && now() - durableAt < refreshMs) {
      return { ok: loadError === null, doc: durable };
    }
    durableAt = now();
    try {
      const raw = hasKv ? kv.get(KV_KEY, emptyDoc()) : JSON.parse(io.readFileSync(file, "utf8"));
      durable = readDoc(raw);
      loaded = true;
      loadError = null;
      return { ok: true, doc: durable };
    } catch (error) {
      if (hasFile && error && error.code === "ENOENT") {
        // The file is gone: a first run again, not a failure.
        durable = emptyDoc();
        loaded = true;
        loadError = null;
        return { ok: true, doc: durable };
      }
      loadError = describe(error, "read-failed");
      return { ok: false, doc: durable };
    }
  }

  // The effective document: the durable value with this instance's unconfirmed
  // edits applied, so an edit is visible before the host has answered.
  function current() {
    const read = readDurable(false);
    return applyButtonOps(read.doc, ops);
  }

  // Every pending operation is written together, in the order the user made
  // them. A retry therefore cannot store a later edit while an earlier one is
  // still unsaved, and the value is rebuilt from the freshest durable read so a
  // change another TUI instance made is preserved instead of being clobbered by
  // a stale copy. Only the operations that attempt carried are confirmed, and
  // the failure is cleared only once nothing is left unsaved - an edit made
  // while a save was in flight must not be reported as saved.
  function confirmPending(pending) {
    if (pending.length === 0) return;
    const stored = new Set(pending);
    ops = ops.filter((entry) => !stored.has(entry));
    if (ops.length === 0) clearWriteError();
    notify("change");
  }

  function persist() {
    const pending = ops.slice();
    if (hasStorage) {
      if (typeof update !== "function") {
        setWriteError({
          code: "persist-unavailable",
          message: "the host store did not provide a way to save buttons",
        });
        return false;
      }
      let result;
      try {
        result = update((draft) => {
          const next = applyButtonOps(draft, pending);
          draft.version = next.version;
          draft.projects = next.projects;
          draft.custom = next.custom;
        });
      } catch (error) {
        setWriteError(describe(error, "save-failed"));
        return false;
      }
      durableAt = -Infinity;
      if (result && typeof result.then === "function") {
        // An async update is only a save once it resolves: a rejection is
        // reported and every unsaved operation stays, so the editor keeps the
        // user's edits visible instead of silently reverting them.
        result.then(
          () => {
            durableAt = -Infinity;
            writes += 1;
            confirmPending(pending);
          },
          (error) => setWriteError(describe(error, "save-failed")),
        );
      } else {
        writes += 1;
        confirmPending(pending);
      }
      return true;
    }

    // Read the durable value fresh before writing. Failing closed here is the
    // point: without the saved buttons there is no value this instance may
    // safely write, and replacing the store would destroy edits it cannot see
    // (or a file it could not parse) while claiming the change was saved.
    const read = readDurable(true);
    if (!read.ok) {
      setWriteError(
        loadError ?? { code: "read-failed", message: "the saved buttons could not be read" },
      );
      return false;
    }
    const value = applyButtonOps(read.doc, pending);
    if (hasKv) {
      try {
        kv.set(KV_KEY, value);
      } catch (error) {
        setWriteError(describe(error, "save-failed"));
        return false;
      }
      writes += 1;
      durable = readDoc(value);
      durableAt = now();
      confirmPending(pending);
      return true;
    }
    if (!hasFile) {
      setWriteError({ code: "persist-unavailable", message: "buttons cannot be saved here" });
      return false;
    }
    try {
      io.mkdirSync(path.dirname(file), { recursive: true });
      tmpCounter += 1;
      const tmp = `${file}.${process.pid}.${tmpCounter}.tmp`;
      io.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8" });
      // Same directory, so the rename is atomic on every supported platform.
      io.renameSync(tmp, file);
    } catch (error) {
      setWriteError(describe(error, "save-failed"));
      return false;
    }
    writes += 1;
    durable = readDoc(value);
    durableAt = now();
    confirmPending(pending);
    return true;
  }

  // Record the operation, apply it locally, then try to store it with every
  // other unsaved operation. The local result is returned either way: a failed
  // write is reported through error() and the edit stays visible.
  function commit(op) {
    ops.push(op);
    persist();
    notify("change");
    return current();
  }

  return {
    get ready() {
      return loadError === null && writeError === null;
    },
    error() {
      return writeError ?? loadError;
    },
    writes() {
      return writes;
    },
    // The effective document, for tests and diagnostics.
    doc() {
      return current();
    },
    overridesFor(dir) {
      const entry = current().projects[dir];
      const map = new Map();
      if (!entry) return map;
      for (const [id, patch] of Object.entries(entry.overrides)) map.set(id, clonePatch(patch));
      return map;
    },
    // This project's stored button order, or an empty list when it has never
    // been reordered. The ids are opaque to this store: it never checks them
    // against discovery, so an id the project no longer has is harmless.
    orderFor(dir) {
      if (typeof dir !== "string" || !dir) return [];
      return cloneOrder(current().projects[dir]?.order);
    },
    // Replace this project's button order with one whole list, written as a
    // single operation. The list is normalized (strings, no repeats) and an
    // empty one is refused, so a move can never silently erase the order.
    saveOrder(dir, ids) {
      if (typeof dir !== "string" || !dir) return fail("unknown-project", "No project is active.");
      if (!Array.isArray(ids)) {
        return fail("invalid-order", "The button order must be a list of ids.");
      }
      const order = readOrder(ids);
      if (!order.length) return fail("invalid-order", "The button order cannot be empty.");
      commit({ op: "order", dir, ids: order });
      return { ok: true, order };
    },
    // Every custom button of one project, in creation order. A custom button
    // keeps the directory it was created in, which is also its working
    // directory, so it never runs from another project.
    customFor(dir) {
      return current()
        .custom.filter((entry) => entry.project === dir)
        .map((entry) => ({ ...clonePatch(entry), id: entry.id, project: entry.project }));
    },
    // One custom button by id, wherever it was created.
    customById(id) {
      const entry = current().custom.find((item) => item.id === id);
      return entry ? { ...clonePatch(entry), id: entry.id, project: entry.project } : undefined;
    },
    saveOverride(dir, id, patch) {
      if (typeof dir !== "string" || !dir) return fail("unknown-project", "No project is active.");
      if (typeof id !== "string" || !id) return fail("invalid-id", "A button id is required.");
      const result = validateButtonPatch(patch);
      if (!result.ok) return result;
      commit({ op: "override", dir, id, value: result.value });
      return { ok: true, id };
    },
    // Clears an override only. The discovered action - and the visibility
    // setting that hides or shows it - are untouched.
    resetOverride(dir, id) {
      if (typeof dir !== "string" || !dir) return fail("unknown-project", "No project is active.");
      if (typeof id !== "string" || !id) return fail("invalid-id", "A button id is required.");
      const existed = current().projects[dir]?.overrides?.[id] !== undefined;
      if (!existed) return { ok: true, removed: false };
      commit({ op: "reset", dir, id });
      return { ok: true, removed: true };
    },
    addCustom(dir, patch) {
      if (typeof dir !== "string" || !dir) return fail("unknown-project", "No project is active.");
      const result = validateButtonPatch(patch);
      if (!result.ok) return result;
      const id = newId();
      if (typeof id !== "string" || !id) {
        return fail("invalid-id", "A new button could not be named.");
      }
      commit({ op: "custom-add", dir, id, value: result.value });
      return { ok: true, id };
    },
    updateCustom(id, patch) {
      if (typeof id !== "string" || !id) return fail("invalid-id", "A button id is required.");
      const existing = this.customById(id);
      if (!existing) return fail("not-found", "No custom button has that id.");
      const result = validateButtonPatch(patch);
      if (!result.ok) return result;
      commit({ op: "custom-update", id, value: result.value });
      return { ok: true, id };
    },
    deleteCustom(id) {
      if (typeof id !== "string" || !id) return fail("invalid-id", "A button id is required.");
      if (!this.customById(id)) return fail("not-found", "No custom button has that id.");
      commit({ op: "custom-remove", id });
      return { ok: true, removed: true };
    },
    // `listener(reason)` with reason "change" or "error". The disposer removes
    // the listener and never throws.
    subscribe(listener) {
      if (typeof listener !== "function") {
        return () => {
          // Intended no-op: a non-function subscriber has nothing to remove.
        };
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      listeners.clear();
    },
  };
}
