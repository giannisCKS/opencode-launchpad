// Tests for git.js. Every repository here is a synthetic temp repo under
// /tmp/opencode; the user's real repos, index and remotes are never touched and
// no network is used. Each repo is removed in the global `after` hook.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  LUNA_MODEL,
  MAX_MESSAGE_CHARS,
  buildGeneratePrompt,
  classifyStatus,
  createGitActions,
  defaultExec,
  isSafeRelPath,
  gitignorePatternFor,
  parseStatusPorcelain,
  redact,
  redactUrl,
  sanitizeMessage,
  selectCommitGenerator,
  writeAllSync,
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

function shellArg(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

function writeHook(file, body) {
  writeFileSync(file, `#!/bin/sh\n${body}\n`);
  chmodSync(file, 0o755);
}

function failingCall(stderr = "failed") {
  return { ok: false, code: 128, spawnError: null, timedOut: false, stdout: "", stderr };
}

// ------------------------------------------------------- add to .gitignore

function isIgnored(dir, name) {
  try {
    // check-ignore rejects GIT_LITERAL_PATHSPECS, so it is run without the
    // helper's environment; -- keeps a leading dash in a name from being read
    // as an option.
    execFileSync("git", ["check-ignore", "-q", "--", name], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_LITERAL_PATHSPECS: "0" },
    });
    return true;
  } catch {
    return false;
  }
}

test("gitignorePatternFor escapes every glob metacharacter and anchors to the root", () => {
  assert.equal(gitignorePatternFor("a.txt"), "/a.txt");
  assert.equal(gitignorePatternFor("dir/a.txt"), "/dir/a.txt");
  assert.equal(gitignorePatternFor("star*.txt"), "/star\\*.txt");
  assert.equal(gitignorePatternFor("q?.txt"), "/q\\?.txt");
  assert.equal(gitignorePatternFor("[abc].txt"), "/\\[abc\\].txt");
  assert.equal(gitignorePatternFor("back\\slash.txt"), "/back\\\\slash.txt");
  assert.equal(gitignorePatternFor("sp ace.txt"), "/sp\\ ace.txt");
  // A leading # or ! stays literal because the pattern starts with /.
  assert.equal(gitignorePatternFor("#hash.txt"), "/#hash.txt");
  assert.equal(gitignorePatternFor("!bang.txt"), "/!bang.txt");
});

test("addToGitignore ignores only the literal target and keeps the existing bytes", async () => {
  const repo = makeRepo();
  baseline(repo);
  // Existing content without a trailing newline: the append must add exactly
  // one separator and leave every earlier byte untouched.
  repo.write(".gitignore", "already-here");
  repo.write("star*.txt", "x\n");
  repo.write("starX.txt", "x\n");
  const before = readFileSync(repo.path(".gitignore"));

  const actions = newActions();
  const result = await actions.addToGitignore({ cwd: repo.dir, file: "star*.txt" });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.file, "star*.txt");
  assert.equal(result.root, repo.dir);

  const after = readFileSync(repo.path(".gitignore"));
  assert.equal(after.subarray(0, before.length).equals(before), true);
  assert.equal(after.toString("utf8"), "already-here\n/star\\*.txt\n");
  assert.equal(isIgnored(repo.dir, "star*.txt"), true);
  // The glob did not widen: a different name is still not ignored.
  assert.equal(isIgnored(repo.dir, "starX.txt"), false);
  // Nothing was staged or committed; the .gitignore is a plain worktree change.
  assert.equal(repo.git("status", "--porcelain"), "?? .gitignore\n?? starX.txt\n");
  assert.equal(repo.git("log", "--format=%s").trim(), "init");
  actions.dispose();
});

test("addToGitignore creates a missing .gitignore and preserves CRLF conventions", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("fresh.txt", "x\n");

  const actions = newActions();
  const created = await actions.addToGitignore({ cwd: repo.dir, file: "fresh.txt" });
  assert.equal(created.ok, true, JSON.stringify(created.error));
  assert.equal(readFileSync(repo.path(".gitignore"), "utf8"), "/fresh.txt\n");
  // Creating the ignore file is a worktree change only: nothing staged.
  assert.equal(repo.git("status", "--porcelain"), "?? .gitignore\n");

  // A CRLF file keeps CRLF for the appended line.
  repo.write("second.txt", "x\n");
  repo.write(".gitignore", "old\r\n");
  const appended = await actions.addToGitignore({ cwd: repo.dir, file: "second.txt" });
  assert.equal(appended.ok, true, JSON.stringify(appended.error));
  assert.equal(readFileSync(repo.path(".gitignore"), "utf8"), "old\r\n/second.txt\r\n");
  actions.dispose();
});

test("addToGitignore refuses tracked, missing and non-file targets", async () => {
  const repo = makeRepo();
  baseline(repo);
  mkdirSync(repo.path("dir"), { recursive: true });
  writeFileSync(repo.path("dir/nested.txt"), "x\n");
  const actions = newActions();

  for (const [file, code] of [
    ["a.txt", "not-untracked"],
    ["dir", "not-untracked"],
    ["missing.txt", "not-untracked"],
    [".gitignore", "unsafe-path"],
    ["../outside.txt", "unsafe-path"],
    ["/etc/passwd", "unsafe-path"],
    ["line\nbreak.txt", "unsafe-path"],
    ["carriage\rreturn.txt", "unsafe-path"],
    ["", "no-file"],
  ]) {
    const result = await actions.addToGitignore({ cwd: repo.dir, file });
    assert.equal(result.ok, false, file);
    assert.equal(result.error.code, code, file);
  }
  assert.equal(existsSync(repo.path(".gitignore")), false);
  actions.dispose();
});

test("addToGitignore never sees a non-regular file: git does not list a FIFO", async () => {
  const repo = makeRepo();
  baseline(repo);
  execFileSync("mkfifo", [repo.path("pipe")]);
  const actions = newActions();
  // git status omits FIFOs, so the target never becomes a candidate; the
  // regular-file check in the service is a second line of defence.
  const result = await actions.addToGitignore({ cwd: repo.dir, file: "pipe" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "not-untracked");
  assert.equal(existsSync(repo.path(".gitignore")), false);
  actions.dispose();
});

test("addToGitignore appends LF after a CR-only .gitignore so the new rule is separate", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("cr.txt", "x\n");
  // A legacy CR-only file has no LF at all: Git would read any appended text as
  // part of the final pattern unless an LF is inserted first.
  repo.write(".gitignore", "legacy\r");
  const before = readFileSync(repo.path(".gitignore"));

  const actions = newActions();
  const result = await actions.addToGitignore({ cwd: repo.dir, file: "cr.txt" });
  assert.equal(result.ok, true, JSON.stringify(result.error));

  const after = readFileSync(repo.path(".gitignore"));
  assert.equal(after.subarray(0, before.length).equals(before), true);
  assert.equal(after.toString("utf8"), "legacy\r\n/cr.txt\n");
  assert.equal(isIgnored(repo.dir, "cr.txt"), true);
  actions.dispose();
});

test("addToGitignore refuses a .gitignore that is a directory", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("target.txt", "x\n");
  mkdirSync(repo.path(".gitignore"));
  const actions = newActions();
  const result = await actions.addToGitignore({ cwd: repo.dir, file: "target.txt" });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "not-a-file");
  actions.dispose();
});

test("addToGitignore refuses a symlink target and a symlinked .gitignore", async () => {
  const repo = makeRepo();
  baseline(repo);
  symlinkSync("/etc/hostname", repo.path("outside-link"));
  symlinkSync(repo.path("b.txt"), repo.path("inside-link"));
  const actions = newActions();

  const escaped = await actions.addToGitignore({ cwd: repo.dir, file: "outside-link" });
  assert.equal(escaped.ok, false);
  assert.equal(escaped.error.code, "symlink-escape");

  const inside = await actions.addToGitignore({ cwd: repo.dir, file: "inside-link" });
  assert.equal(inside.ok, false);
  assert.equal(inside.error.code, "symlink");

  // A .gitignore symlink must not be written through, even when it points
  // inside the repo.
  repo.write("target.txt", "x\n");
  symlinkSync(repo.path("elsewhere"), repo.path(".gitignore"));
  const linked = await actions.addToGitignore({ cwd: repo.dir, file: "target.txt" });
  assert.equal(linked.ok, false);
  assert.equal(linked.error.code, "symlink");
  assert.equal(existsSync(repo.path("elsewhere")), false);
  actions.dispose();
});

test("addToGitignore reports a write failure and leaves the file unchanged", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root bypasses file permissions");
    return;
  }
  const repo = makeRepo();
  baseline(repo);
  repo.write("target.txt", "x\n");
  repo.write(".gitignore", "keep\n");
  chmodSync(repo.path(".gitignore"), 0o444);
  const actions = newActions();
  try {
    const result = await actions.addToGitignore({ cwd: repo.dir, file: "target.txt" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "gitignore-unwritable");
    assert.equal(readFileSync(repo.path(".gitignore"), "utf8"), "keep\n");
    assert.equal(repo.git("status", "--porcelain"), "?? .gitignore\n?? target.txt\n");
  } finally {
    chmodSync(repo.path(".gitignore"), 0o644);
    actions.dispose();
  }
});

test("addToGitignore anchors a nested path to the repository root", async () => {
  const repo = makeRepo();
  baseline(repo);
  mkdirSync(repo.path("sub"), { recursive: true });
  writeFileSync(repo.path("sub/keep.log"), "x\n");
  writeFileSync(repo.path("keep.log"), "x\n");

  const actions = newActions();
  const result = await actions.addToGitignore({ cwd: repo.dir, file: "sub/keep.log" });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(readFileSync(repo.path(".gitignore"), "utf8"), "/sub/keep.log\n");
  assert.equal(isIgnored(repo.dir, "sub/keep.log"), true);
  // The same name at the root is not caught by the anchored pattern.
  assert.equal(isIgnored(repo.dir, "keep.log"), false);
  actions.dispose();
});

test("addToGitignore reports a create failure and leaves no .gitignore behind", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root bypasses file permissions");
    return;
  }
  const repo = makeRepo();
  baseline(repo);
  repo.write("target.txt", "x\n");
  chmodSync(repo.dir, 0o555);
  const actions = newActions();
  try {
    const result = await actions.addToGitignore({ cwd: repo.dir, file: "target.txt" });
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "gitignore-unwritable");
    assert.equal(existsSync(repo.path(".gitignore")), false);
  } finally {
    chmodSync(repo.dir, 0o755);
    actions.dispose();
  }
});

test("writeAllSync drains a short write instead of reporting a partial append", () => {
  const dir = tempDir("git-test-write-");
  const file = path.join(dir, "out.txt");
  const fd = openSync(file, "w");
  try {
    // One byte per writeSync call: the helper must loop, not return early.
    const total = writeAllSync(fd, "/very\\ long.txt\n", 1);
    assert.equal(total, 16);
  } finally {
    closeSync(fd);
  }
  assert.equal(readFileSync(file, "utf8"), "/very\\ long.txt\n");

  // A descriptor that accepts nothing must throw, not report success.
  const readOnly = openSync(file, "r");
  try {
    assert.throws(() => writeAllSync(readOnly, "x"), /EBADF|EACCES|EIO/);
  } finally {
    closeSync(readOnly);
  }
});

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

test("redactUrl strips credentials from every URL shape, and leaves plain paths alone", () => {
  assert.equal(redactUrl("https://user:tok@github.com/x.git"), "https://github.com/x.git");
  assert.equal(redactUrl("ssh://alice:hunter2@example.invalid/repo.git"), "ssh://example.invalid/repo.git");
  assert.equal(redactUrl("https://alice:p@ss@example.invalid/repo.git"), "https://example.invalid/repo.git");
  assert.equal(redactUrl("alice:hunter2@example.invalid:repo.git"), "example.invalid:repo.git");
  assert.equal(redactUrl("alice:p@ss@example.invalid:repo.git"), "example.invalid:repo.git");
  assert.equal(redactUrl("git@github.com:acme/repo.git"), "git@github.com:acme/repo.git");
  assert.equal(redactUrl("/tmp/opencode/bare.git"), "/tmp/opencode/bare.git");
  assert.equal(redactUrl(""), "");
});

test("redact removes scp-like credential pairs from git stderr", () => {
  const text = "fatal: could not read from alice:hunter2@example.invalid:repo.git";
  const clean = redact(text);
  assert.equal(clean.includes("hunter2"), false);
  assert.match(clean, /example\.invalid:repo\.git/);
  const atInPassword = redact("fatal: https://alice:p@ss@example.invalid/repo.git and bob:p@ss@example.invalid:repo.git");
  assert.equal(atInPassword.includes("p@ss"), false);
  assert.match(atInPassword, /fatal: https:\/\/example\.invalid\/repo\.git and example\.invalid:repo\.git/);
});

test("sanitizeMessage strips fences and bullets, and refuses empty output", () => {
  assert.equal(sanitizeMessage("```\nfeat(x): add thing\n```"), "feat(x): add thing");
  assert.equal(sanitizeMessage("- one\n- two"), "one\ntwo");
  assert.equal(sanitizeMessage('"feat: quoted"'), "feat: quoted");
  assert.equal(sanitizeMessage(""), null);
  assert.equal(sanitizeMessage("   \n  "), null);
  assert.equal(sanitizeMessage("\u001B[31mfeat: red\u001B[0m"), "feat: red");
  assert.equal(sanitizeMessage("x".repeat(MAX_MESSAGE_CHARS + 100)).length, MAX_MESSAGE_CHARS);
  // A generated subject and body stay separated: the internal blank line is
  // kept, only the outer whitespace is trimmed.
  assert.equal(sanitizeMessage("  add the thing\n\nBody line one.\nBody line two.\n\n"), "add the thing\n\nBody line one.\nBody line two.");
  // Repeated blanks collapse to one and a blank-only reply is still refused.
  assert.equal(sanitizeMessage("subject\n\n\n\nbody"), "subject\n\nbody");
  assert.equal(sanitizeMessage("\n\n\n"), null);
  assert.equal(sanitizeMessage("\n  \n\t\n"), null);
});

test("buildGeneratePrompt quotes only the frozen diff and marks it untrusted", () => {
  const prompt = buildGeneratePrompt({ diff: "diff --git a/a.txt b/a.txt\n+hello\n", files: ["a.txt"] });
  // The diff is present and delimited, and the model is told not to obey it.
  assert.match(prompt, /----- BEGIN DIFF -----/);
  assert.match(prompt, /----- END DIFF -----/);
  assert.match(prompt, /\+hello/);
  assert.ok(prompt.indexOf("----- BEGIN DIFF -----") < prompt.indexOf("+hello"));
  assert.ok(prompt.indexOf("+hello") < prompt.indexOf("----- END DIFF -----"));
  assert.match(prompt, /untrusted/i);
  // Plain English subject, never a Conventional Commit prefix.
  assert.match(prompt, /Do not use Conventional Commit prefixes/);
  assert.match(prompt, /a blank line, then a detailed body/);
  assert.match(prompt, /Describe each significant change/);
  assert.match(prompt, /Do not invent motivations, test results, or behavior/);
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

// ------------------------------------------------- generator selection

const proxyProvider = { id: "opencodex", name: "OpenCodex", activation: "enabled" };
const nativeProvider = { id: "openai", name: "OpenAI", activation: "enabled" };

function advertisedModel(providerID, id, { name = "Luna", enabled = true, variants = [] } = {}) {
  return { id, modelID: id, providerID, name, enabled, variants: variants.map((variant) => ({ id: variant })) };
}

test("generator selection prefers an available OpenCodex Luna model", () => {
  const selected = selectCommitGenerator({
    providers: [proxyProvider, nativeProvider],
    models: [
      advertisedModel("opencodex", "gpt-6-luna", { variants: ["low"] }),
      advertisedModel("openai", "gpt-6-luna"),
    ],
  });
  assert.deepEqual(selected, {
    ok: true,
    generator: {
      source: "opencodex",
      providerID: "opencodex",
      id: "gpt-6-luna",
      variant: "low",
      providerName: "OpenCodex",
      modelName: "Luna",
    },
  });
});

test("generator selection falls back only to a Luna model OpenAI advertises", () => {
  const selected = selectCommitGenerator({
    providers: [nativeProvider],
    models: [
      advertisedModel("openai", "gpt-5", { name: "GPT-5" }),
      advertisedModel("openai", "gpt-6-luna"),
    ],
  });
  assert.deepEqual(selected, {
    ok: true,
    generator: {
      source: "openai",
      providerID: "openai",
      id: "gpt-6-luna",
      providerName: "OpenAI",
      modelName: "Luna",
    },
  });
});

test("generator selection does not guess a native Luna id or variant", () => {
  const noLuna = selectCommitGenerator({
    providers: [nativeProvider],
    models: [advertisedModel("openai", "gpt-5", { name: "GPT-5" })],
  });
  assert.equal(noLuna.ok, false);
  assert.equal(noLuna.error.code, "model-unavailable");
  assert.match(noLuna.error.message, /Luna/);

  const ambiguous = selectCommitGenerator({
    providers: [nativeProvider],
    models: [
      advertisedModel("openai", "openai-luna-a", { name: "Luna A" }),
      advertisedModel("openai", "openai-luna-b", { name: "Luna B" }),
    ],
  });
  assert.equal(ambiguous.ok, false);
  assert.equal(ambiguous.error.code, "model-ambiguous");

  // A variant is never guessed: native OpenAI gets no proxy "low" and no
  // arbitrary pick from its own variants unless a future contract names one.
  const advertisedVariant = selectCommitGenerator({
    providers: [nativeProvider],
    models: [advertisedModel("openai", "gpt-6-luna", { variants: ["high"] })],
  });
  assert.equal(advertisedVariant.ok, true);
  assert.equal(advertisedVariant.generator.variant, undefined);
});

test("generator selection refuses missing, malformed or unavailable metadata", () => {
  for (const input of [undefined, {}, { providers: [], models: null }, { providers: "x", models: [] }]) {
    const selected = selectCommitGenerator(input);
    assert.equal(selected.ok, false);
    assert.equal(selected.error.code, "generator-probe-failed");
  }

  const neither = selectCommitGenerator({ providers: [proxyProvider, nativeProvider], models: [] });
  assert.equal(neither.ok, false);
  assert.equal(neither.error.code, "model-unavailable");

  const disabledProxy = selectCommitGenerator({
    providers: [{ ...proxyProvider, activation: "disabled" }, nativeProvider],
    models: [advertisedModel("opencodex", "gpt-6-luna", { variants: ["low"] })],
  });
  assert.equal(disabledProxy.ok, false, "a disabled proxy is not silently used");

  const disabledNativeModel = selectCommitGenerator({
    providers: [nativeProvider],
    models: [advertisedModel("openai", "gpt-6-luna", { enabled: false })],
  });
  assert.equal(disabledNativeModel.ok, false);
  assert.equal(disabledNativeModel.error.code, "model-unavailable");
});

// --------------------------------------------------------- luna generation

// Wait for a condition instead of guessing how long a flow needs.
async function until(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for the generator to be called");
}

// A fake native generator that records every payload it is handed. It models the
// confirmed host contract: `generate.text({ prompt, model }, { signal })`.
function generator(handler) {
  const calls = [];
  const generateText = (payload, callOptions) => {
    calls.push({ payload, signal: callOptions?.signal });
    return handler(payload, callOptions);
  };
  generateText.calls = calls;
  return generateText;
}

test("generation refuses to send anything without explicit egress approval", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const generate = generator(() => ({ text: "change a" }));
  const actions = newActions({ generateText: generate });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });

  // No approval: refused before any payload is built.
  const refused = await actions.generateMessage({ token: preview.token });
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, "egress-not-approved");
  assert.equal(generate.calls.length, 0);
  actions.dispose();
});

test("generation refuses a stale or unknown review before it sends anything", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const generate = generator(() => ({ text: "change a" }));
  const actions = newActions({ generateText: generate });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  actions.discard({ token: preview.token });

  const stale = await actions.generateMessage({ token: preview.token, approveEgress: true });
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, "unknown-preview");
  assert.equal(generate.calls.length, 0, "a dropped review never reaches the model");
  actions.dispose();
});

test("generation sends only the frozen diff to the exact Luna model and returns a clean message", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  // The repo carries an instruction file that must never travel to the model.
  repo.write("AGENTS.md", "ALWAYS write a conventional commit\n");
  const generate = generator(() => ({ text: "```\nfeat(core)!: change a\n```" }));
  const actions = newActions({ generateText: generate });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const generated = await actions.generateMessage({ token: preview.token, approveEgress: true });
  assert.equal(generated.ok, true, JSON.stringify(generated.error));
  // The Conventional Commit prefix (scope and `!` included) is stripped.
  assert.equal(generated.message, "change a");

  assert.equal(generate.calls.length, 1, "the model is called once");
  const [{ payload, signal }] = generate.calls;
  assert.deepEqual(payload.model, { providerID: "opencodex", id: "gpt-6-luna", variant: "low" });
  assert.equal(typeof signal.aborted, "boolean", "the call gets an AbortSignal");
  // Only the frozen diff and the task instructions travel: the diff is present,
  // and no repository instruction file is ever included.
  assert.match(payload.prompt, /\+changed/);
  assert.ok(payload.prompt.includes(preview.diff), "the exact reviewed patch is the payload");
  assert.doesNotMatch(payload.prompt, /ALWAYS write a conventional commit/);
  assert.doesNotMatch(payload.prompt, /AGENTS\.md/);
  actions.dispose();
});

test("generation reports a malformed, empty or failed reply instead of faking one", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");

  const empty = newActions({ generateText: generator(() => ({ text: "```\n```" })) });
  const preview = await empty.preview({ cwd: repo.dir, files: ["a.txt"] });
  const blank = await empty.generateMessage({ token: preview.token, approveEgress: true });
  assert.equal(blank.ok, false);
  assert.equal(blank.error.code, "empty-message");
  empty.dispose();

  const malformed = newActions({ generateText: generator(() => ({ text: "   \n  " })) });
  const preview2 = await malformed.preview({ cwd: repo.dir, files: ["a.txt"] });
  const broken = await malformed.generateMessage({ token: preview2.token, approveEgress: true });
  assert.equal(broken.ok, false);
  assert.equal(broken.error.code, "empty-message");
  malformed.dispose();

  const failing = newActions({
    generateText: generator(() => {
      throw new Error("provider exploded");
    }),
  });
  const preview3 = await failing.preview({ cwd: repo.dir, files: ["a.txt"] });
  const failed = await failing.generateMessage({ token: preview3.token, approveEgress: true });
  assert.equal(failed.ok, false);
  assert.equal(failed.error.code, "generation-failed");
  // The provider's own text can quote what it was sent, so it is replaced by a
  // safe diagnostic instead of being surfaced.
  assert.equal(failed.error.message, "Luna message generation failed");
  assert.equal(JSON.stringify(failed).includes("provider exploded"), false, "no raw provider text");
  failing.dispose();

  // A host with no native text API reports a capability gap, not a model error.
  const unavailable = newActions({
    generateText: generator(() => {
      const error = new Error("no client");
      error.code = "generation-unavailable";
      throw error;
    }),
  });
  const preview4 = await unavailable.preview({ cwd: repo.dir, files: ["a.txt"] });
  const gap = await unavailable.generateMessage({ token: preview4.token, approveEgress: true });
  assert.equal(gap.ok, false);
  assert.equal(gap.error.code, "generation-unavailable");
  assert.equal(gap.error.message, "No commit message generator is connected");
  unavailable.dispose();
});

test("a provider error that quotes the diff never carries it out of the service", async () => {
  const repo = makeRepo();
  baseline(repo);
  // The changed line looks like a credential: if the provider echoes it, the
  // error must not become a leak channel.
  repo.write("a.txt", "SECRET=hunter2-not-a-real-token\n");
  const generate = generator(() => {
    // A provider that echoes the payload it rejected.
    return Promise.reject(new Error("400 Bad Request: gh" + "p_" + "A".repeat(30)));
  });
  const actions = newActions({ generateText: generate });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const result = await actions.generateMessage({ token: preview.token, approveEgress: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "generation-failed");
  assert.equal(result.error.message, "Luna message generation failed");
  const surfaced = JSON.stringify(result);
  assert.equal(surfaced.includes("hunter2-not-a-real-token"), false, "the diff is not echoed");
  assert.equal(surfaced.includes("g" + "hp_"), false, "a token-shaped provider message is not echoed");
  actions.dispose();
});

test("generation with no connected generator fails closed and never touches git", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const result = await actions.generateMessage({ token: preview.token, approveEgress: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "generation-unavailable");
  assert.equal(actions.active(), null);
  actions.dispose();
});

test("generation times out at the deadline and releases the busy lock", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  let capturedSignal = null;
  const actions = newActions({
    // Long enough that the recheck always finishes first, short enough to keep
    // the test quick: the deadline must fire while the callback hangs.
    generationTimeoutMs: 1500,
    generateText: (payload, callOptions) => {
      capturedSignal = callOptions.signal;
      // Never settles: only the deadline can end this call.
      return new Promise(() => {});
    },
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const result = await actions.generateMessage({ token: preview.token, approveEgress: true });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, "message-timeout");
  assert.equal(capturedSignal.aborted, true);
  assert.equal(actions.active(), null, "the busy lock is released after a timeout");
  actions.dispose();
});

test("dispose aborts an in-flight generation even if the callback ignores the signal", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  let callSignal = null;
  const actions = newActions({
    generationTimeoutMs: 5000,
    generateText: (payload, callOptions) => {
      callSignal = callOptions.signal;
      return new Promise(() => {}); // ignores the signal entirely
    },
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const running = actions.generateMessage({ token: preview.token, approveEgress: true });
  await until(() => callSignal !== null);
  assert.ok(actions.active(), "a generation is active");
  assert.equal(callSignal.aborted, false, "not aborted yet");

  actions.dispose();
  const settled = await running;
  assert.equal(settled.ok, false);
  assert.equal(settled.error.code, "message-cancelled");
  assert.equal(callSignal.aborted, true, "dispose aborts the native request");
  assert.equal(actions.active(), null, "the busy lock settles without the callback");
});

test("cancelGeneration aborts the request and releases the busy lock", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  let callSignal = null;
  const actions = newActions({
    generationTimeoutMs: 5000,
    generateText: (payload, callOptions) => {
      callSignal = callOptions.signal;
      return new Promise(() => {});
    },
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const running = actions.generateMessage({ token: preview.token, approveEgress: true });
  await until(() => callSignal !== null);
  actions.cancelGeneration();
  const settled = await running;
  assert.equal(settled.error.code, "message-cancelled");
  assert.equal(callSignal.aborted, true);
  assert.equal(actions.active(), null);
  actions.dispose();
});

test("cancelling or closing during the recheck never invokes the generator", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");

  for (const close of ["cancel", "dispose"]) {
    const generate = generator(() => ({ text: "change a" }));
    // Freeze the flow inside its recheck: the first git call after the review is
    // approved blocks until the test says otherwise.
    const realExec = defaultExec;
    let releaseRecheck;
    const recheckGate = new Promise((resolve) => {
      releaseRecheck = resolve;
    });
    let armed = false;
    let inRecheck = false;
    const exec = async (request) => {
      if (armed && !inRecheck) {
        inRecheck = true;
        await recheckGate;
      }
      return realExec(request);
    };
    const actions = newActions({ exec, generateText: generate });
    const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
    armed = true;

    const running = actions.generateMessage({ token: preview.token, approveEgress: true });
    await until(() => inRecheck);
    assert.equal(generate.calls.length, 0, "nothing was generated while the recheck ran");

    if (close === "cancel") actions.cancelGeneration();
    else actions.dispose();
    releaseRecheck();

    const settled = await running;
    assert.equal(settled.ok, false, close);
    assert.equal(settled.error.code, "message-cancelled", close);
    assert.equal(generate.calls.length, 0, `${close}: the model was never called`);
    assert.equal(actions.active(), null, `${close}: the busy lock is released`);
    actions.dispose();
  }
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
    generateText: async () => {
      await gate;
      return { text: "change a" };
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

test("push previews redact credentials but the token keeps the exact raw target", async () => {
  const repo = makeRepo();
  baseline(repo);
  connectUpstream(repo);
  // Git resolves the raw URL below; no network is reached because the push
  // itself is answered by the wrapper. The credential must never reach the UI.
  repo.git("remote", "set-url", "origin", "https://alice:hunter2@example.invalid/acme/repo.git");
  repo.write("a.txt", "changed\n");
  repo.git("add", "a.txt");
  repo.git("commit", "-qm", "change");

  const calls = [];
  const actions = newActions({
    exec: async (call) => {
      calls.push(call);
      if (call.args.includes("push")) {
        return { ok: true, code: 0, spawnError: null, timedOut: false, stdout: "To example.invalid\n", stderr: "" };
      }
      return defaultExec(call);
    },
  });
  const preview = await actions.previewPush({ cwd: repo.dir });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  assert.equal(preview.destination, "https://example.invalid/acme/repo.git");
  assert.deepEqual(preview.destinations, ["https://example.invalid/acme/repo.git"]);
  assert.equal(JSON.stringify(preview).includes("hunter2"), false, "no credential in the preview");
  assert.equal(JSON.stringify(preview).includes("alice"), false, "no username in the preview");

  // The recheck and the push still compare against the raw URL kept in the
  // token: a redacted internal target would fail as repo-changed here.
  const pushed = await actions.push({ token: preview.token, confirm: true });
  assert.equal(pushed.ok, true, JSON.stringify(pushed.error));
  assert.equal(pushed.destination, "https://example.invalid/acme/repo.git");
  assert.equal(JSON.stringify(pushed).includes("hunter2"), false, "no credential in the push result");
  assert.equal(calls.some((call) => call.args.join(" ").includes("hunter2")), false, "the credential never enters argv");
  actions.dispose();
});

test("a push recheck compares the raw URL, not the redacted display copy", async () => {
  const repo = makeRepo();
  baseline(repo);
  connectUpstream(repo);
  repo.git("remote", "set-url", "origin", "https://alice:hunter2@example.invalid/acme/repo.git");
  repo.write("a.txt", "changed\n");
  repo.git("add", "a.txt");
  repo.git("commit", "-qm", "change");

  const actions = newActions();
  const preview = await actions.previewPush({ cwd: repo.dir });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  // Only the credential rotates; the redacted display would be identical. The
  // service must notice because its token kept the exact raw destination.
  repo.git("remote", "set-url", "origin", "https://alice:hunter3@example.invalid/acme/repo.git");
  const moved = await actions.push({ token: preview.token, confirm: true });
  assert.equal(moved.ok, false);
  assert.equal(moved.error.code, "repo-changed");
  assert.equal(moved.error.message.includes("hunter"), false, "the refusal carries no credential");
  actions.dispose();
});

test("a failed push redacts credentials from git stderr", async () => {
  const repo = makeRepo();
  baseline(repo);
  connectUpstream(repo);
  repo.git("remote", "set-url", "origin", "https://alice:hunter2@example.invalid/acme/repo.git");
  repo.write("a.txt", "changed\n");
  repo.git("add", "a.txt");
  repo.git("commit", "-qm", "change");

  const actions = newActions({
    exec: async (call) => {
      if (call.args.includes("push")) {
        return {
          ok: false,
          code: 128,
          spawnError: null,
          timedOut: false,
          stdout: "",
          stderr: "fatal: unable to access 'https://alice:hunter2@example.invalid/acme/repo.git/': denied\n",
        };
      }
      return defaultExec(call);
    },
  });
  const preview = await actions.previewPush({ cwd: repo.dir });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  const pushed = await actions.push({ token: preview.token, confirm: true });
  assert.equal(pushed.ok, false);
  assert.equal(pushed.error.code, "push-failed");
  assert.equal(pushed.error.message.includes("hunter2"), false, "the stderr credential is stripped");
  assert.equal(pushed.error.message.includes("alice"), false, "the stderr username is stripped");
  assert.match(pushed.error.message, /example\.invalid/);
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
  assert.deepEqual(pushCall.args, ["-c", "push.followTags=false", "push", "--no-follow-tags", "origin", `${preview.head}:refs/heads/main`]);
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
  // Their credentials are stripped before the message leaves the service.
  const other = "https://alice:hunter2@example.invalid/one.git";
  const third = "bob:swordfish@example.invalid:two.git";
  repo.git("config", "--add", "remote.origin.pushurl", other);
  repo.git("config", "--add", "remote.origin.pushurl", third);
  const many = await actions.previewPush({ cwd: repo.dir });
  assert.equal(many.ok, false);
  assert.equal(many.error.code, "multiple-push-targets");
  assert.match(many.error.message, /refusing to guess/);
  assert.match(many.error.message, /example\.invalid/);
  assert.equal(many.error.message.includes("hunter2"), false, "pushurl password stays private");
  assert.equal(many.error.message.includes("swordfish"), false, "scp-like password stays private");
  assert.equal(many.error.message.includes("alice"), false, "pushurl username stays private");
  assert.equal(many.error.message.includes("bob"), false, "scp-like username stays private");
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

test("discard during a commit defers token cleanup until the private index is free", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");

  const tmpRoot = tempDir("git-test-defer-");
  let reachedCommit;
  const commitReached = new Promise((resolve) => {
    reachedCommit = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const actions = newActions({
    tmpRoot,
    exec: async (call) => {
      if (call.args.includes("commit")) {
        reachedCommit();
        await gate;
      }
      return defaultExec(call);
    },
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  assert.equal(readdirSync(tmpRoot).length, 1, "the private review directory exists");

  const pending = actions.commit({ token: preview.token, message: "fix: defer discard" });
  await commitReached;

  // The flow closed while git was about to commit. Deleting the token now would
  // remove the private index git is still using, so the service queues it.
  const discarded = actions.discard({ token: preview.token });
  assert.equal(discarded.ok, true);
  assert.equal(discarded.deferred, true);
  assert.equal(existsSync(path.join(tmpRoot, readdirSync(tmpRoot)[0], "index")), true, "the index still exists for git");

  release();
  const committed = await pending;
  assert.equal(committed.ok, true, JSON.stringify(committed.error));
  assert.equal(repo.git("log", "-1", "--format=%s").trim(), "fix: defer discard");
  assert.equal(readdirSync(tmpRoot).length, 0, "the deferred token's temp directory is gone after settle");
  // The token was spent by the commit; the deferred cleanup is gone, not stuck.
  const replay = await actions.commit({ token: preview.token, message: "fix: again" });
  assert.equal(replay.error.code, "unknown-preview");
  actions.dispose();
});

test("dispose during a commit also defers cleanup until the commit settles", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const tmpRoot = tempDir("git-test-dispose-defer-");
  let reachedCommit;
  const commitReached = new Promise((resolve) => {
    reachedCommit = resolve;
  });
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const actions = newActions({
    tmpRoot,
    exec: async (call) => {
      if (call.args.includes("commit")) {
        reachedCommit();
        await gate;
      }
      return defaultExec(call);
    },
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const pending = actions.commit({ token: preview.token, message: "fix: dispose defer" });
  await commitReached;

  actions.dispose();
  assert.equal(readdirSync(tmpRoot).length, 1, "dispose does not delete state git is using");
  release();
  const committed = await pending;
  assert.equal(committed.ok, true, JSON.stringify(committed.error));
  assert.equal(readdirSync(tmpRoot).length, 0, "dispose cleanup runs after the commit settles");
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

// ------------------------------------------- frozen HEAD and reference guard

test("a concurrent HEAD advance before the commit is rejected, not replayed onto the new tip", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  let concurrent = null;
  let injected = false;
  const actions = newActions({
    exec: async (call) => {
      if (!injected && call.args.includes("commit")) {
        injected = true;
        repo.write("c.txt", "concurrent\n");
        gitIn(repo.dir, "add", "c.txt");
        gitIn(repo.dir, "commit", "-qm", "concurrent");
        concurrent = repo.git("rev-parse", "HEAD").trim();
      }
      return defaultExec(call);
    },
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));

  const committed = await actions.commit({ token: preview.token, message: "fix: concurrent guard" });
  assert.equal(committed.ok, false);
  assert.equal(committed.error.code, "commit-rejected");
  assert.match(committed.error.message, /moved before the commit/);
  // The concurrent commit is still the tip; the reviewed commit was not created.
  assert.equal(repo.git("rev-parse", "HEAD").trim(), concurrent);
  assert.equal(repo.git("log", "--format=%s").trim().split("\n")[0], "concurrent");
  assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "2");
  assert.equal(repo.git("show", "HEAD:a.txt"), "one\n");
  actions.dispose();
});

test("a HEAD advance during the pre-commit hook is rejected before publication", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  writeHook(
    repo.path(".git/hooks/pre-commit"),
    [
      "unset GIT_INDEX_FILE",
      "git -c core.hooksPath=/dev/null -c maintenance.auto=false commit --allow-empty --no-verify -qm concurrent",
    ].join("\n"),
  );

  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const committed = await actions.commit({ token: preview.token, message: "fix: hook race" });
  assert.equal(committed.ok, false);
  // Git's own old-OID lock and the guard both fail closed here; either rejection
  // is safe, and neither may publish the reviewed commit.
  assert.ok(["commit-rejected", "commit-failed"].includes(committed.error.code), committed.error.code);
  assert.equal(repo.git("log", "-1", "--format=%s").trim(), "concurrent");
  assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "2");
  actions.dispose();
});

test("a same-hash branch switch during the commit is rejected by the guard", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const base = repo.git("rev-parse", "HEAD").trim();
  repo.git("branch", "other");
  let switched = false;
  const actions = newActions({
    exec: async (call) => {
      if (!switched && call.args.includes("commit")) {
        switched = true;
        // Same commit, different branch: a hash-only check would pass here.
        gitIn(repo.dir, "symbolic-ref", "HEAD", "refs/heads/other");
      }
      return defaultExec(call);
    },
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));

  const committed = await actions.commit({ token: preview.token, message: "fix: branch race" });
  assert.equal(committed.ok, false);
  assert.equal(committed.error.code, "commit-rejected");
  assert.equal(repo.git("symbolic-ref", "HEAD").trim(), "refs/heads/other");
  assert.equal(repo.git("rev-parse", "main").trim(), base);
  assert.equal(repo.git("rev-parse", "other").trim(), base);
  assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "1");
  actions.dispose();
});

test("an unborn branch and a detached HEAD both commit through the guard", async () => {
  const unbornRepo = makeRepo();
  unbornRepo.write("a.txt", "first\n");
  const unbornActions = newActions();
  const unbornPreview = await unbornActions.preview({ cwd: unbornRepo.dir, files: ["a.txt"] });
  assert.equal(unbornPreview.ok, true, JSON.stringify(unbornPreview.error));
  assert.equal(unbornPreview.head, null);
  const unbornCommit = await unbornActions.commit({ token: unbornPreview.token, message: "feat: first" });
  assert.equal(unbornCommit.ok, true, JSON.stringify(unbornCommit.error));
  assert.equal(unbornRepo.git("show", "HEAD:a.txt"), "first\n");
  assert.equal(unbornRepo.git("symbolic-ref", "HEAD").trim(), "refs/heads/main");
  assert.equal(unbornRepo.git("rev-list", "--count", "HEAD").trim(), "1");
  unbornActions.dispose();

  const detachedRepo = makeRepo();
  baseline(detachedRepo);
  const main = detachedRepo.git("rev-parse", "main").trim();
  detachedRepo.git("checkout", "-q", "--detach");
  detachedRepo.write("a.txt", "detached\n");
  const detachedActions = newActions();
  const detachedPreview = await detachedActions.preview({ cwd: detachedRepo.dir, files: ["a.txt"] });
  assert.equal(detachedPreview.ok, true, JSON.stringify(detachedPreview.error));
  const detachedCommit = await detachedActions.commit({ token: detachedPreview.token, message: "fix: detached" });
  assert.equal(detachedCommit.ok, true, JSON.stringify(detachedCommit.error));
  assert.equal(detachedRepo.git("rev-parse", "HEAD").trim(), detachedCommit.hash);
  assert.throws(() => detachedRepo.git("symbolic-ref", "--quiet", "HEAD"));
  assert.equal(detachedRepo.git("rev-parse", "main").trim(), main);
  detachedActions.dispose();
});

test("default, relative, absolute and disabled hooks are all dispatched faithfully", { skip: process.platform === "win32" }, async () => {
  // A relative hooks path is resolved from the worktree root; an absolute one is
  // used as written; /dev/null disables hooks entirely.
  for (const mode of ["relative", "absolute", "disabled"]) {
    const repo = makeRepo();
    baseline(repo);
    repo.write("a.txt", "changed\n");
    const marker = path.join(tempDir("git-test-hook-marker-"), "ran");
    const hookBody = `git config --get core.hooksPath > ${shellArg(marker)}`;
    if (mode === "relative") {
      mkdirSync(repo.path("custom-hooks"), { recursive: true });
      writeHook(repo.path("custom-hooks/pre-commit"), hookBody);
      repo.git("config", "core.hooksPath", "custom-hooks");
    } else if (mode === "absolute") {
      const hooks = tempDir("git-test-abs-hooks-");
      writeHook(path.join(hooks, "pre-commit"), hookBody);
      repo.git("config", "core.hooksPath", hooks);
    } else {
      writeHook(repo.path(".git/hooks/pre-commit"), hookBody);
      repo.git("config", "core.hooksPath", "/dev/null");
    }

    const actions = newActions();
    const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
    assert.equal(preview.ok, true, `${mode}: ${JSON.stringify(preview.error)}`);
    const committed = await actions.commit({ token: preview.token, message: `fix: ${mode} hooks` });
    assert.equal(committed.ok, true, `${mode}: ${JSON.stringify(committed.error)}`);
    assert.equal(existsSync(marker), mode !== "disabled", `${mode}: hook dispatch`);
    if (mode !== "disabled") {
      // The original hook sees the real configuration: the outer -c hook path is
      // not leaked through GIT_CONFIG_PARAMETERS to a nested git command.
      const seen = readFileSync(marker, "utf8").trim();
      const expected = mode === "relative" ? "custom-hooks" : repo.git("config", "--get", "core.hooksPath").trim();
      assert.equal(seen, expected, `${mode}: original configuration is restored`);
    }
    actions.dispose();
  }
});

test("the original reference-transaction hook still sees every transaction and can reject", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const log = repo.path("rt.log");
  writeHook(
    repo.path(".git/hooks/reference-transaction"),
    `{ printf 'STATE=%s\\n' "$1"; cat; } >> ${shellArg(log)}`,
  );

  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const committed = await actions.commit({ token: preview.token, message: "fix: forward transaction" });
  assert.equal(committed.ok, true, JSON.stringify(committed.error));
  const lines = readFileSync(log, "utf8");
  // The original hook saw the prepared and committed states, with the same
  // stdin the guard parsed, plus git's own no-op pseudo-ref transactions.
  assert.match(lines, /STATE=prepared/);
  assert.match(lines, /STATE=committed/);
  assert.ok(lines.includes(`${preview.head} ${committed.hash} refs/heads/main`), lines);
  assert.match(lines, /AUTO_MERGE/);

  const rejecting = makeRepo();
  baseline(rejecting);
  rejecting.write("a.txt", "changed\n");
  writeHook(
    rejecting.path(".git/hooks/reference-transaction"),
    `if [ "$1" = "prepared" ]; then echo original-ref-rejected >&2; exit 1; fi\nexit 0`,
  );
  const rejectingActions = newActions();
  const rejectedPreview = await rejectingActions.preview({ cwd: rejecting.dir, files: ["a.txt"] });
  const rejected = await rejectingActions.commit({ token: rejectedPreview.token, message: "fix: rejected transaction" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "commit-rejected");
  assert.match(rejected.error.message, /rejected/);
  assert.equal(rejecting.git("rev-list", "--count", "HEAD").trim(), "1");
  assert.equal(rejecting.git("log", "-1", "--format=%s").trim(), "init");
  rejectingActions.dispose();
  actions.dispose();
});

test("hook arguments, working directory and message pass through the dispatcher", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const marker = path.join(tempDir("git-test-msg-marker-"), "commit-msg");
  writeHook(
    repo.path(".git/hooks/commit-msg"),
    [
      `{ printf 'cwd=%s\\n' "$(pwd)"`,
      `  printf 'argc=%s\\n' "$#"`,
      `  printf 'index=%s\\n' "$GIT_INDEX_FILE"`,
      `  printf 'message=%s\\n' "$(head -n 1 "$1")"; } > ${shellArg(marker)}`,
    ].join("\n"),
  );

  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const committed = await actions.commit({ token: preview.token, message: "fix: forwarded message" });
  assert.equal(committed.ok, true, JSON.stringify(committed.error));
  const seen = readFileSync(marker, "utf8");
  assert.ok(seen.includes(`cwd=${repo.git("rev-parse", "--show-toplevel").trim()}`), seen);
  assert.match(seen, /argc=1/);
  assert.match(seen, /message=fix: forwarded message/);
  // The hook still sees the private temp index, not the user's real index.
  const indexLine = /index=(.+)/.exec(seen)?.[1];
  assert.ok(indexLine, seen);
  assert.notEqual(indexLine, repo.path(".git/index"));
  assert.ok(indexLine.startsWith(BASE), indexLine);
  actions.dispose();
});

test("a post-commit hook that moves HEAD reports the created hash and skips reconcile", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo();
  baseline(repo);
  // A reserve commit that the post-commit hook can move HEAD to without touching
  // the real index.
  repo.git("checkout", "-q", "-b", "reserve");
  repo.write("c.txt", "reserve\n");
  repo.git("add", "c.txt");
  repo.git("commit", "-qm", "reserve");
  const reserve = repo.git("rev-parse", "HEAD").trim();
  repo.git("checkout", "-q", "main");
  repo.write("a.txt", "changed\n");
  writeHook(repo.path(".git/hooks/post-commit"), `git update-ref HEAD ${shellArg(reserve)}`);

  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const committed = await actions.commit({ token: preview.token, message: "fix: post-commit move" });
  assert.equal(committed.ok, false);
  assert.equal(committed.error.code, "head-moved");
  assert.equal(typeof committed.error.hash, "string");
  assert.equal(repo.git("cat-file", "-t", committed.error.hash).trim(), "commit");
  assert.equal(repo.git("show", `${committed.error.hash}:a.txt`), "changed\n");
  assert.notEqual(committed.error.hash, reserve, "the recorded hash is the created commit, not the moved HEAD");
  assert.equal(repo.git("rev-parse", "HEAD").trim(), reserve);
  assert.match(committed.error.message, /do not retry/);
  // The reconcile was skipped: the real index still holds the old selected blob.
  assert.equal(repo.git("show", ":a.txt"), "one\n");
  actions.dispose();
});

test("an unreadable real index fails closed at preview, recheck and reconcile", async () => {
  const isDigest = (call) => call.args[0] === "ls-files" && call.args.includes("--stage");

  const previewRepo = makeRepo();
  baseline(previewRepo);
  previewRepo.write("a.txt", "changed\n");
  const previewRoot = tempDir("git-test-digest-preview-");
  const previewActions = newActions({
    tmpRoot: previewRoot,
    exec: async (call) => (isDigest(call) ? failingCall("ls-files failed") : defaultExec(call)),
  });
  const preview = await previewActions.preview({ cwd: previewRepo.dir, files: ["a.txt"] });
  assert.equal(preview.ok, false);
  assert.equal(preview.error.code, "index-unreadable");
  assert.equal(readdirSync(previewRoot).length, 0, "no token state is left behind");
  previewActions.dispose();

  const recheckRepo = makeRepo();
  baseline(recheckRepo);
  recheckRepo.write("a.txt", "changed\n");
  let failDigest = false;
  const recheckActions = newActions({
    exec: async (call) => (failDigest && isDigest(call) ? failingCall("ls-files failed") : defaultExec(call)),
  });
  const recheckPreview = await recheckActions.preview({ cwd: recheckRepo.dir, files: ["a.txt"] });
  failDigest = true;
  const recheck = await recheckActions.commit({ token: recheckPreview.token, message: "fix: digest recheck" });
  assert.equal(recheck.ok, false);
  assert.equal(recheck.error.code, "index-unreadable");
  assert.equal(recheckRepo.git("rev-list", "--count", "HEAD").trim(), "1");
  // No commit was issued; the review token is still usable once the index reads.
  failDigest = false;
  const retried = await recheckActions.commit({ token: recheckPreview.token, message: "fix: digest recheck" });
  assert.equal(retried.ok, true, JSON.stringify(retried.error));
  recheckActions.dispose();

  const reconcileRepo = makeRepo();
  baseline(reconcileRepo);
  reconcileRepo.write("a.txt", "changed\n");
  let committed = false;
  const reconcileActions = newActions({
    exec: async (call) => {
      if (isDigest(call) && committed) return failingCall("ls-files failed");
      const result = await defaultExec(call);
      if (call.args.includes("commit")) committed = true;
      return result;
    },
  });
  const reconcilePreview = await reconcileActions.preview({ cwd: reconcileRepo.dir, files: ["a.txt"] });
  const reconciled = await reconcileActions.commit({ token: reconcilePreview.token, message: "fix: digest reconcile" });
  assert.equal(reconciled.ok, false);
  assert.equal(reconciled.error.code, "reconcile-index-unreadable");
  assert.equal(reconciled.error.hash, reconcileRepo.git("rev-parse", "HEAD").trim());
  assert.equal(reconcileRepo.git("show", ":a.txt"), "one\n", "the reset was skipped");
  reconcileActions.dispose();
});

test("a Git older than the reference-transaction hook fails closed before committing", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const actions = newActions({
    exec: async (call) =>
      call.args[0] === "--version"
        ? { ok: true, code: 0, spawnError: null, timedOut: false, stdout: "git version 2.28.0\n", stderr: "" }
        : defaultExec(call),
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const committed = await actions.commit({ token: preview.token, message: "fix: old git" });
  assert.equal(committed.ok, false);
  assert.equal(committed.error.code, "git-too-old");
  assert.match(committed.error.message, /Git 2\.29 or newer/);
  assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "1");
  actions.dispose();
});

test("a guard that cannot be prepared fails closed before git commit runs", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const actions = newActions({
    exec: async (call) =>
      call.args[0] === "rev-parse" && call.args.includes("--git-path")
        ? failingCall("fatal: cannot resolve hooks path")
        : defaultExec(call),
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const committed = await actions.commit({ token: preview.token, message: "fix: guard setup" });
  assert.equal(committed.ok, false);
  assert.equal(committed.error.code, "guard-unavailable");
  assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "1");
  actions.dispose();
});

test("a guard that cannot record its state fails closed", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const tmpRoot = tempDir("git-test-guard-record-");
  const actions = newActions({
    tmpRoot,
    exec: async (call) => {
      if (call.args.includes("commit")) {
        for (const name of readdirSync(tmpRoot)) {
          const guard = path.join(tmpRoot, name, "guard");
          if (existsSync(guard)) chmodSync(guard, 0o500);
        }
      }
      return defaultExec(call);
    },
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const committed = await actions.commit({ token: preview.token, message: "fix: guard record" });
  assert.equal(committed.ok, false);
  assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "1");
  actions.dispose();
});

test("push sends the frozen commit even if HEAD moves after the recheck", async () => {
  const repo = makeRepo();
  baseline(repo);
  connectUpstream(repo);
  repo.write("a.txt", "changed\n");
  repo.git("add", "a.txt");
  repo.git("commit", "-qm", "change");

  const calls = [];
  let advanced = false;
  const actions = newActions({
    exec: async (call) => {
      if (!advanced && call.args.includes("push")) {
        advanced = true;
        repo.write("c.txt", "later\n");
        gitIn(repo.dir, "add", "c.txt");
        gitIn(repo.dir, "commit", "-qm", "later");
        calls.push(call);
        return { ok: true, code: 0, spawnError: null, timedOut: false, stdout: "To origin\n", stderr: "" };
      }
      return defaultExec(call);
    },
  });
  const preview = await actions.previewPush({ cwd: repo.dir });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  const pushed = await actions.push({ token: preview.token, confirm: true });
  assert.equal(pushed.ok, true, JSON.stringify(pushed.error));

  const pushCall = calls.find((call) => call.args.includes("push"));
  assert.deepEqual(pushCall.args.slice(-2), ["origin", `${preview.head}:refs/heads/main`]);
  assert.notEqual(preview.head, repo.git("rev-parse", "HEAD").trim(), "HEAD moved after the recheck");
  actions.dispose();
});

test("the busy lock stays held until post-commit verification and reconcile settle", async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  let releaseShow;
  const showGate = new Promise((resolve) => {
    releaseShow = resolve;
  });
  let reachedShow;
  const showReached = new Promise((resolve) => {
    reachedShow = resolve;
  });
  const actions = newActions({
    exec: async (call) => {
      if (call.args[0] === "show" && call.args.includes("--format=%B")) {
        reachedShow();
        await showGate;
      }
      return defaultExec(call);
    },
  });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const pending = actions.commit({ token: preview.token, message: "fix: slow verification" });
  await showReached;

  // The ref is published, but the service must stay busy until the recorded
  // commit has been verified and the index reconciled.
  assert.ok(actions.active(), "the commit flow is still active");
  assert.equal(actions.active().phase, "commit");
  const blocked = await actions.status({ cwd: repo.dir });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.error.code, "busy");

  releaseShow();
  const committed = await pending;
  assert.equal(committed.ok, true, JSON.stringify(committed.error));
  assert.equal(actions.active(), null);
  actions.dispose();
});

test("a post-commit same-hash branch switch skips reconciliation", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  writeHook(
    repo.path(".git/hooks/post-commit"),
    ["git branch other HEAD", "git symbolic-ref HEAD refs/heads/other"].join("\n"),
  );

  const actions = newActions();
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const committed = await actions.commit({ token: preview.token, message: "fix: same hash switch" });
  assert.equal(committed.ok, false);
  assert.equal(committed.error.code, "head-moved");
  assert.equal(committed.error.hash, repo.git("rev-parse", "HEAD").trim());
  assert.equal(repo.git("symbolic-ref", "HEAD").trim(), "refs/heads/other");
  assert.equal(repo.git("rev-parse", "main").trim(), committed.error.hash);
  assert.equal(repo.git("rev-parse", "other").trim(), committed.error.hash);
  // The branch move was detected from the frozen identity, so the selected path
  // was not reset against the new branch.
  assert.equal(repo.git("show", ":a.txt"), "one\n");
  actions.dispose();
});

test("a committed-marker write failure is unknown, not a no-publication rejection", { skip: process.platform === "win32" || process.getuid?.() === 0 }, async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const tmpRoot = tempDir("git-test-record-unknown-");
  // The target transaction commits, then the guard cannot write its committed
  // marker. A later AUTO_MERGE prepared rejection must not turn that published
  // commit into a claimed no-publication outcome.
  writeHook(
    repo.path(".git/hooks/reference-transaction"),
    [
      'input=$(cat)',
      'if [ "$1" = "committed" ]; then',
      '  case "$input" in *" refs/heads/main"*) chmod 500 "${GIT_INDEX_FILE%/*}/guard" ;; esac',
      'elif [ "$1" = "prepared" ]; then',
      '  case "$input" in *" AUTO_MERGE"*) exit 1 ;; esac',
      "fi",
      "exit 0",
    ].join("\n"),
  );

  const actions = newActions({ tmpRoot });
  try {
    const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
    const committed = await actions.commit({ token: preview.token, message: "fix: committed record" });
    assert.equal(committed.ok, false);
    assert.equal(committed.error.code, "commit-outcome-unknown");
    assert.equal(committed.error.hash, undefined);
    // The ref update did land: there are two commits and the message is on HEAD.
    assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "2");
    assert.equal(repo.git("log", "-1", "--format=%s").trim(), "fix: committed record");
    // The review token is spent even though its outcome is unknown.
    const replay = await actions.commit({ token: preview.token, message: "fix: again" });
    assert.equal(replay.error.code, "unknown-preview");
  } finally {
    for (const name of readdirSync(tmpRoot)) {
      const guard = path.join(tmpRoot, name, "guard");
      if (existsSync(guard)) chmodSync(guard, 0o700);
    }
    actions.dispose();
    for (const name of readdirSync(tmpRoot)) {
      rmSync(path.join(tmpRoot, name), { recursive: true, force: true });
    }
  }
});

test("a prepared marker plus a later prepared rejection is unknown, not a no-publication claim", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo();
  baseline(repo);
  repo.write("a.txt", "changed\n");
  const tmpRoot = tempDir("git-test-prepared-rejected-");
  // The target commit is published but its committed marker is unusable. A
  // later AUTO_MERGE prepared rejection must not turn that into "nothing was
  // published": prepared plus rejected is ambiguous.
  writeHook(
    repo.path(".git/hooks/reference-transaction"),
    [
      'input=$(cat)',
      'if [ "$1" = "committed" ]; then',
      '  case "$input" in *" refs/heads/main"*) mkdir -p "${GIT_INDEX_FILE%/*}/guard/committed" ;; esac',
      'elif [ "$1" = "prepared" ]; then',
      '  case "$input" in *" AUTO_MERGE"*) exit 1 ;; esac',
      "fi",
      "exit 0",
    ].join("\n"),
  );

  const actions = newActions({ tmpRoot });
  const preview = await actions.preview({ cwd: repo.dir, files: ["a.txt"] });
  const committed = await actions.commit({ token: preview.token, message: "fix: ambiguous guard state" });
  assert.equal(committed.ok, false);
  assert.equal(committed.error.code, "commit-outcome-unknown");
  assert.equal(committed.error.hash, undefined);
  assert.equal(repo.git("rev-list", "--count", "HEAD").trim(), "2");
  assert.equal(repo.git("log", "-1", "--format=%s").trim(), "fix: ambiguous guard state");
  const replay = await actions.commit({ token: preview.token, message: "fix: again" });
  assert.equal(replay.error.code, "unknown-preview");
  actions.dispose();
});

test("a linked worktree commits on its own branch with its relative hooks", { skip: process.platform === "win32" }, async () => {
  const repo = makeRepo();
  baseline(repo);
  const main = repo.git("rev-parse", "main").trim();
  const worktree = path.join(tempDir("git-test-worktree-"), "wt");
  gitIn(repo.dir, "worktree", "add", "-q", "-b", "feature", worktree);
  mkdirSync(path.join(worktree, ".githooks"), { recursive: true });
  const marker = path.join(tempDir("git-test-worktree-marker-"), "ran");
  writeHook(path.join(worktree, ".githooks", "pre-commit"), `: > ${shellArg(marker)}`);
  writeFileSync(path.join(worktree, "a.txt"), "linked change\n");
  // Per-worktree configuration: the relative path is resolved from this
  // worktree, not from the main checkout or the common git directory.
  repo.git("config", "extensions.worktreeConfig", "true");
  gitIn(worktree, "config", "--worktree", "core.hooksPath", ".githooks");

  const actions = newActions();
  const preview = await actions.preview({ cwd: worktree, files: ["a.txt"] });
  assert.equal(preview.ok, true, JSON.stringify(preview.error));
  const committed = await actions.commit({ token: preview.token, message: "fix: linked worktree" });
  assert.equal(committed.ok, true, JSON.stringify(committed.error));
  assert.equal(existsSync(marker), true, "the relative hook ran from the linked worktree");
  assert.equal(gitIn(worktree, "rev-parse", "HEAD").trim(), committed.hash);
  assert.equal(gitIn(worktree, "symbolic-ref", "HEAD").trim(), "refs/heads/feature");
  assert.equal(repo.git("rev-parse", "main").trim(), main);
  actions.dispose();
});
