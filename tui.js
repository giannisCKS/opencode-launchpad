// OpenCode TUI plugin: project runner rows under all quota contributions.
// The Solid view is loaded lazily so Node tests can drive setupWith with a stub.
import path from "node:path";
import {
  createProjectDetector,
  createRunnerManager,
  discoverActions,
  resolveAction,
  resolveSessionDirectory,
} from "./runners.js";
import { createGitActions } from "./git.js";
import { CONTROL_ITEMS, createVisibilityStore, defaultVisibilityFile } from "./visibility.js";
import { createGitDetector } from "./git-detection.js";
import { createButtonConfigStore, defaultButtonConfigFile } from "./button-config.js";

export const PLUGIN_ID = "local.control";

function notify(context, message, variant) {
  try {
    context.ui?.toast?.show?.({ message, variant });
  } catch {
    // toast is best effort
  }
}

// The palette is global, not per session, so it always follows the active
// session; `rows` reports the directory it painted for the active session.
function currentSessionID(context) {
  try {
    const route = context.ui?.router?.current?.();
    if (route && route.type === "session" && typeof route.sessionID === "string") {
      return route.sessionID;
    }
  } catch {
    // router unavailable
  }
  return undefined;
}

// The two Git flows. Both are reviewed before anything leaves the machine:
// commit freezes a patch, push freezes a target, and each one is confirmed.
const GIT_FLOWS = { commit: "Commit", push: "Push" };

export function createRuntime({
  context,
  manager,
  detector,
  view,
  git,
  gitOptions,
  visibility = createVisibilityStore(),
  gitDetector = createGitDetector(),
  buttonConfig = createButtonConfigStore(),
}) {
  // Last session seen by the sidebar: the router is not the only source of truth.
  let lastSessionID;

  // A refused keystroke is reported rather than looking like a success: the run
  // may have exited, never take reload input, or still be running with the
  // command stream closed (a delivery failure, not a reload).
  function sendKey(key, data) {
    if (manager.send(key, data)) return true;
    const snapshot = manager.snapshot(key);
    if (!snapshot) {
      notify(context, "Runner is no longer tracked", "warning");
    } else if (!snapshot.running) {
      notify(context, `${snapshot.label}: already ${snapshot.status}`, "info");
    } else if (!snapshot.stdin) {
      notify(context, `${snapshot.label}: ${snapshot.display} does not take reload input`, "warning");
    } else {
      notify(context, `${snapshot.label}: reload input could not be delivered`, "error");
    }
    return false;
  }

  function openLog(key) {
    if (!key || !manager.snapshot(key)) return false;
    // The dialog's own modal layer drives the run through this runtime, so a
    // key reaches the same path as the buttons without any shared state.
    try {
      context.ui?.dialog?.show?.(() => view.LogDialog({ context, runtime, runKey: key }));
      context.ui?.dialog?.set?.({ size: "large" });
    } catch {
      return false;
    }
    return true;
  }

  // Resolved at click time: the active tab, not the tab that painted the row.
  function startAction(actionId) {
    const dir = resolveSessionDirectory(context, currentSessionID(context) ?? lastSessionID);
    const project = detector.detect(dir, { fresh: true });
    // The button's effective configuration is re-resolved here, so a click
    // always runs what the user last saved, never a stale captured row.
    const descriptor = effectiveDescriptors(project).find((entry) => entry.id === actionId);
    const resolution = descriptor
      ? resolveEffective(descriptor, project)
      : resolveAction(actionId, project);
    if (!resolution.ok) {
      notify(context, `${resolution.label}: ${resolution.reason}`, "warning");
      return { ok: false, code: "unsupported", message: resolution.reason };
    }

    const result = manager.start({
      actionId,
      label: resolution.title,
      command: resolution.command,
      args: resolution.args,
      cwd: resolution.cwd,
      env: resolution.env,
      display: resolution.display,
      stdin: resolution.stdin,
    });

    if (!result.ok) {
      if (result.code === "already-running") {
        notify(context, result.message, "info");
        openLog(result.key);
      } else {
        notify(context, `${resolution.label}: ${result.message}`, "error");
      }
      return result;
    }

    openLog(result.key);
    return result;
  }

  // Every action this project supports, in display order. Script-generated
  // actions join the specialized ones here, so rows, project keys, the palette
  // and the settings list all read the same catalog instead of a static list.
  function actionDescriptors(project) {
    try {
      const list = discoverActions(project);
      return Array.isArray(list)
        ? list.filter((entry) => entry && typeof entry.id === "string" && entry.id)
        : [];
    } catch {
      // Discovery is best effort: a broken project never breaks the sidebar.
      return [];
    }
  }

  // ------------------------------------------------------- button config
  // Edits are keyed by the detected active directory, so a custom command saved
  // in one project never appears in - and never runs from - another. Visibility
  // is a separate, global setting keyed by stable action id and is unchanged.
  function configDir(project) {
    return project?.dir ?? "";
  }

  // The project the button editor is bound to. A dialog captures this when it
  // opens and passes it back with every mutation, so an edit prepared while
  // project A was active can never be written into project B after the user
  // switches sessions. This is the project key - the detected directory - not
  // the working directory of any single button: a discovered button keeps its
  // own action cwd, which is a different thing.
  function buttonProject() {
    return configDir(detector.detect(currentDirectory()));
  }

  // A caller that passes no capture keeps the historical behavior and edits the
  // project that is active now; the runtime's own editor always passes one.
  function captureMatches(captured, current) {
    return typeof captured !== "string" || captured === current;
  }

  // This project's buttons with the user's edits applied, hidden ones included.
  // A discovered button keeps its immutable id and only its label changes, so a
  // rename never loses the run's log, its stop target or its hidden state. A
  // custom button carries the directory it was created in, which is also its
  // working directory, so it can never run from another project.
  function effectiveDescriptors(project) {
    const overrides = buttonConfig.overridesFor(configDir(project));
    const items = [];
    for (const descriptor of actionDescriptors(project)) {
      const override = overrides.get(descriptor.id);
      items.push({
        id: descriptor.id,
        label: override ? override.label : descriptor.label,
        title: override ? override.label : descriptor.title,
        custom: false,
        overridden: Boolean(override),
        // Carried here so resolveEffective can replace exactly the executable
        // and arguments, and nothing else, of an overridden button.
        command: override ? override.command : undefined,
        args: override ? override.args : undefined,
      });
    }
    for (const custom of buttonConfig.customFor(configDir(project))) {
      items.push({
        id: custom.id,
        label: custom.label,
        title: custom.label,
        custom: true,
        overridden: false,
        command: custom.command,
        args: custom.args,
        cwd: custom.project,
      });
    }
    return applyButtonOrder(items, buttonConfig.orderFor(configDir(project)));
  }

  // The project's saved order is a list of stable action ids. The sidebar, the
  // settings list, the editor and the palette all read this one catalog, so
  // applying the order here keeps them consistent by construction. An id the
  // project no longer has is skipped, and a button the order does not name yet
  // (a script added since, a hand-added button) keeps its discovery position
  // after every named one, so adding a button never reshuffles the rest.
  function applyButtonOrder(items, order) {
    if (!Array.isArray(order) || order.length === 0) return items;
    const byId = new Map(items.map((item) => [item.id, item]));
    const placed = new Set();
    const ordered = [];
    for (const id of order) {
      const item = byId.get(id);
      if (!item || placed.has(id)) continue;
      placed.add(id);
      ordered.push(item);
    }
    for (const item of items) {
      if (placed.has(item.id)) continue;
      placed.add(item.id);
      ordered.push(item);
    }
    return ordered;
  }

  // What a button will actually run. An overridden command replaces the
  // executable, the arguments and the display, and clears the action's own env
  // and stdin, so a build define from the original action can never be injected
  // into an arbitrary command. The action id and the working directory are
  // preserved, which is what keeps the run's key - and therefore its log and its
  // stop target - stable across an edit.
  function resolveEffective(descriptor, project) {
    if (descriptor.custom) {
      return {
        ok: true,
        actionId: descriptor.id,
        label: descriptor.label,
        title: descriptor.title,
        command: descriptor.command,
        args: [...descriptor.args],
        cwd: descriptor.cwd,
        env: {},
        stdin: false,
        display: [descriptor.command, ...descriptor.args].join(" "),
      };
    }
    const resolution = resolveAction(descriptor.id, project);
    if (!resolution.ok || !descriptor.overridden) return resolution;
    return {
      ...resolution,
      command: descriptor.command,
      args: [...descriptor.args],
      env: {},
      stdin: false,
      display: [descriptor.command, ...descriptor.args].join(" "),
      label: descriptor.label,
      title: descriptor.title,
    };
  }

  // Keys of this project's supported runs, hidden or not: hiding a button must
  // not strand a run, so Show logs can still reopen a hidden script's output.
  // A run started from this exact directory is included even when its button no
  // longer exists (a deleted custom button, a script removed from package.json),
  // so deleting a button never loses a run that is still going.
  function projectKeys(project) {
    const keys = new Set();
    for (const descriptor of effectiveDescriptors(project)) {
      const resolution = resolveEffective(descriptor, project);
      if (resolution.ok) keys.add(manager.keyFor(resolution.actionId, resolution.cwd));
    }
    for (const run of manager.list()) {
      if (run.cwd && run.cwd === configDir(project)) keys.add(run.key);
    }
    return keys;
  }

  function rows(sessionID) {
    if (typeof sessionID === "string" && sessionID) lastSessionID = sessionID;
    const dir = resolveSessionDirectory(context, sessionID);
    const project = detector.detect(dir);
    // Only supported, visible actions are listed: an unsupported or hidden
    // button is omitted, not disabled, and an empty list hides the section.
    const items = [];
    for (const descriptor of effectiveDescriptors(project)) {
      if (!visibility.isVisible(descriptor.id)) continue;
      const resolution = resolveEffective(descriptor, project);
      if (!resolution.ok) continue;
      const run = manager.find(descriptor.id, resolution.cwd);
      items.push({
        action: {
          id: descriptor.id,
          label: descriptor.label,
          title: descriptor.title,
        },
        resolution,
        // A sidebar row only needs the state, never the retained output.
        run: run ? manager.snapshot(run.key, 0) : undefined,
      });
    }
    const runs = manager.list();
    const keys = projectKeys(project);
    const repository = gitDetector.detect(dir);
    const gitReady = Boolean(service());
    return {
      projectName: path.basename(project.root || dir),
      dir,
      items,
      // What the UI may draw. A hidden control stays in the palette, never in
      // the grid. The Git controls also need a repository, so they are hidden
      // outside one instead of appearing disabled on every folder.
      controls: {
        commit: visibility.isVisible("commit") && repository.inRepo,
        push: visibility.isVisible("push") && repository.inRepo,
        "stop-all": visibility.isVisible("stop-all"),
        log: visibility.isVisible("log"),
      },
      // Plugin-level controls: Stop all only ever signals runs this plugin
      // started, Show logs only reopens output that already exists.
      canStop: runs.some((run) => run.status === "running"),
      canLog: runs.some((run) => keys.has(run.key)),
      // The Git controls belong to the repository, not to this project's
      // scripts, so they need both a repository and the git service.
      canCommit: gitReady && repository.inRepo,
      canPush: gitReady && repository.inRepo,
    };
  }

  function currentDirectory() {
    return resolveSessionDirectory(context, currentSessionID(context) ?? lastSessionID);
  }

  // Show logs: this project's active run first, then its most recent one, since
  // a finished run keeps its output. An unrelated project's run is never opened.
  function logKey() {
    const keys = projectKeys(detector.detect(currentDirectory()));
    const mine = manager.list().filter((run) => keys.has(run.key));
    const running = mine.find((run) => run.status === "running");
    if (running) return running.key;
    let latest;
    for (const run of mine) {
      if (!latest || (run.startedAt ?? 0) > (latest.startedAt ?? 0)) latest = run;
    }
    return latest?.key;
  }

  function showLog() {
    const key = logKey();
    if (!key) {
      notify(context, "No runner output for this project", "warning");
      return false;
    }
    return openLog(key);
  }

  // Stop all is plugin-owned: only runs this plugin started are signalled, and a
  // partial failure is reported instead of a false success. A run that was
  // already stopping is neither counted as stopped nor as a failure.
  function stopAllRunners() {
    const running = manager.list().filter((run) => run.status === "running");
    // Read the stop state before signalling: list() hands out live run objects.
    const pending = running.filter((run) => !run.stopping);
    const result = manager.stopAll();
    const failedKeys = new Set(
      pending
        .filter((run) => manager.snapshot(run.key)?.stopError)
        .map((run) => run.key),
    );
    const signalled = pending.filter((run) => !failedKeys.has(run.key));
    const already = running.length - pending.length;
    if (!running.length) {
      notify(context, "No runner is running", "warning");
      return result;
    }
    const parts = [];
    if (signalled.length) {
      parts.push(`Stopped ${signalled.length} runner${signalled.length === 1 ? "" : "s"}`);
    }
    if (already) parts.push(`${already} already stopping`);
    if (failedKeys.size) parts.push(`${failedKeys.size} could not be stopped`);
    notify(context, parts.join(" · "), failedKeys.size ? "error" : "info");
    return result;
  }

  // A refused stop is reported, never swallowed: false means the runner is
  // already stopping, already finished, or its signal was refused.
  function requestStop(key) {
    if (manager.stop(key)) return true;
    const snapshot = manager.snapshot(key);
    if (!snapshot) {
      notify(context, "Runner is no longer tracked", "warning");
      return false;
    }
    if (snapshot.stopping) {
      notify(context, `${snapshot.label}: already stopping`, "info");
      return false;
    }
    if (!snapshot.running) {
      notify(context, `${snapshot.label}: already ${snapshot.status}`, "info");
      return false;
    }
    notify(context, `${snapshot.label}: ${snapshot.stopError ?? "could not be stopped"}`, "error");
    return false;
  }

  // ------------------------------------------------------------------ git
  // One service instance, built on demand. Nothing in this module runs git
  // itself: every repository call goes through the service, so a test can inject
  // a fake one and no flow can exist without it.
  let serviceInstance = null;
  let serviceBuilt = false;
  let serviceFailed = false;

  function service() {
    // An injected service wins, including an explicit null ("no service here").
    if (git !== undefined) return git;
    if (!serviceBuilt) {
      serviceBuilt = true;
      try {
        // The message generator is the host's native text API, injected here so
        // git.js stays host-independent. A caller can override it (tests inject
        // a fake); otherwise the adapter below reads the live client lazily.
        const generateText = gitOptions?.generateText ?? nativeGenerateText;
        serviceInstance = createGitActions({ ...gitOptions, generateText });
      } catch {
        serviceFailed = true;
      }
    }
    return serviceFailed ? null : serviceInstance;
  }

  // The native adapter: `client.generate.text({ prompt, model }, { signal })`.
  // The installed host exposes it on the session client (`dist/promise/client.d.ts`),
  // not on any SDK import, so it is read lazily and called with the client as
  // `this`. No tool or session route is touched: the payload is the prompt alone.
  function nativeGenerateText(payload, callOptions) {
    const generate = context?.client?.generate;
    const text = generate?.text;
    if (typeof text !== "function") {
      // A structured code, not the wording, tells git.js this is a missing host
      // capability rather than a provider failure.
      const error = new Error("the session client cannot generate text");
      error.code = "generation-unavailable";
      throw error;
    }
    return text.call(generate, payload, callOptions);
  }

  // The Git controls are disabled while no service exists, and they say why
  // instead of failing silently. `reason` is optional and only used to make that
  // message specific (for example "git is not installed").
  function gitReason() {
    const reason = typeof git?.reason === "string" ? git.reason : "";
    if (reason) return reason;
    if (serviceFailed) return "the git service could not be started";
    return "the git service is not connected yet";
  }

  // The commit flow: a small state machine the dialog drives. Its state lives
  // here rather than in the view, because the message prompt replaces the dialog
  // and the flow has to survive that remount.
  let flow = null;
  let flowGeneration = 0;
  const flowListeners = new Set();

  function flowState() {
    if (!flow) return null;
    return {
      kind: flow.kind,
      step: flow.step,
      busy: flow.busy,
      error: flow.error,
      notice: flow.notice,
      directory: flow.directory,
      branch: flow.branch,
      detached: flow.detached,
      upstream: flow.upstream,
      ahead: flow.ahead,
      files: flow.files,
      selection: [...flow.selection],
      preview: flow.preview,
      message: flow.message,
      push: flow.push,
      pushReady: Boolean(flow.pushToken),
    };
  }

  function flowChanged() {
    for (const listener of [...flowListeners]) {
      try {
        listener();
      } catch {
        // a dead view must not break the flow
      }
    }
  }

  // Mount the dialog for the current state. The generation guard is what makes
  // the close hook honest: our own remounts are ignored, any other close (escape,
  // another dialog, a host clear) cancels the flow and drops its preview.
  function mountFlow() {
    if (!flow) return;
    flowGeneration += 1;
    const generation = flowGeneration;
    try {
      context.ui?.dialog?.show?.(
        () => view.GitDialog({ context, runtime, flow: commitFlow }),
        () => {
          if (generation === flowGeneration) cancelFlow();
        },
      );
      context.ui?.dialog?.set?.({ size: "large" });
    } catch {
      cancelFlow();
    }
  }

  // Forget the flow and drop its frozen preview. Nothing is committed here. Both
  // tokens belong to this flow: a cancelled push must not leave a push token the
  // service still honours, or a stale action could push with it.
  function cancelFlow() {
    const current = flow;
    flow = null;
    flowGeneration += 1;
    // A generation in flight belongs to this flow: abort it so the request stops
    // and the service's busy lock is released, even if the callback is slow.
    try {
      current?.actions?.cancelGeneration?.();
    } catch {
      // best effort: nothing was generating
    }
    for (const token of [current?.token, current?.pushToken]) {
      if (!token) continue;
      try {
        current.actions?.discard?.({ token });
      } catch {
        // best effort: an unknown token means the service already dropped it
      }
    }
    flowChanged();
  }

  function closeFlow() {
    cancelFlow();
    try {
      context.ui?.dialog?.clear?.();
    } catch {
      // the dialog was already closed
    }
  }

  // Session-changed files are the attribution fingerprint: a confirmed change
  // starts checked, and anything the source cannot confirm is shown as
  // unattributed and left unchecked.
  //
  // The installed TUI host is `@opencode/client` `OpenCodeClient` (verified
  // against the published package:
  // `dist/promise/client.d.ts` and `dist/promise/generated/types.d.ts`), not
  // `@opencode-ai/sdk`. Its actual contract:
  //   - `client.message.list({ sessionID, limit?, order?, cursor?, type? })`
  //     resolves `{ data: SessionMessageInfo[], cursor: { previous?, next? } }`.
  //     A user message is `{ type: "user", id, time, text }`; it carries no diff.
  //   - `client.session.diff({ sessionID, from?, to?, context? })` resolves
  //     `FileDiffInfo[]`. Per the API docs, `from` is "user message whose turn
  //     to diff" and `to` defaults to "the turn of `from` alone". The no-argument
  //     call therefore answers only the newest user turn, which loses earlier
  //     edits - the screenshot's "everything unattributed" bug.
  //   - `client.session.list({ parentID, directory, limit?, cursor? })` resolves
  //     `{ data: SessionInfo[], cursor: { previous?, next? } }`. A child record
  //     carries `parentID`; there is no separate `session.children` route.
  //
  // Attribution therefore walks the user turns oldest-first with the opaque
  // `cursor.next` (docs: `order` applies to the first page and "do not combine
  // with order" once a cursor is followed; pass the same `type`), then asks
  // `session.diff({ from: id })` per turn and unions the confirmed files. A
  // per-turn diff is preferred over one oldest-to-newest range because the range
  // compares its first and last snapshot, which can hide a change reverted
  // inside the range. Each source only adds confirmed paths; a missing route,
  // an error, or a truncated walk keeps the confirmed subset and adds a truthful
  // warning. Nothing is ever inferred from the git working tree.
  //
  // Child sessions (native subagents and OMO slim, which both set the native
  // `parentID`) are enumerated breadth-first from the root with the same
  // `session.list` route. The query deliberately carries no folder filter: a
  // folder filter would hide the children that live in another folder, and
  // naming them wrong would attribute a same-named file from the wrong folder.
  // Each listed record's own folder (`directory`, else `location.directory`) is
  // resolved and compared with the captured folder instead; a child in another
  // folder, or one whose folder cannot be verified, is skipped and disclosed.
  // Only records whose `parentID` is the exact node being expanded are
  // followed, ids are deduplicated, and pages, nodes, and depth are bounded. A
  // list failure keeps the confirmed tree and warns; it never erases the root's
  // attribution.
  //
  // A legacy synchronous `state.session.diff(sessionID)` snapshot still wins
  // for the root when it reports files; an empty snapshot is not evidence and
  // does not hide the live client. Children have no legacy snapshot.
  const MESSAGE_PAGE_LIMIT = 100;
  const MESSAGE_PAGE_CAP = 20;
  const TURN_DIFF_CAP = 50;
  const SESSION_PAGE_LIMIT = 20;
  const SESSION_PAGE_CAP = 3;
  const SESSION_NODE_CAP = 100;
  const SESSION_DEPTH_CAP = 4;
  const UNRESOLVED_WARNING =
    "Some session changes could not be read, so unattributed files must be selected by hand.";
  const INCOMPLETE_WARNING =
    "The session history is longer than one read, so older session changes may still be unattributed.";
  const DESCENDANT_WARNING =
    "Child session changes could not be read, so some files may still be unattributed.";
  const DESCENDANT_SKIPPED_WARNING =
    "Child sessions in other or unverified folders were skipped, so their changes may still be unattributed.";
  const CHILD_UNSUPPORTED_WARNING =
    "Child sessions cannot be listed on this host, so files changed in them may still be unattributed.";
  const DESCENDANT_LIMIT_WARNING =
    "The child session tree is larger than one read, so some child changes may still be unattributed.";

  function diffEntries(result) {
    return Array.isArray(result) ? result : null;
  }

  function addEntryPaths(target, entries) {
    for (const entry of entries) {
      const file = entry?.file;
      if (typeof file === "string" && file.length > 0) target.add(file);
    }
  }

  // Enumerate every user-turn id, oldest first, in bounded pages. The cursor is
  // opaque: it is passed back verbatim and stops the walk when it does not
  // advance, so a broken or hostile cursor cannot loop the click.
  async function readUserTurns(sessionID) {
    const message = context.client?.message;
    if (typeof message?.list !== "function") return null;
    const ids = [];
    const seen = new Set();
    let cursor;
    for (let page = 0; page < MESSAGE_PAGE_CAP; page += 1) {
      let result;
      try {
        result = await message.list({
          sessionID,
          limit: MESSAGE_PAGE_LIMIT,
          type: "user",
          ...(cursor ? { cursor } : { order: "asc" }),
        });
      } catch {
        return { ids, failed: true, incomplete: true };
      }
      if (!Array.isArray(result?.data)) return { ids, failed: true, incomplete: true };
      let added = 0;
      for (const entry of result.data) {
        // The server filters by `type`, but do not trust a mixed page to add a
        // non-user id as a diff anchor.
        if (entry?.type !== "user") continue;
        const id = entry?.id;
        if (typeof id !== "string" || !id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        added += 1;
      }
      const next = result?.cursor?.next;
      if (typeof next !== "string" || !next) return { ids, failed: false, incomplete: false };
      if (added === 0) return { ids, failed: false, incomplete: true };
      cursor = next;
      if (page === MESSAGE_PAGE_CAP - 1) return { ids, failed: false, incomplete: true };
    }
    return { ids, failed: false, incomplete: true };
  }

  // Diff each user turn by its id. The list is walk-ordered oldest first, so
  // the newest TURN_DIFF_CAP turns are the ones kept when a session is huge;
  // the dropped older turns are reported, not silently ignored.
  async function readTurnDiffs(sessionID, ids) {
    const session = context.client?.session;
    if (typeof session?.diff !== "function") {
      return { files: new Set(), resolved: false, failed: 0, unreadable: true, truncated: false };
    }
    const wanted = ids.slice(-TURN_DIFF_CAP);
    const files = new Set();
    let resolved = false;
    let failed = 0;
    for (const id of wanted) {
      let entries;
      try {
        entries = diffEntries(await session.diff({ sessionID, from: id }));
      } catch {
        entries = null;
      }
      if (entries === null) {
        failed += 1;
        continue;
      }
      resolved = true;
      addEntryPaths(files, entries);
    }
    return { files, resolved, failed, unreadable: false, truncated: ids.length > wanted.length };
  }

  // The no-argument diff answers the newest user turn only. It is a fallback
  // when the turn list cannot be read, never the session-wide source.
  async function readFlatDiff(sessionID) {
    const session = context.client?.session;
    if (typeof session?.diff !== "function") return null;
    try {
      return diffEntries(await session.diff({ sessionID }));
    } catch {
      return null;
    }
  }

  // The folder a listed session claims: `directory` first, else
  // `location.directory`. Anything else (missing, empty, non-string) is
  // unverifiable and yields null. A claim is resolved to an absolute path so it
  // can be compared with the captured folder exactly; a relative claim resolves
  // against the process folder, so it only counts when it lands on the captured
  // folder, never by assuming a repo root or worktree.
  function recordDirectory(record) {
    const raw =
      typeof record?.directory === "string" && record.directory
        ? record.directory
        : typeof record?.location?.directory === "string" && record.location.directory
          ? record.location.directory
          : null;
    return raw === null ? null : path.resolve(raw);
  }

  // Read one page list of a session's direct children. The response is
  // untrusted: only a record whose `parentID` is exactly the requested id is a
  // child of it, ids must be non-empty strings, and duplicates are dropped. A
  // `directory` filter is never sent - the listing would hide children from
  // other folders - so every record's own folder is verified against the
  // captured folder instead; a child in another or unverifiable folder is
  // skipped, never attributed by name. A cursor that does not advance (no new
  // child) ends the walk instead of looping.
  async function listSessionChildren(session, parentID, directory, options = {}) {
    const limit = options.limit ?? SESSION_PAGE_LIMIT;
    const maxPages = options.maxPages ?? SESSION_PAGE_CAP;
    const captured = typeof directory === "string" && directory ? path.resolve(directory) : null;
    const records = [];
    const seen = new Set();
    let failed = false;
    let truncated = false;
    let skipped = false;
    let cursor;
    for (let page = 0; page < maxPages; page += 1) {
      let result;
      try {
        result = await session.list({
          parentID,
          limit,
          ...(cursor ? { cursor } : {}),
        });
      } catch {
        // A rejected request is a failure, not evidence of a larger tree.
        return { records, failed: true, truncated, skipped };
      }
      if (!Array.isArray(result?.data)) return { records, failed: true, truncated, skipped };
      let considered = 0;
      for (const record of result.data) {
        if (record?.parentID !== parentID) continue;
        const id = record?.id;
        if (typeof id !== "string" || !id || seen.has(id)) continue;
        seen.add(id);
        considered += 1;
        const folder = recordDirectory(record);
        if (captured === null || folder === null || folder !== captured) {
          // The session exists, but its folder is not the captured one or cannot
          // be verified: its files are not this folder's changes.
          skipped = true;
          continue;
        }
        records.push(id);
      }
      const next = result?.cursor?.next;
      if (typeof next !== "string" || !next) return { records, failed, truncated, skipped };
      if (considered === 0) return { records, failed, truncated: true, skipped };
      cursor = next;
      if (page === maxPages - 1) return { records, failed, truncated: true, skipped };
    }
    return { records, failed, truncated: true, skipped };
  }

  // Breadth-first enumeration of the native `parentID` tree. The root is never
  // re-added, each id is visited once (a cycle cannot loop), and every bound is
  // reported rather than silently dropping work. Depth is probed: a node at the
  // depth cap is not expanded, but a one-record probe detects deeper children so
  // the bound is only reported when it actually hides something.
  async function readDescendantSessions(session, rootID, directory) {
    if (typeof session?.list !== "function") {
      return { ids: [], failed: false, unsupported: true, truncated: false, skipped: false };
    }
    const ids = [];
    const seen = new Set([rootID]);
    const queue = [{ id: rootID, depth: 0 }];
    let failed = false;
    let truncated = false;
    let skipped = false;
    while (queue.length > 0) {
      const node = queue.shift();
      if (node.depth >= SESSION_DEPTH_CAP) {
        const probe = await listSessionChildren(session, node.id, directory, {
          limit: 1,
          maxPages: 1,
        });
        if (probe.failed) failed = true;
        if (probe.records.length > 0 || probe.truncated) truncated = true;
        if (probe.skipped) skipped = true;
        continue;
      }
      const page = await listSessionChildren(session, node.id, directory);
      if (page.failed) failed = true;
      if (page.truncated) truncated = true;
      if (page.skipped) skipped = true;
      for (const id of page.records) {
        if (seen.has(id)) continue;
        seen.add(id);
        if (ids.length >= SESSION_NODE_CAP) {
          truncated = true;
          break;
        }
        ids.push(id);
        queue.push({ id, depth: node.depth + 1 });
      }
      if (ids.length >= SESSION_NODE_CAP) {
        if (queue.length > 0) truncated = true;
        break;
      }
    }
    return { ids, failed, unsupported: false, truncated, skipped };
  }

  // One session's confirmed files. The legacy snapshot only exists for the root;
  // children are always read through the live client.
  async function readSessionChanges(sessionID, { legacySnapshot = false } = {}) {
    if (legacySnapshot) {
      try {
        const snapshot = context.state?.session?.diff?.(sessionID);
        if (Array.isArray(snapshot) && snapshot.length > 0) {
          const files = new Set();
          addEntryPaths(files, snapshot);
          return { files: [...files], warning: "" };
        }
      } catch {
        // fall through to the client sources
      }
    }

    const files = new Set();
    const turns = await readUserTurns(sessionID);
    let resolution = "partial";

    if (turns && !turns.failed && turns.ids.length > 0) {
      const perTurn = await readTurnDiffs(sessionID, turns.ids);
      for (const file of perTurn.files) files.add(file);
      if (perTurn.resolved) {
        // An incomplete walk still returns its confirmed turns; say so.
        if (turns.incomplete) return { files: [...files], warning: INCOMPLETE_WARNING };
        if (perTurn.failed > 0 || perTurn.truncated) {
          return { files: [...files], warning: UNRESOLVED_WARNING };
        }
        return { files: [...files], warning: "" };
      }
      resolution = "failed";
    }

    const flat = await readFlatDiff(sessionID);
    if (flat !== null) {
      addEntryPaths(files, flat);
      if (turns === null || turns.failed || resolution === "failed") {
        return { files: [...files], warning: UNRESOLVED_WARNING };
      }
      if (turns.incomplete) return { files: [...files], warning: INCOMPLETE_WARNING };
      return { files: [...files], warning: "" };
    }

    return { files: [...files], warning: UNRESOLVED_WARNING };
  }

  // Root plus its confirmed descendants: each session contributes only its own
  // user-turn diffs. The captured folder is the validation key, not a list
  // filter: a child is expanded only when its own folder resolves to it, so a
  // same-named file from another folder can never be attributed. A child that
  // cannot be read keeps the root and the siblings it already confirmed, and the
  // partial result is stated.
  async function sessionChangedFiles(sessionID, directory) {
    if (typeof sessionID !== "string" || !sessionID) return { files: [], warning: "" };

    const root = await readSessionChanges(sessionID, { legacySnapshot: true });
    const files = new Set(root.files);
    const warnings = root.warning ? [root.warning] : [];
    const descendants = await readDescendantSessions(context.client?.session, sessionID, directory);
    if (descendants.unsupported) {
      warnings.push(CHILD_UNSUPPORTED_WARNING);
    } else {
      for (const id of descendants.ids) {
        const child = await readSessionChanges(id);
        for (const file of child.files) files.add(file);
        if (child.warning) warnings.push(child.warning);
      }
      if (descendants.failed) warnings.push(DESCENDANT_WARNING);
      if (descendants.skipped) warnings.push(DESCENDANT_SKIPPED_WARNING);
      if (descendants.truncated) warnings.push(DESCENDANT_LIMIT_WARNING);
    }

    return { files: [...files], warning: [...new Set(warnings)].join(" ") };
  }

  function beginFlow(kind, { actions, sessionID, directory }) {
    if (flow) {
      // One flow at a time: an open flow is shown again, never duplicated.
      mountFlow();
      return;
    }
    flow = {
      kind,
      actions,
      sessionID,
      directory,
      step: "loading",
      busy: "",
      error: null,
      notice: "",
      root: null,
      branch: null,
      detached: false,
      upstream: null,
      ahead: null,
      files: [],
      selection: new Set(),
      preview: null,
      token: null,
      message: "",
      push: null,
      pushToken: null,
    };
    mountFlow();
    flowChanged();
    if (kind === "push") void loadPushTarget();
    else void loadSelection();
  }

  // Rebuild the file list from the captured folder and session. `preserve` is
  // set only by the ignore refresh: it keeps the user's own choices instead of
  // rebuilding the default selection, and keeps the attribution notice when the
  // new read has no warning of its own. A plain reload passes nothing and gets
  // the fresh default, so an action's own refresh never widens a commit.
  async function loadSelection({ preserve = null } = {}) {
    const current = flow;
    if (!current) return null;
    current.step = "loading";
    current.busy = "";
    current.error = null;
    current.notice = "";
    flowChanged();
    const attribution = await sessionChangedFiles(current.sessionID, current.directory);
    const result = await current.actions.status({ cwd: current.directory, sessionFiles: attribution.files });
    if (flow !== current) return null;
    if (!result?.ok) {
      notify(context, `Commit: ${result?.error?.message ?? "git status failed"}`, "error");
      closeFlow();
      return result;
    }
    current.root = result.root;
    current.branch = result.branch;
    current.detached = result.detached;
    current.upstream = result.upstream;
    current.ahead = result.ahead;
    current.files = result.files;
    // The attribution read is advisory: a partial read still shows its confirmed
    // paths. Say so instead of letting the user assume everything was seen.
    if (attribution.warning) current.notice = attribution.warning;
    else if (preserve?.notice) current.notice = preserve.notice;
    if (preserve) {
      // Keep the user's choices, dropping paths that are gone or no longer
      // selectable. Nothing is added back, so an ignored path and the new
      // .gitignore entry are never checked on the user's behalf.
      const eligible = new Set(result.files.filter((file) => !file.blocked).map((file) => file.path));
      current.selection = new Set([...preserve.selection].filter((path) => eligible.has(path)));
    } else {
      // Only confirmed session changes start checked; unsafe files never do.
      current.selection = new Set(
        current.files.filter((file) => file.session === true && !file.blocked).map((file) => file.path),
      );
    }
    current.step = "files";
    flowChanged();
    return result;
  }

  // Push: freeze the exact target first. The service resolves @{push} itself, so
  // nothing here guesses a remote, and the preview carries every field the
  // confirmation shows and the push revalidates.
  async function loadPushTarget() {
    const current = flow;
    if (!current) return null;
    current.step = "loading";
    current.busy = "";
    current.error = null;
    current.notice = "";
    flowChanged();
    const result = await current.actions.previewPush({ cwd: current.directory });
    if (flow !== current) return null;
    if (!result?.ok) {
      notify(context, `Push: ${result?.error?.message ?? "the push could not be prepared"}`, "error");
      closeFlow();
      return result;
    }
    current.pushToken = result.token;
    current.push = {
      branch: result.branch,
      head: result.head,
      remote: result.remote,
      remoteBranch: result.remoteBranch,
      upstream: result.upstream,
      destination: result.destination,
      outgoing: result.outgoing,
      hashes: result.hashes,
    };
    current.step = "push-review";
    flowChanged();
    return result;
  }

  function askPushConfirm() {
    const current = flow;
    if (!current || current.step !== "push-review" || !current.pushToken || current.busy) return false;
    current.step = "push-confirm";
    current.error = null;
    flowChanged();
    return true;
  }

  // The only network mutation in the plugin, and it only runs after the frozen
  // target was shown and confirmed. Plain push: the service passes the remote and
  // an explicit refspec, never a force flag. The step guard is what keeps that
  // true: a caller cannot push from the review step, only from the confirmation.
  async function runPush() {
    const current = flow;
    if (!current || current.step !== "push-confirm" || !current.pushToken || current.busy) return null;
    current.busy = "pushing";
    current.error = null;
    flowChanged();
    const result = await current.actions.push({ token: current.pushToken, confirm: true });
    if (flow !== current) return null;
    current.busy = "";
    if (!result?.ok) {
      current.error = result?.error ?? { code: "push-failed", message: "the push failed" };
      flowChanged();
      return result;
    }
    const where = `${result.remote}/${result.remoteBranch}`;
    // The service dropped the token with the push, so there is nothing to forget.
    current.pushToken = null;
    notify(context, `Pushed ${result.branch} to ${where}`, "info");
    closeFlow();
    return result;
  }

  function dropPreview() {
    const current = flow;
    if (!current?.token) return;
    try {
      current.actions?.discard?.({ token: current.token });
    } catch {
      // best effort
    }
    current.token = null;
    current.preview = null;
  }

  function toggleFile(path) {
    const current = flow;
    if (!current || current.step !== "files" || current.busy) return false;
    const file = current.files.find((entry) => entry.path === path);
    // A blocked file is shown and explained, never selected.
    if (!file || file.blocked) return false;
    if (current.selection.has(path)) current.selection.delete(path);
    else current.selection.add(path);
    current.error = null;
    flowChanged();
    return true;
  }

  // Ignore is a row action, not a commit step: it writes the captured folder's
  // root .gitignore through the service and stages and commits nothing. Only an
  // untracked, unflagged file can be ignored; a blocked or tracked file is shown
  // and refused. The captured directory and session are the ones the flow opened
  // with, so switching tabs cannot retarget the write at another project.
  async function ignoreFile(filePath) {
    const current = flow;
    if (!current || current.step !== "files" || current.busy) return null;
    const file = current.files.find((entry) => entry.path === filePath);
    if (!file || file.blocked || file.status !== "untracked") return null;
    if (typeof current.actions?.addToGitignore !== "function") {
      const reason = "the git service is missing the ignore step";
      current.error = { code: "ignore-unavailable", message: reason };
      notify(context, `Ignore: ${reason}`, "error");
      flowChanged();
      return { ok: false, error: current.error };
    }
    current.busy = "ignoring the file";
    current.error = null;
    flowChanged();
    let result;
    try {
      result = await current.actions.addToGitignore({ cwd: current.directory, file: filePath });
    } catch (error) {
      // A rejected service call is reported like a refused one: the flow stays
      // open with its choices, the busy flag clears, and the failure is named.
      if (flow !== current) return null;
      const detail =
        typeof error?.message === "string" && error.message
          ? error.message.slice(0, 200)
          : "the ignore request failed";
      current.busy = "";
      current.error = { code: "ignore-failed", message: `the file could not be ignored: ${detail}` };
      notify(context, `Ignore: ${current.error.message}`, "error");
      flowChanged();
      return { ok: false, error: current.error };
    }
    // A closed or replaced flow is never touched by a late answer.
    if (flow !== current) return null;
    current.busy = "";
    if (!result?.ok) {
      const error = result?.error ?? { code: "ignore-failed", message: "the file could not be ignored" };
      current.error = error;
      notify(context, `Ignore: ${error.message}`, "error");
      flowChanged();
      return result;
    }
    // "Added", not "Ignoring": a later nested rule in the same .gitignore can
    // still override the added pattern, so the write is not a guarantee.
    notify(context, `Added ${result.file ?? filePath} to .gitignore`, "info");
    // Refresh the list, but keep the user's manual choices and the attribution
    // notice. The ignored path is gone and never preselected; the new .gitignore
    // entry is not checked for them either.
    await loadSelection({
      preserve: { selection: [...current.selection], notice: current.notice },
    });
    return result;
  }

  async function runPreview() {
    const current = flow;
    if (!current || current.busy) return null;
    const files = [...current.selection];
    if (!files.length) {
      notify(context, "Select at least one file to commit", "warning");
      return null;
    }
    current.busy = "freezing the selection";
    current.error = null;
    current.notice = "";
    flowChanged();
    const result = await current.actions.preview({ cwd: current.directory, files });
    if (flow !== current) return null;
    current.busy = "";
    if (!result?.ok) {
      current.error = result?.error ?? { code: "preview-failed", message: "the preview failed" };
      current.step = "files";
      flowChanged();
      return result;
    }
    if (result.diffTruncated || result.diffUnavailable) {
      // No blind commit: without the exact patch the review is not a review.
      try {
        current.actions.discard?.({ token: result.token });
      } catch {
        // best effort
      }
      current.token = null;
      current.preview = null;
      current.step = "blocked";
      current.notice = result.diffUnavailable
        ? "git produced no patch for this selection, so nothing was reviewed or committed"
        : "the patch is larger than the review limit, so nothing was reviewed or committed";
      flowChanged();
      return result;
    }
    current.token = result.token;
    current.preview = result;
    current.step = "preview";
    flowChanged();
    return result;
  }

  function askEgress() {
    const current = flow;
    if (!current || current.step !== "preview" || !current.token) return false;
    current.step = "egress";
    current.error = null;
    flowChanged();
    return true;
  }

  // The only egress: the reviewed diff goes to the native Luna text API to write
  // a message. It runs only after the egress step was shown and approved, and the
  // step guard is what keeps that true: the API cannot generate from the review.
  async function runGenerate() {
    const current = flow;
    if (!current || current.step !== "egress" || !current.token || current.busy) return null;
    current.busy = "generating with Luna";
    current.error = null;
    flowChanged();
    const result = await current.actions.generateMessage({
      token: current.token,
      approveEgress: true,
    });
    if (flow !== current) return null;
    current.busy = "";
    if (!result?.ok) {
      current.error = result?.error ?? { code: "generate-failed", message: "no message was generated" };
      current.step = "preview";
      flowChanged();
      return result;
    }
    current.message = result.message;
    flowChanged();
    return promptMessage();
  }

  async function promptMessage() {
    const current = flow;
    if (!current || !current.token) return null;
    // The host prompt replaces this dialog, so the flow state lives here: the
    // dialog is mounted again once the message comes back.
    flowGeneration += 1;
    let text;
    try {
      text = await context.ui?.dialog?.prompt?.({
        title: "Commit message",
        description: "Used as-is. Only the selected files are committed.",
        // A plain descriptive subject: the prompt never teaches a Conventional
        // Commit prefix, which the generator is told not to produce.
        placeholder: "shorten the header spacing",
        value: current.message,
      });
    } catch {
      text = undefined;
    }
    if (flow !== current) return null;
    if (typeof text === "string" && text.trim()) {
      current.message = text.trim();
      current.step = "confirm";
      current.error = null;
      current.notice = "";
    } else if (typeof text === "string") {
      // The user cleared the draft on purpose. Committing the message they just
      // deleted would be wrong, so the draft goes and nothing is committed.
      current.message = "";
      current.step = "preview";
      current.error = null;
      current.notice = "The message was cleared, so nothing was committed";
    } else if (!current.message) {
      // Cancelled with no draft: the commit cannot go ahead.
      current.notice = "No message was set, so nothing was committed";
      current.step = "preview";
    } else {
      // Cancelled with an existing draft: keep it for editing. Cancelling a
      // prompt never commits on its own.
      current.step = "confirm";
    }
    mountFlow();
    flowChanged();
    return current.message || null;
  }

  async function runCommit() {
    const current = flow;
    if (!current || !current.token || current.busy) return null;
    // Only the confirm step may commit. A failure that carries a hash means the
    // commit is already in history, so the flow never returns to a retry step.
    if (current.step !== "confirm") return null;
    if (!current.message) {
      notify(context, "A commit message is required", "warning");
      return null;
    }
    current.busy = "committing the selected files";
    current.error = null;
    flowChanged();
    const result = await current.actions.commit({ token: current.token, message: current.message });
    if (flow !== current) return null;
    current.busy = "";
    if (!result?.ok) {
      const error = result?.error ?? { code: "commit-failed", message: "the commit failed" };
      current.error = error;
      if (error.hash) {
        // The commit exists. Show the hash and stop here: retrying would create a
        // second commit. The token stays so closing still drops the review.
        current.step = "committed";
        notify(context, `Commit exists as ${error.hash} — do not retry`, "error");
      }
      flowChanged();
      return result;
    }
    const count = Array.isArray(result.files) ? result.files.length : 0;
    const hash = typeof result.hash === "string" ? result.hash.slice(0, 12) : "";
    // The service dropped the preview with the commit, so there is nothing left
    // to discard.
    current.token = null;
    notify(
      context,
      `Committed ${count} file${count === 1 ? "" : "s"}${hash ? ` · ${hash}` : ""}`,
      "info",
    );
    closeFlow();
    return result;
  }

  function back() {
    const current = flow;
    if (!current || current.busy) return false;
    if (current.step === "blocked") {
      current.step = "files";
      current.notice = "";
      flowChanged();
      return true;
    }
    if (current.step === "preview") {
      // Going back to the file list drops the frozen review it described.
      dropPreview();
      current.step = "files";
      current.error = null;
      flowChanged();
      return true;
    }
    if (current.step === "egress" || current.step === "confirm") {
      current.step = "preview";
      current.error = null;
      flowChanged();
      return true;
    }
    if (current.step === "push-confirm") {
      current.step = "push-review";
      current.error = null;
      flowChanged();
      return true;
    }
    return false;
  }

  const commitFlow = {
    subscribe(listener) {
      flowListeners.add(listener);
      return () => flowListeners.delete(listener);
    },
    state: flowState,
    toggle: toggleFile,
    ignoreFile,
    back,
    cancel: () => closeFlow(),
    reload: () => loadSelection(),
    previewSelection: () => runPreview(),
    askEgress,
    approveEgress: () => runGenerate(),
    editMessage: () => promptMessage(),
    confirm: () => runCommit(),
    confirmPush: askPushConfirm,
    pushNow: () => runPush(),
  };

  // Both the session and the folder are captured at click time, so switching
  // tabs afterwards cannot widen the flow to another project.
  function openGit(flowName) {
    const title = GIT_FLOWS[flowName] ?? flowName;
    const sessionID = currentSessionID(context) ?? lastSessionID;
    const directory = resolveSessionDirectory(context, sessionID);
    const actions = service();
    if (!actions) {
      const reason = gitReason();
      notify(context, `${title}: ${reason}`, "warning");
      return { ok: false, code: "unavailable", message: reason };
    }
    if (flowName === "push") {
      if (typeof actions.previewPush !== "function" || typeof actions.push !== "function") {
        const reason = "the git service is missing the push steps";
        notify(context, `${title}: ${reason}`, "error");
        return { ok: false, code: "unavailable", message: reason };
      }
      beginFlow("push", { actions, sessionID, directory });
      return { ok: true, flow: flowName, sessionID, directory };
    }
    if (typeof actions.status !== "function" || typeof actions.preview !== "function") {
      const reason = "the git service is missing the commit steps";
      notify(context, `${title}: ${reason}`, "error");
      return { ok: false, code: "unavailable", message: reason };
    }
    beginFlow("commit", { actions, sessionID, directory });
    return { ok: true, flow: flowName, sessionID, directory };
  }

  // -------------------------------------------------------------- settings
  // Native settings extensibility: the installed plugin SDK exposes host slots
  // only for app/home/session/sidebar (`TuiHostSlotMap` in
  // @opencode-ai/plugin/dist/tui.d.ts) and no plugin settings registry. There
  // is therefore no host Settings page to extend, so these live in the plugin's
  // own dialog and stay reachable from the Launchpad palette.
  // A failed save must not look like a success: `setVisible` keeps the local
  // state truthful, and this reporter tells the user their choice will not
  // survive a restart. Deduplicated so a repeated failure is reported once.
  // Both settings stores report a failed save the same way, deduplicated per
  // store so a repeated failure is reported once.
  function makeReporter(errorSource) {
    const reported = { signature: null };
    return () => {
      const error = errorSource();
      if (!error) {
        reported.signature = null;
        return false;
      }
      const signature = `${error.code}:${error.message}`;
      if (reported.signature === signature) return false;
      reported.signature = signature;
      notify(context, `Settings not saved: ${error.message} (${error.code})`, "warning");
      return true;
    };
  }
  const reportSettingsError = makeReporter(() => visibility.error());
  const reportButtonConfigError = makeReporter(() => buttonConfig.error());
  const settingsErrorSubscriptions = [];
  for (const [store, report] of [
    [visibility, reportSettingsError],
    [buttonConfig, reportButtonConfigError],
  ]) {
    if (typeof store.subscribe === "function") {
      settingsErrorSubscriptions.push(
        store.subscribe((reason) => {
          if (reason === "error") report();
        }),
      );
    }
  }
  const unsubscribeSettingsError = () => {
    for (const off of settingsErrorSubscriptions) off();
  };

  function settingsItems() {
    const project = detector.detect(currentDirectory());
    const items = effectiveDescriptors(project).map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      visible: visibility.isVisible(descriptor.id),
    }));
    for (const control of CONTROL_ITEMS) {
      items.push({
        id: control.id,
        label: control.label,
        visible: visibility.isVisible(control.id),
      });
    }
    return items;
  }

  // The unresolved settings failure, or null. A Settings dialog renders this
  // instead of claiming everything is fine.
  function settingsError() {
    return visibility.error();
  }

  function setVisible(id, visible) {
    const changed = visibility.setVisible(id, visible);
    if (changed) reportSettingsError();
    return changed;
  }

  function showAllButtons() {
    const restored = visibility.showAll();
    if (restored) {
      notify(context, `Showing ${restored} hidden button${restored === 1 ? "" : "s"}`, "info");
      reportSettingsError();
    }
    return restored;
  }

  // How many buttons are hidden across every project, not just the active one:
  // visibility is keyed by stable action id, and Show all restores them all.
  function hiddenCount() {
    return visibility.hiddenIds().length;
  }

  function subscribeSettings(listener) {
    // Both stores notify: a label edit, a visibility toggle or a failed save all
    // reach the same listener.
    const offVisibility = visibility.subscribe(listener);
    const offButtons = buttonConfig.subscribe(listener);
    return () => {
      offVisibility();
      offButtons();
    };
  }

  function openSettings() {
    // The palette entry runs this same path, so pointing at the palette would
    // only tell the user to repeat the thing that just failed.
    const unavailable = "Settings dialog is unavailable in this host";
    if (typeof view?.SettingsDialog !== "function") {
      notify(context, unavailable, "warning");
      return false;
    }
    const dialog = context.ui?.dialog;
    const render = () => view.SettingsDialog({ context, runtime });
    // The typed host API is `TuiDialogStack.replace(render)` with a separate
    // `setSize`; the older show/set pair the other dialogs here use is the
    // fallback. Each API is attempted on its own, so a host whose preferred
    // call throws still gets the fallback - and a `catch` never claims the
    // dialog opened when it did not.
    const open = () => {
      if (typeof dialog?.replace === "function") {
        try {
          dialog.replace(render);
          return () => dialog.setSize?.("large");
        } catch {
          // fall through to the older API
        }
      }
      if (typeof dialog?.show === "function") {
        try {
          dialog.show(render);
          return () => dialog.set?.({ size: "large" });
        } catch {
          // fall through to the unavailable report
        }
      }
      return undefined;
    };

    const resize = open();
    if (resize) {
      // Sizing is cosmetic and runs after the dialog is already open: a host
      // that cannot resize still has a usable dialog, so this is not a failure
      // and the dialog is not opened twice.
      try {
        resize();
      } catch {
        // ignore: the dialog is open
      }
      return true;
    }
    notify(context, unavailable, "warning");
    return false;
  }

  // ------------------------------------------------------ button editor
  // The editor's data: what each button will run, including a button the user
  // never touched. A button whose command cannot be resolved is left out, so an
  // unsupported action can never be edited into something that runs.
  function buttonEditorItems() {
    const project = detector.detect(currentDirectory());
    const items = [];
    for (const descriptor of effectiveDescriptors(project)) {
      const resolution = resolveEffective(descriptor, project);
      if (!resolution.ok) continue;
      items.push({
        id: descriptor.id,
        label: descriptor.label,
        command: resolution.command,
        args: [...(resolution.args ?? [])],
        cwd: resolution.cwd,
        custom: Boolean(descriptor.custom),
        overridden: Boolean(descriptor.overridden),
      });
    }
    return items;
  }

  function buttonConfigError() {
    return buttonConfig.error();
  }

  // Input mistakes are the dialog's to explain, so they are not also toasted;
  // everything else (a built-in button, an unknown id, a failed save) is.
  const quietEditCodes = new Set(["invalid-label", "invalid-command", "invalid-args", "project-changed"]);
  function failEdit(code, reason) {
    if (!quietEditCodes.has(code)) notify(context, reason, "warning");
    return { ok: false, code, reason };
  }

  // The dialog is the one that can explain this and reopen itself, so the
  // refusal is returned rather than toasted.
  function staleCapture(captured, current) {
    if (captureMatches(captured, current)) return null;
    return failEdit("project-changed", "Project changed. Reopen the button editor.");
  }

  // A refused edit is reported here; a save the store could not persist is
  // reported by the error subscription, so nothing is announced twice.
  function finishEdit(result, idOf) {
    if (!result.ok) return failEdit(result.code, result.reason);
    reportButtonConfigError();
    return { ok: true, id: idOf() };
  }

  // Built-in controls have no discovered action behind them, so they can be
  // neither renamed nor deleted.
  function controlLocked(id) {
    return CONTROL_ITEMS.some((control) => control.id === id);
  }

  // Save a new hand-added button (no id) or update one (an id). The button's
  // executable and arguments are stored as typed; nothing is ever executed here.
  // `patch.project` is the dialog's capture of buttonProject(): when it no
  // longer matches, the edit is refused before anything is written, because the
  // id alone cannot say which project the user meant.
  function saveButton(patch = {}) {
    const dir = buttonProject();
    const stale = staleCapture(patch?.project, dir);
    if (stale) return stale;
    const id = typeof patch?.id === "string" && patch.id ? patch.id : undefined;
    if (id && controlLocked(id)) {
      return failEdit("control-locked", "This button is built in and cannot be changed.");
    }
    if (!id) {
      const result = buttonConfig.addCustom(dir, patch);
      return finishEdit(result, () => result.id);
    }
    const custom = buttonConfig.customById(id);
    if (custom) {
      // A button added by hand belongs to the project it was created in.
      if (custom.project !== dir) {
        return failEdit("unknown-action", "That button belongs to another project.");
      }
      return finishEdit(buttonConfig.updateCustom(id, patch), () => id);
    }
    // An override needs the discovered action to exist: a stale editor row for a
    // button the project no longer has must not save a command for it.
    const project = detector.detect(currentDirectory());
    const known = actionDescriptors(project).some((descriptor) => descriptor.id === id);
    if (!known) return failEdit("unknown-action", "That button is not part of this project.");
    return finishEdit(buttonConfig.saveOverride(dir, id, patch), () => id);
  }

  // Clears an override only. The discovered action, its id and its hidden/shown
  // state are untouched.
  function resetButton(id, projectCapture) {
    const dir = buttonProject();
    const stale = staleCapture(projectCapture, dir);
    if (stale) return stale;
    if (controlLocked(id)) {
      return failEdit("control-locked", "This button is built in and cannot be changed.");
    }
    if (buttonConfig.customById(id)) {
      return failEdit("not-overridable", "This button was added by hand; delete it instead.");
    }
    // A stale editor row for a button the project no longer has must not reset
    // anything, so the same rule as saving applies here.
    const project = detector.detect(currentDirectory());
    const known = actionDescriptors(project).some((descriptor) => descriptor.id === id);
    if (!known) return failEdit("unknown-action", "That button is not part of this project.");
    const result = buttonConfig.resetOverride(dir, id);
    if (!result.ok) return failEdit(result.code, result.reason);
    reportButtonConfigError();
    return { ok: true, id, reset: Boolean(result.removed) };
  }

  // Move one runner one place up or down in this project's full button order,
  // hidden buttons included. The order is keyed by immutable id, so a move
  // survives a later rename and never touches a run's identity. A built-in
  // control is not part of this list and is refused; a move at either end is a
  // no-op - nothing to write and nothing to report - not an error.
  function moveButton(id, direction, projectCapture) {
    const dir = buttonProject();
    const stale = staleCapture(projectCapture, dir);
    if (stale) return stale;
    if (direction !== "up" && direction !== "down") {
      return failEdit("invalid-direction", "Direction must be up or down.");
    }
    if (typeof id !== "string" || !id) {
      return failEdit("invalid-id", "A button id is required.");
    }
    if (controlLocked(id)) {
      return failEdit("control-locked", "This button is built in and cannot be reordered.");
    }
    const project = detector.detect(currentDirectory());
    const list = effectiveDescriptors(project).map((descriptor) => descriptor.id);
    const index = list.indexOf(id);
    if (index < 0) return failEdit("unknown-action", "That button is not part of this project.");
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= list.length) {
      return { ok: true, id, moved: false };
    }
    const next = list.slice();
    [next[index], next[target]] = [next[target], next[index]];
    const result = buttonConfig.saveOrder(dir, next);
    if (!result.ok) return failEdit(result.code, result.reason);
    reportButtonConfigError();
    return { ok: true, id, moved: true, order: result.order };
  }

  // Deletes a hand-added button. A run it already started keeps its identity -
  // the key comes from the immutable id and the captured directory - so its log
  // and its stop target survive the delete.
  function deleteButton(id, projectCapture) {
    const dir = buttonProject();
    const stale = staleCapture(projectCapture, dir);
    if (stale) return stale;
    if (controlLocked(id)) {
      return failEdit("control-locked", "This button is built in and cannot be changed.");
    }
    const custom = buttonConfig.customById(id);
    if (!custom) return failEdit("not-custom", "Only buttons added by hand can be deleted.");
    if (custom.project !== dir) {
      return failEdit("unknown-action", "That button belongs to another project.");
    }
    const result = buttonConfig.deleteCustom(id);
    if (!result.ok) return failEdit(result.code, result.reason);
    reportButtonConfigError();
    return { ok: true, id };
  }

  const runtime = {
    context,
    manager,
    detector,
    view,
    rows,
    currentDirectory,
    actionDescriptors: () => effectiveDescriptors(detector.detect(currentDirectory())),
    settingsItems,
    settingsError,
    setVisible,
    hiddenCount,
    showAllButtons,
    openSettings,
    subscribeSettings,
    // Button configuration: the editor's items, the project it is bound to, its
    // three mutations, and the unresolved save failure. `buttonEditorItems`
    // lists the active project's buttons only; visibility stays a separate,
    // global setting. A dialog captures `buttonProject()` when it opens and
    // passes it back to the mutations, so an edit cannot land in a project the
    // user switched to. A capture is optional for direct calls, which then edit
    // whatever project is active.
    buttonEditorItems,
    buttonProject,
    saveButton,
    resetButton,
    deleteButton,
    moveButton,
    buttonConfigError,
    disposeButtons: () => buttonConfig.dispose(),
    startAction,
    openLog,
    showLog,
    logKey,
    openGit,
    commitFlow,
    gitReady: () => Boolean(service()),
    stop: (key) => manager.stop(key),
    requestStop,
    stopAllRunners,
    send: (key, data) => sendKey(key, data),
    snapshot: (key) => manager.snapshot(key),
    // Drop every frozen preview and temp index the service is holding.
    disposeGit: () => {
      cancelFlow();
      try {
        service()?.dispose?.();
      } catch {
        // the service already cleaned up
      }
    },
    // Detach the internal settings-error reporter. `visibility.dispose()` is
    // called separately by setup, which owns the store's lifetime.
    disposeSettings: () => unsubscribeSettingsError(),
  };
  return runtime;
}

// A discovered script id is derived from a directory and a script name, so it
// carries percent-encoding and a ':' separator. Command ids are opaque to the
// host but must stay unique and free of separators it may reserve, so the
// palette derives a plain id and keeps the real action id only inside `run`.
function commandSuffix(id) {
  const plain = String(id).replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
  return plain || "action";
}

export function createCommands(context, runtime) {
  // The palette follows the project's discovered actions, including the ones
  // hidden from the grid: hiding a button never makes it unreachable, it only
  // removes it from the sidebar.
  const commands = [];
  const used = new Set();
  for (const descriptor of runtime.actionDescriptors()) {
    const base = `${PLUGIN_ID}.${commandSuffix(descriptor.id)}`;
    let id = base;
    for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
    used.add(id);
    commands.push({
      id,
      title: `Launchpad: ${descriptor.title}`,
      group: "Launchpad",
      palette: true,
      run: () => runtime.startAction(descriptor.id),
    });
  }

  commands.push(
    {
      id: `${PLUGIN_ID}.stop-all`,
      title: "Launchpad: stop all",
      group: "Launchpad",
      palette: true,
      run: () => runtime.stopAllRunners(),
    },
    {
      id: `${PLUGIN_ID}.log`,
      title: "Launchpad: show log",
      group: "Launchpad",
      palette: true,
      run: () => runtime.showLog(),
    },
    {
      id: `${PLUGIN_ID}.commit`,
      title: "Launchpad: commit session changes",
      group: "Launchpad",
      palette: true,
      run: () => runtime.openGit("commit"),
    },
    {
      id: `${PLUGIN_ID}.push`,
      title: "Launchpad: push",
      group: "Launchpad",
      palette: true,
      run: () => runtime.openGit("push"),
    },
    {
      id: `${PLUGIN_ID}.settings`,
      title: "Launchpad: settings",
      group: "Launchpad",
      palette: true,
      run: () => runtime.openSettings(),
    },
    {
      id: `${PLUGIN_ID}.show-all`,
      title: "Launchpad: show all buttons",
      group: "Launchpad",
      palette: true,
      run: () => runtime.showAllButtons(),
    },
  );

  return commands;
}

// The host persistence API is `context.kv` (TuiKV). Anything else - a stub, a
// legacy host, a missing key - falls back to the config file below.
function hostKv(context) {
  const kv = context?.kv;
  return kv && typeof kv.get === "function" && typeof kv.set === "function" ? kv : undefined;
}

// The V2 durable store: `context.storage.store(key, { initial })` returns
// `[reactiveSettings, asyncUpdate]`. It is feature-detected rather than
// version-checked, because the installed typings can lag the host.
function hostStorage(context) {
  const storage = context?.storage;
  return storage && typeof storage.store === "function" ? storage : undefined;
}

export async function setupWith(context, view, options = {}) {
  const manager = createRunnerManager({
    spawn: options.spawn,
    env: options.env,
    notifyMs: options.notifyMs,
    killGraceMs: options.killGraceMs,
    killProcessGroup: options.killProcessGroup,
    probeGroup: options.probeGroup,
    readProcessStat: options.readProcessStat,
    maxLines: options.maxLines,
    maxLineChars: options.maxLineChars,
    now: options.now,
  });
  const detector = createProjectDetector({ ttlMs: options.detectTtlMs });
  // Persistence, in the order the host offers it: the V2 durable store, then
  // the legacy `context.kv`, then a scoped user config file. Tests inject
  // `visibilityFile` so setup never reads or writes a real home config.
  const visibility = createVisibilityStore({
    storage: hostStorage(context),
    kv: hostKv(context),
    file: options.visibilityFile ?? defaultVisibilityFile(),
  });
  // Repository detection is filesystem-only and cached, so a paint never runs
  // git just to decide whether the Commit/Push controls exist.
  const gitDetector = createGitDetector({ ttlMs: options.gitDetectTtlMs, now: options.now });
  // Button edits use the same three-tier persistence, read-only at setup: the
  // store is created without writing, so merely loading the plugin leaves no
  // file behind. Tests inject `buttonConfigFile` to stay off a real home.
  const buttonConfig = createButtonConfigStore({
    storage: hostStorage(context),
    kv: hostKv(context),
    file: options.buttonConfigFile ?? defaultButtonConfigFile(),
    // Injected by tests so a failing write can be exercised without touching a
    // real config directory. The store defaults to the real filesystem.
    io: options.buttonConfigIo,
  });

  // The palette is one `global` keymap layer, rebuilt for the active project.
  //
  // Documented contract (V2 CLI plugin guide): `context.keymap.layer(factory)`
  // takes a factory that must be *pure*, is evaluated once without dependency
  // tracking to validate the initial command shape, and then evaluated
  // reactively. So the factory builds a fresh layer every call and keeps no
  // state of its own: it reads the live project through the runtime accessors
  // and returns new commands. A session switch re-evaluates it, which is what
  // refreshes the palette. Cost is carried by the caches below - the project
  // detector memoizes discovery per directory and the visibility store caches
  // its durable reads - not by a memo of the command array.
  function paletteLayer() {
    return { mode: "global", commands: createCommands(context, runtime) };
  }
  let disposePalette;

  // `git: undefined` keeps the built-in service; an injected service (or an
  // explicit null for tests) wins. Nothing here runs git at setup time.
  const runtime = createRuntime({
    context,
    manager,
    detector,
    view,
    git: options.git,
    gitOptions: options.gitOptions,
    visibility,
    gitDetector,
    buttonConfig,
  });
  const disposers = [];

  if (typeof context.ui?.slot === "function") {
    disposers.push(
      context.ui.slot({
        // `after` pins the block below every sidebar.content contribution,
        // whatever order plugins register in.
        after: "sidebar.content",
        render: (props) => view.Sidebar({ context, runtime, sessionID: props?.sessionID }),
      }),
    );
  }

  // Registered after the runtime exists: the host calls the factory during
  // setup, and the factory reads the runtime.
  try {
    const disposer = context.keymap?.layer?.(() => paletteLayer());
    disposePalette = typeof disposer === "function" ? disposer : undefined;
  } catch {
    // a host without a keymap simply offers no palette
  }

  // Children belong to this TUI process; do not leave them behind on exit.
  const onExit = () => manager.stopAll();
  process.once("exit", onExit);

  return () => {
    process.removeListener("exit", onExit);
    runtime.disposeGit();
    runtime.disposeSettings();
    manager.dispose();
    visibility.dispose();
    buttonConfig.dispose();
    try {
      disposePalette?.();
    } catch {
      // the layer was already released
    }
    for (const dispose of disposers) {
      try {
        dispose?.();
      } catch {
        // already disposed
      }
    }
  };
}

export default {
  id: PLUGIN_ID,
  async setup(context) {
    const view = await import("./view.jsx");
    return setupWith(context, view, context?.options ?? {});
  },
};
