/** @jsxImportSource @opentui/solid */
// Sidebar rows and log dialog for the project runners plugin.
import { createMemo, createSignal, For, Index, onCleanup, onMount, Show } from "solid-js";
import {
  buttonVisual,
  controlVisual,
  dialogKeyLayer,
  statusLine,
  statusTone,
  token,
} from "./runners.js";

function sessionIdOf(props) {
  const value = props.sessionID;
  return typeof value === "function" ? value() : value;
}

// One place decides which buttons the sidebar draws. A hidden control leaves the
// row, and a Git button also leaves when there is no git service behind it, so
// the two callers (the section gate and the buttons) can never disagree. The
// palette still reaches a hidden command.
function withControls(board) {
  const controls = board?.controls ?? {};
  const on = (name) => controls[name] !== false;
  return {
    ...board,
    canCommit: Boolean(board?.canCommit) && on("commit"),
    canPush: Boolean(board?.canPush) && on("push"),
    canStop: Boolean(board?.canStop) && on("stop-all"),
    canLog: Boolean(board?.canLog) && on("log"),
    showStop: on("stop-all"),
    showLog: on("log"),
  };
}

export function Sidebar(props) {
  const { context, runtime } = props;
  const theme = context.theme;
  const [tick, setTick] = createSignal(0);
  const [hover, setHover] = createSignal("");
  // Collapsing hides the rows only. It is view state, so it never touches a
  // run: processes keep running and their logs stay retained.
  const [collapsed, setCollapsed] = createSignal(false);

  onCleanup(runtime.manager.subscribe(() => setTick((value) => value + 1)));
  // Showing or hiding a button is a runtime decision, so the rows follow the
  // runtime instead of caching whatever was read on the first render.
  if (typeof runtime.subscribeSettings === "function") {
    onCleanup(runtime.subscribeSettings(() => setTick((value) => value + 1)));
  }
  // Keeps the running elapsed time fresh without waiting for output events.
  const timer = setInterval(() => setTick((value) => value + 1), 1000);
  onCleanup(() => clearInterval(timer));

  const board = createMemo(() => {
    tick();
    return withControls(runtime.rows(sessionIdOf(props)));
  });
  const items = createMemo(() => board().items);
  // Row-major pairs, two columns at most. A list with an odd length ends in a
  // row of one, and that button takes the whole row. Index keeps one node per
  // slot, so output events update the label instead of rebuilding the grid.
  const rows = createMemo(() => {
    const list = items();
    const pairs = [];
    for (let index = 0; index < list.length; index += 2) {
      pairs.push([list[index], list[index + 1]]);
    }
    const tail = pairs[pairs.length - 1];
    if (tail && tail.length > 1 && !tail[1]) pairs[pairs.length - 1] = [tail[0]];
    return pairs;
  });

  return (
    <Show
      when={
        items().length > 0 ||
        board().canStop ||
        board().canLog ||
        board().canCommit ||
        board().canPush
      }
    >
      <box flexDirection="column" flexShrink={0}>
        {/* The header stays visible while collapsed and only toggles the view.
            The chevron matches the other collapsible sidebar sections. */}
        <box
          flexDirection="row"
          gap={1}
          onMouseUp={() => setCollapsed((value) => !value)}
        >
          <text fg="#ffffff" wrapMode="none">
            {collapsed() ? "▶" : "▼"}
          </text>
          <text fg={token(theme, "textBase")}>
            <b>Launchpad</b>
          </text>
          <text fg={token(theme, "textMuted")} wrapMode="none" truncate>
            {board().projectName}
          </text>
        </box>
        <Show when={!collapsed()}>
          {/* Git controls come first, above the command grid. They use the same
              row box as every other row, so the vertical spacing is identical.
              A button leaves the row when its control is hidden or when the git
              service is not connected. A lone button fills the row, and the row
              leaves when both are gone. The click reports why a button is not
              available. */}
          <Show when={board().canCommit || board().canPush}>
            <box flexDirection="row" flexShrink={0} gap={1}>
              <Show when={board().canCommit}>
                <UtilityButton
                  theme={theme}
                  label="Commit"
                  disabled={!board().canCommit}
                  onPress={() => runtime.openGit("commit")}
                />
              </Show>
              <Show when={board().canPush}>
                <UtilityButton
                  theme={theme}
                  label="Push"
                  disabled={!board().canPush}
                  onPress={() => runtime.openGit("push")}
                />
              </Show>
            </box>
          </Show>
          <Index each={rows()}>
            {(cells) => (
              <box flexDirection="row" flexShrink={0} gap={1}>
                <Index each={cells()}>
                  {(cell) => (
                    <RunnerButton
                      theme={theme}
                      cell={cell}
                      hovered={hover}
                      onOver={() => {
                        const row = cell();
                        if (row) setHover(row.action.id);
                      }}
                      onOut={() => setHover("")}
                      onPress={() => {
                        const row = cell();
                        if (row) runtime.startAction(row.action.id);
                      }}
                    />
                  )}
                </Index>
              </box>
            )}
          </Index>
          {/* Plugin-level controls, one row under the command grid. They are never
              project commands, so they use the control colour rule instead of a
              run frame, and each one says why it is unavailable. A hidden control
              leaves the row, so a lone button fills it.
              The box is the same as an action row, with no extra padding, so the
              vertical spacing between rows is identical everywhere. */}
          <Show when={board().showStop || board().showLog}>
            <box flexDirection="row" flexShrink={0} gap={1}>
              <Show when={board().showStop}>
                <UtilityButton
                  theme={theme}
                  label="Stop all"
                  disabled={!board().canStop}
                  onPress={() => runtime.stopAllRunners()}
                />
              </Show>
              <Show when={board().showLog}>
                <UtilityButton
                  theme={theme}
                  label="Show logs"
                  disabled={!board().canLog}
                  onPress={() => runtime.showLog()}
                />
              </Show>
            </box>
          </Show>
        </Show>
      </box>
    </Show>
  );
}

// One label renderer for every sidebar cell, so a lone button, a paired button
// and a control all read the same. The words of the label become separate text
// nodes in one wrapping row, and the row centres each drawn line. A single
// wrapping text node cannot do this: it draws every line from its own left edge,
// and the core this view is rendered on has no text-align option. A flex row
// that holds the whole label also fails, because a line that shrinks wraps the
// label early. A word too long for its line still breaks inside its own node, so
// nothing is drawn over a cell wall.
function CellLabel(props) {
  const words = createMemo(() =>
    String(props.label ?? "")
      .split(/\s+/)
      .filter(Boolean),
  );
  return (
    <box flexDirection="row" flexWrap="wrap" justifyContent="center" columnGap={1}>
      <For each={words()}>
        {(word) => (
          <text fg={props.color} wrapMode="char" flexShrink={1} minWidth={0}>
            {word}
          </text>
        )}
      </For>
    </box>
  );
}

function RunnerButton(props) {
  const theme = props.theme;
  const row = () => props.cell();
  const visual = createMemo(() => buttonVisual(theme, row(), props.hovered() === row()?.action.id));
  return (
    <box
      flexGrow={1}
      flexBasis={0}
      flexShrink={1}
      minWidth={0}
      flexDirection="column"
      justifyContent="center"
      border
      borderStyle={visual().style}
      borderColor={visual().border}
      paddingLeft={1}
      paddingRight={0}
      onMouseOver={props.onOver}
      onMouseOut={props.onOut}
      onMouseUp={props.onPress}
    >
      {/* The inset box measures the label against the cell's inner width and
          grows to the cell height, which keeps a one line label on the first
          line when a neighbour needs two. It holds no column back on the right:
          the centring row needs that column for the longest line a word can
          take. */}
      <box flexGrow={1} minWidth={0}>
        <CellLabel color={visual().text} label={row()?.action.label ?? ""} />
      </box>
    </box>
  );
}

// Plugin-level control: the same cell geometry as a runner button so the grid
// stays aligned, but its colour follows the control rule, so only a disabled
// control is muted.
function UtilityButton(props) {
  const theme = props.theme;
  const [hover, setHover] = createSignal(false);
  const visual = () => controlVisual(theme, { disabled: props.disabled, hovered: hover() });
  return (
    <box
      flexGrow={1}
      flexBasis={0}
      flexShrink={1}
      minWidth={0}
      flexDirection="column"
      justifyContent="center"
      border
      borderStyle={visual().style}
      borderColor={visual().border}
      paddingLeft={1}
      paddingRight={0}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (props.disabled) return;
        props.onPress();
      }}
    >
      {/* Same inset box as a runner button, so the utility row lines up and its
          label is measured against the cell's inner width. The label centres
          inside it, so a lone control and a paired control read the same. */}
      <box flexGrow={1} minWidth={0}>
        <CellLabel color={visual().text} label={props.label} />
      </box>
    </box>
  );
}

function Button(props) {
  const theme = props.theme;
  const [hover, setHover] = createSignal(false);
  const visual = () => controlVisual(theme, { disabled: props.disabled, hovered: hover() });
  return (
    <box
      flexDirection="row"
      flexShrink={0}
      border
      borderStyle={visual().style}
      borderColor={visual().border}
      paddingLeft={1}
      paddingRight={1}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (props.disabled) return;
        props.onPress();
      }}
    >
      <text fg={visual().text} wrapMode="none">
        {props.label}
      </text>
    </box>
  );
}

// One glyph, one hit target: a ⊘ that adds an untracked file to .gitignore. It
// is drawn for every file and is live only for an untracked, unblocked file
// while the flow is idle. A dimmed control stays visible so the column reads as
// one thing; its reason travels to the dialog hint on hover, because this host
// draws no tooltip. The glyph is padded to two columns: a one column target is
// too small to hit reliably.
function IgnoreControl(props) {
  const theme = props.theme;
  const [hover, setHover] = createSignal(false);
  const enabled = () => Boolean(props.enabled);
  const visual = () => controlVisual(theme, { disabled: !enabled(), hovered: hover() });
  const hint = () => (enabled() ? "Add to .gitignore" : props.reason);
  return (
    <box
      flexShrink={0}
      paddingLeft={1}
      onMouseOver={() => {
        setHover(true);
        props.onHint?.(hint());
      }}
      onMouseOut={() => {
        setHover(false);
        props.onHint?.("");
      }}
      onMouseUp={() => {
        if (!enabled()) return;
        props.onPress();
      }}
    >
      <text fg={visual().text} wrapMode="none">
        {props.label}
      </text>
    </box>
  );
}

export function LogDialog(props) {
  const { context, runtime, runKey } = props;
  const theme = context.theme;
  const [tick, setTick] = createSignal(0);

  onCleanup(runtime.manager.subscribe(() => setTick((value) => value + 1)));
  const timer = setInterval(() => setTick((value) => value + 1), 1000);
  onCleanup(() => clearInterval(timer));
  // Optional lifecycle notification for the runtime that owns this popup. It
  // only says the dialog unmounted; closing never stops the runner.
  onCleanup(() => {
    if (typeof props.onClose === "function") props.onClose();
  });

  const snapshot = () => {
    tick();
    return runtime.snapshot(runKey);
  };
  const close = () => {
    try {
      context.ui?.dialog?.clear?.();
    } catch {
      // dialog already closed
    }
  };
  // Escape hides the popup, and only hides it: the runner keeps running. The
  // advertised r/R/s keys drive this run through the same runtime as the buttons.
  onCleanup(dialogKeyLayer(context, close, runtime, runKey));

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Show
        when={snapshot()}
        fallback={
          <box flexDirection="column">
            <text fg={token(theme, "textMuted")}>Runner is no longer tracked.</text>
            <box flexDirection="row" paddingTop={1}>
              <Button theme={theme} label="Close esc" onPress={close} />
            </box>
          </box>
        }
      >
        {(value) => (
          <box flexDirection="column">
            <text fg={token(theme, "textBase")} wrapMode="none">
              <b>{value().label}</b>
            </text>
            <text fg={token(theme, "textMuted")} wrapMode="none">
              {value().display}
            </text>
            <text fg={token(theme, "textMuted")} wrapMode="none">
              {value().cwd}
            </text>
            <text fg={statusTone(theme, value())} wrapMode="none">
              {statusLine(value())}
            </text>
            <Show when={value().progress}>
              <text fg={token(theme, "textMuted")} wrapMode="none">
                {value().progress}
              </text>
            </Show>
            <scrollbox
              scrollY
              stickyScroll
              stickyStart="bottom"
              flexGrow={1}
              minHeight={3}
              maxHeight={16}
              ref={(node) => {
                // Best effort: a focused scroll box answers arrow keys, j/k,
                // page up/down and home/end on its own. Focus stays host owned.
                try {
                  node?.focus?.();
                } catch {
                  // focus is host owned
                }
              }}
            >
              <box flexDirection="column">
                <For each={value().lines}>
                  {(line) => (
                    <text fg={token(theme, "textMuted")} wrapMode="none">
                      {line.length > 160 ? `${line.slice(0, 160)}…` : line}
                    </text>
                  )}
                </For>
                <Show when={value().lines.length === 0}>
                  <text fg={token(theme, "textMuted")}>waiting for output…</text>
                </Show>
              </box>
            </scrollbox>
            <box flexDirection="row" gap={1} paddingTop={1} flexShrink={0}>
              <Button
                theme={theme}
                label="Stop s"
                disabled={!value().running || value().stopping}
                onPress={() => runtime.requestStop(runKey)}
              />
              <Button
                theme={theme}
                label="Reload r"
                disabled={!(value().running && value().stdin)}
                onPress={() => runtime.send(runKey, "r")}
              />
              <Button
                theme={theme}
                label="Restart R"
                disabled={!(value().running && value().stdin)}
                onPress={() => runtime.send(runKey, "R")}
              />
              <Button theme={theme} label="Close esc" onPress={close} />
            </box>
          </box>
        )}
      </Show>
    </box>
  );
}

// Enter starts a new line, which is what a commit body needs. The textarea
// already submits on meta+return (Alt+Enter); Ctrl+Enter saves too wherever the
// terminal can tell it apart from a plain Return. Saving only hands the text
// back to the flow, so no key here can commit anything by itself.
const EDIT_SAVE_KEYS = [{ name: "return", ctrl: true, action: "submit" }];

// The commit message field. The flow owns the draft, so the field only reports
// what is typed and never keeps a copy of its own: the text the editor opens
// with is the draft as it stood, and a save hands the same draft back.
function MessageEditor(props) {
  const { theme } = props;
  const initial = typeof props.text === "string" ? props.text : "";
  const [cursorLine, setCursorLine] = createSignal(1);
  const [lineCount, setLineCount] = createSignal(initial.split("\n").length);
  let field;
  // The editor opens at the start, so the subject and the beginning of the
  // message are reviewed before the caret scrolls to the tail. End and Home
  // move through the whole draft; nothing is cut.
  const refreshPosition = () => {
    const count = field?.lineCount;
    if (typeof count === "number" && count > 0) setLineCount(count);
    const row = field?.logicalCursor?.row;
    if (typeof row === "number") setCursorLine(row + 1);
  };
  onMount(() => {
    if (!field) return;
    try {
      field.cursorOffset = 0;
    } catch {
      // Some fields do not support cursor assignment; mounting must still
      // succeed, so refreshPosition below owns the initial position.
    }
    refreshPosition();
  });
  // The host reports what changed, not always the text itself: read the field
  // when the argument is not the text, so the flow gets the real message.
  const report = (value) => {
    if (typeof value === "string") return props.onChange?.(value);
    const text = field?.plainText;
    return props.onChange?.(typeof text === "string" ? text : "");
  };
  return (
    <box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={5}>
      {/* A field without a scrollbar needs to say that it scrolls. The line
          counter moves with the caret, so the top and the tail can be told
          apart without guessing how many rows are hidden. */}
      <text fg={token(theme, "textMuted")} wrapMode="word" flexShrink={0}>
        {`Message · line ${cursorLine()} of ${lineCount()}`}
      </text>
      <textarea
        ref={(node) => { field = node; }}
        initialValue={initial}
        placeholder="Write a subject, then a blank line and details"
        focused
        flexGrow={1}
        flexShrink={1}
        minHeight={4}
        marginTop={1}
        wrapMode="word"
        scrollMargin={1}
        textColor={token(theme, "textBase")}
        focusedTextColor={token(theme, "textBase")}
        keyBindings={EDIT_SAVE_KEYS}
        onCursorChange={() => refreshPosition()}
        onContentChange={(value) => { report(value); refreshPosition(); }}
        onSubmit={() => props.onSave?.()}
      />
    </box>
  );
}

// The Git dialogs. Commit and Push share one flow object: each step reads its
// state from the runtime, so the dialog holds no copy of it. Escape closes the
// dialog through the host, which cancels the flow and drops whatever it had
// frozen: it can never commit or push. Nothing here runs git.
export function GitDialog(props) {
  const { context, flow } = props;
  const theme = context.theme;
  const [version, setVersion] = createSignal(0);
  // The ⊘ column has no tooltip in this host, so hovering a control writes its
  // explanation here and the files step shows it under the list.
  const [ignoreHint, setIgnoreHint] = createSignal("");

  onCleanup(flow.subscribe(() => setVersion((value) => value + 1)));

  const state = () => {
    version();
    return flow.state();
  };
  const step = (name) => state()?.step === name;
  const busy = () => Boolean(state()?.busy);

  const header = () => {
    const value = state();
    if (!value) return "";
    if (value.kind === "push") {
      if (!value.push) return value.directory;
      const where = `${value.push.remote}/${value.push.remoteBranch}`;
      return `${value.push.branch} to ${where} · ${value.directory}`;
    }
    const branch = value.detached ? "detached HEAD" : value.branch ?? "no branch";
    const selected = value.selection.length;
    return `${branch} · ${value.directory} · ${selected} of ${value.files.length} selected`;
  };

  // A file the service refused to touch is shown, explained, and not clickable.
  const marker = (file) => {
    if (file.blocked) return `cannot commit (${file.blocked})`;
    return file.session ? "session change" : "unattributed";
  };

  // A file can be ignored only when git itself reports it untracked, the service
  // did not block it, and no step is running. Everything else draws the ⊘ dimmed
  // with the reason a hover shows.
  const ignorable = (file) => file.status === "untracked" && !file.blocked && !busy();
  const ignoreReason = () =>
    busy() ? "Wait for the current step to finish" : ".gitignore only applies to untracked files";

  // The ⊘ ignore control and the selection target are siblings, never nested: one
  // click target each, so a click on the symbol can never flip the selection and
  // a click on the row can never ignore the file.
  const fileRow = (file) => {
    const selected = () => state()?.selection.includes(file.path) ?? false;
    const fg = () => (file.blocked ? token(theme, "textMuted") : token(theme, "textBase"));
    return (
      <box flexDirection="row" gap={1}>
        <IgnoreControl
          theme={theme}
          label="⊘"
          enabled={ignorable(file)}
          reason={ignoreReason()}
          onHint={(text) => setIgnoreHint(text ?? "")}
          onPress={() => flow.ignoreFile?.(file.path)}
        />
        <box
          flexDirection="row"
          gap={1}
          flexGrow={1}
          flexBasis={0}
          minWidth={0}
          onMouseUp={() => flow.toggle(file.path)}
        >
          <text fg={fg()} wrapMode="none">
            {selected() ? "[x]" : "[ ]"}
          </text>
          <text fg={fg()} wrapMode="none" flexGrow={1}>
            {file.path}
          </text>
          <text fg={token(theme, "textMuted")} wrapMode="none">
            {marker(file)}
          </text>
        </box>
      </box>
    );
  };

  // The reviewed patch, exactly as the service produced it. Read from the top,
  // so it does not stick to the bottom like the live log does.
  const diffLines = () => String(state()?.preview?.diff ?? "").split("\n");

  // The preview names the destination the preflight selected. A legacy host
  // reports it as unverified, so the view says it is the assumed default rather
  // than claiming a configured route was found.
  const generatorProvider = () =>
    state()?.generator?.providerName || state()?.generator?.providerID || "the configured provider";
  const generatorModel = () => {
    const generator = state()?.generator;
    if (!generator) return "Luna";
    const model = generator.id || "Luna";
    return generator.variant ? `${model} (${generator.variant})` : model;
  };

  // The scrollbar draws over the last content column, so one column of padding
  // keeps every wrapped diff byte clear of it. The box takes focus on the steps
  // where it is the only thing that can be scrolled; the edit step keeps focus
  // in the message field instead. The optional header scrolls with the diff, so
  // a long confirmation message is never a clipped block above the dialog.
  const diffBox = (autoFocus = true, header = null) => (
    <scrollbox
      scrollY
      flexGrow={1}
      minHeight={4}
      maxHeight={16}
      paddingRight={1}
      ref={(node) => {
        if (!autoFocus) return;
        try {
          node?.focus?.();
        } catch {
          // focus is host owned
        }
      }}
    >
      <box flexDirection="column">
        {header}
        <text fg={token(theme, "textMuted")} wrapMode="word">
          Frozen diff
        </text>
        <For each={diffLines()}>
          {(line) => (
            <text fg={token(theme, "textMuted")} wrapMode="char">
              {line}
            </text>
          )}
        </For>
      </box>
    </scrollbox>
  );

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <Show when={state()} fallback={<box flexDirection="column" />}>
        <text fg={token(theme, "textBase")} wrapMode="none" flexShrink={0}>
          <b>{state().kind === "push" ? "Push to the configured remote" : "Commit selected files"}</b>
        </text>
        <text fg={token(theme, "textMuted")} wrapMode="word" flexShrink={0}>
          {header()}
        </text>
        <Show when={state()?.notice}>
          <text fg={token(theme, "textMuted")} wrapMode="word" flexShrink={0}>
            {state().notice}
          </text>
        </Show>
        <Show when={state()?.error}>
          <text fg={token(theme, "textError")} wrapMode="word" flexShrink={0}>
            {state()?.error?.message}
          </text>
        </Show>
        <Show when={state()?.error?.hash}>
          <text fg={token(theme, "textError")} wrapMode="none">
            {`commit ${state()?.error?.hash} already exists — do not retry`}
          </text>
        </Show>
        <Show when={state()?.busy}>
          <text fg={token(theme, "textMuted")} wrapMode="none">
            {state().busy}…
          </text>
        </Show>

        <Show when={step("files")}>
          <text fg={token(theme, "textMuted")} wrapMode="word" flexShrink={0}>
            Session changes are preselected. Review the selection before continuing.
          </text>
          <scrollbox scrollY flexGrow={1} minHeight={4} maxHeight={16}>
            <box flexDirection="column">
              <For each={state().files}>{(file) => fileRow(file)}</For>
              <Show when={state().files.length === 0}>
                <text fg={token(theme, "textMuted")}>Nothing changed in this repository.</text>
              </Show>
            </box>
          </scrollbox>
          {/* The ⊘ column explained in one short line. Hovering a control
              replaces it with that control's own explanation. */}
          <text fg={token(theme, "textMuted")} wrapMode="word" flexShrink={0}>
            {ignoreHint() || "⊘ adds an untracked file to .gitignore. It only applies to untracked files."}
          </text>
        </Show>

        <Show when={step("preview") || step("confirm")}>
          <Show when={step("preview")}>
            {/* The disclosure, the file list, the stat and the frozen diff share
                one review scroll box, so a narrow terminal cannot push the
                actions below the viewport. The exact destination is still the
                first thing shown, and Generate message stays in the fixed
                footer. That press is the approval; there is no second sharing
                screen. */}
            {diffBox(
              true,
              <box flexDirection="column">
                <Show when={state()?.generator}>
                  <text fg={token(theme, "textBase")} wrapMode="word">
                    Sending this selected frozen diff to {generatorProvider()} using {generatorModel()} is
                    the only thing that leaves your machine in this flow. The provider only drafts a
                    message: no tools run and no session is created. Generate message sends this exact
                    diff; you can edit the message before the final commit.
                  </text>
                  <text fg={token(theme, "textMuted")} wrapMode="word">
                    Files in the diff: {state().selection.join(", ")}
                  </text>
                  <Show when={state()?.generator?.verified === false}>
                    <text fg={token(theme, "textMuted")} wrapMode="word">
                      This host does not list providers or models, so this destination is the assumed
                      default, not verified.
                    </text>
                  </Show>
                </Show>
                <text fg={token(theme, "textMuted")} wrapMode="word">
                  {String(state()?.preview?.stat ?? "").trim()}
                </text>
              </box>
            )}
          </Show>
          <Show when={step("confirm")}>
            {/* The whole message and the frozen diff share one review scroll
                box. The subject is at the start; the tail and the diff are
                reachable by scrolling; Commit stays in the fixed footer. */}
            <text fg={token(theme, "textMuted")} wrapMode="word" flexShrink={0}>
              Scroll: mouse wheel or PgUp/PgDn · End jumps to the end · Home returns to the top
            </text>
            {diffBox(
              true,
              <box flexDirection="column">
                <text fg={token(theme, "textMuted")} wrapMode="word">
                  Message
                </text>
                <text fg={token(theme, "textBase")} wrapMode="word">
                  {state().message}
                </text>
                <text fg={token(theme, "textMuted")} wrapMode="word">
                  — end of message —
                </text>
                <text fg={token(theme, "textMuted")} wrapMode="word">
                  {String(state()?.preview?.stat ?? "").trim()}
                </text>
              </box>
            )}
          </Show>
        </Show>

        <Show when={step("edit")}>
          {/* The frozen diff was already reviewed and owns no space here: the
              editor gets every row the footer leaves. Movement keys are stated
              because this field has no visible scrollbar. */}
          <text fg={token(theme, "textMuted")} wrapMode="word" flexShrink={0}>
            Arrows scroll · End shows the tail · Home returns to the top
          </text>
          <text fg={token(theme, "textMuted")} wrapMode="word" flexShrink={0}>
            Enter adds a line · Alt+Enter saves · Cancel discards changes · Esc closes the flow
          </text>
          {MessageEditor({
            theme,
            text: state().draft,
            onChange: (value) => flow.draftChanged?.(value),
            onSave: () => flow.saveMessage?.(),
          })}
        </Show>

        <Show when={step("blocked")}>
          <text fg={token(theme, "textError")} wrapMode="word" flexShrink={0}>
            {state().notice}
          </text>
        </Show>

        <Show when={step("push-review") || step("push-confirm")}>
          <text fg={token(theme, "textBase")} wrapMode="word" flexShrink={0}>
            Destination: {state().push.destination}
          </text>
          <text fg={token(theme, "textMuted")} wrapMode="word" flexShrink={0}>
            Upstream: {state().push.upstream} · outgoing commits: {state().push.outgoing}
          </text>
          <scrollbox scrollY flexGrow={1} minHeight={3} maxHeight={10}>
            <box flexDirection="column">
              <For each={state().push.hashes}>
                {(hash) => (
                  <text fg={token(theme, "textMuted")} wrapMode="none">
                    {String(hash).slice(0, 12)}
                  </text>
                )}
              </For>
            </box>
          </scrollbox>
          <Show when={step("push-confirm")}>
            <text fg={token(theme, "textBase")} wrapMode="word" flexShrink={0}>
              This sends those commits to the destination above. No force, no other refs.
            </text>
          </Show>
        </Show>

        <Show when={step("committed")}>
          <text fg={token(theme, "textBase")} wrapMode="word" flexShrink={0}>
            The commit is already in history, so it was not retried. Close this window and
            reconcile the leftover files by hand if they still matter.
          </text>
        </Show>

        <box flexDirection="row" flexWrap="wrap" gap={1} paddingTop={1} flexShrink={0}>
          <Show when={step("loading")}>
            <Button theme={theme} label="Cancel esc" onPress={() => flow.cancel()} />
          </Show>
          <Show when={step("files")}>
            <Button
              theme={theme}
              label="Continue"
              disabled={!state().selection.length || busy()}
              onPress={() => flow.previewSelection()}
            />
            <Button theme={theme} label="Cancel esc" onPress={() => flow.cancel()} />
          </Show>
          <Show when={step("preview")}>
            <Button
              theme={theme}
              label="Generate message"
              disabled={!state()?.generator || busy()}
              onPress={() => flow.approveEgress()}
            />
            <Button
              theme={theme}
              label="Write message"
              disabled={busy()}
              onPress={() => flow.editMessage()}
            />
            <Button theme={theme} label="Back" disabled={busy()} onPress={() => flow.back()} />
            <Button theme={theme} label="Cancel esc" onPress={() => flow.cancel()} />
          </Show>
          <Show when={step("confirm")}>
            <Button
              theme={theme}
              label="Commit"
              disabled={!state().message || busy()}
              onPress={() => flow.confirm()}
            />
            <Button
              theme={theme}
              label="Edit message"
              disabled={busy()}
              onPress={() => flow.editMessage()}
            />
            <Button theme={theme} label="Back" disabled={busy()} onPress={() => flow.back()} />
            <Button theme={theme} label="Cancel esc" onPress={() => flow.cancel()} />
          </Show>
          <Show when={step("edit")}>
            <Button
              theme={theme}
              label="Save message"
              disabled={busy()}
              onPress={() => flow.saveMessage?.()}
            />
            <Button theme={theme} label="Cancel" disabled={busy()} onPress={() => flow.cancelMessage?.()} />
          </Show>
          <Show when={step("blocked")}>
            <Button theme={theme} label="Back to files" onPress={() => flow.back()} />
            <Button theme={theme} label="Close esc" onPress={() => flow.cancel()} />
          </Show>
          <Show when={step("committed")}>
            <Button theme={theme} label="Close esc" onPress={() => flow.cancel()} />
          </Show>
          <Show when={step("push-review")}>
            <Button
              theme={theme}
              label="Confirm push"
              disabled={busy()}
              onPress={() => flow.confirmPush()}
            />
            <Button theme={theme} label="Cancel esc" onPress={() => flow.cancel()} />
          </Show>
          <Show when={step("push-confirm")}>
            <Button
              theme={theme}
              label="Push now"
              disabled={busy()}
              onPress={() => flow.pushNow()}
            />
            <Button theme={theme} label="Back" disabled={busy()} onPress={() => flow.back()} />
            <Button theme={theme} label="Cancel esc" onPress={() => flow.cancel()} />
          </Show>
        </box>
      </Show>
    </box>
  );
}

// Built-in controls always exist; every other row is a project command.
const BUILTIN_CONTROLS = new Set(["commit", "push", "stop-all", "log"]);

function isBuiltin(item) {
  if (item?.kind === "builtin") return true;
  if (item?.kind === "script") return false;
  return BUILTIN_CONTROLS.has(item?.id);
}

// One move control: a small click target that steps a runner one place up or
// down the list. A disabled control - the first up, the last down - still shows
// where the button could go, but its colour never lifts and its click never
// fires, so the ends of the list read as the ends. The single arrow glyph is
// padded to two columns: a one column target is too small to hit reliably.
function MoveControl(props) {
  const theme = props.theme;
  const [hover, setHover] = createSignal(false);
  const lit = () => props.enabled && hover();
  return (
    <box
      paddingLeft={1}
      onMouseOver={() => setHover(true)}
      onMouseOut={() => setHover(false)}
      onMouseUp={() => {
        if (!props.enabled) return;
        props.onPress();
      }}
    >
      <text fg={lit() ? token(theme, "textBase") : token(theme, "textMuted")} wrapMode="none">
        {props.label}
      </text>
    </box>
  );
}

function SettingsRow(props) {
  const theme = props.theme;
  const item = () => props.item;
  const [hover, setHover] = createSignal(false);
  const [editHover, setEditHover] = createSignal(false);
  // The label carries the state: a bright row is on, a muted row is hidden from
  // the sidebar. Hovering brightens the row so the click target is visible.
  const fg = () => (item().visible || hover() ? token(theme, "textBase") : token(theme, "textMuted"));
  return (
    // The two move controls, the toggle and the editor are siblings, never
    // nested: one click target each, so a click on a move control can never
    // reach the toggle behind it and a move never flips a button's visibility.
    // The moves sit left of the name and the editor sits right, so the eye reads
    // "step this button, then the button, then edit it".
    <box flexDirection="row" gap={1}>
      {/* A runner can be moved; a built-in control is fixed, so its row carries
          no move control at all, the same way it carries no editor. The drawn
          glyph is the control's name: this host draws no separate accessibility
          text, so an arrow is the whole label. Two arrows, two hit targets. */}
      <Show when={props.movable}>
        <MoveControl
          theme={theme}
          label="↑"
          enabled={props.canUp}
          onPress={() => props.onMove(item(), "up")}
        />
        <MoveControl
          theme={theme}
          label="↓"
          enabled={props.canDown}
          onPress={() => props.onMove(item(), "down")}
        />
      </Show>
      <box
        flexDirection="row"
        gap={1}
        flexGrow={1}
        flexBasis={0}
        minWidth={0}
        onMouseOver={() => setHover(true)}
        onMouseOut={() => setHover(false)}
        onMouseUp={() => props.onToggle(item())}
      >
        <text fg={fg()} wrapMode="none">
          {item().visible ? "[x]" : "[ ]"}
        </text>
        <text fg={fg()} wrapMode="word">
          {item().label}
        </text>
      </box>
      <Show when={props.editable}>
        <box
          onMouseOver={() => setEditHover(true)}
          onMouseOut={() => setEditHover(false)}
          onMouseUp={() => props.onEdit(item())}
        >
          <text fg={editHover() ? token(theme, "textBase") : token(theme, "textMuted")} wrapMode="none">
            Edit
          </text>
        </box>
      </Show>
    </box>
  );
}

// One editor field. The input owns its text while the editor is open, so typing
// never re-renders the field and the caret stays put. The marker shows which
// field the keyboard is in, and a click anywhere on the row moves it there.
function FieldRow(props) {
  const theme = props.theme;
  const active = () => props.active;
  const fg = () => (active() ? token(theme, "textBase") : token(theme, "textMuted"));
  return (
    <box flexDirection="row" gap={1} onMouseUp={() => props.onFocus()}>
      <text fg={fg()} wrapMode="none">
        {active() ? "▸" : " "}
      </text>
      <text fg={fg()} wrapMode="none">
        {props.name.padEnd(FIELD_NAME_WIDTH)}
      </text>
      <box flexGrow={1} flexBasis={0} minWidth={0}>
        <input
          ref={(node) => props.setRef(props.field, node)}
          value={props.value}
          focused={active()}
          placeholder={props.placeholder}
          onSubmit={() => props.onSubmit()}
        />
      </box>
    </box>
  );
}

// The widest field name ("Arguments") sets the column, so the inputs line up.
const FIELD_NAME_WIDTH = 9;
const ARGUMENT_HINT = 'Arguments must be a JSON list of strings, for example ["run", "--watch"].';
// The list box stops at eleven rows. Eleven rows plus the title, the hint and
// the footer is seventeen, so the popup stays inside a seventeen row dialog
// however many buttons a project has: the status lines above the list take
// their rows from the box, and a longer list scrolls inside it instead of
// pushing the footer off the window.
const LIST_MAX_ROWS = 11;

// Settings popup: one row per button the sidebar can draw. Hiding a button only
// removes it from the sidebar; the command stays in the palette, so the runtime
// still reaches it. A project command can also be edited here, and a new button
// can be added. Nothing here starts or stops a run.
export function SettingsDialog(props) {
  const { context, runtime } = props;
  const theme = context.theme;
  const [tick, setTick] = createSignal(0);
  // "list" shows the buttons, "edit" edits one runner, "confirm" guards a delete.
  const [mode, setMode] = createSignal("list");
  const [field, setField] = createSignal("label");
  const [formError, setFormError] = createSignal(null);
  const [draft, setDraft] = createSignal(null);
  const [pending, setPending] = createSignal(null);
  // A refused move (a project that changed, a button the runtime no longer
  // knows) is shown on its own line, so a reorder that did not land never looks
  // like it did.
  const [moveError, setMoveError] = createSignal(null);
  // The dialog learns its own height from the box the host lays out. Zero means
  // the host never reported one, and the seventeen row dialog is assumed.


  if (typeof runtime.subscribeSettings === "function") {
    onCleanup(runtime.subscribeSettings(() => setTick((value) => value + 1)));
  }

  const items = createMemo(() => {
    tick();
    const list = runtime.settingsItems?.();
    return Array.isArray(list) ? list : [];
  });
  const scripts = createMemo(() => items().filter((item) => !isBuiltin(item)));
  const builtins = createMemo(() => items().filter((item) => isBuiltin(item)));
  // The move controls act on the runners only, hidden ones included, so their
  // ends are the ends of the runner list and never the built-in controls below.
  const runnerIndex = (item) => scripts().findIndex((each) => each.id === item.id);
  const canMoveUp = (item) => runnerIndex(item) > 0;
  const canMoveDown = (item) => {
    const at = runnerIndex(item);
    return at >= 0 && at < scripts().length - 1;
  };
  // Hidden ids are stored for the whole install, and "Show all buttons" clears
  // every one of them, not only the ids this project can draw. The runtime
  // counts them all, so the footer counts that: a project with nothing hidden
  // still needs the restore button while another project hides buttons.
  const localHidden = createMemo(() => items().filter((item) => !item.visible).length);
  const allHidden = createMemo(() => {
    tick();
    const value = typeof runtime.hiddenCount === "function" ? runtime.hiddenCount() : null;
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  });
  const hiddenCount = createMemo(() => allHidden() ?? localHidden());
  // The list only shows this project's buttons, so the count says when the rest
  // are hidden elsewhere instead of looking wrong next to an unmarked list.
  const hiddenNote = createMemo(() => {
    const total = hiddenCount();
    const local = localHidden();
    const plural = total === 1 ? "" : "s";
    if (total <= local) return `${total} button${plural} hidden`;
    if (local === 0) return `${total} button${plural} hidden in other projects`;
    return `${total} button${plural} hidden (${total - local} in other projects)`;
  });
  // A failed read or write is shown in place of a silent success: the runtime
  // reports it, and the dialog must not look like the change was saved.
  const error = createMemo(() => {
    tick();
    const value = runtime.settingsError?.();
    return value && typeof value === "object" ? value : null;
  });
  // The runners behind the rows: the runtime reports the executable, the
  // argument list and the directory for each one. Built-in controls are not
  // runners, so they never appear here and never get an Edit affordance.
  const editable = createMemo(() => {
    tick();
    const list = runtime.buttonEditorItems?.();
    return Array.isArray(list) ? list : [];
  });
  const editableById = createMemo(() => new Map(editable().map((item) => [item.id, item])));
  const configError = createMemo(() => {
    tick();
    const value = runtime.buttonConfigError?.();
    return value && typeof value === "object" ? value : null;
  });
  // The list needs one row per button, plus a header and a blank line for each
  // group. A label long enough to wrap takes a second row, so the box can end up
  // one row short at a narrow width; the list then scrolls rather than growing.
  const listContentRows = createMemo(() => {
    if (items().length === 0) return 1;
    return (
      (scripts().length > 0 ? 2 + scripts().length : 0) +
      (builtins().length > 0 ? 2 + builtins().length : 0)
    );
  });
  // One row for each message above the list, two for the hidden count because
  // that row carries a blank line before it.
  const listStatusRows = createMemo(
    () =>
      (error()?.message ? 1 : 0) +
      (configError()?.message ? 1 : 0) +
      (moveError() ? 1 : 0) +
      (hiddenCount() > 0 ? 2 : 0),
  );
  // The box is one row taller than its content: the renderer draws one row less
  // than the height it is given, so the spare row is what shows the last button.
  // The cap keeps the popup inside a seventeen row dialog: six rows are the
  // title, the hint and the footer, and the status lines take the rest. The
  // renderer cannot report the window height to the view, so the runtime must
  // give this dialog seventeen rows or more (dialog.setSize("large")).
  const listHeight = createMemo(() =>
    Math.max(3, Math.min(LIST_MAX_ROWS - listStatusRows(), listContentRows() + 1)),
  );

  // The inputs own their text while the editor is open. Save reads the
  // renderables back through this plain object, so typing never re-renders a
  // field and the caret stays where the person left it.
  const refs = { label: null, command: null, args: null };
  const setRef = (name, node) => {
    refs[name] = node;
  };
  const readField = (name) => {
    try {
      return refs[name]?.value ?? "";
    } catch {
      return "";
    }
  };
  const argumentText = (value) => {
    if (Array.isArray(value)) return value.length > 0 ? JSON.stringify(value) : "";
    return typeof value === "string" ? value : "";
  };

  const close = () => {
    try {
      context.ui?.dialog?.clear?.();
    } catch {
      // dialog already closed
    }
  };
  const showAll = () => {
    try {
      runtime.showAllButtons?.();
    } catch {
      // runtime refused the change
    }
  };
  const toggle = (item) => {
    try {
      runtime.setVisible?.(item.id, !item.visible);
    } catch {
      // runtime refused the change
    }
  };

  // The project is captured once, when the dialog opens, and every draft uses
  // that frozen value. Reading it again when the editor opens would pair a row
  // that the list loaded earlier with the project that is open now, and the
  // runtime's guard would then accept a write meant for the project left behind.
  // The directory a runner runs in is not the same thing: a nested package
  // borrows its root's commands, so the owner of the button may differ.
  const capturedProject = (() => {
    try {
      const value = runtime.buttonProject?.();
      return typeof value === "string" && value !== "" ? value : null;
    } catch {
      return null;
    }
  })();

  const startNew = () => {
    setDraft({
      id: null,
      label: "",
      command: "",
      args: [],
      // A new button is captured in the project that was open when this dialog
      // opened, so the read-only line names it instead of staying generic.
      cwd: capturedProject ?? "",
      project: capturedProject,
      custom: true,
      overridden: false,
    });
    setFormError(null);
    setField("label");
    setMode("edit");
  };
  const startEdit = (row) => {
    const item = editableById().get(row?.id);
    if (!item) return;
    setDraft({
      id: item.id,
      label: typeof item.label === "string" ? item.label : row.label,
      command: typeof item.command === "string" ? item.command : "",
      args: Array.isArray(item.args) ? item.args : [],
      cwd: typeof item.cwd === "string" ? item.cwd : "",
      project: capturedProject,
      custom: item.custom === true,
      overridden: item.overridden === true,
    });
    setFormError(null);
    setField("label");
    setMode("edit");
  };
  // Escape closes the list, steps back from the editor, and keeps the button in
  // the confirmation.
  const back = () => {
    if (mode() === "confirm") {
      setPending(null);
      setMode("edit");
      return;
    }
    if (mode() === "edit") {
      setFormError(null);
      setMode("list");
      return;
    }
    close();
  };
  const save = () => {
    const current = draft();
    if (!current) return;
    const label = readField("label").trim();
    const command = readField("command").trim();
    const raw = readField("args").trim();
    if (label === "") {
      setFormError("A button needs a name.");
      setField("label");
      return;
    }
    if (command === "") {
      setFormError("A button needs a command.");
      setField("command");
      return;
    }
    // The arguments field is a JSON list. An empty field means no arguments, so
    // a plain command does not have to be written as [].
    let args = [];
    if (raw !== "") {
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        setFormError(ARGUMENT_HINT);
        setField("args");
        return;
      }
      if (!Array.isArray(parsed) || parsed.some((each) => typeof each !== "string")) {
        setFormError(ARGUMENT_HINT);
        setField("args");
        return;
      }
      args = parsed;
    }
    const payload = { label, command, args };
    if (current.id) payload.id = current.id;
    if (current.project) payload.project = current.project;
    let result = null;
    try {
      result = typeof runtime.saveButton === "function" ? runtime.saveButton(payload) : null;
    } catch {
      result = null;
    }
    if (!result || result.ok !== true) {
      // The runtime owns the reasons: a protected built-in, a name already in
      // use, a refused write, a project that changed while the editor was open.
      // Show what it says instead of a silent success.
      const reason = result && typeof result.reason === "string" && result.reason !== "" ? result.reason : "Could not save the button.";
      setFormError(reason);
      return;
    }
    setFormError(null);
    setMode("list");
  };
  // Enter walks the fields and then saves, so a whole button can be typed
  // without reaching for the mouse.
  const advance = () => {
    const order = ["label", "command", "args"];
    const at = order.indexOf(field());
    if (at >= 0 && at < order.length - 1) {
      setField(order[at + 1]);
      return;
    }
    save();
  };
  // A reset and a delete carry the captured project too, and the runtime can
  // refuse both when the project moved on. A refusal keeps the editor open with
  // its values, so nothing is applied to the wrong project.
  const refused = (result, fallback) => {
    if (!result || result.ok !== false) return null;
    return typeof result.reason === "string" && result.reason !== "" ? result.reason : fallback;
  };
  // Moving a runner carries the project the dialog captured when it opened, the
  // same safeguard the editor uses: a session switched while the list is open
  // must not reorder the project that is open now. The runtime may also refuse
  // and say why; the reason is shown instead of a silent no-op. A move at either
  // end is a no-op the disabled control already prevents, so it writes nothing.
  const move = (item, direction) => {
    if (!item || typeof item.id !== "string" || item.id === "") return;
    let result = null;
    try {
      result =
        typeof runtime.moveButton === "function"
          ? runtime.moveButton(item.id, direction, capturedProject)
          : null;
    } catch {
      result = null;
    }
    const reason = refused(result, "Could not move the button.");
    if (reason) {
      setMoveError(reason);
      return;
    }
    setMoveError(null);
  };
  const reset = () => {
    const current = draft();
    if (!current?.id) return;
    let result = null;
    try {
      result = runtime.resetButton?.(current.id, current.project ?? undefined);
    } catch {
      result = null;
    }
    const reason = refused(result, "Could not restore the button.");
    if (reason) {
      setFormError(reason);
      return;
    }
    setFormError(null);
    setMode("list");
  };
  const askDelete = () => {
    const current = draft();
    if (!current?.custom || !current.id) return;
    setPending(current);
    setMode("confirm");
  };
  const confirmDelete = () => {
    const current = pending();
    let result = null;
    if (current?.id) {
      try {
        result = runtime.deleteButton?.(current.id, current.project ?? undefined);
      } catch {
        result = null;
      }
    }
    const reason = refused(result, "Could not delete the button.");
    if (reason) {
      setPending(null);
      setFormError(reason);
      setMode("edit");
      return;
    }
    setPending(null);
    setFormError(null);
    setMode("list");
  };

  // Escape closes the list, steps back from the editor and keeps the button in
  // the confirmation. "a" restores every button, and only from the list, so it
  // cannot fire while someone is typing a command.
  let disposed = false;
  const dispose = context?.keymap?.layer?.(() => ({
    mode: "modal",
    commands: [
      {
        bind: "escape",
        title: mode() === "list" ? "Close" : mode() === "confirm" ? "Keep the button" : "Back to the list",
        group: "Dialog",
        run: () => {
          if (disposed) return false;
          back();
          return true;
        },
      },
      {
        bind: "a",
        title: "Show all buttons",
        group: "Dialog",
        enabled: () => mode() === "list",
        run: () => {
          if (disposed) return false;
          showAll();
          return true;
        },
      },
    ],
  }));
  onCleanup(() => {
    disposed = true;
    try {
      dispose?.();
    } catch {
      // layer already gone
    }
  });

  const title = () => {
    if (mode() === "confirm") return "Delete button";
    if (mode() === "edit") return draft()?.id ? "Edit button" : "New button";
    return "Sidebar buttons";
  };

  return (
    <box flexDirection="column" paddingLeft={1} paddingRight={1}>
      <text fg={token(theme, "textBase")} wrapMode="none">
        <b>{title()}</b>
      </text>

      <Show when={mode() === "list"}>
        <text fg={token(theme, "textMuted")} wrapMode="word">
          A hidden button leaves the sidebar and stays in the command palette.
        </text>
        <Show when={error()?.message}>
          <text fg={token(theme, "textError")} wrapMode="word">
            {error().message}
          </text>
        </Show>
        <Show when={configError()?.message}>
          <text fg={token(theme, "textError")} wrapMode="word">
            {configError().message}
          </text>
        </Show>
        <Show when={moveError()}>
          <text fg={token(theme, "textError")} wrapMode="word">
            {moveError()}
          </text>
        </Show>
        {/* The list scrolls: a project with many scripts keeps the footer in
            reach, and a short dialog shrinks the list instead of overlapping the
            lines above it. */}
        <scrollbox scrollY flexShrink={1} minHeight={3} height={listHeight()} focused={mode() === "list"}>
          <Show when={items().length === 0}>
            <text fg={token(theme, "textMuted")} wrapMode="none">
              No buttons to configure.
            </text>
          </Show>
          <Show when={scripts().length > 0}>
            <box flexDirection="column" paddingTop={1}>
              <text fg={token(theme, "textMuted")} wrapMode="none">
                Project commands
              </text>
              <For each={scripts()}>
                {(item) => (
                  <SettingsRow
                    theme={theme}
                    item={item}
                    movable
                    canUp={canMoveUp(item)}
                    canDown={canMoveDown(item)}
                    editable={editableById().has(item.id)}
                    onToggle={toggle}
                    onMove={move}
                    onEdit={startEdit}
                  />
                )}
              </For>
            </box>
          </Show>
          <Show when={builtins().length > 0}>
            <box flexDirection="column" paddingTop={1}>
              <text fg={token(theme, "textMuted")} wrapMode="none">
                Built-in controls
              </text>
              <For each={builtins()}>
                {(item) => <SettingsRow theme={theme} item={item} editable={false} onToggle={toggle} />}
              </For>
            </box>
          </Show>
        </scrollbox>
        <Show when={hiddenCount() > 0}>
          <box flexDirection="row" paddingTop={1}>
            <text fg={token(theme, "textMuted")} wrapMode="none">
              {hiddenNote()}
            </text>
          </box>
        </Show>
        <box flexDirection="row" gap={1} paddingTop={1} flexShrink={0}>
          <Button theme={theme} label="New button" onPress={startNew} />
          <Button theme={theme} label="Show all buttons" disabled={hiddenCount() === 0} onPress={showAll} />
          <Button theme={theme} label="Close esc" onPress={close} />
        </box>
      </Show>

      <Show when={mode() === "edit"}>
        <text fg={token(theme, "textMuted")} wrapMode="word">
          The command runs directly, without a shell.
        </text>
        <Show when={formError()}>
          <text fg={token(theme, "textError")} wrapMode="word">
            {formError()}
          </text>
        </Show>
        <Show when={configError()?.message}>
          <text fg={token(theme, "textError")} wrapMode="word">
            {configError().message}
          </text>
        </Show>
        <FieldRow
          theme={theme}
          field="label"
          name="Name"
          value={draft()?.label ?? ""}
          active={field() === "label"}
          placeholder="Button name"
          setRef={setRef}
          onFocus={() => setField("label")}
          onSubmit={advance}
        />
        <FieldRow
          theme={theme}
          field="command"
          name="Command"
          value={draft()?.command ?? ""}
          active={field() === "command"}
          placeholder="Executable"
          setRef={setRef}
          onFocus={() => setField("command")}
          onSubmit={advance}
        />
        <FieldRow
          theme={theme}
          field="args"
          name="Arguments"
          value={argumentText(draft()?.args)}
          active={field() === "args"}
          placeholder="[]"
          setRef={setRef}
          onFocus={() => setField("args")}
          onSubmit={advance}
        />
        {/* The directory is the runtime's to decide, so it is shown, not typed. */}
        <box flexDirection="row" gap={1}>
          <text fg={token(theme, "textMuted")} wrapMode="none">
            {" "}
          </text>
          <text fg={token(theme, "textMuted")} wrapMode="none">
            {"Directory".padEnd(FIELD_NAME_WIDTH)}
          </text>
          <text fg={token(theme, "textMuted")} wrapMode="word">
            {draft()?.cwd ? `Runs in ${draft().cwd}` : "Runs in this project's directory"}
          </text>
        </box>
        <box flexDirection="row" gap={1} paddingTop={1} flexShrink={0}>
          <Button theme={theme} label="Save" onPress={save} />
          <Button theme={theme} label="Cancel" onPress={back} />
          <Show when={draft()?.overridden}>
            <Button theme={theme} label="Reset defaults" onPress={reset} />
          </Show>
          <Show when={draft()?.custom && draft()?.id}>
            <Button theme={theme} label="Delete" onPress={askDelete} />
          </Show>
        </box>
      </Show>

      <Show when={mode() === "confirm"}>
        <text fg={token(theme, "textMuted")} wrapMode="word">
          {`${pending()?.label ?? "This button"} leaves the sidebar and the command palette.`}
        </text>
        <Show when={configError()?.message}>
          <text fg={token(theme, "textError")} wrapMode="word">
            {configError().message}
          </text>
        </Show>
        <box flexDirection="row" gap={1} paddingTop={1} flexShrink={0}>
          <Button theme={theme} label="Delete button" onPress={confirmDelete} />
          <Button theme={theme} label="Keep" onPress={back} />
        </box>
      </Show>
    </box>
  );
}
