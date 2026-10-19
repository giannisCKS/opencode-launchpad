// Git actions: a bounded, host-independent service for the commit and push
// flows, plus the Copilot-assisted commit message. Node builtins only, and no
// OpenCode import: the module must load under `node --test` and must not depend
// on any host API version.
//
// Safety model, in one place:
//  - Nothing is ever selected automatically. `status` reports which changed
//    files a session named and which it did not; every choice is the user's.
//  - A commit never touches the real index until it succeeds. The selected
//    content is frozen into a private temp index, reviewed from there, and only
//    the selected paths are reconciled back after the commit lands. Unrelated
//    staged work is preserved on success, cancel and failure alike; the
//    reconcile is skipped, not forced, when the real index changed while the
//    commit ran. A selected file that already has staged content is refused
//    outright: the worktree version would silently replace it.
//  - The reviewed diff is frozen with the HEAD it was built against, plus a hash
//    of the repo status and a digest of the real index. Every mutation rechecks
//    those and aborts if the repo moved, so a review can never commit something
//    else. The frozen index is never rebuilt: the recheck compares it to the
//    worktree instead of re-staging, so nothing is taken after the user confirms.
//  - Hooks run as normal. `--no-verify` is never passed; after the commit the
//    resulting tree is compared with the frozen one, and a hook that changed the
//    content is reported rather than hidden. A hook may also rewrite the commit
//    message or the real index; both outcomes are reported, never reverted.
//  - Once the commit exists the review token is spent and the temp state is
//    dropped. No error after that point is retryable, and every one of them
//    carries the commit hash.
//  - Every file name that reaches git is a literal pathspec
//    (`GIT_LITERAL_PATHSPECS=1`): a name like `[abc].txt` or `:(glob)**` selects
//    exactly that file and can never widen a stage, diff, commit or reconcile.
//  - Exactly one flow runs at a time; a second call is refused as busy.
//  - Push is previewed into a token that names the exact branch, HEAD, remote,
//    upstream ref and destination; push() rechecks all of them and sends an
//    explicit `HEAD:refs/heads/<branch>` refspec to that one remote. Never a
//    force, mirror or `--all` flag, never a detached HEAD, never a guessed
//    remote, never more than one push target, and never a tag the user did not
//    preview (`push.followTags` is forced off).
//  - Copilot sees only the selected diff, on stdin, with no tools available.
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const GIT_TIMEOUT_MS = 30_000;
const COPILOT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
// What we are willing to hand to Copilot. A larger diff is refused rather than
// truncated: a message generated from half a diff would describe a change the
// user is not about to make.
const MAX_DIFF_BYTES = 512 * 1024;
const MAX_MESSAGE_CHARS = 4000;
const MAX_MESSAGE_LINES = 60;
const MAX_PUSH_LOG_LINES = 50;

// Never hand the model a tool. `--available-tools` decides what the model can
// see; the deny rules decide what it may run, and denial beats --allow-all-tools.
// `--allow-all-tools` is present only because the installed CLI's own help says
// it is required for non-interactive mode; with no tools available it grants
// nothing, and the denials below are the belt to that braces.
const COPILOT_DENY_TOOLS = ["shell", "write", "url"];

// ---------------------------------------------------------------- pure helpers

// `git status --porcelain=v2 -z`. Records are NUL separated and the path is the
// last field, so a path with spaces survives: the record is split only up to the
// fixed columns. A rename (type 2) carries its original path in the next token.
export function parseStatusPorcelain(stdout) {
  const tokens = String(stdout ?? "").split("\0");
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const kind = token[0];
    if (kind === "?" || kind === "!") {
      // Ignored files are not candidates and are dropped here, not filtered later.
      if (kind === "?") entries.push({ path: token.slice(2), xy: "??", sub: "N...", kind: "untracked" });
      continue;
    }
    if (kind !== "1" && kind !== "2" && kind !== "u") continue;
    const parts = token.split(" ");
    const xy = parts[1] ?? "..";
    const entry = {
      path: parts.slice(kind === "u" ? 10 : kind === "2" ? 9 : 8).join(" "),
      xy,
      sub: parts[2] ?? "N...",
      index: xy[0],
      worktree: xy[1],
      kind: kind === "u" ? "unmerged" : "tracked",
    };
    if (kind === "2") {
      index += 1;
      entry.origPath = tokens[index] ?? "";
    }
    entries.push(entry);
  }
  return entries;
}

// The worktree column describes what a commit would take; the index column is
// the fallback when the worktree agrees with the index (".").
export function classifyStatus(entry) {
  if (entry.kind === "unmerged") return "conflicted";
  if (entry.kind === "untracked") return "untracked";
  if (typeof entry.sub === "string" && entry.sub.startsWith("S")) return "submodule";
  const code = entry.worktree && entry.worktree !== "." ? entry.worktree : entry.index;
  switch (code) {
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
    case "C":
      return "renamed";
    case "T":
      return "typechange";
    default:
      return "modified";
  }
}

// A repo-relative path we are willing to pass to git as a pathspec. Absolute
// paths, parent traversal and git's own metadata are refused.
export function isSafeRelPath(relPath) {
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  if (relPath.includes("\0")) return false;
  if (path.isAbsolute(relPath)) return false;
  const normalized = path.posix.normalize(relPath.replaceAll("\\", "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") return false;
  if (normalized === ".git" || normalized.startsWith(".git/")) return false;
  return true;
}

// Remote URLs and token headers can appear in git's stderr. Strip the shapes
// that carry credentials before any of it is surfaced to the UI.
export function redact(text) {
  return String(text ?? "")
    .replace(/(\/\/)[^/@\s]+@/g, "$1")
    .replace(/\b(gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]")
    .replace(/\b(x-access-token|Authorization):\s*\S+/gi, "$1: [redacted]");
}

function bounded(text, maxBytes = 4000) {
  const value = redact(text).trim();
  return value.length > maxBytes ? `${value.slice(0, maxBytes)}\n…` : value;
}

function hashOf(text) {
  return createHash("sha256").update(String(text ?? "")).digest("hex");
}

// The exact argv used for generation. Built here, not inline, so the tool-free
// claim is reviewable and testable: no shell permission, no path widening, no
// auto-update, no remote, no MCP server, no custom instructions, and the diff
// arrives on stdin. `--disallow-temp-dir` is deliberately absent: the call runs
// from a neutral temp directory, which that flag would make unusable.
export function buildCopilotArgs({ prompt }) {
  const args = [
    "--prompt",
    prompt,
    "--silent",
    "--output-format",
    "text",
    "--no-ask-user",
    "--no-custom-instructions",
    "--disable-builtin-mcps",
    "--no-auto-update",
    "--no-remote",
    "--no-remote-export",
    "--no-color",
    "--log-level",
    "none",
    "--allow-all-tools",
  ];
  for (const tool of COPILOT_DENY_TOOLS) args.push("--deny-tool", tool);
  // Last, with no values: keeps zero tools available to the model. Denials above
  // are the belt to this braces.
  args.push("--available-tools");
  return args;
}

// Turn a model reply into one commit message. Fences, leading bullets and stray
// quotes are removed; anything empty is refused so the UI never shows a blank.
export function sanitizeMessage(raw) {
  const text = String(raw ?? "")
    .replace(/\u001B\[[0-9;]*[A-Za-z]/g, "")
    .replace(/^\s*```[A-Za-z]*\s*$/gm, "")
    .replace(/^\s*```\s*$/gm, "")
    .trim();
  if (!text) return null;
  const lines = text
    .split("\n")
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_MESSAGE_LINES);
  const message = lines.join("\n").replace(/^["'`]+|["'`]+$/g, "").trim();
  if (!message) return null;
  return message.length > MAX_MESSAGE_CHARS ? message.slice(0, MAX_MESSAGE_CHARS).trimEnd() : message;
}

// ------------------------------------------------------------------- the exec

export function defaultExec({ file, args, cwd, env, input, timeoutMs, maxBytes = MAX_OUTPUT_BYTES }) {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { cwd, env: env ?? process.env, timeout: timeoutMs, maxBuffer: maxBytes, encoding: "utf8", windowsHide: true },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          // A number is the process exit code; a string is a spawn failure.
          code: typeof error?.code === "number" ? error.code : 0,
          spawnError: typeof error?.code === "string" ? error.code : null,
          timedOut: Boolean(error?.killed),
          stdout: stdout ?? "",
          stderr: stderr ?? "",
        });
      },
    );
    if (input !== undefined && child.stdin) child.stdin.end(input);
  });
}

// ------------------------------------------------------------------- the service

export function createGitActions(options = {}) {
  const exec = options.exec ?? defaultExec;
  const now = options.now ?? Date.now;
  const tmpRoot = options.tmpRoot ?? tmpdir();
  const gitBin = options.gitBin ?? "git";
  const copilotBin = options.copilotBin ?? "copilot";
  const timeoutMs = options.timeoutMs ?? GIT_TIMEOUT_MS;
  const copilotTimeoutMs = options.copilotTimeoutMs ?? COPILOT_TIMEOUT_MS;

  // One flow at a time. `active` is what refuses a second concurrent flow.
  let active = null;
  const previews = new Map();
  const pushTokens = new Map();
  const tempDirs = new Set();

  function fail(code, message) {
    return { ok: false, error: { code, message } };
  }

  function busy() {
    return fail("busy", active ? `Another git flow is active (${active.phase})` : "Another git flow is active");
  }

  function makeTempDir() {
    mkdirSync(tmpRoot, { recursive: true });
    const dir = mkdtempSync(path.join(tmpRoot, "project-runners-git-"));
    tempDirs.add(dir);
    return dir;
  }

  function dropTempDir(dir) {
    if (!dir) return;
    tempDirs.delete(dir);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort: a leftover temp dir is harmless
    }
  }

  function envWith(indexFile, extra = {}) {
    const env = { ...process.env, ...extra };
    if (indexFile) env.GIT_INDEX_FILE = indexFile;
    else delete env.GIT_INDEX_FILE;
    // Every user-supplied file name is a literal path. `--` ends option parsing
    // but does NOT disable pathspec magic, so a name like `[abc].txt` or
    // `:(glob)**` would otherwise match other files and widen the selection.
    env.GIT_LITERAL_PATHSPECS = "1";
    return env;
  }

  function git(cwd, args, extra = {}) {
    return exec({
      file: gitBin,
      args,
      cwd,
      // envWith, not process.env: no inherited GIT_INDEX_FILE, and literal
      // pathspecs everywhere.
      env: extra.env ?? envWith(null),
      input: extra.input,
      timeoutMs: extra.timeoutMs ?? timeoutMs,
      maxBytes: extra.maxBytes ?? MAX_OUTPUT_BYTES,
    });
  }

  async function resolveRoot(cwd) {
    if (typeof cwd !== "string" || cwd.length === 0) return fail("no-directory", "No directory was given");
    const result = await git(cwd, ["rev-parse", "--show-toplevel"]);
    if (!result.ok) return fail("not-a-repo", bounded(result.stderr) || "Not a git repository");
    const root = result.stdout.trim();
    if (!root) return fail("not-a-repo", "Not a git repository");
    return { ok: true, root };
  }

  async function headOf(root) {
    const result = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return result.ok ? result.stdout.trim() : null;
  }

  async function upstreamOf(root) {
    const result = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
    if (!result.ok) return null;
    const name = result.stdout.trim();
    return name && !name.includes("@{") ? name : null;
  }

  // A digest of the real index content. `git status` can refresh its stat cache
  // without changing what is staged, so the porcelain text is not enough to
  // notice a concurrent stage; the recorded entries are. `ls-files --stage` only
  // reads: nothing is written to the user's repository to take this measurement.
  async function realIndexDigest(root) {
    const result = await git(root, ["ls-files", "--stage", "-z"], { env: envWith(null) });
    return result.ok ? hashOf(result.stdout) : null;
  }

  // Paths among `paths` whose staged content differs from HEAD. Any of them makes
  // the selection unsafe to freeze: staging the worktree version would drop what
  // the user staged, and reconciling afterwards would lose it for good.
  async function stagedAmong(root, paths) {
    const result = await git(root, ["diff", "--cached", "--name-only", "-z", "--", ...paths]);
    if (!result.ok) return { ok: false, error: fail("status-failed", bounded(result.stderr) || "Could not read the index") };
    return { ok: true, paths: result.stdout.split("\0").filter(Boolean) };
  }

  // A symlink whose target leaves the repo is refused: the selection would be
  // pointed at something the user never reviewed.
  function pathBlockReason(root, rootReal, relPath) {
    if (!isSafeRelPath(relPath)) return "unsafe-path";
    const absolute = path.join(root, relPath);
    try {
      if (!existsSync(absolute)) return null;
      if (!lstatSync(absolute).isSymbolicLink()) return null;
      const target = realpathSync(absolute);
      if (target === rootReal || target.startsWith(`${rootReal}${path.sep}`)) return null;
      return "symlink-escape";
    } catch {
      return null;
    }
  }

  function decorate(root, rootReal, entry, sessionSet) {
    const status = classifyStatus(entry);
    const unsafe = pathBlockReason(root, rootReal, entry.path);
    // Conflicts, submodules and renames are shown but never committable: each
    // one has more than one reasonable meaning, so the user picks by hand.
    const blocked =
      unsafe ??
      (status === "conflicted"
        ? "conflicted"
        : status === "submodule"
          ? "submodule"
          : status === "renamed"
            ? "ambiguous-rename"
            : null);
    return {
      path: entry.path,
      origPath: entry.origPath ?? null,
      status,
      index: entry.index ?? null,
      worktree: entry.worktree ?? null,
      session: sessionSet.has(entry.path),
      // Flagged, never chosen: an unattributed change is shown as such.
      unattributed: !sessionSet.has(entry.path),
      blocked,
    };
  }

  // The full repo picture plus the candidate split. No selection happens here.
  async function status({ cwd, sessionFiles = [] } = {}) {
    if (active) return busy();
    const resolved = await resolveRoot(cwd);
    if (!resolved.ok) return resolved;
    const { root } = resolved;
    const rootReal = realpathSync(root);

    const statusResult = await git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    if (!statusResult.ok) return fail("status-failed", bounded(statusResult.stderr) || "git status failed");

    const branchResult = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const branch = branchResult.ok ? branchResult.stdout.trim() : null;
    const head = await headOf(root);
    const upstream = await upstreamOf(root);
    let ahead = null;
    if (upstream) {
      const aheadResult = await git(root, ["rev-list", "--count", `${upstream}..HEAD`]);
      if (aheadResult.ok) ahead = Number.parseInt(aheadResult.stdout.trim(), 10) || 0;
    }

    // Session paths are compared repo-relative, so a session that reports
    // absolute paths still matches; nothing is matched by suffix or guesswork.
    const sessionSet = new Set();
    for (const file of sessionFiles) {
      if (typeof file !== "string" || file.length === 0) continue;
      const absolute = path.isAbsolute(file) ? file : path.join(root, file);
      const rel = path.relative(root, absolute);
      if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) sessionSet.add(rel.split(path.sep).join("/"));
    }

    const entries = parseStatusPorcelain(statusResult.stdout);
    const files = entries.map((entry) => decorate(root, rootReal, entry, sessionSet));

    return {
      ok: true,
      root,
      branch,
      detached: branch === null,
      head,
      upstream,
      upstreamResolved: upstream !== null,
      ahead,
      files,
      candidates: files.filter((file) => file.session),
      unattributed: files.filter((file) => file.unattributed),
      statusHash: hashOf(statusResult.stdout),
    };
  }

  // Build the frozen index for a selection. Shared by preview and the recheck,
  // so both describe exactly the same content.
  async function stageInto(root, indexFile, head, paths) {
    const base = head ? ["read-tree", "HEAD"] : ["read-tree", "--empty"];
    const tree = await git(root, base, { env: envWith(indexFile) });
    if (!tree.ok) return fail("index-failed", bounded(tree.stderr) || "Could not read HEAD into the temp index");
    const add = await git(root, ["add", "-A", "--", ...paths], { env: envWith(indexFile) });
    if (!add.ok) return fail("index-failed", bounded(add.stderr) || "Could not stage the selection");
    const written = await git(root, ["write-tree"], { env: envWith(indexFile) });
    if (!written.ok) return fail("index-failed", bounded(written.stderr) || "Could not write the selection tree");
    return { ok: true, tree: written.stdout.trim() };
  }

  // Freeze the selection and produce the diff the user reviews. The real index
  // is not touched: everything happens in a private temp index.
  async function preview({ cwd, files } = {}) {
    if (active) return busy();
    const selected = Array.isArray(files) ? files.filter((file) => typeof file === "string") : [];
    if (selected.length === 0) return fail("no-selection", "No files were selected");
    for (const file of selected) {
      if (!isSafeRelPath(file)) return fail("unsafe-path", `Refusing the path ${file}`);
    }

    const resolved = await resolveRoot(cwd);
    if (!resolved.ok) return resolved;
    const { root } = resolved;
    const rootReal = realpathSync(root);

    const statusResult = await git(root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    if (!statusResult.ok) return fail("status-failed", bounded(statusResult.stderr) || "git status failed");
    const entries = parseStatusPorcelain(statusResult.stdout);
    const byPath = new Map(entries.map((entry) => [entry.path, entry]));

    // Every selection is revalidated against the live repo: a file that is now a
    // conflict, a submodule or an ambiguous rename is refused, not committed.
    const details = [];
    for (const file of selected) {
      const entry = byPath.get(file);
      if (!entry) return fail("not-changed", `${file} is not changed in this repository`);
      const decorated = decorate(root, rootReal, entry, new Set([file]));
      if (decorated.blocked) return fail(decorated.blocked, `${file} cannot be committed (${decorated.blocked})`);
      details.push(decorated);
    }

    const head = await headOf(root);

    // A file that already has staged content is refused: freezing it from the
    // worktree would replace what the user staged, and the reconcile afterwards
    // would erase it. The user resolves the staging first.
    const stagedAlready = await stagedAmong(root, selected);
    if (!stagedAlready.ok) return stagedAlready.error;
    if (stagedAlready.paths.length > 0) {
      return fail("staged-selection", `These files already have staged changes: ${stagedAlready.paths.join(", ")}. Commit or unstage them first.`);
    }

    const dir = makeTempDir();
    const indexFile = path.join(dir, "index");
    const staged = await stageInto(root, indexFile, head, selected);
    if (!staged.ok) {
      dropTempDir(dir);
      return staged;
    }

    const diffArgs = ["diff", "--cached", "--no-color", "--no-ext-diff", "--no-textconv", "--patch"];
    const diff = await git(root, diffArgs, { env: envWith(indexFile), maxBytes: MAX_DIFF_BYTES });
    // A diff that does not fit is refused rather than truncated: the user reviews
    // this patch before confirming, so there is no blind commit of a selection
    // they never saw. Nothing has been written, so the review is simply dropped.
    if (!diff.ok || diff.stdout.length >= MAX_DIFF_BYTES) {
      dropTempDir(dir);
      return fail("diff-too-large", "The selected diff is too large to review; select fewer files");
    }
    const diffText = diff.stdout;
    const stat = await git(root, ["diff", "--cached", "--no-color", "--stat"], { env: envWith(indexFile) });

    const indexDigest = await realIndexDigest(root);
    const token = randomUUID();
    const frozen = {
      token,
      root,
      files: selected,
      indexFile,
      dir,
      head,
      tree: staged.tree,
      indexDigest,
      statusHash: hashOf(statusResult.stdout),
      diff: diffText,
      createdAt: now(),
    };
    previews.set(token, frozen);

    return {
      ok: true,
      token,
      files: details,
      diff: diffText,
      stat: stat.ok ? stat.stdout : "",
      head,
      tree: staged.tree,
      statusHash: frozen.statusHash,
    };
  }

  // A frozen review is only valid while the repo stands still. Anything that
  // moved since the review aborts the mutation instead of committing the wrong
  // thing. Nothing is staged here: the frozen index is compared to the worktree,
  // so the content the user approved is exactly what gets committed.
  async function recheck(frozen) {
    const head = await headOf(frozen.root);
    if ((head ?? null) !== (frozen.head ?? null)) return fail("repo-changed", "HEAD moved since the review");
    // The real index content, not just its porcelain columns: a concurrent stage
    // of an unrelated file must stop the flow, or the reconcile could destroy it.
    const indexDigest = await realIndexDigest(frozen.root);
    if (indexDigest !== frozen.indexDigest) return fail("index-changed", "The staged index changed since the review");
    const statusResult = await git(frozen.root, ["status", "--porcelain=v2", "-z", "--untracked-files=all"]);
    if (!statusResult.ok) return fail("status-failed", bounded(statusResult.stderr) || "git status failed");
    if (hashOf(statusResult.stdout) !== frozen.statusHash) return fail("repo-changed", "The working tree changed since the review");
    const drift = await git(frozen.root, ["diff", "--quiet", "--", ...frozen.files], { env: envWith(frozen.indexFile) });
    if (drift.ok) return { ok: true };
    if (drift.code === 1) return fail("repo-changed", "The selected files changed since the review");
    return fail("diff-failed", bounded(drift.stderr) || "Could not compare the selection with the review");
  }

  function requirePreview(token) {
    const frozen = previews.get(token);
    if (!frozen) return fail("unknown-preview", "This review is no longer valid; review the selection again");
    return { ok: true, frozen };
  }

  // Every failure that happens after the commit exists must say so: the work is
  // already in history, and retrying would create a second commit.
  function committedError(code, detail, committed) {
    const hash = committed.hash ?? null;
    return {
      ok: false,
      error: {
        code,
        message: `${detail} The commit exists as ${hash ?? "HEAD"}; do not retry, it is already committed.`,
        hash,
      },
    };
  }

  async function commit({ token, message } = {}) {
    if (active) return busy();
    const found = requirePreview(token);
    if (!found.ok) return found;
    const { frozen } = found;
    const text = typeof message === "string" ? message.trim() : "";
    if (!text) return fail("empty-message", "A commit message is required");
    if (text.length > MAX_MESSAGE_CHARS) return fail("message-too-long", "The commit message is too long");
    if (text.includes("\0")) return fail("bad-message", "The commit message contains a NUL byte");

    active = { token, phase: "commit", startedAt: now() };
    try {
      const checked = await recheck(frozen);
      if (!checked.ok) return checked;

      // The temp index is the only index involved, so the user's staged work is
      // untouched until the commit exists. Hooks run normally: --no-verify is
      // never passed, and the tree they produce is verified below.
      const result = await git(frozen.root, ["commit", "-m", text], { env: envWith(frozen.indexFile) });
      if (!result.ok) {
        return fail("commit-failed", bounded(result.stderr || result.stdout) || "git commit failed");
      }

      // The commit now exists. The review token is spent and the temp index is
      // gone: nothing below can re-run the commit, and no failure here is
      // retryable, so every one of them carries the hash.
      previews.delete(token);
      dropTempDir(frozen.dir);

      const hash = await headOf(frozen.root);
      const committed = { hash, message: text };
      // A hook may legitimately rewrite the message; report what was committed,
      // not what was typed.
      if (hash) {
        const messageResult = await git(frozen.root, ["show", "-s", "--format=%B", hash]);
        if (messageResult.ok && messageResult.stdout.trim()) committed.message = messageResult.stdout.trim();
      }
      // A pre-commit hook can rewrite the index it was given. Compare what was
      // committed with what the user reviewed before reporting success.
      const treeResult = await git(frozen.root, ["rev-parse", `${hash ?? "HEAD"}^{tree}`]);
      const actualTree = treeResult.ok ? treeResult.stdout.trim() : null;
      if (actualTree === null) {
        return committedError("tree-unreadable", "The commit landed, but its tree could not be read to verify it.", committed);
      }
      if (actualTree !== frozen.tree) {
        return committedError(
          "hook-changed-tree",
          `A git hook changed what was committed (${actualTree} instead of the reviewed ${frozen.tree}).`,
          committed,
        );
      }

      // Reconcile only the committed paths, exactly as a normal commit would:
      // every other staged path keeps its content. The digest was taken at
      // review time, so this is a best-effort guard, not a lock: if the real
      // index changed while the commit ran, the reset is skipped rather than
      // erasing that change.
      const indexDigest = await realIndexDigest(frozen.root);
      if (indexDigest !== frozen.indexDigest) {
        return committedError(
          "reconcile-index-changed",
          "The staged index changed while the commit ran, so it was left untouched.",
          committed,
        );
      }
      const reconcile = await git(frozen.root, ["reset", "-q", hash ?? "HEAD", "--", ...frozen.files]);
      if (!reconcile.ok) {
        return committedError("reconcile-failed", bounded(reconcile.stderr) || "The index could not be reconciled.", committed);
      }
      return { ok: true, hash, files: frozen.files, message: committed.message };
    } finally {
      active = null;
    }
  }

  // Generate a message from the reviewed diff. Refused unless the caller states
  // that sending this diff to Copilot is approved: egress is the user's call.
  async function generateMessage({ token, approveEgress } = {}) {
    if (active) return busy();
    if (approveEgress !== true) return fail("egress-not-approved", "Sending the diff to Copilot was not approved");
    const found = requirePreview(token);
    if (!found.ok) return found;
    const { frozen } = found;

    active = { token, phase: "generate", startedAt: now() };
    try {
      const checked = await recheck(frozen);
      if (!checked.ok) return checked;

      const prompt = [
        "Write a plain, descriptive commit message for the staged diff supplied on stdin.",
        "Do not use Conventional Commit prefixes such as feat:, fix:, chore:, or type(scope):.",
        "Do not include AI attribution or generated-by text.",
        "Reply with the message only: one subject line, then an optional blank line and short body.",
        "No code fences, no commentary, no bullet markers.",
        `Files: ${frozen.files.join(", ")}`,
      ].join("\n");

      // Authentication lives in COPILOT_HOME (default ~/.copilot), so the call
      // uses the user's real one: pointing it at a private directory would drop
      // stored credentials and fail. A caller that authenticates through
      // COPILOT_GITHUB_TOKEN/GH_TOKEN/GITHUB_TOKEN can pass `copilotHome` to
      // keep this call's session state out of the real home instead. The CLI's
      // own help offers no flag to disable session persistence in prompt mode,
      // so that is the documented tradeoff.
      const env = envWith(null, options.copilotHome ? { COPILOT_HOME: options.copilotHome } : {});
      // COPILOT_ALLOW_ALL="true" additionally trusts the working directory,
      // loading its skills, plugins, MCP servers and hooks. Never let it apply.
      delete env.COPILOT_ALLOW_ALL;
      // The cwd is the review's temp directory, not the repo: nothing about the
      // project is reachable, and no instruction file can be picked up.
      const result = await exec({
        file: copilotBin,
        args: buildCopilotArgs({ prompt }),
        cwd: frozen.dir,
        env,
        input: frozen.diff,
        timeoutMs: copilotTimeoutMs,
        maxBytes: MAX_OUTPUT_BYTES,
      });
      if (!result.ok) {
        return fail("copilot-failed", bounded(result.stderr || result.stdout) || "Copilot did not return a message");
      }
      const cleaned = sanitizeMessage(result.stdout);
      const message = cleaned?.replace(/^(?:feat|fix|chore|docs|style|refactor|perf|test|build|ci|revert)(?:\([^\r\n)]*\))?!?:\s*/i, "").trim();
      if (!message) return fail("empty-message", "Copilot returned no usable message");
      return { ok: true, message };
    } finally {
      active = null;
    }
  }

  // Resolve the exact push target. The destination comes from `@{push}`, not
  // from the fetch upstream: branch.<name>.pushRemote and remote.pushDefault can
  // send the branch somewhere else, so a guessed remote is never used.
  async function pushTarget(root) {
    const branchResult = await git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const branch = branchResult.ok ? branchResult.stdout.trim() : null;
    if (!branch) return fail("detached", "Refusing to push a detached HEAD");
    const head = await headOf(root);
    if (!head) return fail("unborn", "There is no commit to push");

    const pushRef = await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{push}"]);
    const upstream = pushRef.ok ? pushRef.stdout.trim() : "";
    const slash = upstream.indexOf("/");
    if (!upstream || slash <= 0) return fail("no-upstream", `No push destination is configured for ${branch}`);
    const remote = upstream.slice(0, slash);
    const remoteBranch = upstream.slice(slash + 1);
    // A remote name or ref that starts with a dash would be read as a flag.
    if (remote.startsWith("-") || remoteBranch.startsWith("-")) return fail("unsafe-ref", "The configured push destination is unsafe");
    const branchCheck = await git(root, ["check-ref-format", "--branch", remoteBranch]);
    if (!branchCheck.ok) return fail("unsafe-ref", `${remoteBranch} is not a valid branch name`);

    const mirror = await git(root, ["config", "--bool", "--get", `remote.${remote}.mirror`]);
    if (mirror.ok && mirror.stdout.trim() === "true") return fail("mirror-remote", `The remote ${remote} is configured as a mirror; refusing to push`);
    // `remote get-url --push` applies url.<base>.insteadOf, so the destination
    // shown is the URL git will actually contact, and --all lists every pushurl.
    const urls = await git(root, ["remote", "get-url", "--push", "--all", remote]);
    const destinations = urls.ok ? urls.stdout.split("\n").map((line) => line.trim()).filter(Boolean) : [];
    if (destinations.length === 0) return fail("no-destination", `The remote ${remote} has no push URL`);
    if (destinations.length > 1) {
      return fail("multiple-push-targets", `The remote ${remote} pushes to ${destinations.map((url) => redact(url)).join(", ")}; refusing to guess`);
    }

    const countResult = await git(root, ["rev-list", "--count", `${upstream}..HEAD`]);
    if (!countResult.ok) return fail("upstream-unresolved", `Cannot compare with ${upstream}`);
    const outgoing = Number.parseInt(countResult.stdout.trim(), 10) || 0;
    const hashesResult = await git(root, ["rev-list", "-n", String(MAX_PUSH_LOG_LINES), `${upstream}..HEAD`]);
    const hashes = hashesResult.ok ? hashesResult.stdout.trim().split("\n").filter(Boolean) : [];

    return { ok: true, branch, head, remote, remoteBranch, upstream, destination: destinations[0], destinations, outgoing, hashes };
  }

  // Preview the push. Nothing is sent: the returned token carries the exact
  // branch, HEAD, remote, upstream ref, destination and outgoing commits, and
  // push() refuses a token whose target has moved since.
  async function previewPush({ cwd } = {}) {
    if (active) return busy();
    const resolved = await resolveRoot(cwd);
    if (!resolved.ok) return resolved;
    const target = await pushTarget(resolved.root);
    if (!target.ok) return target;
    const token = randomUUID();
    pushTokens.set(token, { ...target, token, root: resolved.root, createdAt: now() });
    return { ok: true, token, ...publicPush(target) };
  }

  function publicPush(target) {
    return {
      branch: target.branch,
      head: target.head,
      remote: target.remote,
      remoteBranch: target.remoteBranch,
      upstream: target.upstream,
      destination: target.destination,
      destinations: target.destinations,
      outgoing: target.outgoing,
      hashes: target.hashes,
    };
  }

  // Push one approved target. Separate from commit, separately confirmed, and
  // never forced: the remote and an explicit refspec are the only arguments.
  async function push({ token, confirm } = {}) {
    if (active) return busy();
    if (confirm !== true) return fail("unconfirmed", "Pushing was not confirmed");
    const frozen = pushTokens.get(token);
    if (!frozen) return fail("unknown-push", "This push preview is no longer valid; preview the push again");

    active = { token, phase: "push", startedAt: now() };
    try {
      // Revalidate the approved target immediately before the only network
      // mutation: the same resolution runs again and every field must match.
      const now = await pushTarget(frozen.root);
      if (!now.ok) return now;
      if (now.head !== frozen.head) return fail("repo-changed", "HEAD moved since the push was approved");
      if (now.branch !== frozen.branch) return fail("repo-changed", "The branch changed since the push was approved");
      if (now.upstream !== frozen.upstream) return fail("repo-changed", "The push destination changed since the push was approved");
      if (now.destination !== frozen.destination) return fail("repo-changed", "The remote URL changed since the push was approved");
      if (now.remote !== frozen.remote || now.remoteBranch !== frozen.remoteBranch) return fail("repo-changed", "The remote changed since the push was approved");

      // Explicit remote and refspec, no force flag of any kind. The refspec on
      // the command line means push.default and remote.<name>.push are not
      // consulted at all. push.followTags is switched off twice over, because
      // otherwise an annotated tag reachable from the pushed commits would ride
      // along without ever being previewed.
      const refspec = `HEAD:refs/heads/${frozen.remoteBranch}`;
      const result = await git(frozen.root, ["-c", "push.followTags=false", "push", "--no-follow-tags", frozen.remote, refspec], {
        timeoutMs: timeoutMs * 4,
      });
      if (!result.ok) return fail("push-failed", bounded(result.stderr || result.stdout) || "git push failed");
      pushTokens.delete(token);
      return {
        ok: true,
        ...publicPush(frozen),
        output: bounded(`${result.stdout}\n${result.stderr}`, 2000),
      };
    } finally {
      active = null;
    }
  }

  // Release a token by hand: either a frozen commit review or a push preview.
  // A cancelled flow must not leave a token that the UI has forgotten but the
  // module still honours, so both kinds are dropped here.
  function discard({ token } = {}) {
    const frozen = previews.get(token);
    if (frozen) {
      previews.delete(token);
      dropTempDir(frozen.dir);
      return { ok: true };
    }
    if (pushTokens.has(token)) {
      pushTokens.delete(token);
      return { ok: true };
    }
    return { ok: false, error: { code: "unknown-preview", message: "Nothing to discard" } };
  }

  // Drop every temp index. Called when the UI closes; the user's real index was
  // never touched, so there is nothing to undo.
  function dispose() {
    for (const token of [...previews.keys()]) discard({ token });
    pushTokens.clear();
    for (const dir of [...tempDirs]) dropTempDir(dir);
    active = null;
  }

  function activeFlow() {
    return active ? { ...active } : null;
  }

  return { status, preview, commit, generateMessage, previewPush, push, discard, dispose, active: activeFlow };
}

// --------------------------------------------------------------- CLI helpers

// `copilot` needs a real executable; a caller that has no Copilot must be able
// to ask before offering the button.
export function copilotAvailable({ exec, copilotBin = "copilot" } = {}) {
  const run = exec ?? defaultExec;
  return run({ file: copilotBin, args: ["--version"], cwd: tmpdir(), timeoutMs: 10_000 }).then((result) => result.ok);
}

export { COPILOT_TIMEOUT_MS, GIT_TIMEOUT_MS, MAX_DIFF_BYTES, MAX_MESSAGE_CHARS };
