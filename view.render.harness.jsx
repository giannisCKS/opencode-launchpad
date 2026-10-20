/** @jsxImportSource @opentui/solid */
// Render harness for view.jsx.
//
// It mounts the real Sidebar and SettingsDialog through the @opentui/solid test
// renderer, so every number it prints is a post-layout measurement: box bounds
// from the renderable tree and cell spans read back from the drawn characters.
// It measures only. `view.render.test.mjs` compares the measurements.
//
// The test compiles this file with babel-preset-solid first, because bun's own
// JSX transform builds a static tree that never reacts. Run the compiled copy
// with bun from a directory that can resolve @opentui/solid. It prints one JSON
// document after the marker line.
import { testRender } from "@opentui/solid";
import { GitDialog, LogDialog, SettingsDialog, Sidebar } from "./view.jsx";

const MARKER = "##SIDEBAR-RENDER##";

const theme = {
  text: { base: "#e6e6e6", muted: "#8a8a8a", feedback: { error: { base: "#ff6b6b" } } },
  border: { base: "#5f5f5f" },
};

// A stand-in for tui.js. It records every call the view makes and lets a
// scenario flip the state and notify the view, which is what the runtime does
// after it hides or shows a button.
function createFakeRuntime(initial) {
  const listeners = new Set();
  const calls = [];
  const state = {
    board: initial.board,
    settings: (initial.settings ?? []).map((item) => ({ ...item })),
    error: initial.error ?? null,
    // The ids hidden for the whole install, which the runtime counts.
    hidden: Array.isArray(initial.hidden) ? [...initial.hidden] : null,
    // When set, a write fails and the runtime reports the failure, which is what
    // the real runtime does through subscribeSettings.
    failWrites: initial.failWrites ?? false,
    // The runners behind the settings rows. `null` models a runtime that cannot
    // report them, so the rows simply have no editor.
    editors: Array.isArray(initial.editors) ? initial.editors.map((item) => ({ ...item })) : null,
    configError: initial.configError ?? null,
    // A reason string makes the next save fail, which is how the runtime refuses
    // a name that is already taken or a built-in command.
    rejectSave: initial.rejectSave ?? null,
    // The project the runtime is on now. The editor captures it when it opens
    // and the runtime refuses a write whose capture no longer matches, which is
    // what a session switch during an open editor looks like.
    project: initial.project ?? "/workspace/demo",
    nextCustom: 1,
  };
  const PROJECT_CHANGED = { ok: false, code: "project-changed", reason: "Project changed. Reopen the button editor." };
  const mismatched = (project) => typeof project === "string" && project !== "" && project !== state.project;
  // The built-in controls are fixed: they are not part of the project's saved
  // order, so a move for one is refused and a runner is never swapped past them.
  const CONTROL_IDS = new Set(["commit", "push", "stop-all", "log"]);
  // The commit flow behind GitDialog. It is not the runtime; GitDialog receives
  // it as `flow`. Its calls land in the same log as the runtime's, so one
  // scenario prints one call list.
  const gitListeners = [];
  const notifyGit = () => {
    for (const listener of Array.from(gitListeners)) listener();
  };
  const git = {
    kind: initial.git?.kind ?? "commit",
    step: initial.git?.step ?? "files",
    busy: initial.git?.busy ?? null,
    branch: initial.git?.branch ?? "main",
    directory: initial.git?.directory ?? "/workspace/demo",
    detached: initial.git?.detached ?? false,
    notice: initial.git?.notice ?? null,
    error: initial.git?.error ?? null,
    preview: initial.git?.preview ?? null,
    message: initial.git?.message ?? "",
    draft: initial.git?.draft ?? initial.git?.message ?? "",
    generator: initial.git?.generator ?? null,
    push: initial.git?.push ?? null,
    selection: [...(initial.git?.selection ?? [])],
    files: (initial.git?.files ?? []).map((file) => ({ ...file })),
  };
  return {
    state,
    calls,
    gitFlow: {
      subscribe: (listener) => {
        gitListeners.push(listener);
        return () => {
          const index = gitListeners.indexOf(listener);
          if (index > -1) gitListeners.splice(index, 1);
        };
      },
      state: () => ({
        ...git,
        files: git.files.map((file) => ({ ...file })),
        selection: [...git.selection],
      }),
      toggle(path) {
        calls.push(["toggle", path]);
      },
      ignoreFile(path) {
        calls.push(["ignoreFile", path]);
      },
      cancel: () => calls.push(["cancel"]),
      previewSelection: () => calls.push(["previewSelection"]),
      back: () => calls.push(["back"]),
      approveEgress: () => calls.push(["approveEgress"]),
      editMessage: () => calls.push(["editMessage"]),
      // The message field reports what is typed and the flow holds it: recording
      // the value is what lets a test read the multi-line text back.
      draftChanged(value) {
        git.draft = value;
        calls.push(["draftChanged", value]);
        return true;
      },
      saveMessage(text) {
        const typed = typeof text === "string" ? text : git.draft;
        calls.push(["saveMessage", typed]);
        if (!String(typed).trim()) {
          git.message = "";
          git.step = "preview";
          notifyGit();
          return null;
        }
        git.message = String(typed).trim();
        git.draft = git.message;
        git.step = "confirm";
        notifyGit();
        return git.message;
      },
      cancelMessage() {
        calls.push(["cancelMessage"]);
        git.step = git.message ? "confirm" : "preview";
        return git.message || null;
      },
      confirm: () => calls.push(["confirm"]),
      confirmPush: () => calls.push(["confirmPush"]),
      pushNow: () => calls.push(["pushNow"]),
    },
    notify() {
      for (const listener of Array.from(listeners)) listener();
    },
    manager: { subscribe: () => () => {} },
    rows: () => state.board,
    startAction: (id) => calls.push(["startAction", id]),
    openGit: (kind) => calls.push(["openGit", kind]),
    stopAllRunners: () => calls.push(["stopAllRunners"]),
    showLog: () => calls.push(["showLog"]),
    settingsItems: () => state.settings.map((item) => ({ ...item })),
    settingsError: () => state.error,
    // The runtime counts hidden ids for the whole install. `null` models a
    // runtime that cannot report them, which is what the view falls back from.
    hiddenCount: () => (state.hidden ? state.hidden.length : null),
    setVisible(id, visible) {
      calls.push(["setVisible", id, visible]);
      const item = state.settings.find((each) => each.id === id);
      if (item) item.visible = visible;
      if (state.hidden) {
        state.hidden = state.hidden.filter((each) => each !== id);
        if (!visible) state.hidden.push(id);
      }
      if (state.failWrites) {
        state.error = { code: "save-failed", message: "Could not save the sidebar buttons." };
      }
      this.notify();
    },
    showAllButtons() {
      calls.push(["showAllButtons"]);
      for (const item of state.settings) item.visible = true;
      if (state.hidden) state.hidden = [];
      this.notify();
    },
    buttonEditorItems: () => (state.editors ? state.editors.map((item) => ({ ...item })) : []),
    buttonProject: () => state.project,
    buttonConfigError: () => state.configError,
    saveButton(payload) {
      calls.push(["saveButton", { ...payload }]);
      if (mismatched(payload.project)) {
        // No write: the capture belongs to a project that is no longer open.
        this.notify();
        return { ...PROJECT_CHANGED };
      }
      if (state.rejectSave) {
        state.configError = { code: "save-refused", message: state.rejectSave };
        this.notify();
        return { ok: false, reason: state.rejectSave };
      }
      let id = payload.id ?? null;
      if (!id) {
        id = `custom-${state.nextCustom}`;
        state.nextCustom += 1;
      }
      const existing = state.editors?.find((item) => item.id === id);
      if (existing) {
        existing.label = payload.label;
        existing.command = payload.command;
        existing.args = [...payload.args];
        existing.overridden = true;
      } else if (state.editors) {
        state.editors.push({
          id,
          label: payload.label,
          command: payload.command,
          args: [...payload.args],
          cwd: "",
          custom: true,
          overridden: false,
        });
      }
      state.configError = null;
      this.notify();
      return { ok: true, id };
    },
    resetButton(id, project) {
      calls.push(["resetButton", id, project]);
      if (mismatched(project)) {
        this.notify();
        return { ...PROJECT_CHANGED };
      }
      const found = state.editors?.find((item) => item.id === id);
      if (found) found.overridden = false;
      state.configError = null;
      this.notify();
      return { ok: true };
    },
    deleteButton(id, project) {
      calls.push(["deleteButton", id, project]);
      if (mismatched(project)) {
        this.notify();
        return { ...PROJECT_CHANGED };
      }
      if (state.editors) state.editors = state.editors.filter((item) => item.id !== id);
      state.settings = state.settings.filter((item) => item.id !== id);
      state.configError = null;
      this.notify();
      return { ok: true };
    },
    // One place up or down in this project's runner order, hidden runners
    // included. A move past either end is a silent no-op and a built-in control
    // is refused, exactly like the runtime; a project that changed under the
    // open dialog is refused with the same code and reason. The order reaches
    // both the settings list and the board the sidebar reads, so the grid
    // reflows with the list.
    moveButton(id, direction, projectCapture) {
      calls.push(["moveButton", id, direction, projectCapture]);
      if (mismatched(projectCapture)) {
        this.notify();
        return { ...PROJECT_CHANGED };
      }
      if (direction !== "up" && direction !== "down") {
        this.notify();
        return { ok: false, code: "invalid-direction", reason: "Direction must be up or down." };
      }
      if (CONTROL_IDS.has(id)) {
        this.notify();
        return {
          ok: false,
          code: "control-locked",
          reason: "This button is built in and cannot be reordered.",
        };
      }
      const runners = state.settings.filter((each) => !CONTROL_IDS.has(each.id));
      const index = runners.findIndex((each) => each.id === id);
      if (index < 0) {
        this.notify();
        return { ok: false, code: "unknown-action", reason: "That button is not part of this project." };
      }
      const target = direction === "up" ? index - 1 : index + 1;
      if (target < 0 || target >= runners.length) {
        this.notify();
        return { ok: true, id, moved: false };
      }
      const next = runners.slice();
      [next[index], next[target]] = [next[target], next[index]];
      // The built-in controls stay after the runners, exactly like the runtime.
      const fixed = state.settings.filter((each) => CONTROL_IDS.has(each.id));
      state.settings = [...next, ...fixed];
      // The sidebar reads its order from the board, so it reflows with the list.
      const boardIndex = state.board.items.findIndex((each) => each.action?.id === id);
      const boardTarget = direction === "up" ? boardIndex - 1 : boardIndex + 1;
      if (boardIndex >= 0 && boardTarget >= 0 && boardTarget < state.board.items.length) {
        const items = state.board.items.slice();
        [items[boardIndex], items[boardTarget]] = [items[boardTarget], items[boardIndex]];
        state.board = { ...state.board, items };
      }
      this.notify();
      return { ok: true, id, moved: true, order: next.map((each) => each.id) };
    },
    subscribeSettings(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    openSettings: () => calls.push(["openSettings"]),
    // The view registers one keymap layer and the host re-runs the factory when
    // the dialog changes. The fake records what each run produced, so a test can
    // see the mode-dependent titles and the enabled flags.
    keymap: {
      lastFactory: null,
      samples: [],
      // The factory is only stored here. Calling it from inside layer() would run
      // it in the component's own reactive scope, and the dialog is mounted as a
      // JSX expression, so the component would re-run on every mode change and
      // reset its own signals. sample() is called after a frame instead.
      layer(factory) {
        this.lastFactory = factory;
        return () => {
          this.lastFactory = null;
        };
      },
      sample() {
        if (typeof this.lastFactory !== "function") return null;
        const layer = this.lastFactory();
        const commands = Array.isArray(layer?.commands) ? layer.commands : [];
        const record = {
          mode: layer?.mode,
          binds: commands.map((each) => each.bind),
          titles: commands.map((each) => each.title),
          enabled: commands.map((each) => (typeof each.enabled === "function" ? each.enabled() : each.enabled ?? true)),
        };
        const last = this.samples[this.samples.length - 1];
        if (!last || JSON.stringify(last) !== JSON.stringify(record)) this.samples.push(record);
        return record;
      },
      invoke(index) {
        const layer = this.lastFactory?.();
        const command = layer?.commands?.[index];
        if (typeof command?.run === "function") command.run();
        return this.sample();
      },
    },
  };
}

// The log dialog reads one run through the runtime. This stand-in keeps the
// snapshot behind a getter and changes it only when a scenario says so, which is
// what the real manager does from its own events.
function createFakeLogRuntime(initial = {}) {
  const listeners = new Set();
  const calls = [];
  const clone = (value) =>
    value
      ? { ...value, lines: Array.isArray(value.lines) ? [...value.lines] : [] }
      : undefined;
  let snapshot = clone(initial.snapshot);
  const runtime = {
    calls,
    runKey: initial.runKey ?? "runner-1",
    context: {
      theme,
      ui: { dialog: { clear: () => calls.push(["dialog.clear"]) } },
    },
    manager: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    },
    // The shared result collector reads these once per scenario. This runtime
    // has no sidebar state of its own, so it reports empty collections instead
    // of leaving the collector to guess.
    gitFlow: { state: () => null },
    state: { settings: [], editors: [] },
    keymap: { samples: [], sample() {} },
    snapshot: () => clone(snapshot),
    requestStop: (key) => calls.push(["requestStop", key]),
    send: (key, data) => calls.push(["send", key, data]),
    setSnapshot(next, notify = true) {
      snapshot = clone(next);
      if (notify) {
        for (const listener of Array.from(listeners)) listener();
      }
    },
    logClosed: false,
  };
  return runtime;
}

function item(id, label) {
  return { action: { id, label, title: label }, resolution: null, run() {} };
}

function boardOf(overrides = {}) {
  return {
    projectName: "demo",
    dir: "/workspace/demo",
    items: [],
    canStop: true,
    canLog: true,
    canCommit: true,
    canPush: true,
    controls: {},
    ...overrides,
  };
}

// Every renderable, with the box bounds the layout engine produced and the text
// each node ended up containing. A box carries the text of its whole subtree, so
// a row box and the cell inside it both report the label of that cell.
function measure(nodes, path = "0") {
  const children = nodes.getChildren?.() ?? [];
  return children.flatMap((child, index) => {
    const childPath = `${path}.${index}`;
    const own = typeof child.plainText === "string" ? child.plainText : "";
    const below = measure(child, childPath);
    // A wrapped text node reports its text once per level, so repeats collapse:
    // the bordered cell and the inset box around its label share one label. A
    // label drawn as one node per word reports every word as well, so a fragment
    // that another node in the same subtree spells out in full is dropped.
    const labels = [...new Set([own, ...below.map((each) => each.label)])].filter(Boolean);
    const label = labels
      .filter((each) => !labels.some((other) => other !== each && other.includes(each)))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    return [
      {
        path: childPath,
        ctor: child.constructor.name,
        x: child.x,
        y: child.y,
        w: child.width,
        h: child.height,
        border: typeof child.border === "boolean" ? child.border : undefined,
        label,
      },
      ...below,
    ];
  });
}

// Cell spans read back from the drawn frame: a span starts at a top-left corner
// and ends at the matching top-right corner, so its length is the outer width of
// one bordered cell.
const OPEN = new Set(["┌", "┏"]);
const CLOSE = new Set(["┐", "┓"]);

function frameCells(frame) {
  const rows = [];
  frame.split("\n").forEach((line, y) => {
    const spans = [];
    let start = -1;
    for (let x = 0; x < line.length; x += 1) {
      const char = line[x];
      if (OPEN.has(char)) {
        if (start < 0) start = x;
      } else if (CLOSE.has(char) && start >= 0) {
        spans.push({ x0: start, x1: x, width: x - start + 1 });
        start = -1;
      }
    }
    if (spans.length > 0) rows.push({ y, spans });
  });
  return rows;
}

const scenarios = [];

function scenario(name, options) {
  scenarios.push({ height: 16, ...options, name });
}

function sidebar(name, width, board, options = {}) {
  scenario(name, {
    width,
    runtime: options.runtime ?? createFakeRuntime({ board }),
    build(runtime) {
      return (
        <box flexDirection="column" width="100%" height="100%">
          {Sidebar({ context: { theme }, runtime, sessionID: "session-1" })}
        </box>
      );
    },
    ...options,
  });
}

const nextOnly = { items: [item("next-live", "Next live")] };
const twoActions = {
  items: [item("web-live", "Live web"), item("next-live", "Next live")],
};
const longLabels = {
  items: [
    item("build-mobile", "Build mobile (Expo)"),
    item("adb-install", "ADB install on emulator"),
  ],
};
const fiveActions = {
  items: [
    item("build-mobile", "Build"),
    item("mobile-live", "Live mobile"),
    item("web-live", "Live web"),
    item("next-live", "Next live"),
    item("adb-install", "ADB install"),
  ],
};
// The Rust buttons the runners lane adds. The labels are the strings runners.js
// hands to the grid, so this measures what a Cargo project actually draws.
const cargoActions = {
  items: [
    item("cargo-build", "Cargo build"),
    item("cargo-run", "Cargo run"),
    item("cargo-test", "Cargo test"),
    item("cargo-check", "Cargo check"),
    item("cargo-clippy", "Cargo clippy"),
    item("cargo-fmt", "Cargo fmt"),
  ],
};

for (const width of [80, 60, 40, 30, 24, 20]) {
  sidebar(`grid-singleton-${width}`, width, boardOf(nextOnly));
}
sidebar("grid-pair-80", 80, boardOf(twoActions));
sidebar("grid-five-80", 80, boardOf(fiveActions));
for (const width of [80, 40, 30, 24]) {
  // Six Cargo buttons wrap to two lines each at 24 columns, so this scenario
  // needs more rows than the default box.
  sidebar(`grid-rust-${width}`, width, boardOf(cargoActions), { height: 24 });
}
// Every column count a narrow terminal can produce, so no width goes
// unmeasured between the documented stops.
const sweepWidths = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 34, 36, 38, 40];
for (const width of sweepWidths) {
  sidebar(`grid-rust-sweep-${width}`, width, boardOf(cargoActions), { height: 30 });
  sidebar(`grid-singleton-sweep-${width}`, width, boardOf(nextOnly), { height: 16 });
}
sidebar("grid-long-labels-30", 30, boardOf({ ...longLabels, canStop: false }));
sidebar("grid-long-labels-80", 80, boardOf(longLabels));
// The same long labels with the row to themselves: a wide one still centres,
// a narrow one wraps.
for (const width of [80, 30]) {
  sidebar(
    `grid-long-singleton-${width}`,
    width,
    boardOf({ items: [item("build-mobile", "Build mobile (Expo)")] }),
  );
  sidebar(
    `grid-long-singleton-narrow-${width}`,
    width,
    boardOf({ items: [item("adb-install", "ADB install on emulator")] }),
  );
}
sidebar("grid-no-git-80", 80, boardOf({ ...nextOnly, canCommit: false, canPush: false }));
sidebar("grid-no-git-24", 24, boardOf({ ...nextOnly, canCommit: false, canPush: false }));
sidebar("controls-hide-push-80", 80, boardOf({ ...nextOnly, controls: { push: false } }));
sidebar("controls-hide-commit-40", 40, boardOf({ ...nextOnly, controls: { commit: false } }));
sidebar("controls-hide-stop-all-80", 80, boardOf({ ...nextOnly, controls: { "stop-all": false } }));
sidebar("controls-hide-log-80", 80, boardOf({ ...nextOnly, controls: { log: false } }));
sidebar(
  "controls-hide-both-utilities-80",
  80,
  boardOf({ ...nextOnly, controls: { "stop-all": false, log: false } }),
);
sidebar(
  "controls-hide-git-row-80",
  80,
  boardOf({ ...nextOnly, controls: { commit: false, push: false } }),
);
sidebar(
  "controls-hide-everything-60",
  60,
  boardOf({
    items: [],
    canStop: true,
    canLog: true,
    canCommit: true,
    canPush: true,
    controls: { commit: false, push: false, "stop-all": false, log: false },
  }),
);
sidebar(
  "controls-hide-all-with-actions-60",
  60,
  boardOf({ ...fiveActions, controls: { commit: false, push: false, "stop-all": false, log: false } }),
);
sidebar("outside-repo-80", 80, boardOf({ ...nextOnly, canCommit: false, canPush: false }));

// Attribution scenarios. The utility row loses the right wall of its second cell
// at 24 columns. These rows are the same two bordered cells built by hand, with
// no Sidebar, no runtime state and no Show, so the measurements show whether the
// quirk belongs to view.jsx or to the renderer's text wrapping. The legacy shape
// keeps the text straight inside the bordered box, the current shape wraps it in
// an inset box, so the two can be compared side by side.
function plainCell(props) {
  const body = () => <text wrapMode="word">{props.label}</text>;
  return (
    <box
      flexGrow={1}
      flexBasis={0}
      flexShrink={1}
      minWidth={0}
      flexDirection="column"
      justifyContent="center"
      border
      borderStyle="single"
      paddingLeft={1}
      paddingRight={0}
    >
      {props.legacy ? (
        body()
      ) : (
        <box minWidth={0} paddingRight={1}>
          {body()}
        </box>
      )}
    </box>
  );
}

for (const width of [23, 24, 25]) {
  scenario(`plain-utility-row-${width}`, {
    width,
    runtime: createFakeRuntime({ board: boardOf(nextOnly) }),
    build() {
      return (
        <box flexDirection="column" width="100%" height="100%">
          <box flexDirection="row" flexShrink={0} gap={1}>
            {plainCell({ label: "Stop all" })}
            {plainCell({ label: "Show logs" })}
          </box>
        </box>
      );
    },
  });
}

// The geometry before the fix: padding on the bordered box. The label is drawn
// one column too far right, so an exact fit lands on the right wall.
for (const width of [23, 24, 25]) {
  scenario(`plain-utility-row-legacy-${width}`, {
    width,
    runtime: createFakeRuntime({ board: boardOf(nextOnly) }),
    build() {
      return (
        <box flexDirection="column" width="100%" height="100%">
          <box flexDirection="row" flexShrink={0} gap={1}>
            {plainCell({ label: "Stop all", legacy: true })}
            {plainCell({ label: "Show logs", legacy: true })}
          </box>
        </box>
      );
    },
  });
}

// Collapsing is view state only: the rows go away and the header stays.
scenario("collapse-80", {
  width: 80,
  runtime: createFakeRuntime({ board: boardOf(nextOnly) }),
  build(runtime) {
    return (
      <box flexDirection="column" width="100%" height="100%">
        {Sidebar({ context: { theme }, runtime, sessionID: "session-1" })}
      </box>
    );
  },
  async after(setup, runtime, capture) {
    capture("frame");
    await setup.mockMouse.click(1, 0);
    await setup.renderOnce();
    capture("collapsed");
  },
});

// The runtime hides a button after the dialog asks for it. The view must follow
// the runtime instead of caching the first board it saw.
scenario("controls-live-toggle-40", {
  width: 40,
  runtime: createFakeRuntime({ board: boardOf({ ...nextOnly, controls: { push: false } }) }),
  build(runtime) {
    return (
      <box flexDirection="column" width="100%" height="100%">
        {Sidebar({ context: { theme }, runtime, sessionID: "session-1" })}
      </box>
    );
  },
  async after(setup, runtime, capture) {
    capture("before");
    runtime.state.board = boardOf({ ...nextOnly, controls: {} });
    runtime.notify();
    await setup.renderOnce();
    capture("after");
  },
});

const settingsList = [
  { id: "build-mobile", label: "Build", visible: true },
  { id: "web-live", label: "Live web", visible: false },
  { id: "commit", label: "Commit", visible: true },
  { id: "stop-all", label: "Stop all", visible: false },
];

scenario("settings-dialog-70", {
  width: 70,
  // 17 rows is the height the dialog needs once the failure line is present.
  height: 17,
  runtime: createFakeRuntime({ board: boardOf(nextOnly), settings: settingsList }),
  build(runtime) {
    return (
      <box flexDirection="column" width="100%" height="100%">
        {SettingsDialog({ context: { theme, ui: { dialog: { clear() {} } } }, runtime })}
      </box>
    );
  },
});

scenario("settings-dialog-empty-70", {
  width: 70,
  // 17 rows is the height the dialog needs once the failure line is present.
  height: 17,
  runtime: createFakeRuntime({ board: boardOf(nextOnly), settings: [] }),
  build(runtime) {
    return (
      <box flexDirection="column" width="100%" height="100%">
        {SettingsDialog({ context: { theme, ui: { dialog: { clear() {} } } }, runtime })}
      </box>
    );
  },
  // Nothing is hidden and this runtime cannot report ids from other projects, so
  // the restore button is off and the click must not reach the handler.
  async after(setup, runtime, capture) {
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Show all buttons"));
    if (row >= 0) {
      await setup.mockMouse.click(lines[row].indexOf("Show all buttons") + 2, row);
    }
    await setup.renderOnce();
    capture("after-click");
  },
});

// The store keeps hidden ids for the whole install, so a project whose own
// buttons are all visible still has buttons hidden elsewhere. The footer must
// count those and keep the restore button live.
scenario("settings-dialog-other-project-70", {
  width: 70,
  // 17 rows is the height the dialog needs once the failure line is present.
  height: 17,
  runtime: createFakeRuntime({
    board: boardOf(nextOnly),
    settings: [
      { id: "build-mobile", label: "Build", visible: true },
      { id: "web-live", label: "Live web", visible: true },
      { id: "commit", label: "Commit", visible: true },
      { id: "stop-all", label: "Stop all", visible: true },
    ],
    hidden: ["cargo-run", "cargo-test", "adb-install"],
  }),
  build(runtime) {
    return (
      <box flexDirection="column" width="100%" height="100%">
        {SettingsDialog({ context: { theme, ui: { dialog: { clear() {} } } }, runtime })}
      </box>
    );
  },
  async after(setup, runtime, capture) {
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Show all buttons"));
    if (row >= 0) {
      await setup.mockMouse.click(lines[row].indexOf("Show all buttons") + 2, row);
    }
    await setup.renderOnce();
    capture("after-show-all");
  },
});

// Both at once: one button hidden in this project, one hidden elsewhere.
scenario("settings-dialog-mixed-70", {
  width: 70,
  // 17 rows is the height the dialog needs once the failure line is present.
  height: 17,
  runtime: createFakeRuntime({
    board: boardOf(nextOnly),
    settings: settingsList,
    hidden: ["web-live", "stop-all", "cargo-fmt"],
  }),
  build(runtime) {
    return (
      <box flexDirection="column" width="100%" height="100%">
        {SettingsDialog({ context: { theme, ui: { dialog: { clear() {} } } }, runtime })}
      </box>
    );
  },
});

scenario("settings-dialog-click-70", {
  width: 70,
  // 17 rows is the height the dialog needs once the failure line is present.
  height: 17,
  runtime: createFakeRuntime({ board: boardOf(nextOnly), settings: settingsList }),
  build(runtime) {
    return (
      <box flexDirection="column" width="100%" height="100%">
        {SettingsDialog({ context: { theme, ui: { dialog: { clear() {} } } }, runtime })}
      </box>
    );
  },
  async after(setup, runtime, capture) {
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Live web"));
    // The move arrows lead the row now, so aim at the toggle itself.
    const column = row >= 0 ? lines[row].indexOf("Live web") : -1;
    if (row >= 0 && column >= 0) await setup.mockMouse.click(column + 2, row);
    await setup.renderOnce();
    capture("after-toggle");
    const showAll = setup.captureCharFrame().split("\n").findIndex((line) => line.includes("Show all buttons"));
    if (showAll >= 0) {
      const column = setup.captureCharFrame().split("\n")[showAll].indexOf("Show all buttons");
      await setup.mockMouse.click(column + 2, showAll);
    }
    await setup.renderOnce();
    capture("after-show-all");
  },
});

// A settings failure must be visible in the dialog, and a failure that arrives
// while the dialog is open must appear without reopening it.
scenario("settings-dialog-error-70", {
  width: 70,
  // 17 rows is the height the dialog needs once the failure line is present.
  height: 17,
  runtime: createFakeRuntime({
    board: boardOf(nextOnly),
    settings: settingsList,
    error: { code: "read-failed", message: "Could not read the saved sidebar buttons." },
  }),
  build(runtime) {
    return (
      <box flexDirection="column" width="100%" height="100%">
        {SettingsDialog({ context: { theme, ui: { dialog: { clear() {} } } }, runtime })}
      </box>
    );
  },
});

scenario("settings-dialog-error-after-click-70", {
  width: 70,
  // 17 rows is the height the dialog needs once the failure line is present.
  height: 17,
  runtime: createFakeRuntime({
    board: boardOf(nextOnly),
    settings: settingsList,
    failWrites: true,
  }),
  build(runtime) {
    return (
      <box flexDirection="column" width="100%" height="100%">
        {SettingsDialog({ context: { theme, ui: { dialog: { clear() {} } } }, runtime })}
      </box>
    );
  },
  async after(setup, runtime, capture) {
    capture("before");
    const lines = setup.captureCharFrame().split("\n");
    const row = lines.findIndex((line) => line.includes("Live web"));
    // The move arrows lead the row now, so aim at the toggle itself.
    const column = row >= 0 ? lines[row].indexOf("Live web") : -1;
    if (row >= 0 && column >= 0) await setup.mockMouse.click(column + 2, row);
    await setup.renderOnce();
    capture("after");
  },
});

// The runners behind the settings rows: what the runtime reports as editable.
// Built-in controls are absent here, which is what keeps them out of the editor.
const editorItems = [
  {
    id: "next-live",
    label: "Next live",
    command: "bun",
    args: ["run", "dev"],
    cwd: "/workspace/demo",
    custom: false,
    overridden: true,
  },
  {
    id: "web-live",
    label: "Live web",
    command: "bun",
    args: ["run", "web"],
    cwd: "/workspace/demo",
    custom: false,
    overridden: false,
  },
  {
    id: "custom-audit",
    label: "Audit deps",
    command: "bun",
    args: ["audit"],
    cwd: "/workspace/demo",
    custom: true,
    overridden: false,
  },
];

// "build-mobile" is a project command the runtime does not offer for editing, so
// its row must have no Edit affordance even though it is not a built-in.
const editableSettings = [
  { id: "build-mobile", label: "Build", visible: true },
  { id: "next-live", label: "Next live", visible: true },
  { id: "web-live", label: "Live web", visible: true },
  { id: "custom-audit", label: "Audit deps", visible: true },
  { id: "commit", label: "Commit", visible: true },
  { id: "stop-all", label: "Stop all", visible: true },
];

// Clicks `text` on the row that contains `anchor`. A title can repeat a button
// label ("Delete button"), so the anchor keeps the click on the right row. The
// column comes from the measured box: the drawn frame can shift a label by the
// scrollbar column, and the renderer reads a click at column x as column x-1,
// so the click lands one column inside the target. A click that finds no target
// is recorded, so a test can fail on it instead of reading a stale frame.
const misses = [];

async function clickOn(setup, anchor, text) {
  const nodes = measure(setup.renderer.root);
  const anchorNode = nodes.find((each) => each.y >= 0 && each.label === anchor);
  if (!anchorNode) {
    misses.push({ anchor, text, reason: "no anchor row" });
    return -1;
  }
  const target = nodes.find((each) => each.y === anchorNode.y && each.label === text);
  if (!target) {
    misses.push({ anchor, text, y: anchorNode.y, reason: "no target box" });
    return -2;
  }
  // Click the middle of the target, not its first column: the mock mouse and the
  // renderer disagree about a one column offset in some runs, and the middle of a
  // box is inside it under either mapping.
  await setup.mockMouse.click(target.x + Math.max(1, Math.floor(target.w / 2)), target.y);
  await setup.renderOnce();
  return target.y;
}

// Types into the focused field, the way a person would.
async function type(setup, text) {
  await setup.mockInput.typeText(text);
  await setup.renderOnce();
}

async function pressEnter(setup) {
  await setup.mockInput.pressEnter();
  await setup.renderOnce();
}

// The settings dialog on its own, with the fake keymap so a test can see which
// commands the view registered and whether they are enabled in this mode.
function dialogScenario(name, options) {
  scenario(name, {
    width: options.width ?? 70,
    height: options.height ?? 17,
    runtime: createFakeRuntime(options.runtime),
    build(runtime) {
      return (
        <box flexDirection="column" width="100%" height="100%">
          {SettingsDialog({
            context: { theme, ui: { dialog: { clear: () => runtime.calls.push(["dialog.clear"]) } }, keymap: runtime.keymap },
            runtime,
          })}
        </box>
      );
    },
    after: options.after,
  });
}

dialogScenario("settings-editable-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
});

dialogScenario("settings-edit-open-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
  async after(setup, runtime, capture) {
    await clickOn(setup, "Next live", "Edit");
    capture("editor");
  },
});

// Saving an existing runner: the name is typed into the focused field, then
// Enter walks the remaining fields and saves on the last one.
dialogScenario("settings-edit-save-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
  async after(setup, runtime, capture) {
    await clickOn(setup, "Live web", "Edit");
    await type(setup, "-x");
    await pressEnter(setup);
    await pressEnter(setup);
    await pressEnter(setup);
    capture("after-save");
  },
});

// A save the runtime accepts can still fail later, durably. The runtime reports
// that through buttonConfigError and the settings subscription, so the open
// dialog has to pick it up without being reopened.
dialogScenario("settings-config-error-late-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
  async after(setup, runtime, capture) {
    await clickOn(setup, "Live web", "Edit");
    await type(setup, "-x");
    await pressEnter(setup);
    await pressEnter(setup);
    await pressEnter(setup);
    capture("after-save");
    runtime.state.configError = { code: "save-failed", message: "Could not save the button." };
    runtime.notify();
    await setup.renderOnce();
    capture("after-late");
  },
});

// A new button: no id in the payload, so the runtime knows to add one.
dialogScenario("settings-edit-new-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
  async after(setup, runtime, capture) {
    await clickOn(setup, "New button", "New button");
    capture("editor");
    await type(setup, "Audit");
    await pressEnter(setup);
    await type(setup, "bun");
    await pressEnter(setup);
    await type(setup, '["audit", "--json"]');
    await pressEnter(setup);
    capture("after-save");
  },
});

// The arguments field is a JSON list: a value that is not one is refused in the
// dialog, before the runtime sees it.
dialogScenario("settings-edit-bad-json-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
  async after(setup, runtime, capture) {
    await clickOn(setup, "Next live", "Edit");
    await pressEnter(setup);
    await pressEnter(setup);
    for (let index = 0; index < 14; index += 1) {
      await setup.mockInput.pressBackspace();
    }
    await setup.renderOnce();
    await type(setup, '{"a":1}');
    await pressEnter(setup);
    capture("after-enter");
  },
});

// The runtime refuses a save and says why. The dialog must stay open and show it.
dialogScenario("settings-edit-reject-70", {
  runtime: {
    board: boardOf(nextOnly),
    settings: editableSettings,
    editors: editorItems,
    rejectSave: "A button with that name already exists.",
  },
  async after(setup, runtime, capture) {
    await clickOn(setup, "Live web", "Edit");
    await pressEnter(setup);
    await pressEnter(setup);
    await pressEnter(setup);
    capture("after-save");
  },
});

dialogScenario("settings-edit-reset-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
  async after(setup, runtime, capture) {
    await clickOn(setup, "Next live", "Edit");
    await clickOn(setup, "Reset defaults", "Reset defaults");
    capture("after-reset");
  },
});

// Deleting a custom button asks first, and the confirmation can be backed out.
dialogScenario("settings-edit-delete-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
  async after(setup, runtime, capture) {
    await clickOn(setup, "Audit deps", "Edit");
    await clickOn(setup, "Delete", "Delete");
    capture("confirm");
    await clickOn(setup, "Keep", "Delete button");
    capture("after-delete");
  },
});

dialogScenario("settings-edit-keep-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
  async after(setup, runtime, capture) {
    await clickOn(setup, "Audit deps", "Edit");
    await clickOn(setup, "Delete", "Delete");
    await clickOn(setup, "Keep", "Keep");
    capture("after-keep");
  },
});

// The session can switch projects while the editor is open. The capture made
// when it opened then no longer matches, the runtime refuses, and the dialog
// shows why instead of writing into the project that is open now.
dialogScenario("settings-project-changed-save-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
  async after(setup, runtime, capture) {
    await clickOn(setup, "Live web", "Edit");
    capture("editor");
    runtime.state.project = "/home/nitro/code/other";
    await pressEnter(setup);
    await pressEnter(setup);
    await pressEnter(setup);
    capture("after-save");
  },
});

dialogScenario("settings-project-changed-reset-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
  async after(setup, runtime, capture) {
    await clickOn(setup, "Next live", "Edit");
    runtime.state.project = "/home/nitro/code/other";
    await clickOn(setup, "Reset defaults", "Reset defaults");
    capture("after-reset");
  },
});

dialogScenario("settings-project-changed-delete-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
  async after(setup, runtime, capture) {
    await clickOn(setup, "Audit deps", "Edit");
    await clickOn(setup, "Delete", "Delete");
    runtime.state.project = "/home/nitro/code/other";
    await clickOn(setup, "Keep", "Delete button");
    capture("after-delete");
  },
});

// The list can be loaded in one project and the session can switch before the
// editor is opened at all. The dialog captured the project when it opened, so
// the draft still carries the project the row came from and the runtime refuses
// it, instead of writing the old project's command into the new project.
dialogScenario("settings-project-changed-before-edit-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
  async after(setup, runtime, capture) {
    runtime.state.project = "/home/nitro/code/other";
    await clickOn(setup, "Live web", "Edit");
    capture("editor");
    await pressEnter(setup);
    await pressEnter(setup);
    await pressEnter(setup);
    capture("after-save");
  },
});

dialogScenario("settings-project-changed-before-new-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
  async after(setup, runtime, capture) {
    runtime.state.project = "/home/nitro/code/other";
    await clickOn(setup, "New button", "New button");
    await type(setup, "Audit");
    await pressEnter(setup);
    await type(setup, "bun");
    await pressEnter(setup);
    await pressEnter(setup);
    capture("after-save");
  },
});

// A new button belongs to the project that is open when it is created, so the
// read-only directory line names it instead of staying generic.
dialogScenario("settings-new-cwd-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
  async after(setup, runtime, capture) {
    await clickOn(setup, "New button", "New button");
    capture("editor");
  },
});

// Escape is the way back: out of the confirmation, out of the editor, then out
// of the dialog. The keymap commands are the same ones the host dispatches.
dialogScenario("settings-edit-escape-70", {
  runtime: { board: boardOf(nextOnly), settings: editableSettings, editors: editorItems },
  async after(setup, runtime, capture) {
    await clickOn(setup, "Audit deps", "Edit");
    runtime.keymap.invoke(0);
    await setup.renderOnce();
    capture("back-to-list");
    runtime.keymap.invoke(0);
    await setup.renderOnce();
    capture("closed");
  },
});

// A project with many scripts: the list scrolls, so the footer stays in reach.
const manyScripts = Array.from({ length: 20 }, (_, index) => ({
  id: `script-${index + 1}`,
  label: `Script ${index + 1}`,
  visible: true,
}));

dialogScenario("settings-many-scripts-70", {
  height: 17,
  runtime: { board: boardOf(nextOnly), settings: [...manyScripts, { id: "commit", label: "Commit", visible: true }] },
});

// A short dialog: the list gives up its rows instead of drawing over the lines
// above it, which is what the earlier fixed-height layout did.
// The popup is sized for a seventeen row dialog, which is what the runtime asks
// the host for. A twelve row window cannot fit twenty scripts plus the footer,
// so no scenario pins that case.

dialogScenario("settings-config-error-70", {
  runtime: {
    board: boardOf(nextOnly),
    settings: editableSettings,
    editors: editorItems,
    configError: { code: "read-failed", message: "Could not read the saved buttons." },
  },
});

// Reordering. Every runner row carries an up arrow and a down arrow, left of the
// name; the built-in controls are fixed, so their rows carry neither. One runner
// is hidden, to show a hidden button is still listed and still movable.
const moveSettings = [
  { id: "build-mobile", label: "Build", visible: true },
  { id: "web-live", label: "Live web", visible: false },
  { id: "next-live", label: "Next live", visible: true },
  { id: "commit", label: "Commit", visible: true },
  { id: "stop-all", label: "Stop all", visible: false },
];

dialogScenario("settings-move-controls-70", {
  runtime: { board: boardOf(nextOnly), settings: moveSettings },
});

// A move swaps the runner with its neighbour and tells the runtime which button
// and which way. The toggle never fires: the click only reaches the move.
dialogScenario("settings-move-up-70", {
  runtime: { board: boardOf(nextOnly), settings: moveSettings },
  async after(setup, runtime, capture) {
    capture("before");
    await clickOn(setup, "Next live", "↑");
    capture("after-move");
  },
});

dialogScenario("settings-move-down-70", {
  runtime: { board: boardOf(nextOnly), settings: moveSettings },
  async after(setup, runtime, capture) {
    capture("before");
    await clickOn(setup, "Build", "↓");
    capture("after-move");
  },
});

// The ends of the runner list: the first cannot go up and the last cannot go
// down. The arrows stay drawn but disabled, so a click on either lands on
// nothing and the order never changes.
dialogScenario("settings-move-boundary-70", {
  runtime: { board: boardOf(nextOnly), settings: moveSettings },
  async after(setup, runtime, capture) {
    capture("before");
    await clickOn(setup, "Build", "↑");
    await clickOn(setup, "Next live", "↓");
    capture("after-move");
  },
});

// A hidden runner is still in the list and still movable, and it keeps its
// hidden marker after it moves.
dialogScenario("settings-move-hidden-70", {
  runtime: { board: boardOf(nextOnly), settings: moveSettings },
  async after(setup, runtime, capture) {
    capture("before");
    await clickOn(setup, "Live web", "↑");
    capture("after-move");
  },
});

// The session can switch projects while the list is open. The move carries the
// project the dialog captured, so the runtime refuses it and the dialog shows
// why instead of reordering the project that is open now.
dialogScenario("settings-move-stale-70", {
  runtime: { board: boardOf(nextOnly), settings: moveSettings },
  async after(setup, runtime, capture) {
    capture("before");
    runtime.state.project = "/home/nitro/code/other";
    await clickOn(setup, "Next live", "↑");
    capture("after-move");
  },
});

// The move list and the sidebar read one order, so a move reorders the grid too.
const pairSettings = [
  { id: "build-mobile", label: "Build", visible: true },
  { id: "web-live", label: "Live web", visible: true },
  { id: "commit", label: "Commit", visible: true },
];

scenario("settings-move-sidebar-order-70", {
  width: 70,
  height: 26,
  runtime: createFakeRuntime({
    board: boardOf({ items: [item("build-mobile", "Build"), item("web-live", "Live web")] }),
    settings: pairSettings,
  }),
  build(runtime) {
    return (
      <box flexDirection="column" width="100%" height="100%">
        {Sidebar({ context: { theme }, runtime, sessionID: "session-1" })}
        {SettingsDialog({ context: { theme, ui: { dialog: { clear() {} } } }, runtime })}
      </box>
    );
  },
  async after(setup, runtime, capture) {
    capture("before");
    await clickOn(setup, "[x] Live web", "↑");
    capture("after-move");
  },
});

// The commit dialog with a fake flow, so a test can read exactly which calls a
// click makes. The flow lives on the runtime so its calls share the runtime's
// one log, which is what the harness prints.
function gitScenario(name, options) {
  scenario(name, {
    width: options.width ?? 70,
    height: options.height ?? 20,
    runtime: createFakeRuntime({ board: boardOf(nextOnly), git: options.git }),
    build(runtime) {
      return (
        <box flexDirection="column" width="100%" height="100%">
          {GitDialog({
            context: { theme, ui: { dialog: { clear: () => runtime.calls.push(["dialog.clear"]) } } },
            flow: runtime.gitFlow,
          })}
        </box>
      );
    },
    after: options.after,
  });
}

// One untracked file the ⊘ can act on, one tracked file it cannot, and one the
// service already refused. The selection is empty, so Continue stays off.
const gitFileList = [
  { path: "src/new-notes.md", status: "untracked", blocked: null, session: true, unattributed: false, index: " ", worktree: "?" },
  { path: "src/app.js", status: "modified", blocked: null, session: true, unattributed: false, index: " ", worktree: "M" },
  { path: "src/locked.bin", status: "conflicted", blocked: "conflicted", session: false, unattributed: true, index: "U", worktree: "U" },
];

gitScenario("git-files-70", { git: { files: gitFileList, selection: [] } });

gitScenario("git-files-ignore-70", {
  git: { files: gitFileList, selection: [] },
  async after(setup, runtime, capture) {
    await clickOn(setup, "src/new-notes.md", "⊘");
    capture("after-ignore");
  },
});

gitScenario("git-files-tracked-70", {
  git: { files: gitFileList, selection: [] },
  async after(setup, runtime, capture) {
    await clickOn(setup, "src/app.js", "⊘");
    capture("after-tracked");
  },
});

gitScenario("git-files-blocked-70", {
  git: { files: gitFileList, selection: [] },
  async after(setup, runtime, capture) {
    await clickOn(setup, "src/locked.bin", "⊘");
    capture("after-blocked");
  },
});

gitScenario("git-files-busy-70", {
  git: { files: gitFileList, selection: ["src/app.js"], busy: "Committing" },
  async after(setup, runtime, capture) {
    await clickOn(setup, "src/new-notes.md", "⊘");
    capture("after-busy");
  },
});

// A long untracked path: the ⊘ stays left of the name and the status stays on
// the right, so the row reads the same at any name length.
gitScenario("git-files-longpath-70", {
  git: {
    files: [
      { path: "src/features/checkout/components/payment-methods/very-long-file-name-for-testing.tsx", status: "untracked", blocked: null, session: true, unattributed: false },
      { path: "src/app.js", status: "modified", blocked: null, session: true, unattributed: false },
    ],
    selection: [],
  },
});

// A diff line past 200 columns must not be cut at display time: the preview
// shows the exact frozen diff, so the tail of the line has to be reachable. The
// narrow viewport wraps the long line and the lines before it push the tail
// below the fold, so only scrolling can reveal the marker.
const LONG_LINE_TAIL = "END-OF-LONG-DIFF-LINE-9f3c";
const longDiffLine = `+${"a".repeat(220)}${LONG_LINE_TAIL}`;
gitScenario("git-preview-longline-36", {
  width: 36,
  height: 20,
  git: {
    step: "preview",
    selection: ["src/app.js"],
    preview: {
      stat: "1 file changed",
      diff: [
        ...Array.from({ length: 24 }, (_, index) => ` context line ${index + 1}`),
        longDiffLine,
        "+short line after",
      ].join("\n"),
    },
  },
  async after(setup, runtime, capture) {
    // The diff scrollbox is the only scrollable box on this screen. Scroll
    // inside its bounds, not over the buttons below it.
    const box = measure(setup.renderer.root).find((node) => node.ctor.includes("ScrollBox"));
    if (!box) throw new Error("the preview screen has no diff scrollbox");
    capture("before-scroll");
    for (let index = 0; index < 80; index += 1) {
      await setup.mockMouse.scroll(box.x + 2, box.y + 1, "down");
    }
    await setup.renderOnce();
    capture("after-scroll");
  },
});

gitScenario("git-preview-native-70", {
  width: 76,
  height: 20,
  git: {
    step: "preview",
    generator: {
      source: "openai",
      providerID: "openai",
      id: "gpt-6-luna",
      providerName: "OpenAI",
      modelName: "Luna",
      verified: true,
    },
    selection: ["src/app.js"],
    preview: { stat: "1 file changed", diff: "+one line\n+another line\n" },
  },
});

// A host with no provider or model list keeps the fixed OpenCodex default. The
// review must call it the assumed default, never a verified route.
gitScenario("git-preview-legacy-70", {
  width: 76,
  height: 22,
  git: {
    step: "preview",
    generator: {
      source: "opencodex",
      providerID: "opencodex",
      id: "gpt-6-luna",
      variant: "low",
      providerName: "OpenCodex",
      modelName: "Luna",
      verified: false,
    },
    selection: ["src/app.js"],
    preview: { stat: "1 file changed", diff: "+one line\n+another line\n" },
  },
});

// A proxy provider with a long name, at a width where the disclosure paragraph
// and the file list both wrap. The disclosure, the file list, the stat and the
// diff share the review scroll box; the actions must stay in the viewport at
// both ends of that scroll.
gitScenario("git-preview-narrow-32", {
  width: 32,
  height: 26,
  git: {
    step: "preview",
    generator: {
      source: "proxy",
      providerID: "opencode-proxy",
      id: "luna-large-preview",
      providerName: "OpenCode Proxy",
      modelName: "Luna",
      variant: "high",
    },
    selection: ["src/app.js", "src/features/checkout/use-checkout.ts"],
    preview: { stat: "2 files changed", diff: "+one line\n+another line\n" },
  },
  async after(setup, runtime, capture) {
    const box = measure(setup.renderer.root).find((node) => node.ctor.includes("ScrollBox"));
    if (!box) throw new Error("the preview has no review scroll box");
    for (let index = 0; index < 80; index += 1) {
      await setup.mockMouse.scroll(box.x + 2, box.y + 1, "down");
    }
    await setup.renderOnce();
    capture("after-scroll");
  },
});

// The final confirmation after the editor. The message can be much taller than
// the terminal, so it lives in the review scroll box: the subject is on screen
// at the start, the tail is reachable by scrolling, and Commit never leaves the
// bottom of the dialog.
const confirmMessageBody = Array.from(
  { length: 24 },
  (_, index) =>
    `CONFIRM-BODY-ROW-${index + 1}: the final review can scroll every row of a long generated message.`,
).join("\n");
const confirmMessage = `confirm the whole message is readable\n\n${confirmMessageBody}\nCONFIRM-BODY-TAIL-5e8b`;

gitScenario("git-confirm-longmessage-70", {
  height: 22,
  git: {
    step: "confirm",
    selection: ["src/app.js"],
    message: confirmMessage,
    preview: { stat: "1 file changed", diff: "+one line\n+another line\n" },
  },
  async after(setup, runtime, capture) {
    capture("before-scroll");
    const box = measure(setup.renderer.root).find((node) => node.ctor.includes("ScrollBox"));
    if (!box) throw new Error("the confirmation has no review scroll box");
    for (let index = 0; index < 80; index += 1) {
      await setup.mockMouse.scroll(box.x + 2, box.y + 1, "down");
    }
    await setup.renderOnce();
    capture("after-scroll");
  },
});

// The message editor. A generated subject, a blank line and a body have to live
// in one field: the host prompt drew a single line, so this screen is where the
// whole message, its wrap, and its scroll have to work.
const longMessageBody =
  "Body explains why the spacing mattered and what the review looked like before it changed at all.";

gitScenario("git-edit-multiline-70", {
  height: 22,
  git: {
    step: "edit",
    selection: ["src/app.js"],
    message: `add the header spacing\n\n${longMessageBody}`,
    preview: { stat: "1 file changed", diff: "+one line\n+another line\n" },
  },
});

// Typing in the field: a plain Return is a newline, never a save, and the
// message is handed to the flow only when an explicit save key asks for it.
gitScenario("git-edit-typing-70", {
  height: 22,
  git: {
    step: "edit",
    selection: ["src/app.js"],
    message: "add the header spacing",
    preview: { stat: "1 file changed", diff: "+one line\n" },
  },
  async after(setup, runtime, capture) {
    await setup.mockInput.pressKey("\u001B[F");
    await setup.renderOnce();
    await type(setup, " and a body");
    await pressEnter(setup);
    await type(setup, "second line of the body");
    capture("after-typing");
    // The host binds meta+return (Alt+Enter) to submit; a bare Return stays a
    // newline, so the message cannot be saved just by pressing Return.
    await setup.mockInput.pressEnter({ meta: true });
    await setup.renderOnce();
    capture("after-save");
  },
});

// The explicit controls. Both are on screen next to the field, and neither one
// commits anything by itself.
gitScenario("git-edit-save-button-70", {
  height: 22,
  git: {
    step: "edit",
    selection: ["src/app.js"],
    message: "add the header spacing\n\nBody explains why.",
    preview: { stat: "1 file changed", diff: "+one line\n" },
  },
  async after(setup, runtime, capture) {
    await clickOn(setup, "Save message", "Save message");
    capture("after-save");
  },
});

gitScenario("git-edit-cancel-70", {
  height: 22,
  git: {
    step: "edit",
    selection: ["src/app.js"],
    message: "add the header spacing\n\nBody explains why.",
    preview: { stat: "1 file changed", diff: "+one line\n" },
  },
  async after(setup, runtime, capture) {
    await type(setup, " thrown away");
    capture("after-typing");
    await clickOn(setup, "Cancel", "Cancel");
    capture("after-cancel");
  },
});

// A message longer than the field can show: the field takes the body height,
// scrolls with the caret, and still hands the whole text back on save.
const overflowMessageBody = [
  "OVERFLOW-BODY-START: the review read every wrapped row and flagged only the spacing before the first paragraph.",
  "The body then keeps going for many more rows so that the field cannot show it all at once and the caret has to scroll.",
  "Nothing here is special, which is the point: a long commit body is normal, and it must never be cut short or replaced by a marker.",
  "The field now owns the body instead of a fixed six rows. It grows with the dialog, not with the message, so the footer cannot be pushed off screen.",
  "The frozen diff belongs to the review that comes before and after this editor. Repeating it here stole the rows the message needed.",
  "Home returns to the top and End reaches the tail. The rows between them stay reachable, and the text is never replaced by an ellipsis.",
  "The last rows before the tail name the end marker, so a scrolled field can be told apart from a truncated one.",
  "OVERFLOW-BODY-END-7c1a",
].join("\n");

gitScenario("git-edit-overflow-70", {
  height: 22,
  git: {
    step: "edit",
    selection: ["src/app.js"],
    message: `add the header spacing\n\n${overflowMessageBody}`,
    preview: { stat: "1 file changed", diff: "+one line\n" },
  },
  async after(setup, runtime, capture) {
    // The field opens at the top so the subject is the first thing reviewed.
    // End moves the caret and the viewport to the tail, where typing continues.
    await setup.mockInput.pressKey("\u001B[F");
    await setup.renderOnce();
    capture("after-end");
    await type(setup, "\nOVERFLOW-TYPED-TAIL-4b2d");
    await setup.renderOnce();
    capture("after-typing");
    await setup.mockInput.pressEnter({ meta: true });
    await setup.renderOnce();
    capture("after-save");
  },
});

// The message from the reported screenshots: a full subject and three
// paragraphs, well over 1000 characters. It is the fixture for the terminal
// sizes the user actually runs, so the field viewport and every hidden row are
// measured against real text rather than a short sample.
const longReviewMessage = [
  "Resolve and disclose the commit message generator before diff sharing",
  "",
  "Preflight runs before anything leaves this machine. The provider and model are resolved once, then the exact destination is shown next to the frozen diff. The selection stays unchanged while the message is drafted, so the review cannot drift away from what was sent. Every sentence in the message remains readable, and the frozen diff stays exactly as it was reviewed. The wording names the route and the model, and it never implies that a second send step exists.",
  "",
  "The editor is a real multi-line field. Enter adds a line, Alt+Enter saves, and Cancel keeps the draft that existed before the editor opened. The field opens at the subject, End reaches the tail, and Home returns to the top. Saving sends the whole text, not only the rows on screen. A line counter names the caret row and the total row count, because the field itself has no visible scrollbar. If the host cannot report its route, the preview says that the destination is assumed, not verified.",
  "",
  "The review keeps the message and the frozen diff in one bounded scroll area. A fixed line names the scroll and End and Home keys, the message ends with an explicit marker, and the frozen diff starts under its own label. Commit stays in the footer while the body scrolls, and editing never commits on its own. The footer never scrolls away, so the last paragraph and the first diff row can be told apart without losing the controls.",
  "",
  "LONG-MESSAGE-TAIL-9a4c",
].join("\n");
const longEditScenario = (name, width, height) =>
  gitScenario(name, {
    width,
    height,
    git: {
      step: "edit",
      selection: ["src/app.js"],
      message: longReviewMessage,
      // The edit screen no longer renders the diff. The saved review uses the
      // same short diff as the direct confirm scenario so its tail, the end
      // marker, and the Frozen diff label can share one viewport.
      preview: { stat: "1 file changed, 2 insertions(+)", diff: "+one line\n+another line\n+DIFF-TAIL-4f2e" },
    },
    async after(setup, runtime, capture) {
      // The field opens at the subject. End moves the caret and the field's
      // viewport to the tail; Home puts both back at the top.
      await setup.mockInput.pressKey("\u001B[F");
      await setup.renderOnce();
      capture("after-end");
      await setup.mockInput.pressKey("\u001B[H");
      await setup.renderOnce();
      capture("after-home");
      await setup.mockInput.pressKey("\u001B[F");
      await setup.renderOnce();
      await setup.mockInput.pressEnter({ meta: true });
      await setup.renderOnce();
      capture("after-save");
      // The saved review still scrolls: the exact tail must be reachable there
      // too, and the footer must stay on screen.
      await setup.mockInput.pressKey("\u001B[F");
      await setup.renderOnce();
      capture("after-save-end");
    },
  });

longEditScenario("git-edit-long-100x30", 100, 30);
longEditScenario("git-edit-long-70x22", 70, 22);
longEditScenario("git-edit-long-32x26", 32, 26);

const longConfirmScenario = (name, width, height) =>
  gitScenario(name, {
    width,
    height,
    git: {
      step: "confirm",
      selection: ["src/app.js"],
      message: longReviewMessage,
      // A short diff keeps the message end and the diff label in one viewport
      // at the tail, which is exactly the boundary the screenshot confused.
      preview: { stat: "1 file changed, 2 insertions(+)", diff: "+one line\n+another line\n+DIFF-TAIL-4f2e" },
    },
    async after(setup, runtime, capture) {
      capture("before-scroll");
      const box = measure(setup.renderer.root).find((node) => node.ctor.includes("ScrollBox"));
      if (!box) throw new Error("the confirmation has no review scroll box");
      // Both stated controls are exercised: End jumps to the tail, Home returns.
      await setup.mockInput.pressKey("\u001B[F");
      await setup.renderOnce();
      capture("after-end");
      await setup.mockInput.pressKey("\u001B[H");
      await setup.renderOnce();
      capture("after-home");
      for (let index = 0; index < 100; index += 1) {
        await setup.mockMouse.scroll(box.x + 2, box.y + 1, "down");
      }
      await setup.renderOnce();
      capture("after-scroll");
    },
  });

longConfirmScenario("git-confirm-long-100x30", 100, 30);
longConfirmScenario("git-confirm-long-70x22", 70, 22);
longConfirmScenario("git-confirm-long-32x26", 32, 26);

// A run the dialog is opened on, then the same snapshot after its terminal
// event, then no snapshot at all. The output stays in the terminal snapshot, so
// the fallback has to be a statement about tracking, not about the process.
const retainedLogLines = ["BUILD-START-8f2c", "compiling src/app.js", "BUILD-TAIL-4d1e"];
const runningLog = {
  key: "runner-1",
  actionId: "build-mobile",
  label: "Build mobile",
  display: "npm run build",
  cwd: "/workspace/demo",
  pid: 4242,
  stdin: true,
  status: "running",
  running: true,
  exitCode: undefined,
  signal: undefined,
  error: null,
  stopError: null,
  stopping: false,
  orphaned: false,
  startedAt: 0,
  elapsedMs: 4200,
  lineCount: retainedLogLines.length,
  progress: "building 2/3",
  lines: retainedLogLines,
};
const terminalLog = {
  ...runningLog,
  status: "exited",
  running: false,
  exitCode: 0,
  elapsedMs: 5300,
};

function logScenario(name, options) {
  scenario(name, {
    width: options.width ?? 70,
    // The dialog needs the rows for its fixed header, progress and footer. A
    // shorter box lets the header rows compress into each other.
    height: options.height ?? 26,
    runtime: createFakeLogRuntime({ snapshot: options.snapshot, runKey: options.runKey }),
    build(runtime) {
      return (
        <box flexDirection="column" width="100%" height="100%">
          {LogDialog({
            context: runtime.context,
            runtime,
            runKey: runtime.runKey,
            onClose: () => {
              runtime.logClosed = true;
              runtime.calls.push(["dialog.close"]);
            },
          })}
        </box>
      );
    },
    after: options.after,
  });
}

logScenario("log-dialog-lifecycle-70", {
  snapshot: runningLog,
  async after(setup, runtime, capture) {
    capture("running");
    // The manager's subscription redraws a run that finished while its dialog
    // stayed open; the retained output is never dropped.
    runtime.setSnapshot(terminalLog);
    await setup.renderOnce();
    capture("terminal");
    // The snapshot disappears without a notification. The dialog's one second
    // timer is what notices, so the fallback is drawn without a manager event.
    runtime.setSnapshot(undefined, false);
    await new Promise((resolve) => setTimeout(resolve, 1250));
    await setup.renderOnce();
    capture("missing");
  },
});

const results = [];
for (const entry of scenarios) {
  const runtime = entry.runtime;
  const setup = await testRender(() => entry.build(runtime), {
    width: entry.width,
    height: entry.height,
  });
  await setup.renderOnce();
  const gitBefore = runtime.gitFlow.state();
  const frames = {};
  const nodesByFrame = {};
  const capture = (name) => {
    frames[name] = setup.captureCharFrame();
    nodesByFrame[name] = measure(setup.renderer.root);
    // Sampled outside the render, so reading the key layer cannot subscribe the
    // component that owns it.
    if (typeof runtime.keymap?.sample === "function") runtime.keymap.sample();
  };
  capture("frame");
  if (entry.after) await entry.after(setup, runtime, capture);
  // Destroy before reading the call log: an unmount cleanup is part of what a
  // scenario measures, and the log dialog reports its own unmount there.
  setup.renderer.destroy();
  results.push({
    name: entry.name,
    width: entry.width,
    height: entry.height,
    frames,
    // Bounds are read at the same moment as the frame, so a scenario that
    // toggles state reports the layout that frame was drawn from.
    nodes: nodesByFrame.frame ?? measure(setup.renderer.root),
    nodesByFrame,
    cells: Object.fromEntries(Object.entries(frames).map(([key, frame]) => [key, frameCells(frame)])),
    calls: runtime.calls,
    gitBefore,
    git: runtime.gitFlow.state(),
    settings: runtime.state.settings,
    // What the view registered with the host keymap on each run, plus what the
    // runtime reported as editable.
    keymap: runtime.keymap.samples,
    editors: runtime.state.editors,
    // The optional lifecycle notification the runtime can use to forget this
    // popup before it disposes the manager.
    logClosed: runtime.logClosed ?? false,
  });
}

const payload = `${MARKER}\n${JSON.stringify({ scenarios: results, misses })}\n`;
// The sidebar keeps a one second timer alive, so the process would never exit on
// its own. Wait for the write to land, then leave.
await new Promise((resolve) => process.stdout.write(payload, resolve));
process.exit(0);
