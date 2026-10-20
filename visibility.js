// Persistent button visibility for the Launchpad sidebar.
//
// Ownership: this module only remembers *which* buttons the user hid. It knows
// nothing about the sidebar, the runners or git, so it can be unit tested
// without a host. Ids are the stable action ids (specialized actions and
// script-generated ones alike) plus the four plugin controls, never the visible
// labels: renaming a button must not silently unhide it.
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
// Reads answer from the *durable* value, not from a copy taken at setup: another
// TUI instance that hides or shows a button is honoured here as well. A toggle
// still applies immediately, through a small overlay of changes whose write has
// not been confirmed yet, so a slow or failing host write never makes the
// sidebar look like the click was lost.
//
// Creating the store never writes, so merely running the plugin (or a setup
// test) leaves no file behind. A failed read or write is reported through
// `error()` and `ready`, never swallowed: a caller must be able to tell the user
// that their choice will not survive a restart.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

// The plugin controls the sidebar draws. Their ids are also the keys of
// `rows().controls`, so the view and this store agree by construction.
export const CONTROL_ITEMS = Object.freeze([
  { id: "commit", label: "Commit" },
  { id: "push", label: "Push" },
  { id: "stop-all", label: "Stop all" },
  { id: "log", label: "Show logs" },
]);

// `context.kv` is per plugin, so the key stays short.
const KV_KEY = "control.visibility";
const FILE_VERSION = 1;

// How long a durable read is reused. A paint asks about every button, so an
// uncached file read would stat and parse the config once per button; a short
// cache keeps that bounded while still picking up another instance's change.
const REFRESH_MS = 250;

// Where the fallback file lives when the host has no persistence API. Inject a
// path (`visibilityFile`) in tests so no test touches a real home directory.
export function defaultVisibilityFile(env = process.env) {
  const base =
    typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.trim()
      ? env.XDG_CONFIG_HOME
      : path.join(env.HOME || ".", ".config");
  return path.join(base, "opencode", "control", "visibility.json");
}

function readHidden(value) {
  const list = Array.isArray(value) ? value : Array.isArray(value?.hidden) ? value.hidden : [];
  return new Set(list.filter((id) => typeof id === "string" && id.length > 0));
}

// A failure the user may care about, in a shape a toast or a dialog can render.
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

export function createVisibilityStore(options = {}) {
  const storage = options.storage;
  const kv = options.kv;
  const file = options.file;
  const io = options.io ?? { mkdirSync, readFileSync, renameSync, writeFileSync };
  const now = options.now ?? Date.now;
  const refreshMs = options.refreshMs ?? REFRESH_MS;
  const hasStorage = Boolean(storage) && typeof storage.store === "function";
  const hasKv = !hasStorage && Boolean(kv) && typeof kv.get === "function" && typeof kv.set === "function";
  const hasFile = !hasStorage && !hasKv && typeof file === "string" && Boolean(file);

  const listeners = new Set();
  // Changes this instance made that the durable value does not show yet. The
  // overlay is dropped as soon as a read confirms them.
  const pending = new Map();
  let durable = new Set();
  let durableAt = -Infinity;
  let loaded = false;
  let loadError = null;
  let writeError = null;
  let writes = 0;
  let tmpCounter = 0;
  let settings;
  let update;

  // Read-only load. A missing file is a first run, not an error; an unreadable
  // or corrupt one is reported and degrades to "everything visible" rather than
  // throwing into the host's setup.
  if (hasStorage) {
    try {
      const pair = storage.store(KV_KEY, { initial: { hidden: [] } });
      settings = pair?.[0];
      update = pair?.[1];
      durable = readHidden(settings?.hidden);
      durableAt = now();
      loaded = true;
      if (typeof update !== "function") {
        writeError = {
          code: "persist-unavailable",
          message: "the host store did not provide a way to save settings",
        };
      }
    } catch (error) {
      loadError = describe(error, "store-unavailable");
    }
  } else if (hasKv) {
    try {
      durable = readHidden(kv.get(KV_KEY, []));
      durableAt = now();
      loaded = true;
    } catch (error) {
      loadError = describe(error, "read-failed");
    }
  } else if (hasFile) {
    try {
      durable = readHidden(JSON.parse(io.readFileSync(file, "utf8")));
      loaded = true;
    } catch (error) {
      if (!error || error.code !== "ENOENT") loadError = describe(error, "read-failed");
      else loaded = true;
    }
    durableAt = now();
  } else {
    loaded = true;
  }

  // The durable value as the host currently holds it. `ok` is false when the
  // read failed; the last known value is still returned so the sidebar works.
  function readDurable(force) {
    if (hasStorage) {
      // The reactive settings object *is* the live value: the host updates it
      // for every instance, so no cache is involved.
      durable = readHidden(settings?.hidden);
      durableAt = now();
      return { ok: Boolean(settings) || loaded, hidden: durable };
    }
    if (!hasKv && !hasFile) return { ok: true, hidden: durable };
    if (!force && loaded && now() - durableAt < refreshMs) {
      return { ok: loadError === null, hidden: durable };
    }
    durableAt = now();
    try {
      const raw = hasKv ? kv.get(KV_KEY, []) : JSON.parse(io.readFileSync(file, "utf8"));
      durable = readHidden(raw);
      loaded = true;
      loadError = null;
      return { ok: true, hidden: durable };
    } catch (error) {
      if (hasFile && error && error.code === "ENOENT") {
        // The file is gone: a first run again, not a failure.
        durable = new Set();
        loaded = true;
        loadError = null;
        return { ok: true, hidden: durable };
      }
      loadError = describe(error, "read-failed");
      return { ok: false, hidden: durable };
    }
  }

  // The effective set: the durable value with this instance's unconfirmed
  // changes applied. A pending entry is dropped once a read confirms it.
  function current() {
    const read = readDurable(false);
    if (read.ok) {
      for (const [id, visible] of pending) {
        if (!read.hidden.has(id) === visible) pending.delete(id);
      }
    }
    const hidden = new Set(read.hidden);
    for (const [id, visible] of pending) {
      if (visible) hidden.delete(id);
      else hidden.add(id);
    }
    return hidden;
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

  // `mutate` applies the change to a Set of hidden ids, so a writer always
  // rebuilds the value from the freshest one it can see. For the durable store
  // that means read-modify-write inside the draft update: a change another TUI
  // instance made is preserved instead of being clobbered by a stale copy.
  //
  // `confirm` drops the overlay entries this write covered, once the write is
  // accepted. Until then they keep the sidebar showing what the user clicked.
  function persist(mutate, confirm) {
    if (hasStorage) {
      if (typeof update !== "function") {
        setWriteError({
          code: "persist-unavailable",
          message: "the host store did not provide a way to save settings",
        });
        return false;
      }
      let result;
      try {
        result = update((draft) => {
          const next = readHidden(draft?.hidden);
          mutate(next);
          draft.hidden = [...next].sort();
        });
      } catch (error) {
        setWriteError(describe(error, "save-failed"));
        return false;
      }
      // The host applies the update; ask the durable value again either way.
      durableAt = -Infinity;
      if (result && typeof result.then === "function") {
        // An async update is only a save once it resolves: a rejection is
        // reported and the overlay stays, so the sidebar keeps the user's
        // choice visible instead of silently reverting it.
        result.then(
          () => {
            durableAt = -Infinity;
            confirm();
            clearWriteError();
          },
          (error) => setWriteError(describe(error, "save-failed")),
        );
      } else {
        writes += 1;
        confirm();
        clearWriteError();
      }
      return true;
    }

    const value = { version: FILE_VERSION, hidden: [...current()].sort() };
    if (hasKv) {
      try {
        kv.set(KV_KEY, value);
      } catch (error) {
        setWriteError(describe(error, "save-failed"));
        return false;
      }
      writes += 1;
      durable = new Set(value.hidden);
      durableAt = now();
      confirm();
      clearWriteError();
      return true;
    }
    if (!hasFile) {
      setWriteError({ code: "persist-unavailable", message: "settings cannot be saved here" });
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
    durable = new Set(value.hidden);
    durableAt = now();
    confirm();
    clearWriteError();
    return true;
  }

  function notify(reason) {
    for (const listener of Array.from(listeners)) {
      try {
        listener(reason);
      } catch {
        // a dead subscriber must not break the toggle
      }
    }
  }

  return {
    // True only while every load and write has succeeded: a caller can trust it
    // as "this choice will still be there after a restart".
    get ready() {
      return loadError === null && writeError === null;
    },
    // The failure behind `ready` being false, or null. `code` is one of
    // "store-unavailable", "read-failed", "save-failed", "persist-unavailable".
    error() {
      if (writeError) return writeError;
      if (loadError) return loadError;
      return null;
    },
    isVisible(id) {
      if (typeof id !== "string" || !id) return true;
      return !current().has(id);
    },
    // Only an explicit boolean is accepted, so a stray truthy value can never
    // hide a button by accident.
    setVisible(id, visible) {
      if (typeof id !== "string" || !id || typeof visible !== "boolean") return false;
      if (this.isVisible(id) === visible) return false;
      pending.set(id, visible);
      persist(
        (next) => (visible ? next.delete(id) : next.add(id)),
        () => pending.delete(id),
      );
      notify("change");
      return true;
    },
    // Returns how many buttons came back, so a caller can report it.
    showAll() {
      const before = current();
      if (!before.size) return 0;
      for (const id of before) pending.set(id, true);
      persist(
        (next) => next.clear(),
        () => pending.clear(),
      );
      notify("change");
      return before.size;
    },
    hiddenIds() {
      return [...current()].sort();
    },
    // Writes the host accepted. A rejected write is not counted; `error()`
    // reports it instead.
    writes() {
      return writes;
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
