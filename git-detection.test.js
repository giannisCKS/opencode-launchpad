import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGitDetector, detectRepository } from "./git-detection.js";

const roots = [];
function tempDir() {
  const dir = mkdtempSync(path.join(tmpdir(), "control-git-detection-"));
  roots.push(dir);
  return dir;
}

test.after(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function enoent() {
  return Object.assign(new Error("ENOENT: no such file or directory"), { code: "ENOENT" });
}

// A filesystem that only contains what a test declares. `dirs` are real
// directories, `files` are real files: a `.git` pointer, or the `HEAD` entry
// that proves a Git directory is one.
function fakeFs({ dirs = [], files = {}, errors = {} } = {}) {
  const directories = new Set(dirs.map((dir) => path.resolve(dir)));
  const fileContents = new Map();
  for (const [file, content] of Object.entries(files)) {
    fileContents.set(path.resolve(file), content);
  }
  const statSync = (target) => {
    const resolved = path.resolve(target);
    if (errors[resolved]) throw errors[resolved];
    if (directories.has(resolved)) return { isDirectory: () => true, isFile: () => false };
    if (fileContents.has(resolved)) return { isDirectory: () => false, isFile: () => true };
    throw enoent();
  };
  const readFileSync = (target) => {
    const resolved = path.resolve(target);
    if (errors[resolved]) throw errors[resolved];
    if (!fileContents.has(resolved)) throw enoent();
    return fileContents.get(resolved);
  };
  return { statSync, readFileSync };
}

// A Git directory always has HEAD; a bare directory named `.git` is not one.
function head(dir) {
  return path.join(dir, ".git", "HEAD");
}

test("a plain repository is detected from any directory inside it", () => {
  const repo = path.resolve("/work/repo");
  const deps = fakeFs({
    dirs: [path.join(repo, ".git")],
    files: { [head(repo)]: "ref: refs/heads/main\n" },
  });
  const nested = path.join(repo, "packages", "app");

  for (const dir of [repo, nested, path.join(repo, "src", "deep", "deeper")]) {
    const result = detectRepository(dir, deps);
    assert.equal(result.inRepo, true, dir);
    assert.equal(result.root, repo, "the directory holding .git wins");
    assert.equal(result.gitDir, path.join(repo, ".git"));
    assert.equal(result.worktree, false);
    assert.equal(result.submodule, false);
    assert.equal(result.error, null);
    assert.equal(result.reason, null);
  }
});

test("a plain folder is not a repository", () => {
  const dir = path.resolve("/work/plain");
  const result = detectRepository(dir, fakeFs({}));
  assert.equal(result.inRepo, false);
  assert.equal(result.root, null);
  assert.equal(result.error, null, "a missing .git is not an error");
  assert.equal(result.reason, "no-git");
});

test("a directory named .git without Git metadata is not a repository", () => {
  const dir = path.resolve("/work/not-really");
  // The directory exists but has no HEAD: it is a folder that happens to be
  // called `.git`, not a repository.
  const result = detectRepository(dir, fakeFs({ dirs: [path.join(dir, ".git")] }));
  assert.equal(result.inRepo, false);
  assert.equal(result.reason, "no-head");
  assert.equal(result.error, null, "a missing HEAD is not an fs error");
});

test("the nearest repository wins for a nested repository", () => {
  const outer = path.resolve("/work/outer");
  const inner = path.resolve("/work/outer/vendor/inner");
  const deps = fakeFs({
    dirs: [path.join(outer, ".git"), path.join(inner, ".git")],
    files: {
      [head(outer)]: "ref: refs/heads/main\n",
      [head(inner)]: "ref: refs/heads/main\n",
    },
  });
  assert.equal(detectRepository(path.join(inner, "src"), deps).root, inner);
  assert.equal(detectRepository(path.join(outer, "src"), deps).root, outer);
});

test("a linked worktree is detected and classified", () => {
  const worktree = path.resolve("/work/feature");
  const common = path.resolve("/work/repo", ".git", "worktrees", "feature");
  const deps = fakeFs({
    dirs: [common],
    files: {
      [path.join(worktree, ".git")]: `gitdir: ${common}\n`,
      [path.join(common, "HEAD")]: "ref: refs/heads/feature\n",
    },
  });
  const result = detectRepository(worktree, deps);
  assert.equal(result.inRepo, true);
  assert.equal(result.root, worktree);
  assert.equal(result.gitDir, common);
  assert.equal(result.worktree, true);
  assert.equal(result.submodule, false);
});

test("a relative gitdir pointer is resolved against the .git file's directory", () => {
  const worktree = path.resolve("/work/feature");
  const deps = fakeFs({
    dirs: [path.resolve("/work/repo/.git/worktrees/feature")],
    files: {
      [path.join(worktree, ".git")]: "gitdir: ../repo/.git/worktrees/feature\n",
      [path.resolve("/work/repo/.git/worktrees/feature/HEAD")]: "ref: refs/heads/feature\n",
    },
  });
  const result = detectRepository(path.join(worktree, "src"), deps);
  assert.equal(result.inRepo, true);
  assert.equal(result.gitDir, path.resolve("/work/repo/.git/worktrees/feature"));
  assert.equal(result.worktree, true);
});

test("a submodule checkout is distinguished from a worktree", () => {
  const submodule = path.resolve("/work/repo/vendor/lib");
  const pointer = path.resolve("/work/repo/.git/modules/vendor/lib");
  const deps = fakeFs({
    dirs: [pointer],
    files: {
      [path.join(submodule, ".git")]: `gitdir: ${pointer}`,
      [path.join(pointer, "HEAD")]: "ref: refs/heads/main\n",
    },
  });
  const result = detectRepository(submodule, deps);
  assert.equal(result.inRepo, true);
  assert.equal(result.submodule, true);
  assert.equal(result.worktree, false);
});

test("an arbitrary .git file is not a repository", () => {
  const dir = path.resolve("/work/stray");
  const deps = fakeFs({ files: { [path.join(dir, ".git")]: "not a git pointer\n" } });
  const result = detectRepository(dir, deps);
  assert.equal(result.inRepo, false, "a file named .git is not proof on its own");
  assert.equal(result.reason, "bad-pointer");
  assert.equal(result.error, null);
});

test("a dangling gitdir pointer is not a repository", () => {
  const dir = path.resolve("/work/dangling");
  const deps = fakeFs({
    files: { [path.join(dir, ".git")]: "gitdir: /gone/worktrees/feature\n" },
  });
  const result = detectRepository(dir, deps);
  assert.equal(result.inRepo, false);
  assert.equal(result.reason, "missing-target");
  assert.equal(result.error, null);
});

test("a gitdir pointer to a directory without HEAD is not a repository", () => {
  const dir = path.resolve("/work/empty-target");
  const target = path.resolve("/work/repo/.git/worktrees/gone");
  const deps = fakeFs({
    dirs: [target],
    files: { [path.join(dir, ".git")]: `gitdir: ${target}\n` },
  });
  const result = detectRepository(dir, deps);
  assert.equal(result.inRepo, false);
  assert.equal(result.reason, "no-head");
});

test("a .git file whose pointer cannot be read is reported, not guessed", () => {
  const dir = path.resolve("/work/locked");
  // stat sees the file, read fails. The content is unknown, so the directory is
  // not claimed as a repository; the caller learns why.
  const deps = {
    statSync: () => ({ isDirectory: () => false, isFile: () => true }),
    readFileSync: () => {
      throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
    },
  };
  const result = detectRepository(dir, deps);
  assert.equal(result.inRepo, false);
  assert.equal(result.gitDir, null, "the pointer could not be read");
  assert.equal(result.error, "EACCES", "the caller still learns about the failure");
  assert.equal(result.reason, "unreadable");
});

test("a permission error is reported, never silently read as no repository", () => {
  const dir = path.resolve("/work/secret");
  const dotGit = path.join(dir, ".git");
  const error = Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
  const result = detectRepository(dir, fakeFs({ errors: { [dotGit]: error } }));
  assert.equal(result.inRepo, false, "not claimed as a repository");
  assert.equal(result.error, "EACCES", "the caller can tell an error from a plain folder");
  assert.equal(result.reason, "unreadable");
});

test("ENOTDIR is treated as a missing entry, not an error", () => {
  const dir = path.resolve("/work/file-path");
  const dotGit = path.join(dir, ".git");
  const result = detectRepository(dir, fakeFs({
    errors: { [dotGit]: Object.assign(new Error("ENOTDIR"), { code: "ENOTDIR" }) },
  }));
  assert.equal(result.inRepo, false);
  assert.equal(result.error, null);
  assert.equal(result.reason, "no-git");
});

test("the detector caches per directory and bounds the stats per paint", () => {
  const repo = path.resolve("/work/repo");
  const base = fakeFs({
    dirs: [path.join(repo, ".git")],
    files: { [head(repo)]: "ref: refs/heads/main\n" },
  });
  let stats = 0;
  const deps = {
    statSync: (target) => {
      stats += 1;
      return base.statSync(target);
    },
    readFileSync: base.readFileSync,
  };
  let clock = 1000;
  const detector = createGitDetector({ statSync: deps.statSync, readFileSync: deps.readFileSync, now: () => clock });

  assert.equal(detector.detect(repo).inRepo, true);
  const afterFirst = stats;
  assert.equal(afterFirst, 2, "a paint costs two stats: .git and its HEAD, never a command");
  detector.detect(repo);
  detector.detect(repo);
  assert.equal(stats, afterFirst, "a cache hit does not touch the filesystem");

  clock += 4001;
  const beforeExpiry = stats;
  detector.detect(repo);
  assert.equal(stats - beforeExpiry, 2, "the entry expires after the ttl and is recomputed");

  detector.detect(repo);
  const beforeFresh = stats;
  detector.detect(repo, { fresh: true });
  assert.equal(stats - beforeFresh, 2, "fresh bypasses the cache");
});

test("the cache is bounded so a long session cannot grow it forever", () => {
  const detector = createGitDetector({
    max: 3,
    statSync: () => ({ isDirectory: () => false, isFile: () => false }),
    readFileSync: () => "",
    now: () => 0,
  });
  for (const dir of ["/a", "/b", "/c", "/d", "/e"]) detector.detect(dir);
  assert.equal(detector.size(), 3);
  // The oldest insertions were evicted, the newest are retained.
  assert.equal(detector.detect("/e").inRepo, false);
  detector.clear();
  assert.equal(detector.size(), 0);
});

test("the cache key is the resolved path, so two spellings share one entry", () => {
  const deps = fakeFs({});
  let stats = 0;
  const detector = createGitDetector({
    statSync: (target) => {
      stats += 1;
      return deps.statSync(target);
    },
    readFileSync: deps.readFileSync,
    now: () => 0,
  });
  detector.detect("/work/plain");
  const after = stats;
  detector.detect("/work/./plain");
  assert.equal(stats, after, "the same directory is one cache entry");
  assert.equal(detector.size(), 1);
});

test("real files: an ordinary repository and a worktree pointer", () => {
  const repo = tempDir();
  mkdirSync(path.join(repo, ".git"), { recursive: true });
  writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  mkdirSync(path.join(repo, "src", "nested"), { recursive: true });
  assert.equal(detectRepository(path.join(repo, "src", "nested")).root, repo);

  const plain = tempDir();
  assert.equal(detectRepository(plain).inRepo, false);

  // A directory that only looks like a repository: `.git` without HEAD.
  const fake = tempDir();
  mkdirSync(path.join(fake, ".git"), { recursive: true });
  const lookedLike = detectRepository(fake);
  assert.equal(lookedLike.inRepo, false, "an empty .git directory is not a repository");
  assert.equal(lookedLike.reason, "no-head");

  const worktree = tempDir();
  const pointer = path.join(repo, ".git", "worktrees", "wt");
  mkdirSync(pointer, { recursive: true });
  writeFileSync(path.join(pointer, "HEAD"), "ref: refs/heads/wt\n");
  writeFileSync(path.join(worktree, ".git"), `gitdir: ${pointer}\n`);
  const detected = detectRepository(worktree);
  assert.equal(detected.inRepo, true);
  assert.equal(detected.worktree, true);
  assert.equal(detected.gitDir, pointer);

  // A dangling pointer hides the Git controls instead of offering them.
  const dangling = tempDir();
  writeFileSync(path.join(dangling, ".git"), "gitdir: /gone/worktrees/wt\n");
  const broken = detectRepository(dangling);
  assert.equal(broken.inRepo, false);
  assert.equal(broken.reason, "missing-target");
});
