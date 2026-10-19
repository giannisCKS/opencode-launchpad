// Tests for git.js. Every repository here is a synthetic temp repo under
// /tmp/opencode; the user's real repos, index and remotes are never touched and
// no network is used. Each repo is removed in the global `after` hook.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  MAX_MESSAGE_CHARS,
  buildCopilotArgs,
  classifyStatus,
  createGitActions,
  defaultExec,
  isSafeRelPath,
  parseStatusPorcelain,
  redact,
  sanitizeMessage,
} from "./git.js";

const BASE = process.env.PROJECT_RUNNERS_TEST_TMP || "/tmp/opencode";
mkdirSync(BASE, { recursive: true });

// Hermetic git: no user/system config, no prompt, no signing, no editor.
const configDir = mkdtempSync(path.join(BASE, "git-test-config-"));
writeFileSync(path.join(configDir, "global"), "");
process.env.GIT_CONFIG_GLOBAL = path.join(configDir, "global");
process.env.GIT_CONFIG_SYSTEM = path.join(configDir, "system");
process.env.GIT_TERMINAL_PROMPT = "0";
process.env.GIT_ASKPASS = "/bin/true";
process.env.EDITOR = "true";
process.env.GIT_PAGER = "cat";

const created = [configDir];
test.after(() => {
  for (const dir of created) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
});

function tempDir(prefix) {
  const dir = mkdtempSync(path.join(BASE, prefix));
  created.push(dir);
  return dir;
}

function gitIn(dir, ...args) {
  // The fixtures themselves must name files literally: a test that creates
  // `[abc].txt` would otherwise stage `a.txt` through pathspec globbing.
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GIT_LITERAL_PATHSPECS: "1" },
  });
}

function makeRepo() {
  const dir = tempDir("git-test-");
  gitIn(dir, "init", "-q", "-b", "main");
  gitIn(dir, "config", "user.name", "Test");
  gitIn(dir, "config", "user.email", "test@example.com");
  gitIn(dir, "config", "commit.gpgsign", "false");
  return {
    dir,
    git: (...args) => gitIn(dir, ...args),
    write: (name, content) => writeFileSync(path.join(dir, name), content),
    path: (name) => path.join(dir, name),
  };
}

function baseline(repo) {
  repo.write("a.txt", "one\n");
  repo.write("b.txt", "bee\n");
  repo.write("d.txt", "dee\n");
  repo.git("add", "a.txt", "b.txt", "d.txt");
  repo.git("commit", "-qm", "init");
}

function newActions(extra = {}) {
  return createGitActions({ tmpRoot: BASE, ...extra });
}

// ------------------------------------------------------------ pure functions

test("parseStatusPorcelain reads v2 -z records, keeping spaces and rename origins", () => {
  const stdout =
    "1 MM N... 100644 100644 100644 aaa bbb src/a.txt\0" +
    "2 R. N... 100644 100644 100644 aaa bbb R100 src/new.txt\0src/old.txt\0" +
    "u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflict.txt\0" +
    "1 .M S..U 160000 160000 160000 aaa bbb sub\0" +
    "? src/untracked file.txt\0" +
    "! src/ignored.txt\0";
  const entries = parseStatusPorcelain(stdout);
  assert.deepEqual(
    entries.map((entry) => entry.path),
    ["src/a.txt", "src/new.txt", "src/conflict.txt", "sub", "src/untracked file.txt"],
  );
  assert.equal(entries[0].index, "M");
  assert.equal(entries[1].origPath, "src/old.txt");
  assert.equal(entries[2].kind, "unmerged");
  assert.equal(entries[4].kind, "untracked");
  // Ignored files are dropped entirely, not offered as candidates.
  assert.ok(!entries.some((entry) => entry.path.includes("ignored")));
});

test("classifyStatus names the worktree meaning of each entry", () => {
  assert.equal(classifyStatus({ kind: "untracked" }), "untracked");
  assert.equal(classifyStatus({ kind: "unmerged" }), "conflicted");
  assert.equal(classifyStatus({ kind: "tracked", sub: "S..U", index: ".", worktree: "M" }), "submodule");
  assert.equal(classifyStatus({ kind: "tracked", sub: "N...", index: "M", worktree: "M" }), "modified");
  assert.equal(classifyStatus({ kind: "tracked", sub: "N...", index: "A", worktree: "." }), "added");
  assert.equal(classifyStatus({ kind: "tracked", sub: "N...", index: "D", worktree: "." }), "deleted");
  assert.equal(classifyStatus({ kind: "tracked", sub: "N...", index: "R", worktree: "." }), "renamed");
  assert.equal(classifyStatus({ kind: "tracked", sub: "N...", index: "T", worktree: "T" }), "typechange");
});

test("isSafeRelPath refuses absolute, parent and .git paths", () => {
  for (const good of ["a.txt", "src/a.txt", "a b.txt", "a/../b.txt"]) {
    assert.equal(isSafeRelPath(good), true, good);
  }
  for (const bad of ["", "/etc/passwd", "../evil", "..", ".git", ".git/config", "x/../../y", "a\0b"]) {
    assert.equal(isSafeRelPath(bad), false, bad);
  }
});

test("redact removes credentials from git output", () => {
  assert.equal(redact("https://user:tok@github.com/x.git"), "https://github.com/x.git");
  assert.match(redact(`token ghp_${"a".repeat(24)}`), /\[redacted\]/);
  assert.match(redact("Authorization: Bearer abc123"), /Authorization: \[redacted\]/);
});

test("sanitizeMessage strips fences and bullets, and refuses empty output", () => {
  assert.equal(sanitizeMessage("```\nfeat(x): add thing\n```"), "feat(x): add thing");
  assert.equal(sanitizeMessage("- one\n- two"), "one\ntwo");
  assert.equal(sanitizeMessage('"feat: quoted"'), "feat: quoted");
  assert.equal(sanitizeMessage(""), null);
  assert.equal(sanitizeMessage("   \n  "), null);
  assert.equal(sanitizeMessage("\u001B[31mfeat: red\u001B[0m"), "feat: red");
  assert.equal(sanitizeMessage("x".repeat(MAX_MESSAGE_CHARS + 100)).length, MAX_MESSAGE_CHARS);
});

test("buildCopilotArgs grants no tool access and takes the diff on stdin", () => {
  const args = buildCopilotArgs({ prompt: "write a message" });
  assert.equal(args[0], "--prompt");
  assert.equal(args[1], "write a message");
  assert.ok(args.includes("--no-ask-user"));
  assert.ok(args.includes("--disable-builtin-mcps"));
  assert.ok(args.includes("--no-auto-update"));
  assert.ok(args.includes("--no-remote"));
  // Denials are explicit and come before the empty allow-list.
  for (const tool of ["shell", "write", "url"]) {
    const index = args.indexOf(tool);
    assert.ok(index > 0 && args[index - 1] === "--deny-tool", `deny ${tool}`);
  }
  assert.equal(args.at(-1), "--available-tools", "empty allow-list must be last");
  // Hooks and instructions: no custom instructions, and --disallow-temp-dir is
  // absent because the call runs from a neutral temp directory.
  assert.ok(args.includes("--no-custom-instructions"));
  assert.ok(!args.includes("--disallow-temp-dir"));
  // The CLI's own help says non-interactive mode requires this; with an empty
  // allow-list it grants nothing.
  assert.ok(args.includes("--allow-all-tools"));
  // No path widening, no blanket permissions, no tool grants, no session export.
  for (const forbidden of ["--allow-tool", "--allow-all-paths", "--yolo", "--allow-all", "--share", "--share-gist", "--add-dir", "--allow-url"]) {
    assert.ok(!args.includes(forbidden), `must not pass ${forbidden}`);
  }
});

// ------------------------------------------------------------- status/candidates

test("status reports session candidates and unattributed changes without selecting", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "one changed\n");
  repo.write("c.txt", "new\n");

  const actions = newActions();
  const result = await actions.status({ cwd: repo.dir, sessionFiles: ["a.txt"] });
  assert.equal(result.ok, true);
  assert.equal(result.branch, "main");
  assert.equal(result.detached, false);

  const a = result.files.find((file) => file.path === "a.txt");
  assert.equal(a.session, true);
  assert.equal(a.unattributed, false);
  assert.equal(a.status, "modified");

  const c = result.files.find((file) => file.path === "c.txt");
  assert.equal(c.session, false);
  assert.equal(c.unattributed, true);
  assert.equal(c.status, "untracked");

  assert.deepEqual(result.candidates.map((file) => file.path), ["a.txt"]);
  assert.deepEqual(result.unattributed.map((file) => file.path), ["c.txt"]);
  // Session paths may be absolute; matching is repo-relative.
  const absolute = await actions.status({ cwd: repo.dir, sessionFiles: [repo.path("a.txt")] });
  assert.deepEqual(absolute.candidates.map((file) => file.path), ["a.txt"]);
});

test("status matches session files relative to the repo, not the shell", async () => {
  const repo = makeRepo();
  baseline(repo);
  const nested = path.join(repo.dir, "src");
  mkdirSync(nested);
  repo.write("src/deep.txt", "deep\n");
  const actions = newActions();
  // A path that escapes the repo is never matched.
  const result = await actions.status({ cwd: repo.dir, sessionFiles: ["../a.txt", "src/deep.txt"] });
  assert.deepEqual(result.candidates.map((file) => file.path), ["src/deep.txt"]);
});

test("status refuses a directory that is not a repo", async () => {
  const dir = tempDir("git-test-plain-");
  const actions = newActions();
  const result = await actions.status({ cwd: dir });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "not-a-repo");
});

// ------------------------------------------------------------------- preview

test("preview freezes the selection without touching the real index", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "one changed\n");

  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  assert.equal(preview.ok, true);
  assert.match(preview.diff, /\+one changed/);
  assert.equal(preview.files.length, 1);
  assert.equal(preview.files[0].session, true);

  // The user's index is untouched: a.txt is modified in the worktree only.
  assert.equal(repo.git("diff", "--cached", "--name-only").trim(), "");
  assert.match(repo.git("status", "--porcelain", "--", "a.txt"), /^ M a\.txt\n$/);
  actions.dispose();
});

test("preview refuses an empty selection and unsafe paths", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const actions = newActions();

  const empty = await actions.preview({ cwd: repo.dir, files: [] });
  assert.equal(empty.ok, false);
  assert.equal(empty.error.code, "no-selection");

  for (const bad of ["/etc/passwd", "../a.txt", ".git/config"]) {
    const result = await actions.preview({ cwd: repo.dir, files: [bad] });
    assert.equal(result.ok, false, bad);
    assert.equal(result.error.code, "unsafe-path", bad);
  }

  const unchanged = await actions.preview({ cwd: repo.dir, files: ["b.txt"] });
  assert.equal(unchanged.ok, false);
  assert.equal(unchanged.error.code, "not-changed");
  actions.dispose();
});

test("preview refuses a symlink that points outside the repo", async () => {
  const repo = makeRepo();
  baseline(repo);
  symlinkSync("/etc/hostname", repo.path("link"));
  const actions = newActions();
  const result = await actions.preview({ cwd: repo.dir, files: ["link"] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "symlink-escape");
  actions.dispose();
});

test("preview refuses a rename and a conflict", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.git("mv", "a.txt", "e.txt");
  const actions = newActions();
  const renamed = await actions.preview({ cwd: repo.dir, files: ["e.txt"] });
  assert.equal(renamed.ok, false);
  assert.equal(renamed.error.code, "ambiguous-rename");

  const conflicted = makeRepo();
  baseline(conflicted);
  conflicted.git("checkout", "-q", "-b", "other");
  conflicted.write("a.txt", "other\n");
  conflicted.git("add", "a.txt");
  conflicted.git("commit", "-qm", "other");
  conflicted.git("checkout", "-q", "main");
  conflicted.write("a.txt", "main\n");
  conflicted.git("add", "a.txt");
  conflicted.git("commit", "-qm", "main");
  try {
    conflicted.git("merge", "--no-edit", "other");
  } catch {
    // the merge is expected to conflict
  }
  const conflictPreview = await actions.preview({ cwd: conflicted.dir, files: ["a.txt"] });
  assert.equal(conflictPreview.ok, false);
  assert.equal(conflictPreview.error.code, "conflicted");
  actions.dispose();
});

// -------------------------------------------------------------------- commit

test("commit lands only the selected paths and preserves unrelated staged work", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "one changed\n");
  repo.write("b.txt", "bee changed\n");
  repo.git("add", "b.txt"); // unrelated work the user already staged

  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  assert.equal(preview.ok, true);

  const committed = await actions.commit({ token: preview.token, message: "fix: change a" });
  assert.equal(committed.ok, true, JSON.stringify(committed.error));

  // a.txt is committed; b.txt keeps its staged content and is NOT in the commit.
  assert.equal(repo.git("show", "HEAD:a.txt"), "one changed\n");
  assert.equal(repo.git("show", "HEAD:b.txt"), "bee\n");
  assert.equal(repo.git("diff", "--cached", "--name-only").trim(), "b.txt");
  assert.match(repo.git("diff", "--cached", "--", "b.txt"), /\+bee changed/);
  // The committed path is reconciled: worktree clean for a.txt.
  assert.equal(repo.git("status", "--porcelain", "--", "a.txt").trim(), "");
  actions.dispose();
});

test("commit can add a new untracked file and delete a tracked one", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("c.txt", "new\n");
  // Deleted in the worktree only: `git rm` would stage the deletion, and a
  // selected file with staged content is refused by design.
  rmSync(repo.path("d.txt"));

  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["c.txt", "d.txt"] });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  const committed = await actions.commit({ token: preview.token, message: "feat: add c, drop d" });
  assert.equal(committed.ok, true, JSON.stringify(committed.error));

  assert.equal(repo.git("show", "HEAD:c.txt"), "new\n");
  assert.equal(repo.git("ls-tree", "--name-only", "HEAD").includes("d.txt"), false);
  assert.equal(repo.git("status", "--porcelain").trim(), "");
  actions.dispose();
});

test("commit validates the message and the review token", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });

  const empty = await actions.commit({ token: preview.token, message: "   " });
  assert.equal(empty.error.code, "empty-message");
  const long = await actions.commit({ token: preview.token, message: "x".repeat(MAX_MESSAGE_CHARS + 1) });
  assert.equal(long.error.code, "message-too-long");
  const nul = await actions.commit({ token: preview.token, message: "bad\0message" });
  assert.equal(nul.error.code, "bad-message");
  const unknown = await actions.commit({ token: "nope", message: "fine" });
  assert.equal(unknown.error.code, "unknown-preview");

  // A failed validation never mutated anything.
  assert.equal(repo.git("diff", "--cached", "--name-only").trim(), "");
  assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "1");
  actions.dispose();
});

test("commit aborts when the working tree or HEAD moved since the review", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const actions = newActions();

  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  repo.write("a.txt", "changed again\n");
  const raced = await actions.commit({ token: preview.token, message: "fix: race" });
  assert.equal(raced.ok, false);
  assert.equal(raced.error.code, "repo-changed");
  assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "1");

  // A new review is valid; moving HEAD afterwards invalidates it.
  const second = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  assert.equal(second.ok, true, JSON.stringify(second.error));
  repo.write("b.txt", "other\n");
  repo.git("add", "b.txt");
  repo.git("commit", "-qm", "elsewhere");
  const headMoved = await actions.commit({ token: second.token, message: "fix: race" });
  assert.equal(headMoved.ok, false);
  assert.equal(headMoved.error.code, "repo-changed");
  actions.dispose();
});

test("discard drops the review and leaves the repo untouched", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });

  assert.equal(actions.discard({ token: preview.token }).ok, true);
  const after = await actions.commit({ token: preview.token, message: "fix: gone" });
  assert.equal(after.error.code, "unknown-preview");
  assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "1");
  assert.equal(repo.git("diff", "--cached", "--name-only").trim(), "");
  assert.match(repo.git("status", "--porcelain", "--", "a.txt"), /^ M a\.txt\n$/);
  actions.dispose();
});

// ------------------------------------------------------- copilot generation

test("generation refuses to send anything without explicit egress approval", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const calls = [];
  const actions = newActions({
    exec: async (call) => {
      calls.push(call);
      return defaultExec(call);
    },
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const refused = await actions.generateMessage({ token: preview.token });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "egress-not-approved");
  assert.equal(calls.some((call) => call.file === "copilot"), false);
  actions.dispose();
});

test("generation sends only the selected diff on stdin and returns a clean message", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  let copilotCall = null;
  const actions = newActions({
    exec: async (call) => {
      if (call.file === "copilot") {
        copilotCall = call;
        return { ok: true, code: 0, spawnError: null, timedOut: false, stdout: "```\nfeat(core)!: change a\n```", stderr: "" };
      }
      return defaultExec(call);
    },
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const generated = await actions.generateMessage({ token: preview.token, approveEgress: true });
  assert.equal(generated.ok, true, JSON.stringify(generated.error));
  assert.equal(generated.message, "change a");

  assert.ok(copilotCall);
  assert.match(copilotCall.args.join(" "), /plain, descriptive commit message/);
  assert.match(copilotCall.args.join(" "), /Do not use Conventional Commit prefixes/);
  // The diff travels on stdin, never in argv.
  assert.match(copilotCall.input, /\+changed/);
  assert.ok(!copilotCall.args.join(" ").includes("+changed"));
  assert.equal(copilotCall.args.at(-1), "--available-tools");
  // Auth lives in the user's real COPILOT_HOME, so it is not overridden, and the
  // call runs from the review's temp directory rather than the repo.
  assert.equal(copilotCall.env.COPILOT_HOME, undefined);
  assert.equal(copilotCall.env.COPILOT_ALLOW_ALL, undefined);
  assert.notEqual(copilotCall.cwd, repo.dir);
  assert.ok(copilotCall.cwd.startsWith(BASE), copilotCall.cwd);
  actions.dispose();
});

test("generation can keep its session state out of the real home on request", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const home = tempDir("git-test-home-");
  let copilotCall = null;
  const actions = newActions({
    copilotHome: home,
    exec: async (call) => {
      if (call.file === "copilot") {
        copilotCall = call;
        return { ok: true, code: 0, spawnError: null, timedOut: false, stdout: "fix: change a", stderr: "" };
      }
      return defaultExec(call);
    },
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const generated = await actions.generateMessage({ token: preview.token, approveEgress: true });
  assert.equal(generated.ok, true, JSON.stringify(generated.error));
  assert.equal(generated.message, "change a");
  assert.equal(copilotCall.env.COPILOT_HOME, home);
  actions.dispose();
});

test("generation reports a malformed or failed Copilot reply instead of faking one", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");

  const empty = newActions({
    exec: async (call) =>
      call.file === "copilot"
        ? { ok: true, code: 0, spawnError: null, timedOut: false, stdout: "```\n```", stderr: "" }
        : defaultExec(call),
  });
  const preview = await empty.preview({ cwd: repo.dir, files: ["a.txt"] });
  const blank = await empty.generateMessage({ token: preview.token, approveEgress: true });
  assert.equal(blank.ok, false);
  assert.equal(blank.error.code, "empty-message");
  empty.dispose();

  const failed = newActions({
    exec: async (call) =>
      call.file === "copilot"
        ? { ok: false, code: 1, spawnError: null, timedOut: false, stdout: "", stderr: "boom" }
        : defaultExec(call),
  });
  const preview2 = await failed.preview({ cwd: repo.dir, files: ["a.txt"] });
  const broke = await failed.generateMessage({ token: preview2.token, approveEgress: true });
  assert.equal(broke.ok, false);
  assert.equal(broke.error.code, "copilot-failed");
  assert.match(broke.error.message, /boom/);
  failed.dispose();
});

test("a selection past the diff bound is refused, never committed unseen", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("big.txt", `${"x".repeat(600 * 1024)}\n`);
  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["big.txt"] });
  // Fail closed: the user cannot review this patch, so nothing is offered to
  // confirm and nothing is written.
  assert.equal(preview.ok, false, JSON.stringify(preview));
  assert.equal(preview.error.code, "diff-too-large");
  assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "1");
  assert.equal(repo.git("diff", "--cached", "--name-only").trim(), "");
  actions.dispose();
});

test("a second flow is refused while one is active", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const actions = newActions({
    exec: async (call) => {
      if (call.file === "copilot") {
        await gate;
        return { ok: true, code: 0, spawnError: null, timedOut: false, stdout: "fix: x", stderr: "" };
      }
      return defaultExec(call);
    },
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const running = actions.generateMessage({ token: preview.token, approveEgress: true });
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.ok(actions.active(), "a flow should be active");

  const blocked = await actions.status({ cwd: repo.dir });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "busy");

  release();
  const finished = await running;
  assert.equal(finished.ok, true);
  assert.equal(actions.active(), null);
  actions.dispose();
});

// -------------------------------------------------------------------- push

// A bare repo wired as `origin` with `main` already pushed: the smallest
// repo that has a resolvable push destination.
function connectUpstream(repo) {
  const bare = tempDir("git-test-bare-");
  gitIn(bare, "init", "-q", "--bare");
  repo.git("remote", "add", "origin", bare);
  repo.git("push", "-q", "-u", "origin", "main");
  return bare;
}

test("push needs a confirmation and a preview token; previewPush names the target", async () => {
  const repo = makeRepo();
  baseline(repo);
  const actions = newActions();

  // Nothing is sent without a token, and a token is never invented.
  const unconfirmed = await actions.push({ cwd: repo.dir });
  assert.equal(unconfirmed.error.code, "unconfirmed");
  const tokenless = await actions.push({ confirm: true });
  assert.equal(tokenless.error.code, "unknown-push");
  const noPreview = await actions.previewPush({ cwd: repo.dir });
  assert.equal(noPreview.error.code, "no-upstream");

  const bare = connectUpstream(repo);
  const preview = await actions.previewPush({ cwd: repo.dir });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  assert.equal(preview.branch, "main");
  assert.equal(preview.remote, "origin");
  assert.equal(preview.remoteBranch, "main");
  assert.equal(preview.upstream, "origin/main");
  assert.equal(preview.destination, bare);
  assert.deepEqual(preview.destinations, [bare]);
  assert.equal(preview.outgoing, 0);
  assert.deepEqual(preview.hashes, []);
  assert.equal(typeof preview.token, "string");

  repo.git("checkout", "-q", "--detach");
  const detached = await actions.previewPush({ cwd: repo.dir });
  assert.equal(detached.error.code, "detached");
  actions.dispose();
});

test("push sends an explicit refspec to the approved remote, never a force flag", async () => {
  const repo = makeRepo();
  baseline(repo);
  connectUpstream(repo);
  repo.write("a.txt", "changed\n");
  repo.git("add", "a.txt");
  repo.git("commit", "-qm", "change");

  const calls = [];
  const actions = newActions({
    exec: async (call) => {
      calls.push(call);
      if (call.args.includes("push")) return { ok: true, code: 0, spawnError: null, timedOut: false, stdout: "To origin\n", stderr: "" };
      return defaultExec(call);
    },
  });
  const preview = await actions.previewPush({ cwd: repo.dir });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  assert.equal(preview.outgoing, 1);
  assert.equal(preview.hashes.length, 1);
  assert.equal(preview.hashes[0], repo.git("rev-parse", "HEAD").trim());

  const pushed = await actions.push({ token: preview.token, confirm: true });
  assert.equal(pushed.ok, true, JSON.stringify(pushed.error));
  assert.equal(pushed.branch, "main");
  assert.equal(pushed.remote, "origin");
  assert.equal(pushed.upstream, "origin/main");
  assert.equal(pushed.outgoing, 1);
  assert.deepEqual(pushed.hashes, preview.hashes);

  const pushCall = calls.find((call) => call.args.includes("push"));
  // The exact argv: follow-tags disabled twice over, then one remote and one
  // explicit refspec. A force, mirror or --all flag cannot appear because none
  // is built.
  assert.deepEqual(pushCall.args, ["-c", "push.followTags=false", "push", "--no-follow-tags", "origin", "HEAD:refs/heads/main"]);
  assert.equal(pushCall.file, "git");
  for (const call of calls) {
    for (const arg of call.args) {
      assert.ok(!/^(-f|--force|--force-with-lease|\+)/.test(arg), `no force flag: ${arg}`);
    }
  }
  // A consumed token cannot be replayed.
  const replay = await actions.push({ token: preview.token, confirm: true });
  assert.equal(replay.error.code, "unknown-push");
  actions.dispose();
});

test("push updates the real upstream through the configured remote", async () => {
  const repo = makeRepo();
  baseline(repo);
  const bare = connectUpstream(repo);
  repo.write("a.txt", "changed\n");
  repo.git("add", "a.txt");
  repo.git("commit", "-qm", "change");

  const actions = newActions();
  const preview = await actions.previewPush({ cwd: repo.dir });
  const pushed = await actions.push({ token: preview.token, confirm: true });
  assert.equal(pushed.ok, true, JSON.stringify(pushed.error));
  assert.equal(gitIn(bare, "rev-parse", "main").trim(), repo.git("rev-parse", "HEAD").trim());
  actions.dispose();
});

test("push never carries tags the user did not preview, even with push.followTags", async () => {
  const repo = makeRepo();
  baseline(repo);
  const bare = connectUpstream(repo);
  // The user's own configuration would normally send a reachable annotated tag
  // along with the branch. An explicit refspec does not stop that, so the flow
  // disables it explicitly.
  repo.git("config", "push.followTags", "true");
  repo.write("a.txt", "changed\n");
  repo.git("add", "a.txt");
  repo.git("commit", "-qm", "change");
  repo.git("tag", "-a", "v1", "-m", "release");

  const actions = newActions();
  const preview = await actions.previewPush({ cwd: repo.dir });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  const pushed = await actions.push({ token: preview.token, confirm: true });
  assert.equal(pushed.ok, true, JSON.stringify(pushed.error));
  // The branch arrived; the tag did not.
  assert.equal(gitIn(bare, "rev-parse", "main").trim(), repo.git("rev-parse", "HEAD").trim());
  assert.equal(gitIn(bare, "tag").trim(), "");
  actions.dispose();
});

test("push refuses a token whose target moved, and a remote with several push targets", async () => {
  const repo = makeRepo();
  baseline(repo);
  connectUpstream(repo);
  const actions = newActions();

  const preview = await actions.previewPush({ cwd: repo.dir });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  repo.write("a.txt", "later\n");
  repo.git("add", "a.txt");
  repo.git("commit", "-qm", "later");
  const moved = await actions.push({ token: preview.token, confirm: true });
  assert.equal(moved.ok, false);
  assert.equal(moved.error.code, "repo-changed");

  // Two push URLs mean two destinations: never guess, refuse and name them.
  const other = tempDir("git-test-bare2-");
  gitIn(other, "init", "-q", "--bare");
  const third = tempDir("git-test-bare3-");
  gitIn(third, "init", "-q", "--bare");
  repo.git("config", "--add", "remote.origin.pushurl", other);
  repo.git("config", "--add", "remote.origin.pushurl", third);
  const many = await actions.previewPush({ cwd: repo.dir });
  assert.equal(many.ok, false);
  assert.equal(many.error.code, "multiple-push-targets");
  assert.match(many.error.message, /refusing to guess/);
  actions.dispose();
});

test("push refuses a remote configured as a mirror", async () => {
  const repo = makeRepo();
  baseline(repo);
  connectUpstream(repo);
  repo.git("config", "remote.origin.mirror", "true");
  const actions = newActions();
  const preview = await actions.previewPush({ cwd: repo.dir });
  assert.equal(preview.ok, false);
  assert.equal(preview.error.code, "mirror-remote");
  actions.dispose();
});

// ------------------------------------------------------------------- hygiene

test("dispose drops frozen reviews and temp state", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  actions.dispose();
  const after = await actions.commit({ token: preview.token, message: "fix: gone" });
  assert.equal(after.error.code, "unknown-preview");
  assert.equal(repo.git("diff", "--cached", "--name-only").trim(), "");
});

// ------------------------------------------------- index safety and hooks

test("preview refuses a file that already has staged changes", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "staged version\n");
  repo.git("add", "a.txt");
  repo.write("a.txt", "worktree version\n");

  const actions = newActions();
  const result = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "staged-selection");
  // The staged content is exactly as the user left it.
  assert.match(repo.git("diff", "--cached", "--", "a.txt"), /\+staged version/);
  assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "1");
  actions.dispose();
});

test("commit aborts when the staged index changes after the review", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  // b.txt is staged before the review, so the porcelain columns do not change
  // when it is staged again: only the index content does.
  repo.write("b.txt", "staged one\n");
  repo.git("add", "b.txt");

  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));

  repo.write("b.txt", "staged two\n");
  repo.git("add", "b.txt");
  const raced = await actions.commit({ token: preview.token, message: "fix: race" });
  assert.equal(raced.ok, false);
  assert.equal(raced.error.code, "index-changed");
  assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "1");
  assert.match(repo.git("diff", "--cached", "--", "b.txt"), /\+staged two/);
  actions.dispose();
});

test("commit runs hooks and reports a hook that changed the committed tree", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const hook = repo.path(".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\necho hook >> a.txt\ngit add a.txt\n");
  chmodSync(hook, 0o755);

  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  const committed = await actions.commit({ token: preview.token, message: "fix: hook" });
  // The hook ran as normal git would, and its content landed. The promise that
  // only the reviewed tree is committed cannot then be kept, so it is reported
  // with the hash instead of being presented as success.
  assert.equal(committed.ok, false);
  assert.equal(committed.error.code, "hook-changed-tree");
  assert.equal(typeof committed.error.hash, "string");
  assert.match(repo.git("show", "HEAD:a.txt"), /hook/);
  actions.dispose();
});

test("a failing hook refuses the commit and leaves HEAD alone", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const hook = repo.path(".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n");
  chmodSync(hook, 0o755);

  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const committed = await actions.commit({ token: preview.token, message: "fix: hook" });
  assert.equal(committed.ok, false);
  assert.equal(committed.error.code, "commit-failed");
  assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "1");
  assert.equal(repo.git("diff", "--cached", "--name-only").trim(), "");
  actions.dispose();
});

// ------------------------------------------------------- literal file names

test("a bracketed filename selects only itself, never a glob match", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("[abc].txt", "bracket one\n");
  repo.git("add", "[abc].txt");
  repo.git("commit", "-qm", "add bracketed name");
  repo.write("[abc].txt", "bracket two\n");
  // `[abc].txt` as a pathspec glob also matches a.txt: without literal pathspecs
  // this file would ride along in the stage, the review and the commit.
  repo.write("a.txt", "a changed\n");

  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["[abc].txt"] });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  assert.deepEqual(preview.files.map((file) => file.path), ["[abc].txt"]);
  assert.match(preview.diff, /\+bracket two/);
  assert.ok(!preview.diff.includes("+a changed"), "the selection must not widen to a.txt");

  const committed = await actions.commit({ token: preview.token, message: "fix: bracketed" });
  assert.equal(committed.ok, true, JSON.stringify(committed.error));
  assert.equal(repo.git("show", "HEAD:[abc].txt"), "bracket two\n");
  assert.equal(repo.git("show", "HEAD:a.txt"), "one\n");
  assert.match(repo.git("status", "--porcelain", "--", "a.txt"), /^ M a\.txt/);
  actions.dispose();
});

test("a filename shaped like pathspec magic selects only that file", async () => {
  const repo = makeRepo();
  baseline(repo);
  const magic = ":(glob)**";
  repo.write(magic, "magic one\n");
  repo.git("add", magic);
  repo.git("commit", "-qm", "add magic name");
  repo.write(magic, "magic two\n");
  repo.write("a.txt", "a changed\n");

  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: [magic] });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  assert.deepEqual(preview.files.map((file) => file.path), [magic]);
  assert.match(preview.diff, /\+magic two/);
  assert.ok(!preview.diff.includes("+a changed"), "pathspec magic must not match other files");
  actions.dispose();
});

// ------------------------------------------- after the commit already exists

test("a hook that stages into the real index during the commit keeps that staging", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  repo.write("b.txt", "staged by the hook\n");
  // The hook writes the REAL index while our commit runs against its own temp
  // index. Releasing GIT_INDEX_FILE is what makes it hit the real one.
  const hook = repo.path(".git/hooks/pre-commit");
  writeFileSync(hook, "#!/bin/sh\nunset GIT_INDEX_FILE\ngit add -- b.txt\n");
  chmodSync(hook, 0o755);

  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  const committed = await actions.commit({ token: preview.token, message: "fix: hook index" });

  // The commit exists, and the flow says so instead of resetting the index the
  // hook just wrote.
  assert.equal(committed.ok, false);
  assert.equal(committed.error.code, "reconcile-index-changed");
  assert.equal(committed.error.hash, repo.git("rev-parse", "HEAD").trim());
  assert.match(committed.error.message, /do not retry/);
  assert.equal(repo.git("log", "-1", "--format=%s").trim(), "fix: hook index");
  // The hook's staging survived untouched: b.txt is staged with the hook's
  // content, not reset back to HEAD.
  assert.match(repo.git("status", "--porcelain", "--", "b.txt"), /^M  b\.txt/);
  assert.equal(gitIn(repo.dir, "show", ":b.txt"), "staged by the hook\n");
  actions.dispose();
});

test("a failed reconcile still reports the commit hash and forbids a retry", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");

  const actions = newActions({
    exec: async (call) => {
      if (call.args[0] === "reset") return { ok: false, code: 128, spawnError: null, timedOut: false, stdout: "", stderr: "fatal: index locked\n" };
      return defaultExec(call);
    },
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  const committed = await actions.commit({ token: preview.token, message: "fix: reconcile" });

  assert.equal(committed.ok, false);
  assert.equal(committed.error.code, "reconcile-failed");
  assert.equal(committed.error.hash, repo.git("rev-parse", "HEAD").trim());
  assert.match(committed.error.message, /do not retry/);
  assert.equal(repo.git("log", "-1", "--format=%s").trim(), "fix: reconcile");
  // The token is spent once the commit exists: no second commit is possible.
  const replay = await actions.commit({ token: preview.token, message: "fix: again" });
  assert.equal(replay.error.code, "unknown-preview");
  assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "2");
  actions.dispose();
});

test("discard releases a push preview token so it cannot be used later", async () => {
  const repo = makeRepo();
  baseline(repo);
  connectUpstream(repo);
  repo.write("a.txt", "changed\n");
  repo.git("add", "a.txt");
  repo.git("commit", "-qm", "change");

  const actions = newActions();
  const preview = await actions.previewPush({ cwd: repo.dir });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  const dropped = await actions.discard({ token: preview.token });
  assert.equal(dropped.ok, true, JSON.stringify(dropped.error));
  // The cancelled token is gone: a stale UI action cannot push with it.
  const replay = await actions.push({ token: preview.token, confirm: true });
  assert.equal(replay.error.code, "unknown-push");
  // Nothing reached the remote.
  assert.equal(gitIn(repo.dir, "rev-parse", "origin/main").trim(), repo.git("rev-parse", "HEAD~1").trim());
  actions.dispose();
});
