// Is this directory inside a Git repository?
//
// The sidebar needs that answer on every paint to decide whether the Commit and
// Push controls exist at all. Running `git rev-parse` for it would spawn a
// process per paint, so detection is pure filesystem work: walk up from the
// directory and look for a `.git` entry. The nearest one wins, which is what
// makes a nested repository and a linked worktree both resolve correctly:
//   - ordinary repository: `.git` is a directory,
//   - linked worktree / submodule: `.git` is a file holding `gitdir: <path>`.
//
// Existing is not the same as being a repository. An empty directory that merely
// happens to be named `.git`, or a plain file with that name, would otherwise
// light up the Git controls. So the candidate must hold minimal real Git
// metadata: a `HEAD` entry. That is one extra stat on the path we already stat,
// never a command.
//
// No git command is ever run here, and no mutation safeguard is involved: this
// module only reports whether the view may offer the buttons.
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

const GITDIR = /^gitdir:[ \t]*(.+?)[\r\n]*$/m;
const WORKTREE = /[\\/]worktrees[\\/]/;
const MODULES = /[\\/]modules[\\/]/;

// An unreadable directory is a real error, not "no repository": the caller must
// be able to tell them apart (a permission problem is reported, a plain
// non-repository is simply not offered Git controls).
function isFsError(error) {
  return Boolean(
    error &&
      typeof error.code === "string" &&
      error.code !== "ENOENT" &&
      error.code !== "ENOTDIR",
  );
}

function missing(reason, error = null) {
  return { inRepo: false, root: null, gitDir: null, worktree: false, submodule: false, error, reason };
}

function found(root, gitDir, { worktree = false, submodule = false } = {}) {
  return { inRepo: true, root, gitDir, worktree, submodule, error: null, reason: null };
}

// Minimal proof that a directory is a real Git directory: it has a HEAD entry.
function hasHead(dir, stat) {
  try {
    if (stat(path.join(dir, "HEAD")).isFile()) return { ok: true };
    return { ok: false, reason: "no-head", error: null };
  } catch (error) {
    if (isFsError(error)) return { ok: false, error: error.code };
    return { ok: false, reason: "no-head", error: null };
  }
}

// A pointer target must itself be a Git directory. `absentReason` distinguishes
// a target that is not there at all ("missing-target") from one that exists but
// is not usable ("no-head").
function gitDirAt(dir, stat, absentReason) {
  let info;
  try {
    info = stat(dir);
  } catch (error) {
    if (isFsError(error)) return { ok: false, error: error.code };
    return { ok: false, reason: absentReason, error: null };
  }
  if (!info || !info.isDirectory()) return { ok: false, reason: absentReason, error: null };
  return hasHead(dir, stat);
}

// Returns `{ inRepo, root, gitDir, worktree, submodule, error, reason }`.
//   inRepo  - true when a repository (or worktree) contains `dir`
//   root    - the directory holding the `.git` entry
//   gitDir  - the `.git` path (for a worktree, the target it points at)
//   error   - an fs error code when a read could not be completed
//   reason  - why this is not a repository: "no-git", "no-head",
//             "bad-pointer", "missing-target" or "unreadable"; null in a repo
export function detectRepository(dir, deps = {}) {
  const stat = deps.statSync ?? statSync;
  const read = deps.readFileSync ?? readFileSync;

  let current = path.resolve(dir || ".");
  for (;;) {
    const dotGit = path.join(current, ".git");
    let info;
    try {
      info = stat(dotGit);
    } catch (error) {
      if (isFsError(error)) return missing("unreadable", error.code);
      info = null;
    }

    if (info && info.isDirectory()) {
      const head = hasHead(dotGit, stat);
      if (head.ok) return found(current, dotGit);
      return missing(head.reason ?? "unreadable", head.error);
    }

    if (info && info.isFile()) {
      // A worktree or a submodule checkout: the file holds a pointer to the real
      // Git directory, which must exist and look like one.
      let pointer = null;
      try {
        const match = GITDIR.exec(String(read(dotGit, "utf8")));
        if (match) pointer = match[1].trim();
      } catch (error) {
        // The pointer exists but cannot be read: that is an error, not a plain
        // non-repository, so the caller can report it instead of pretending the
        // directory is simply not versioned.
        return missing("unreadable", isFsError(error) ? error.code : null);
      }
      if (!pointer) return missing("bad-pointer");
      const target = path.isAbsolute(pointer) ? pointer : path.resolve(current, pointer);
      const head = gitDirAt(target, stat, "missing-target");
      if (head.ok) {
        return found(current, target, {
          worktree: WORKTREE.test(target),
          submodule: MODULES.test(target),
        });
      }
      return missing(head.reason ?? "unreadable", head.error);
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return missing("no-git");
}

// Detection stats a handful of paths per paint; cache it briefly per directory.
// The cache is bounded (LRU by insertion order) so a long-lived TUI that visits
// many directories cannot grow it without limit.
export function createGitDetector(options = {}) {
  const ttlMs = options.ttlMs ?? 4000;
  const now = options.now ?? Date.now;
  const max = options.max ?? 64;
  const deps = { statSync: options.statSync, readFileSync: options.readFileSync };
  const cache = new Map();

  return {
    detect(dir, { fresh = false } = {}) {
      const key = path.resolve(dir || ".");
      const hit = cache.get(key);
      if (!fresh && hit && now() - hit.at < ttlMs) return hit.value;
      const value = detectRepository(key, deps);
      cache.delete(key);
      cache.set(key, { at: now(), value });
      if (cache.size > max) {
        const oldest = cache.keys().next();
        if (!oldest.done) cache.delete(oldest.value);
      }
      return value;
    },
    size() {
      return cache.size;
    },
    clear() {
      cache.clear();
    },
  };
}
