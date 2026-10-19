// Sidebar layout, measured from a real render.
//
// The other view tests read view.jsx as text. This one mounts it: it copies the
// real view.jsx into a scratch directory that can resolve @opentui/solid, then
// renders the sidebar through the OpenTUI test renderer and checks the layout
// the renderer produced. Every number below is a rendered bound: either a box
// bound from the renderable tree or a cell span read back from the drawn frame.
//
// The renderer needs bun and an installed @opentui/solid. When either is
// missing the test skips and says why, so the rest of the suite still runs.
//
// Two steps prepare the scratch directory before it renders:
//
//   1. The JSX is compiled with babel-preset-solid, the way a plugin is built
//      for the host. Bun's own JSX transform evaluates children once, so a tree
//      built by bun alone never reacts to a signal; babel wraps them in
//      accessors, which is what makes the sidebar live.
//   2. solid-js is pinned to its client build. Bun's default conditions pick
//      solid-js/dist/server.js, the server build, which has no reactive core;
//      with it the first frame draws and every later update is dropped.
//
//   node --test view.render.test.mjs
//   KEEP=1 node --test view.render.test.mjs   # keep the scratch directory
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { before, describe } from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const MARKER = "##SIDEBAR-RENDER##";
const PACKAGES = [
  "@opentui/core",
  "@opentui/core-linux-x64",
  "@opentui/solid",
  "solid-js",
  "@babel/core",
  "babel-preset-solid",
];
const KEEP = process.env.KEEP === "1";

// The scratch copy of solid-js: the same package, with the client build on the
// bare specifier. Everything else in the tree then shares one reactive core.
const SOLID_SHIM = {
  name: "solid-js",
  version: "1.9.12",
  type: "module",
  exports: {
    ".": { types: "./types/index.d.ts", import: "./dist/solid.js", require: "./dist/solid.cjs" },
    "./dist/*": "./dist/*",
    "./types/*": "./types/*",
    "./package.json": "./package.json",
  },
};

// The build script, run with bun inside the scratch directory.
const BUILD = `import fs from "node:fs/promises";
import babel from "@babel/core";
import solidPreset from "babel-preset-solid";

const presets = [[solidPreset, { moduleName: "@opentui/solid", generate: "universal" }]];
const jobs = [
  ["view.jsx", "view.js", null],
  ["view.render.harness.jsx", "harness.mjs", 'from "./view.jsx"'],
];
for (const [input, output, specifier] of jobs) {
  const source = await fs.readFile(input, "utf8");
  const transformed = await babel.transformAsync(source, {
    filename: input,
    configFile: false,
    babelrc: false,
    presets,
  });
  if (!transformed?.code) throw new Error("babel produced no code for " + input);
  const code = specifier ? transformed.code.replaceAll(specifier, 'from "./view.js"') : transformed.code;
  if (specifier && !code.includes('from "./view.js"')) {
    throw new Error("could not point " + output + " at the compiled view");
  }
  await fs.writeFile(output, code + "\\n");
}
`;

function findBun() {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "bun");
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

function list(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

// A pnpm store keeps one directory per package, and the package sits in that
// directory's own node_modules. The three @opentui packages must agree on one
// version; solid-js carries its own version, so it is chosen separately.
function candidates(store, entries, name) {
  // A scoped name is spelled scope+name in the store, an unscoped one is not.
  const slash = name.lastIndexOf("/");
  const prefix = slash < 0 ? `${name}@` : `${name.slice(0, slash)}+${name.slice(slash + 1)}@`;
  const found = new Map();
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    const target = path.join(store, entry, "node_modules", name);
    if (!fs.existsSync(target)) continue;
    const version = entry.slice(prefix.length).split(/[_@]/)[0];
    if (!found.has(version)) found.set(version, target);
  }
  return found;
}

function newest(versions) {
  const score = (version) =>
    version.split(/[.\-+]/).map((part) => (Number.parseInt(part, 10) || 0));
  return versions.sort((left, right) => {
    const a = score(left);
    const b = score(right);
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      const diff = (a[index] ?? 0) - (b[index] ?? 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }).pop();
}

function fromStore(store) {
  const entries = list(store);
  const solid = candidates(store, entries, "solid-js");
  if (solid.size === 0) return null;
  const babel = candidates(store, entries, "@babel/core");
  const preset = candidates(store, entries, "babel-preset-solid");
  if (babel.size === 0 || preset.size === 0) return null;
  const babelVersion = newest([...babel.keys()]);
  const solidVersion = newest([...solid.keys()]);
  // babel-preset-solid declares the @babel/core and solid-js it was built
  // against, so its store directory name carries the matching versions.
  const presetEntry = list(store).find(
    (entry) =>
      entry.startsWith("babel-preset-solid@") &&
      entry.includes(`@babel+core@${babelVersion}`) &&
      entry.includes(`solid-js@${solidVersion}`),
  );
  if (!presetEntry) return null;
  for (const [version, core] of candidates(store, entries, "@opentui/core")) {
    const native = candidates(store, entries, "@opentui/core-linux-x64").get(version);
    const forSolid = candidates(store, entries, "@opentui/solid").get(version);
    if (!native || !forSolid) continue;
    return {
      version,
      dirs: [
        ["@opentui/core", core],
        ["@opentui/core-linux-x64", native],
        ["@opentui/solid", forSolid],
        ["solid-js", solid.get(solidVersion)],
        ["@babel/core", babel.get(babelVersion)],
        ["babel-preset-solid", path.join(store, presetEntry, "node_modules", "babel-preset-solid")],
      ],
    };
  }
  return null;
}

function fromRoot(root) {
  const dirs = [];
  for (const name of PACKAGES) {
    const target = path.join(root, "node_modules", name);
    if (!fs.existsSync(target)) return null;
    dirs.push([name, target]);
  }
  return { version: "installed", dirs };
}

// Installed copies usually live in a sibling project's node_modules.
function findPackages() {
  const parent = path.dirname(here);
  const roots = [here, parent, path.dirname(parent)];
  const search = [here, ...roots.map((root) => path.join(root, "node_modules", ".pnpm"))];
  for (const sibling of list(parent)) {
    search.push(path.join(parent, sibling, "node_modules", ".pnpm"));
  }
  for (const root of roots) {
    const direct = fromRoot(root);
    if (direct) return direct;
  }
  for (const store of search) {
    const found = fromStore(store);
    if (found) return found;
  }
  return null;
}

// spawnSync reports a killed or over-buffered child as status null, so say why.
function failure(result) {
  const error = result.error?.message ?? "";
  const signal = result.signal ? `, signal ${result.signal}` : "";
  return `${signal}${error ? `, ${error}` : ""}`;
}

function render() {
  const bun = findBun();
  if (!bun) throw new Error("bun is not on PATH, so the OpenTUI renderer cannot run");
  const packages = findPackages();
  if (!packages) throw new Error(`no install found with ${PACKAGES.join(", ")}`);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-sidebar-render-"));
  for (const name of ["view.jsx", "runners.js", "view.render.harness.jsx"]) {
    const from = path.join(here, name);
    const to = path.join(dir, name);
    fs.copyFileSync(from, to);
    // The copy must be the file under test, byte for byte.
    assert.deepEqual(fs.readFileSync(to), fs.readFileSync(from), `${name} copy differs`);
  }

  const nodeModules = path.join(dir, "node_modules");
  fs.mkdirSync(nodeModules, { recursive: true });
  let solid = null;
  for (const [name, target] of packages.dirs) {
    // solid-js is shimmed below so its client build is the one the tree loads.
    if (name === "solid-js") {
      solid = target;
      continue;
    }
    const nested = path.join(nodeModules, name);
    fs.mkdirSync(path.dirname(nested), { recursive: true });
    fs.symlinkSync(target, nested, "dir");
  }
  assert.ok(solid, "the found install has no solid-js");
  const shim = path.join(nodeModules, "solid-js");
  fs.mkdirSync(shim, { recursive: true });
  fs.symlinkSync(path.join(solid, "dist"), path.join(shim, "dist"), "dir");
  fs.symlinkSync(path.join(solid, "types"), path.join(shim, "types"), "dir");
  fs.writeFileSync(path.join(shim, "package.json"), `${JSON.stringify(SOLID_SHIM, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, "build.mjs"), BUILD);

  const runBun = (script) =>
    spawnSync(bun, ["run", path.join(dir, script)], {
      cwd: dir,
      encoding: "utf8",
      timeout: 240_000,
      // The harness prints every scenario's frames and bounds, which is well past
      // the one megabyte spawnSync allows by default.
      maxBuffer: 256 * 1024 * 1024,
      env: { ...process.env, NO_COLOR: "1" },
    });
  const build = runBun("build.mjs");
  if (build.status !== 0) {
    throw new Error(
      `babel build exited ${build.status}${failure(build)}: ${(build.stderr ?? "").trim().slice(0, 2000)}`,
    );
  }
  const run = runBun("harness.mjs");
  if (run.status !== 0) {
    throw new Error(
      `renderer exited ${run.status}${failure(run)} with @opentui ${packages.version}: ${(run.stderr ?? "").trim().slice(0, 2000)}`,
    );
  }
  const at = run.stdout.indexOf(MARKER);
  if (at < 0) throw new Error(`renderer printed no result: ${run.stdout.slice(0, 400)}`);
  const data = JSON.parse(run.stdout.slice(at + MARKER.length).trim());
  if (!KEEP) fs.rmSync(dir, { recursive: true, force: true });
  else process.stderr.write(`scratch dir kept at ${dir}\n`);
  return data;
}

// A cell is the only bordered box that carries a label, so the row box above it
// can never stand in for a cell. Bounds are read per frame, because a scenario
// that toggles state draws a different layout in each frame.
function nodesOf(entry, frame) {
  return entry.nodesByFrame?.[frame] ?? entry.nodes;
}

function cell(entry, label, frame = "frame") {
  return nodesOf(entry, frame).find(
    (each) => each.label === label && each.border === true && each.y >= 0,
  );
}

function expectCell(entry, label, frame = "frame") {
  const found = cell(entry, label, frame);
  assert.ok(found, `${entry.name}: no rendered cell for "${label}"\n${entry.frames[frame]}`);
  return found;
}

function expectHidden(entry, label, frame = "frame") {
  assert.equal(cell(entry, label, frame), undefined, `${entry.name}: "${label}" still rendered`);
  const text = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.doesNotMatch(entry.frames[frame], new RegExp(text), `${entry.name}: "${label}" still drawn`);
}

// Two buttons in one row split the width equally, minus the one column gap,
// with the odd column in the first slot.
function expectPair(entry, first, second, width, frame = "frame") {
  const left = expectCell(entry, first, frame);
  const right = expectCell(entry, second, frame);
  const expected = Math.ceil((width - 1) / 2);
  assert.equal(left.x, 0, `${entry.name}: "${first}" starts at column ${left.x}`);
  assert.equal(
    right.x,
    left.x + left.w + 1,
    `${entry.name}: "${first}" and "${second}" are not separated by one column`,
  );
  assert.ok(
    Math.abs(left.w - expected) <= 1,
    `${entry.name}: "${first}" is ${left.w} wide, expected ${expected} ± 1`,
  );
  assert.ok(
    Math.abs(right.w - expected) <= 1,
    `${entry.name}: "${second}" is ${right.w} wide, expected ${expected} ± 1`,
  );
  assert.ok(
    left.w + 1 + right.w >= width - 1,
    `${entry.name}: the pair covers ${left.w + 1 + right.w} of ${width} columns`,
  );
  return [left, right];
}

// A cell that shares its row: half the row, minus the one column gap, with the
// odd column in the first slot.
function expectHalfCell(entry, label, width, frame = "frame") {
  const box = expectCell(entry, label, frame);
  const expected = Math.ceil((width - 1) / 2);
  assert.ok(
    Math.abs(box.w - expected) <= 1,
    `${entry.name}: "${label}" is ${box.w} wide, expected ${expected} ± 1`,
  );
  assert.ok(box.w < width, `${entry.name}: "${label}" spans the whole row`);
  return box;
}

// A button that has its row to itself spans the whole row, and nothing takes
// space beside it.
function expectFullWidth(entry, label, width, frame = "frame") {
  const box = expectCell(entry, label, frame);
  assert.equal(box.x, 0, `${entry.name}: "${label}" starts at column ${box.x}`);
  assert.ok(
    Math.abs(box.w - width) <= 1,
    `${entry.name}: "${label}" is ${box.w} wide, expected the whole row (${width})`,
  );
  const beside = nodesOf(entry, frame).find(
    (each) =>
      each.ctor === "BoxRenderable" &&
      each.label === "" &&
      each.border !== true &&
      each.y === box.y &&
      each.w > 0 &&
      (each.x > box.x + box.w - 1 || each.x + each.w < box.x + 1),
  );
  assert.ok(!beside, `${entry.name}: an empty box still shares the row with "${label}"`);
  return box;
}

// A lone button centres its label: the room left of the text matches the room
// right of it. A paired label stays in the left column instead.
function expectCentered(entry, label, frame = "frame") {
  const box = expectCell(entry, label, frame);
  const text = nodesOf(entry, frame).find(
    (each) =>
      each.ctor === "TextRenderable" &&
      each.label === label &&
      each.y > box.y &&
      each.y < box.y + box.h,
  );
  assert.ok(text, `${entry.name}: no text node for "${label}"`);
  const left = text.x - (box.x + 1);
  const right = box.x + box.w - 1 - (text.x + label.length);
  assert.ok(
    Math.abs(left - right) <= 2,
    `${entry.name}: "${label}" is not centred (${left} columns left, ${right} right, cell x=${box.x} w=${box.w})`,
  );
  return box;
}

// A paired label keeps the left column.
function expectLeftAligned(entry, label, frame = "frame") {
  const box = expectCell(entry, label, frame);
  const text = nodesOf(entry, frame).find(
    (each) =>
      each.ctor === "TextRenderable" &&
      each.label === label &&
      each.y > box.y &&
      each.y < box.y + box.h,
  );
  assert.ok(text, `${entry.name}: no text node for "${label}"`);
  assert.ok(
    text.x <= box.x + 3,
    `${entry.name}: paired "${label}" moved to column ${text.x} (cell x=${box.x})`,
  );
  return box;
}

// Read the drawn frame back: every cell top border must close on its own row,
// and every content row of every cell must be walled by vertical borders. A
// label that overflows its cell breaks the wall it crosses, so this is the
// check that catches a label drawn past the border.
const OPEN = new Set(["┌", "┏"]);
const CLOSE = new Set(["┐", "┓"]);
const WALL = new Set(["│", "┃"]);

function expectCellsWellFormed(entry, frame = "frame") {
  const lines = entry.frames[frame].split("\n");
  const nodes = nodesOf(entry, frame);
  for (const row of entry.cells[frame]) {
    const line = lines[row.y];
    for (const span of row.spans) {
      assert.ok(OPEN.has(line[span.x0]), `${entry.name}: row ${row.y} col ${span.x0} is not a corner`);
      assert.ok(CLOSE.has(line[span.x1]), `${entry.name}: row ${row.y} col ${span.x1} does not close`);
      for (let x = span.x0 + 1; x < span.x1; x += 1) {
        assert.ok(!OPEN.has(line[x]) && !CLOSE.has(line[x]), `${entry.name}: cell at ${span.x0} holds a second corner`);
      }
      const box = nodes.find((each) => each.border === true && each.x === span.x0 && each.y === row.y);
      assert.ok(box, `${entry.name}: no measured cell at column ${span.x0}, row ${row.y}`);
      for (let y = box.y + 1; y < box.y + box.h - 1; y += 1) {
        const textRow = lines[y] ?? "";
        assert.ok(
          WALL.has(textRow[span.x0]),
          `${entry.name}: "${box.label}" has no left wall on row ${y}\n${entry.frames[frame]}`,
        );
        assert.ok(
          WALL.has(textRow[span.x1]),
          `${entry.name}: "${box.label}" crosses its right wall on row ${y}\n${entry.frames[frame]}`,
        );
      }
    }
  }
}

// The drawn text inside a cell must hold the whole label. A wrapped label
// spreads over several content rows, so the rows are joined before comparing.
function expectNoTruncation(entry, label, frame = "frame") {
  const box = expectCell(entry, label, frame);
  const lines = entry.frames[frame].split("\n");
  const drawn = [];
  for (let y = box.y + 1; y < box.y + box.h - 1; y += 1) {
    drawn.push((lines[y] ?? "").slice(box.x + 1, box.x + box.w - 1));
  }
  assert.equal(
    drawn.join("").replace(/\s+/g, ""),
    label.replace(/\s+/g, ""),
    `${entry.name}: "${label}" is not drawn in full\n${entry.frames[frame]}`,
  );
  return box;
}

// The first row of a drawn frame that contains `text`, or -1. Two rows of the
// same frame can carry the same word (a sidebar cell and a settings row), so a
// caller that needs one of them picks a substring only that row carries.
function rowIndexOf(frame, text) {
  return frame.split("\n").findIndex((line) => line.includes(text));
}

// The first row of a drawn frame that contains `text`, or "".
function frameLine(frame, text) {
  return frame.split("\n").find((line) => line.includes(text)) ?? "";
}

// The column counts the harness renders for the sweep scenarios. Every width a
// narrow terminal can produce between the documented stops is covered.
const sweepWidths = [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 34, 36, 38, 40];

describe("sidebar layout from a real render", () => {
  let data = null;
  let reason = "";

  before(() => {
    try {
      data = render();
    } catch (error) {
      reason = error.message;
    }
  });

  const measurement = (name) => {
    assert.ok(data, `renderer unavailable: ${reason}`);
    const entry = data.scenarios.find((each) => each.name === name);
    assert.ok(entry, `no measurement for ${name}`);
    return entry;
  };
  const skipIfNoRenderer = (t) => {
    if (data) return false;
    t.skip(`renderer unavailable: ${reason}`);
    return true;
  };

  test("a lone action fills its row and centres its label", (t) => {
    if (skipIfNoRenderer(t)) return;
    for (const width of [80, 60, 40, 30, 24, 20]) {
      const entry = measurement(`grid-singleton-${width}`);
      expectCellsWellFormed(entry);
      expectPair(entry, "Commit", "Push", width);
      expectLeftAligned(entry, "Commit");
      expectPair(entry, "Stop all", "Show logs", width);
      // The one action of the project takes the whole row.
      expectFullWidth(entry, "Next live", width);
      expectCentered(entry, "Next live");
    }
  });

  test("a full grid and a five button grid keep the same geometry", (t) => {
    if (skipIfNoRenderer(t)) return;
    const pair = measurement("grid-pair-80");
    expectCellsWellFormed(pair);
    expectPair(pair, "Live web", "Next live", 80);
    const five = measurement("grid-five-80");
    expectCellsWellFormed(five);
    expectPair(five, "Build", "Live mobile", 80);
    expectPair(five, "Live web", "Next live", 80);
    // The odd fifth button takes the whole last row.
    expectFullWidth(five, "ADB install", 80);
    expectCentered(five, "ADB install");
  });

  test("a long label wraps inside its cell at any width", (t) => {
    if (skipIfNoRenderer(t)) return;
    for (const width of [80, 30]) {
      const entry = measurement(`grid-long-labels-${width}`);
      expectCellsWellFormed(entry);
      const [box] = expectPair(entry, "Build mobile (Expo)", "ADB install on emulator", width);
      assert.ok(box.h >= 3, `${entry.name}: label did not wrap (cell height ${box.h})`);
      const line = entry.frames.frame.split("\n")[box.y + 1];
      assert.ok(WALL.has(line[box.x]), `${entry.name}: wrapped cell lost its left wall`);
      assert.ok(WALL.has(line[box.x + box.w - 1]), `${entry.name}: wrapped cell lost its right wall`);
    }
  });

  test("a long label centres when it has the whole row", (t) => {
    if (skipIfNoRenderer(t)) return;
    for (const width of [80, 30]) {
      const entry = measurement(`grid-long-singleton-${width}`);
      expectCellsWellFormed(entry);
      expectFullWidth(entry, "Build mobile (Expo)", width);
      expectCentered(entry, "Build mobile (Expo)");
      expectNoTruncation(entry, "Build mobile (Expo)");
      const narrow = measurement(`grid-long-singleton-narrow-${width}`);
      expectCellsWellFormed(narrow);
      expectFullWidth(narrow, "ADB install on emulator", width);
      expectNoTruncation(narrow, "ADB install on emulator");
    }
  });

  test("no label crosses its cell wall at any width", (t) => {
    if (skipIfNoRenderer(t)) return;
    // The geometry before the fix drew a label exactly as wide as its cell
    // interior on the wall column. The hand built row with that padding still
    // shows it, and the row with the current padding does not, so the cause is
    // the padding and not the Sidebar.
    const legacy = measurement("plain-utility-row-legacy-24");
    const legacySpan = legacy.cells.frame[0].spans[1];
    const legacyLine = legacy.frames.frame.split("\n")[legacy.cells.frame[0].y + 1];
    assert.ok(
      !WALL.has(legacyLine[legacySpan.x1]),
      "the old padding no longer overflows, so the attribution is stale",
    );

    for (const width of [23, 24, 25]) {
      const plain = measurement(`plain-utility-row-${width}`);
      expectCellsWellFormed(plain);
      expectNoTruncation(plain, "Show logs");
    }

    // Every column count a narrow terminal can produce, with the real Cargo
    // labels and with a lone action: both walls hold and every label is drawn
    // in full.
    for (const width of sweepWidths) {
      for (const name of [`grid-rust-sweep-${width}`, `grid-singleton-sweep-${width}`]) {
        expectCellsWellFormed(measurement(name));
      }
      expectNoTruncation(measurement(`grid-rust-sweep-${width}`), "Cargo clippy");
      const lone = measurement(`grid-singleton-sweep-${width}`);
      expectNoTruncation(lone, "Next live");
      expectNoTruncation(lone, "Show logs");
    }
  });

  test("Git buttons disappear outside a repository, not just grey out", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("grid-no-git-80");
    expectCellsWellFormed(entry);
    expectHidden(entry, "Commit");
    expectHidden(entry, "Push");
    // The command grid moves up into the first row instead of leaving a gap.
    const grid = expectFullWidth(entry, "Next live", 80);
    assert.equal(grid.y, 1, `${entry.name}: the grid starts at row ${grid.y}`);
    const narrow = measurement("grid-no-git-24");
    expectCellsWellFormed(narrow);
    expectFullWidth(narrow, "Next live", 24);
    expectCentered(narrow, "Next live");
  });

  test("a lone control fills its row and centres its label", (t) => {
    if (skipIfNoRenderer(t)) return;
    const push = measurement("controls-hide-push-80");
    expectCellsWellFormed(push);
    expectHidden(push, "Push");
    expectFullWidth(push, "Commit", 80);
    expectCentered(push, "Commit");

    const first = measurement("controls-hide-commit-40");
    expectCellsWellFormed(first);
    expectHidden(first, "Commit");
    const second = expectFullWidth(first, "Push", 40);
    assert.equal(second.x, 0, `${first.name}: "Push" starts at column ${second.x}`);
    expectCentered(first, "Push");

    const stop = measurement("controls-hide-stop-all-80");
    expectCellsWellFormed(stop);
    expectHidden(stop, "Stop all");
    expectFullWidth(stop, "Show logs", 80);
    expectCentered(stop, "Show logs");

    const log = measurement("controls-hide-log-80");
    expectCellsWellFormed(log);
    expectHidden(log, "Show logs");
    expectFullWidth(log, "Stop all", 80);
    expectCentered(log, "Stop all");
  });

  test("a row disappears once every control in it is hidden", (t) => {
    if (skipIfNoRenderer(t)) return;
    const utility = measurement("controls-hide-both-utilities-80");
    expectCellsWellFormed(utility);
    expectHidden(utility, "Stop all");
    expectHidden(utility, "Show logs");
    expectFullWidth(utility, "Next live", 80);

    const git = measurement("controls-hide-git-row-80");
    expectCellsWellFormed(git);
    expectHidden(git, "Commit");
    expectHidden(git, "Push");
    const grid = expectFullWidth(git, "Next live", 80);
    assert.equal(grid.y, 1, `${git.name}: the grid starts at row ${grid.y}`);

    const everything = measurement("controls-hide-everything-60");
    for (const label of ["Commit", "Push", "Stop all", "Show logs"]) expectHidden(everything, label);
    assert.doesNotMatch(everything.frames.frame, /Launchpad/, "the section header is still drawn");
    assert.equal(everything.cells.frame.length, 0, "the section still draws rows");

    const actions = measurement("controls-hide-all-with-actions-60");
    expectCellsWellFormed(actions);
    for (const label of ["Commit", "Push", "Stop all", "Show logs"]) expectHidden(actions, label);
    expectPair(actions, "Build", "Live mobile", 60);
    expectFullWidth(actions, "ADB install", 60);
  });

  test("the sidebar follows the runtime after it hides a button", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("controls-live-toggle-40");
    expectHidden(entry, "Push", "before");
    expectFullWidth(entry, "Commit", 40, "before");
    expectCentered(entry, "Commit", "before");
    expectPair(entry, "Commit", "Push", 40, "after");
    expectCellsWellFormed(entry, "before");
    expectCellsWellFormed(entry, "after");
  });

  test("the header collapses the rows on a click", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("collapse-80");
    const before = entry.frames.frame;
    const after = entry.frames.collapsed;
    assert.match(before, /Next live/);
    assert.match(after, /Launchpad/);
    assert.doesNotMatch(after, /Next live/);
    assert.doesNotMatch(after, /Stop all/);
    assert.equal(entry.cells.collapsed.length, 0, "collapsed rows still draw cells");
  });

  test("the settings dialog lists commands and built-ins", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-dialog-70");
    const frame = entry.frames.frame;
    assert.match(frame, /Sidebar buttons/);
    assert.match(frame, /Project commands/);
    assert.match(frame, /Built-in controls/);
    assert.match(frame, /\[x\] Build/);
    assert.match(frame, /\[ \] Live web/);
    assert.match(frame, /\[x\] Commit/);
    assert.match(frame, /\[ \] Stop all/);
    assert.match(frame, /2 buttons hidden/);
    assert.match(frame, /Show all buttons/);
    assert.match(frame, /Close esc/);

    const empty = measurement("settings-dialog-empty-70");
    assert.match(empty.frames.frame, /No buttons to configure\./);
    assert.match(empty.frames.frame, /Show all buttons/);
  });

  test("a click on a settings row hides and shows the button again", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-dialog-click-70");
    assert.deepEqual(entry.calls[0], ["setVisible", "web-live", true], `calls: ${JSON.stringify(entry.calls)}`);
    assert.match(entry.frames["after-toggle"], /\[x\] Live web/);
    assert.match(entry.frames["after-toggle"], /1 button hidden/);
    assert.ok(
      entry.calls.some((call) => call[0] === "showAllButtons"),
      `calls: ${JSON.stringify(entry.calls)}`,
    );
    assert.match(entry.frames["after-show-all"], /\[x\] Stop all/);
    assert.doesNotMatch(entry.frames["after-show-all"], /button[s]? hidden/);
  });

  test("the restore button counts buttons hidden in other projects", (t) => {
    if (skipIfNoRenderer(t)) return;
    // Every button this project can draw is visible, so no row carries the
    // hidden marker while the store still hides three ids elsewhere.
    const other = measurement("settings-dialog-other-project-70");
    assert.doesNotMatch(other.frames.frame, /\[ \]/, "a button of this project is hidden");
    assert.match(other.frames.frame, /3 buttons hidden in other projects/);
    assert.match(other.frames.frame, /\[x\] Build/);
    // The click only reaches the handler while the button is enabled.
    assert.ok(
      other.calls.some((call) => call[0] === "showAllButtons"),
      `the restore button was disabled: ${JSON.stringify(other.calls)}`,
    );
    assert.doesNotMatch(other.frames["after-show-all"], /button[s]? hidden/);

    // Two hidden here and one elsewhere: the count stays accurate for both.
    const mixed = measurement("settings-dialog-mixed-70");
    assert.match(mixed.frames.frame, /3 buttons hidden \(1 in other projects\)/);
    assert.match(mixed.frames.frame, /\[ \] Live web/);

    // With nothing hidden anywhere the button stays off, so the count above is
    // not simply always enabled.
    const empty = measurement("settings-dialog-empty-70");
    assert.deepEqual(empty.calls, [], "a click reached a disabled button");
  });

  test("a settings failure is shown instead of a silent success", (t) => {
    if (skipIfNoRenderer(t)) return;
    const read = measurement("settings-dialog-error-70");
    assert.match(read.frames.frame, /Could not read the saved sidebar buttons\./);
    assert.match(read.frames.frame, /Show all buttons/, "the footer is missing");
    // The failure line must not disturb the lines above it: an error makes the
    // dialog one row taller, and a box shorter than that overlaps them.
    assert.match(read.frames.frame, /Sidebar buttons/);
    assert.match(read.frames.frame, /A hidden button leaves the sidebar and stays in the command palette\./);

    // A write that fails after the dialog opened must appear in the open dialog,
    // because the runtime reports it through subscribeSettings.
    const write = measurement("settings-dialog-error-after-click-70");
    assert.doesNotMatch(write.frames.before, /Could not save/, "the failure showed before it happened");
    assert.match(write.frames.after, /Could not save the sidebar buttons\./);
    assert.match(write.frames.after, /\[x\] Live web/, "the change is not reflected");
    assert.match(write.frames.after, /A hidden button leaves the sidebar and stays in the command palette\./);
  });

  test("every settings click reaches the control it aimed at", (t) => {
    if (skipIfNoRenderer(t)) return;
    // A click that finds no target leaves the scenario reading a stale frame, so
    // the harness records every miss and this fails on any of them.
    assert.deepEqual(data.misses, [], `a click found no target: ${JSON.stringify(data.misses)}`);

    // The editor opens from the row it belongs to, with the runner's own values.
    const opened = measurement("settings-edit-open-70");
    assert.match(opened.frames.editor, /Edit button/, "the editor did not open");
    assert.match(opened.frames.editor, /Name/);
    assert.match(opened.frames.editor, /Command/);
    assert.match(opened.frames.editor, /Arguments/);
  });

  test("a runner opens an editor with its own command and directory", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-edit-open-70");
    const frame = entry.frames.editor;
    assert.match(frame, /Edit button/);
    assert.match(frame, /The command runs directly, without a shell\./);
    assert.match(frame, /Name\s+Next live/);
    assert.match(frame, /Command\s+bun/);
    assert.match(frame, /Arguments\s+\["run","dev"\]/);
    assert.match(frame, /Runs in \/workspace\/demo/);
    assert.match(frame, /Save/);
    assert.match(frame, /Cancel/);
    assert.deepEqual(entry.calls, [], "opening the editor ran something");
  });

  test("only the runner rows offer an editor", (t) => {
    if (skipIfNoRenderer(t)) return;
    // The built-in controls keep their names and commands, so they carry no
    // editor affordance at all.
    const entry = measurement("settings-editable-70");
    const editRows = [...new Set(entry.nodes.filter((each) => each.label === "Edit" && each.border === false).map((each) => each.y))];
    assert.deepEqual(editRows, [5, 6, 7], `Edit appears on rows ${JSON.stringify(editRows)}`);
    for (const label of ["Commit", "Stop all"]) {
      const line = entry.frames.frame.split("\n").find((each) => each.includes(label));
      assert.ok(line, `the ${label} row is missing`);
      assert.doesNotMatch(line, /Edit/);
    }
  });

  test("saving a button sends the edited name, command and arguments", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-edit-save-70");
    assert.deepEqual(entry.calls, [
      [
        "saveButton",
        { label: "Live web-x", command: "bun", args: ["run", "web"], id: "web-live", project: "/workspace/demo" },
      ],
    ]);
    assert.match(entry.frames["after-save"], /Sidebar buttons/, "the dialog did not return to the list");
    assert.match(entry.frames["after-save"], /\[x\] Live web/);
  });

  test("a new button is saved without an id", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-edit-new-70");
    assert.deepEqual(entry.calls, [
      ["saveButton", { label: "Audit", command: "bun", args: ["audit", "--json"], project: "/workspace/demo" }],
    ]);
    assert.equal(Object.hasOwn(entry.calls[0][1], "id"), false, "a new button was saved with an id");
    assert.match(entry.frames["after-save"], /\[x\] Audit deps/);
  });

  test("a new button names the project it belongs to", (t) => {
    if (skipIfNoRenderer(t)) return;
    // The directory line is read-only and comes from the capture, so a new
    // button shows the project instead of a blank or generic line.
    const entry = measurement("settings-new-cwd-70");
    assert.match(entry.frames.editor, /Runs in \/workspace\/demo/);
    assert.doesNotMatch(entry.frames.editor, /this project's directory/);
  });

  test("arguments that are not a JSON list of strings are refused", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-edit-bad-json-70");
    assert.deepEqual(entry.calls, [], "a bad argument list was saved");
    assert.match(entry.frames["after-enter"], /Arguments must be a JSON list of strings/);
    assert.match(entry.frames["after-enter"], /Edit button/, "the editor closed on a bad value");
  });

  test("a refused save shows the reason the runtime gave", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-edit-reject-70");
    assert.equal(entry.calls.length, 1, `calls: ${JSON.stringify(entry.calls)}`);
    assert.equal(entry.calls[0][0], "saveButton");
    assert.match(entry.frames["after-save"], /A button with that name already exists\./);
    assert.match(entry.frames["after-save"], /Edit button/, "the editor closed on a refused save");
  });

  test("resetting an override asks the runtime to drop it", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-edit-reset-70");
    assert.deepEqual(entry.calls, [["resetButton", "next-live", "/workspace/demo"]]);
    assert.match(entry.frames["after-reset"], /Sidebar buttons/);
  });

  test("deleting a custom button asks first and can be kept", (t) => {
    if (skipIfNoRenderer(t)) return;
    const gone = measurement("settings-edit-delete-70");
    assert.deepEqual(gone.calls, [["deleteButton", "custom-audit", "/workspace/demo"]]);
    assert.doesNotMatch(gone.frames["after-delete"], /Audit deps/, "the deleted button is still listed");
    const kept = measurement("settings-edit-keep-70");
    assert.deepEqual(kept.calls, [], "keeping the button still deleted it");
    assert.match(kept.frames["after-keep"], /Edit button/, "keeping the button left the editor");
    assert.match(kept.frames["after-keep"], /Audit deps/);
  });

  test("a project that changed under an open editor refuses the save", (t) => {
    if (skipIfNoRenderer(t)) return;
    // The editor captured the project when it opened. Switching the session
    // while it stays open must not write the button into the new project.
    const entry = measurement("settings-project-changed-save-70");
    assert.equal(entry.calls.length, 1, `calls: ${JSON.stringify(entry.calls)}`);
    assert.equal(entry.calls[0][0], "saveButton");
    assert.equal(entry.calls[0][1].project, "/workspace/demo", "the payload lost the captured project");
    assert.match(entry.frames["after-save"], /Project changed\. Reopen the button editor\./);
    assert.match(entry.frames["after-save"], /Edit button/, "the editor closed on a refused save");
    const live = entry.editors.find((each) => each.id === "web-live");
    assert.equal(live.label, "Live web", "the refused save still changed the button");
  });

  test("a project that changed before the editor opened refuses the save", (t) => {
    if (skipIfNoRenderer(t)) return;
    // The list was loaded in the first project and the session switched before
    // the row was clicked. The dialog captured the project when it opened, so
    // the draft must still carry the project the row came from, and the write
    // must be refused rather than land in the project that is open now.
    const edited = measurement("settings-project-changed-before-edit-70");
    assert.equal(edited.calls.length, 1, `calls: ${JSON.stringify(edited.calls)}`);
    assert.equal(edited.calls[0][1].project, "/workspace/demo", "the draft recaptured the live project");
    assert.match(edited.frames["after-save"], /Project changed\. Reopen the button editor\./);
    assert.match(edited.frames["after-save"], /Edit button/, "the editor closed on a refused save");
    assert.equal(edited.editors.find((each) => each.id === "web-live").label, "Live web", "the refused save still wrote");

    const created = measurement("settings-project-changed-before-new-70");
    assert.equal(created.calls.length, 1, `calls: ${JSON.stringify(created.calls)}`);
    assert.equal(created.calls[0][1].project, "/workspace/demo", "a new button recaptured the live project");
    assert.equal(Object.hasOwn(created.calls[0][1], "id"), false);
    assert.match(created.frames["after-save"], /Project changed\. Reopen the button editor\./);
    assert.match(created.frames["after-save"], /New button/, "the editor closed on a refused save");
  });

  test("a project that changed under an open editor refuses the reset and the delete", (t) => {
    if (skipIfNoRenderer(t)) return;
    const reset = measurement("settings-project-changed-reset-70");
    assert.deepEqual(reset.calls, [["resetButton", "next-live", "/workspace/demo"]]);
    assert.match(reset.frames["after-reset"], /Project changed\. Reopen the button editor\./);
    assert.match(reset.frames["after-reset"], /Edit button/, "the editor closed on a refused reset");
    assert.equal(reset.editors.find((each) => each.id === "next-live").overridden, true, "the refused reset dropped the override");

    const deleted = measurement("settings-project-changed-delete-70");
    assert.deepEqual(deleted.calls, [["deleteButton", "custom-audit", "/workspace/demo"]]);
    assert.match(deleted.frames["after-delete"], /Project changed\. Reopen the button editor\./);
    assert.match(deleted.frames["after-delete"], /Edit button/, "the dialog left the editor on a refused delete");
    assert.ok(
      deleted.editors.some((each) => each.id === "custom-audit"),
      "the refused delete removed the button",
    );
  });

  test("the runtime's button configuration failure is shown", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-config-error-70");
    assert.match(entry.frames.frame, /Could not read the saved buttons\./);
    assert.match(entry.frames.frame, /Sidebar buttons/);
  });

  test("a failure the runtime reports after a save reaches the open dialog", (t) => {
    if (skipIfNoRenderer(t)) return;
    // The runtime answers a save synchronously and may only discover a durable
    // failure later, through buttonConfigError and the settings subscription.
    const entry = measurement("settings-config-error-late-70");
    assert.deepEqual(entry.calls[0][0], "saveButton");
    assert.doesNotMatch(entry.frames["after-save"], /Could not save the button\./);
    assert.match(entry.frames["after-late"], /Could not save the button\./);
    assert.match(entry.frames["after-late"], /Sidebar buttons/, "the dialog left the list");
    assert.match(entry.frames["after-late"], /\[x\] Live web/);
  });

  test("the Cargo buttons draw like every other action", (t) => {
    if (skipIfNoRenderer(t)) return;
    const labels = [
      "Cargo build",
      "Cargo run",
      "Cargo test",
      "Cargo check",
      "Cargo clippy",
      "Cargo fmt",
    ];
    for (const width of [80, 40, 30, 24]) {
      const entry = measurement(`grid-rust-${width}`);
      expectCellsWellFormed(entry);
      for (const label of labels) {
        const box = expectHalfCell(entry, label, width);
        expectNoTruncation(entry, label);
        assert.ok(box.h >= 3, `${entry.name}: "${label}" has no content row`);
      }
    }

    // The two shortest Cargo labels are exactly as wide as the second cell's
    // interior at 24 columns. They wrap instead of crossing the wall.
    const narrow = measurement("grid-rust-24");
    for (const label of ["Cargo run", "Cargo fmt", "Cargo test"]) {
      const box = expectCell(narrow, label);
      assert.equal(box.w - 2, label.length, `${narrow.name}: "${label}" is no longer an exact fit`);
      assert.ok(box.h >= 4, `${narrow.name}: "${label}" did not wrap`);
    }
  });

  test("a move arrow sits left of every runner and never on a built-in", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-move-controls-70");
    const frame = entry.frames.frame;
    // A runner row carries both arrows, left of the name, so the row reads
    // "step this button, then the button".
    for (const label of ["[x] Build", "[ ] Live web", "[x] Next live"]) {
      const row = frameLine(frame, label);
      assert.ok(row.includes("↑"), `${entry.name}: "${label}" has no up arrow\n${row}`);
      assert.ok(row.includes("↓"), `${entry.name}: "${label}" has no down arrow\n${row}`);
      assert.ok(
        row.indexOf("↑") < row.indexOf(label),
        `${entry.name}: the up arrow is not left of "${label}"\n${row}`,
      );
      assert.ok(
        row.indexOf("↓") < row.indexOf(label),
        `${entry.name}: the down arrow is not left of "${label}"\n${row}`,
      );
    }
    // A built-in control is fixed, so its row carries neither arrow.
    for (const label of ["[x] Commit", "[ ] Stop all"]) {
      const row = frameLine(frame, label);
      assert.ok(!/[↑↓]/.test(row), `${entry.name}: "${label}" offers a move\n${row}`);
    }
    // The editor still closes the row on the right, after the name.
    const editable = measurement("settings-editable-70");
    const editRow = frameLine(editable.frames.frame, "[x] Next live");
    assert.ok(editRow.includes("Edit"), `${editable.name}: the runner row lost its editor\n${editRow}`);
    assert.ok(
      editRow.indexOf("↑") < editRow.indexOf("[x] Next live"),
      `${editable.name}: the move arrow is not left of the name\n${editRow}`,
    );
    assert.ok(
      editRow.indexOf("[x] Next live") < editRow.indexOf("Edit"),
      `${editable.name}: the editor is not on the right of the name\n${editRow}`,
    );
  });

  test("moving a runner up swaps it with the row above", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-move-up-70");
    // The move reaches the runtime with the captured project, and nothing else:
    // the toggle did not fire, so a move never flips a button's visibility.
    assert.deepEqual(
      entry.calls,
      [["moveButton", "next-live", "up", "/workspace/demo"]],
      `calls: ${JSON.stringify(entry.calls)}`,
    );
    const before = entry.frames.before;
    const after = entry.frames["after-move"];
    assert.ok(
      rowIndexOf(before, "[ ] Live web") < rowIndexOf(before, "[x] Next live"),
      `${entry.name}: the rows started in the wrong order`,
    );
    assert.ok(
      rowIndexOf(after, "[x] Next live") < rowIndexOf(after, "[ ] Live web"),
      `${entry.name}: the move did not reorder the list\n${after}`,
    );
  });

  test("moving a runner down swaps it with the row below", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-move-down-70");
    assert.deepEqual(
      entry.calls,
      [["moveButton", "build-mobile", "down", "/workspace/demo"]],
      `calls: ${JSON.stringify(entry.calls)}`,
    );
    const after = entry.frames["after-move"];
    assert.ok(
      rowIndexOf(after, "[ ] Live web") < rowIndexOf(after, "[x] Build"),
      `${entry.name}: the move did not reorder the list\n${after}`,
    );
  });

  test("the ends of the runner list offer no move", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-move-boundary-70");
    // The first runner cannot go up and the last cannot go down. The arrows are
    // drawn but disabled, so a click on either reaches nothing.
    assert.deepEqual(entry.calls, [], `a boundary control still moved: ${JSON.stringify(entry.calls)}`);
    const after = entry.frames["after-move"];
    assert.ok(
      rowIndexOf(after, "[x] Build") < rowIndexOf(after, "[ ] Live web"),
      `${entry.name}: the order changed at the boundary\n${after}`,
    );
    // The disabled arrows are still visible, so the ends of the list read as
    // the ends instead of the control vanishing.
    assert.ok(frameLine(after, "[x] Build").includes("↑"), "the first runner lost its up arrow");
    assert.ok(frameLine(after, "[x] Next live").includes("↓"), "the last runner lost its down arrow");
  });

  test("a hidden runner is still listed and still movable", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-move-hidden-70");
    assert.deepEqual(
      entry.calls,
      [["moveButton", "web-live", "up", "/workspace/demo"]],
      `calls: ${JSON.stringify(entry.calls)}`,
    );
    const after = entry.frames["after-move"];
    assert.match(after, /\[ \] Live web/, "the hidden marker was lost after the move");
    assert.match(after, /2 buttons hidden/, "the hidden count changed after the move");
    assert.ok(
      rowIndexOf(after, "[ ] Live web") < rowIndexOf(after, "[x] Build"),
      `${entry.name}: the hidden runner did not move\n${after}`,
    );
  });

  test("a project that changed under the list refuses the move", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-move-stale-70");
    // The move still carries the project the dialog captured when it opened, so
    // the runtime can refuse it when the session has switched.
    assert.equal(entry.calls.length, 1, `calls: ${JSON.stringify(entry.calls)}`);
    assert.deepEqual(entry.calls[0].slice(0, 3), ["moveButton", "next-live", "up"]);
    assert.equal(entry.calls[0][3], "/workspace/demo", "the move lost the captured project");
    const after = entry.frames["after-move"];
    assert.match(after, /Project changed\. Reopen the button editor\./);
    assert.ok(
      rowIndexOf(after, "[ ] Live web") < rowIndexOf(after, "[x] Next live"),
      `${entry.name}: the refused move still reordered the list\n${after}`,
    );
  });

  test("a move reorders the sidebar and the list together", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("settings-move-sidebar-order-70");
    assert.deepEqual(
      entry.calls,
      [["moveButton", "web-live", "up", "/workspace/demo"]],
      `calls: ${JSON.stringify(entry.calls)}`,
    );
    // The grid and the list read one order: both flip together.
    expectCellsWellFormed(entry, "before");
    expectCellsWellFormed(entry, "after-move");
    expectPair(entry, "Build", "Live web", 70, "before");
    expectPair(entry, "Live web", "Build", 70, "after-move");
    const after = entry.frames["after-move"];
    assert.ok(
      rowIndexOf(after, "[x] Live web") < rowIndexOf(after, "[x] Build"),
      `${entry.name}: the settings list did not reorder with the grid\n${after}`,
    );
  });
});
