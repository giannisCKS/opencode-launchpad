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
import { SettingsDialog, Sidebar } from "./view.jsx";

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
  return {
    state,
    calls,
    notify() {
      for (const listener of [...listeners]) listener();
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
    // the bordered cell and the inset box around its label share one label.
    const label = [...new Set([own, ...below.map((each) => each.label)])]
      .filter(Boolean)
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
    if (row >= 0) await setup.mockMouse.click(2, row);
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
    if (row >= 0) await setup.mockMouse.click(2, row);
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

const results = [];
for (const entry of scenarios) {
  const runtime = entry.runtime;
  const setup = await testRender(() => entry.build(runtime), {
    width: entry.width,
    height: entry.height,
  });
  await setup.renderOnce();
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
    settings: runtime.state.settings,
    // What the view registered with the host keymap on each run, plus what the
    // runtime reported as editable.
    keymap: runtime.keymap.samples,
    editors: runtime.state.editors,
  });
  setup.renderer.destroy();
}

const payload = `${MARKER}\n${JSON.stringify({ scenarios: results, misses })}\n`;
// The sidebar keeps a one second timer alive, so the process would never exit on
// its own. Wait for the write to land, then leave.
await new Promise((resolve) => process.stdout.write(payload, resolve));
process.exit(0);
