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

// A bordered control has to fit both axes of the render surface. Checking the
// measured bounds catches a footer pushed below the last row even when the
// frame still contains the label somewhere off screen.
function expectInViewport(entry, label, frame = "frame") {
  const found = expectCell(entry, label, frame);
  assert.ok(
    found.x >= 0 && found.y >= 0,
    `${entry.name}: "${label}" starts at (${found.x}, ${found.y})\n${entry.frames[frame]}`,
  );
  assert.ok(
    found.x + found.w <= entry.width,
    `${entry.name}: "${label}" ends at column ${found.x + found.w} of ${entry.width}\n${entry.frames[frame]}`,
  );
  assert.ok(
    found.y + found.h <= entry.height,
    `${entry.name}: "${label}" ends at row ${found.y + found.h} of ${entry.height}\n${entry.frames[frame]}`,
  );
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

// Every button centres its label: on each drawn text row the room left of the
// glyphs matches the room right of them. A wrapped label is checked row by row,
// so the rule holds whether the cell shares its row or fills it.
function expectCentered(entry, label, frame = "frame") {
  const box = expectCell(entry, label, frame);
  const lines = entry.frames[frame].split("\n");
  let rows = 0;
  for (let y = box.y + 1; y < box.y + box.h - 1; y += 1) {
    const inner = (lines[y] ?? "").slice(box.x + 1, box.x + box.w - 1);
    const first = inner.search(/\S/);
    if (first < 0) continue;
    const trimmed = inner.replace(/\s+$/, "");
    const left = first;
    const right = inner.length - trimmed.length;
    rows += 1;
    assert.ok(
      Math.abs(left - right) <= 2,
      `${entry.name}: "${label}" row ${y} is not centred (${left} columns left, ${right} right, cell x=${box.x} w=${box.w})`,
    );
  }
  assert.ok(rows > 0, `${entry.name}: "${label}" drew no text`);
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
      // Built-in and utility labels centre whether they share a row or fill it.
      expectPair(entry, "Commit", "Push", width);
      expectCentered(entry, "Commit");
      expectCentered(entry, "Push");
      expectPair(entry, "Stop all", "Show logs", width);
      expectCentered(entry, "Stop all");
      expectCentered(entry, "Show logs");
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
    // Project commands centre in a shared row too, like the built-in controls.
    expectCentered(pair, "Live web");
    expectCentered(pair, "Next live");
    const five = measurement("grid-five-80");
    expectCellsWellFormed(five);
    expectPair(five, "Build", "Live mobile", 80);
    expectCentered(five, "Build");
    expectCentered(five, "Live mobile");
    expectPair(five, "Live web", "Next live", 80);
    expectCentered(five, "Live web");
    expectCentered(five, "Next live");
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
      expectCentered(entry, "Build mobile (Expo)");
      expectCentered(entry, "ADB install on emulator");
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
      expectCentered(narrow, "ADB install on emulator");
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

  test("the commit files step draws a ⊘ left of each file and explains it", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-files-70");
    const frame = entry.frames.frame;
    for (const path of ["src/new-notes.md", "src/app.js", "src/locked.bin"]) {
      const row = frameLine(frame, path);
      assert.ok(row.includes("⊘"), `${entry.name}: "${path}" has no ⊘\n${row}`);
      assert.ok(
        row.indexOf("⊘") < row.indexOf("[ ]"),
        `${entry.name}: the ⊘ is not left of "${path}"\n${row}`,
      );
    }
    assert.match(
      frame.replace(/\s+/g, " "),
      /only applies to untracked files/,
      "the ⊘ column is not explained",
    );
  });

  test("a click on the ⊘ ignores the untracked file and never selects it", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-files-ignore-70");
    // One call, the ignore. No toggle, so the click never reached the row behind
    // the control and the selection did not flip.
    assert.deepEqual(
      entry.calls,
      [["ignoreFile", "src/new-notes.md"]],
      `calls: ${JSON.stringify(entry.calls)}`,
    );
    const after = entry.frames["after-ignore"];
    assert.ok(
      frameLine(after, "src/new-notes.md").includes("[ ]"),
      `the click selected the file\n${after}`,
    );
  });

  test("a tracked file cannot be ignored", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-files-tracked-70");
    assert.deepEqual(entry.calls, [], `a tracked file was ignored: ${JSON.stringify(entry.calls)}`);
    // The control is still drawn, so the column reads as one thing.
    assert.ok(
      frameLine(entry.frames["after-tracked"], "src/app.js").includes("⊘"),
      "the ⊘ vanished for a tracked file",
    );
  });

  test("a blocked file cannot be ignored", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-files-blocked-70");
    assert.deepEqual(entry.calls, [], `a blocked file was ignored: ${JSON.stringify(entry.calls)}`);
    assert.ok(
      frameLine(entry.frames["after-blocked"], "src/locked.bin").includes("⊘"),
      "the ⊘ vanished for a blocked file",
    );
  });

  test("a busy flow cannot ignore a file", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-files-busy-70");
    assert.deepEqual(entry.calls, [], `a busy flow still ignored: ${JSON.stringify(entry.calls)}`);
  });

  test("a long path keeps its ⊘ left of the name and its cell walls", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-files-longpath-70");
    const row = frameLine(entry.frames.frame, "src/features/checkout");
    assert.ok(row.includes("⊘"), `${entry.name}: the long row lost its ⊘\n${row}`);
    assert.ok(
      row.indexOf("⊘") < row.indexOf("[ ]"),
      `${entry.name}: the ⊘ is not left of the long name\n${row}`,
    );
    expectCellsWellFormed(entry);
  });

  test("the preview diff wraps instead of truncating a line past 200 columns", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-preview-longline-36");
    const tail = "END-OF-LONG-DIFF-LINE-9f3c";
    // Wrapping can split the marker across rows, and the scrollbar can sit at
    // the right edge, so compare without whitespace or scrollbar cells.
    const compact = (frame) => frame.replace(/[│█]/g, "").replace(/\s+/g, "");
    // The tail starts below the fold: the lines before it fill the scrollbox,
    // so the marker can only appear once the user scrolls down.
    assert.ok(
      !compact(entry.frames["before-scroll"]).includes(tail),
      `the long line's tail is visible before scrolling\n${entry.frames["before-scroll"]}`,
    );
    const after = entry.frames["after-scroll"];
    assert.ok(
      compact(after).includes(tail),
      `the long line's tail is not reachable by scrolling\n${after}`,
    );
    // The rest of the diff is still there, and no display-time ellipsis stands
    // in for bytes that were never drawn.
    assert.ok(
      compact(after).includes("+shortlineafter"),
      `the diff after the long line is missing\n${after}`,
    );
    assert.doesNotMatch(entry.frames["before-scroll"], /…/);
  });

  test("the preview disclosure names the provider and model actually selected", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-preview-native-70");
    const compact = entry.frames.frame.replace(/\s+/g, "");
    assert.ok(
      compact.includes("OpenAIusinggpt-6-luna"),
      `the preview does not name the selected provider and model\n${entry.frames.frame}`,
    );
    assert.ok(
      frameLine(entry.frames.frame, "Generate message").includes("Generate message"),
      `the one Generate action is missing\n${entry.frames.frame}`,
    );
    assert.ok(
      compact.includes("Writemessage"),
      `the manual message action is missing\n${entry.frames.frame}`,
    );
    assert.equal(
      compact.includes("assumeddefault"),
      false,
      `a verified provider must not be called assumed\n${entry.frames.frame}`,
    );
    assert.doesNotMatch(entry.frames.frame, /Send diff to/, "no second egress action remains");
  });

  test("a legacy host marks the fixed destination as assumed, not verified", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-preview-legacy-70");
    const compact = entry.frames.frame.replace(/\s+/g, "");
    assert.ok(
      compact.includes("OpenCodexusinggpt-6-luna(low)"),
      `the assumed default is not named exactly\n${entry.frames.frame}`,
    );
    assert.ok(
      compact.includes("assumeddefault,notverified."),
      `the review does not say the default is unverified\n${entry.frames.frame}`,
    );
    assert.ok(
      compact.includes("Writemessage"),
      `the manual message action is missing\n${entry.frames.frame}`,
    );
    assert.doesNotMatch(entry.frames.frame, /Send diff to/, "no second egress action remains");
  });

  // At a narrow width the disclosure paragraph wraps to many rows and the file
  // line wraps too. The whole review body scrolls, so the disclosure keeps its
  // own rows and every action stays inside the viewport at both ends.
  test("a narrow preview scrolls the disclosure without moving its actions", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-preview-narrow-32");
    const frame = entry.frames.frame;
    const scrolled = entry.frames["after-scroll"];
    const compact = frame.replace(/\s+/g, "");
    const scrolledCompact = scrolled.replace(/\s+/g, "");
    // The review opens on the disclosure, naming the exact destination first.
    assert.ok(
      frameLine(frame, "Sending this selected frozen").includes("Sending this selected frozen"),
      `the disclosure does not start on screen\n${frame}`,
    );
    assert.ok(
      frameLine(frame, "OpenCode Proxy").includes("OpenCode Proxy"),
      `the provider name is missing\n${frame}`,
    );
    assert.ok(
      frameLine(frame, "luna-large-preview").includes("luna-large-preview (high)"),
      `the model and variant are missing\n${frame}`,
    );
    // At the bottom the last disclosure row sits above the first file row; they
    // never share one.
    const lastConsent = rowIndexOf(scrolled, "before the final");
    const fileLine = rowIndexOf(scrolled, "Files in the diff:");
    assert.ok(
      lastConsent >= 0 && fileLine > lastConsent,
      `the file line does not start below the disclosure\n${scrolled}`,
    );
    // Measured bounds agree with the frame: the paragraph ends before the file
    // line begins, so no leftover words can overwrite it.
    const paragraph = entry.nodes.find((node) => node.label.startsWith("Sending this selected frozen"));
    const files = entry.nodes.find((node) => node.label.startsWith("Files in the diff:"));
    assert.ok(paragraph && files, "the disclosure nodes are missing from the measurement");
    assert.ok(
      paragraph.y + paragraph.h <= files.y,
      `the disclosure box (y=${paragraph.y}, h=${paragraph.h}) runs into the file line (y=${files.y})`,
    );
    // The diff is below the fold at the narrow height, so the scroll is what
    // makes it reachable rather than a shorter body that happened to fit.
    assert.equal(
      compact.includes("Frozendiff"),
      false,
      `the diff starts on screen, so scrolling was not tested\n${frame}`,
    );
    // Below the fold, scrolling reaches the rest of the file list, the stat and
    // the diff, while the disclosure tail remains in the same scroll body.
    assert.ok(
      scrolledCompact.includes("beforethefinalcommit."),
      `the end of the disclosure is unreachable\n${scrolled}`,
    );
    assert.ok(
      scrolledCompact.includes("src/features/checkout/use-checkout.ts"),
      `the file list is cut off\n${scrolled}`,
    );
    assert.ok(
      scrolledCompact.includes("2fileschanged"),
      `the stat is unreachable\n${scrolled}`,
    );
    assert.ok(
      scrolledCompact.includes("Frozendiff") && scrolledCompact.includes("+anotherline"),
      `the diff tail is unreachable\n${scrolled}`,
    );
    assert.doesNotMatch(frame + scrolled, /…/, "a row was replaced by an ellipsis");
    // Every preview action fits the viewport before and after the scroll, and
    // none of them can sit on top of the review body.
    const scrollTop = entry.nodesByFrame.frame.find((node) => node.ctor.includes("ScrollBox"));
    const scrollBottom = entry.nodesByFrame["after-scroll"].find((node) => node.ctor.includes("ScrollBox"));
    assert.ok(scrollTop && scrollBottom, "the review scroll box is missing from the measurement");
    for (const label of ["Generate message", "Write message", "Back", "Cancel esc"]) {
      const before = expectInViewport(entry, label, "frame");
      const after = expectInViewport(entry, label, "after-scroll");
      assert.equal(before.y, after.y, `${entry.name}: "${label}" moved with the scroll`);
      assert.ok(
        before.y >= scrollTop.y + scrollTop.h,
        `${entry.name}: "${label}" overlaps the review body at row ${before.y}`,
      );
      assert.ok(
        after.y >= scrollBottom.y + scrollBottom.h,
        `${entry.name}: "${label}" overlaps the scrolled review body at row ${after.y}`,
      );
    }
    assert.equal(compact.includes("Senddiffto"), false, "no second egress action remains");
  });

  test("the final confirmation scrolls the whole message and keeps Commit in reach", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-confirm-longmessage-70");
    const before = entry.frames["before-scroll"];
    // The review opens at the top: the subject and the first body row are the
    // first things shown, not the tail the caret happened to leave behind.
    assert.ok(
      frameLine(before, "confirm the whole message is readable"),
      `the subject is missing from the confirmation\n${before}`,
    );
    assert.ok(
      frameLine(before, "CONFIRM-BODY-ROW-1:"),
      `the body does not start on screen\n${before}`,
    );
    // The message is taller than the dialog, so its tail needs the scroll box.
    assert.equal(
      rowIndexOf(before, "CONFIRM-BODY-TAIL-5e8b"),
      -1,
      `the tail starts on screen, so scrolling was not tested\n${before}`,
    );
    // Commit belongs to the fixed controls, never to the scrolled message.
    // "Edit message" identifies the footer: the title also says "Commit".
    const beforeFooter = frameLine(before, "Edit message");
    assert.ok(beforeFooter.includes("Commit"), `Commit left the screen below the long message\n${before}`);
    const after = entry.frames["after-scroll"];
    assert.ok(
      frameLine(after, "CONFIRM-BODY-TAIL-5e8b"),
      `the end of the message is unreachable\n${after}`,
    );
    const afterFooter = frameLine(after, "Edit message");
    assert.ok(
      afterFooter.includes("Commit"),
      `Commit left the screen while the message scrolled\n${after}`,
    );
    assert.doesNotMatch(after, /…/, `a row was replaced by an ellipsis\n${after}`);
  });

  test("the message editor shows the whole multi-line message", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-edit-multiline-70");
    const frame = entry.frames.frame;
    // The subject, the blank line and the body all live in one field now. A
    // one-line prompt could only ever have shown the subject.
    const subject = frameLine(frame, "add the header spacing");
    const bodyRow = frameLine(frame, "Body explains why the spacing");
    assert.ok(subject.includes("add the header spacing"), `the subject is missing\n${frame}`);
    assert.ok(bodyRow.includes("Body explains why the spacing"), `the body is missing\n${frame}`);
    assert.ok(
      frame.indexOf(subject) < frame.indexOf(bodyRow),
      `the body is not below the subject\n${frame}`,
    );
    // The long body wraps instead of cutting off, and the field does not fall
    // back to a display-time ellipsis.
    assert.ok(
      frame.replace(/[│█]/g, "").replace(/\s+/g, "").includes("beforeitchangedatall."),
      `the wrapped tail of the body is missing\n${frame}`,
    );
    // Cancel throws away the edit; only the old saved message survives. Escape
    // is the host key that closes the flow, so both are named truthfully.
    const hint = frame.replace(/\s+/g, "");
    assert.ok(hint.includes("Canceldiscardschanges"), `Cancel is described wrongly\n${frame}`);
    assert.equal(hint.includes("Cancelkeepsthedraft"), false, `the old Cancel hint remains\n${frame}`);
    assert.ok(hint.includes("Escclosestheflow"), `Escape is not explained\n${frame}`);
    assert.doesNotMatch(frame, /…/);
  });

  test("the editor keeps a typed newline and saves only on an explicit save", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-edit-typing-70");
    // The new line is on screen: Return inserted it instead of saving.
    assert.ok(
      frameLine(entry.frames["after-typing"], "second line of the body"),
      `the typed line is not on screen\n${entry.frames["after-typing"]}`,
    );
    const saves = entry.calls.filter(([name]) => name === "saveMessage");
    assert.equal(
      saves.length,
      1,
      `a plain Return must not save, and the explicit save must: ${JSON.stringify(entry.calls)}`,
    );
    assert.match(saves[0][1], /second line of the body/, "the typed line never reached the flow");
    // The message survives navigation: the editor opens at the subject, End
    // reaches the tail where the typing continues.
    assert.ok(
      saves[0][1].startsWith("add the header spacing"),
      `the editor did not keep the subject first: ${JSON.stringify(saves[0][1])}`,
    );
    assert.equal(saves[0][1].includes("\n"), true, "the newline was lost on the way to the flow");
    assert.ok(
      entry.calls.some(([name]) => name === "draftChanged"),
      "the field never reported what was typed",
    );
    assert.equal(
      entry.calls.some(([name]) => name === "confirm"),
      false,
      "saving the message committed by itself",
    );
  });

  test("the editor's save button hands the message to the flow", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-edit-save-button-70");
    assert.deepEqual(
      entry.calls.filter(([name]) => name === "saveMessage").map(([, value]) => value),
      ["add the header spacing\n\nBody explains why."],
      `calls: ${JSON.stringify(entry.calls)}`,
    );
    assert.equal(
      entry.calls.some(([name]) => name === "confirm"),
      false,
      "the save button committed by itself",
    );
  });

  test("the editor's cancel keeps the message the flow already had", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-edit-cancel-70");
    assert.equal(
      entry.calls.some(([name]) => name === "saveMessage"),
      false,
      `cancel saved the typing: ${JSON.stringify(entry.calls)}`,
    );
    assert.ok(
      entry.calls.some(([name]) => name === "cancelMessage"),
      `cancel never reached the flow: ${JSON.stringify(entry.calls)}`,
    );
    assert.equal(
      entry.calls.some(([name]) => name === "confirm"),
      false,
      "cancelling the editor committed by itself",
    );
    assert.ok(
      frameLine(entry.frames["after-cancel"], "Body explains why.").includes("Body explains why."),
      `the message left the screen on cancel\n${entry.frames["after-cancel"]}`,
    );
  });

  test("a message longer than the field scrolls it instead of growing it", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("git-edit-overflow-70");
    const fieldRows = (frameName) => {
      const node = (entry.nodesByFrame[frameName] ?? []).find((each) =>
        each.ctor.includes("Textarea"),
      );
      return node?.h;
    };
    // The field takes the body rather than a fixed six rows, and its viewport
    // does not grow while typing: the text inside scrolls instead.
    const startRows = fieldRows("frame");
    assert.ok(
      startRows >= 8 && startRows < 20,
      `the field did not take the available body\n${entry.frames.frame}`,
    );
    assert.ok(
      fieldRows("after-typing") <= startRows + 1,
      `typing grew the field instead of scrolling it\n${entry.frames["after-typing"]}`,
    );
    // Saving opens the review, which has no editor field at all.
    assert.equal(fieldRows("after-save"), undefined, "the editor survived the save");

    // The field opens at the start, so the subject is the first row reviewed.
    // End moves the caret and the viewport to the tail; the message itself is
    // never cut, and the rows between the two are reachable by scrolling.
    assert.ok(
      frameLine(entry.frames.frame, "add the header spacing"),
      `the subject is not on screen\n${entry.frames.frame}`,
    );
    assert.equal(
      rowIndexOf(entry.frames.frame, "OVERFLOW-BODY-END-7c1a"),
      -1,
      `the field did not open at the start\n${entry.frames.frame}`,
    );
    assert.ok(
      frameLine(entry.frames["after-end"], "OVERFLOW-BODY-END-7c1a"),
      `End did not reach the tail of the message\n${entry.frames["after-end"]}`,
    );
    // The row typed under the caret is visible, and no row is cut to an ellipsis.
    assert.ok(
      frameLine(entry.frames["after-typing"], "OVERFLOW-TYPED-TAIL-4b2d"),
      `the typed tail is not on screen\n${entry.frames["after-typing"]}`,
    );
    assert.doesNotMatch(
      entry.frames["after-typing"],
      /…/,
      `a row was replaced by an ellipsis\n${entry.frames["after-typing"]}`,
    );
    // The controls stay where they were, below the field.
    const controls = entry.frames["after-typing"]
      .replace(/[┌┐└┘─│█]/g, " ")
      .replace(/\s+/g, " ");
    assert.ok(
      controls.includes("Save message"),
      `the save control left the screen\n${entry.frames["after-typing"]}`,
    );

    // Saving hands over the whole message, not just the rows on screen.
    const saves = entry.calls.filter(([name]) => name === "saveMessage");
    assert.equal(saves.length, 1, `the save key never reached the flow: ${JSON.stringify(entry.calls)}`);
    const saved = saves[0][1];
    assert.ok(saved.startsWith("add the header spacing\n\nOVERFLOW-BODY-START"), saved);
    assert.ok(saved.includes("OVERFLOW-BODY-END-7c1a"), "the hidden rows were lost");
    assert.ok(saved.endsWith("\nOVERFLOW-TYPED-TAIL-4b2d"), "the typed tail was lost");
    // subject, blank line, eight body rows, typed row.
    assert.equal(saved.split("\n").length, 11, `the message changed shape: ${JSON.stringify(saved)}`);
    assert.ok(saved.length > 600, `the body was shortened: ${JSON.stringify(saved)}`);
  });

  // The reported screenshots run near 100x30, 70x22 and 32 columns. The message
  // is over 1000 characters, so a fixed six-row field cannot show it and the
  // frozen diff is not allowed to compete for the body.
  test("the long editor gives the message the body and keeps both ends reachable", (t) => {
    if (skipIfNoRenderer(t)) return;
    const sizes = [
      ["git-edit-long-100x30", 30, 8],
      ["git-edit-long-70x22", 22, 6],
      ["git-edit-long-32x26", 26, 4],
    ];
    for (const [name, height, minimum] of sizes) {
      const entry = measurement(name);
      const field = (frame) =>
        (entry.nodesByFrame[frame] ?? []).find((node) => node.ctor.includes("Textarea"));
      const frame = entry.frames.frame;
      const compact = frame.replace(/\s+/g, "");
      // The field owns the available body instead of a fixed six rows, and it
      // does not grow when the caret moves: only its viewport scrolls.
      const start = field("frame");
      assert.ok(start, `${name}: the message field is missing\n${frame}`);
      assert.ok(
        start.h >= minimum,
        `${name}: the field kept only ${start.h} rows instead of using the body\n${frame}`,
      );
      assert.ok(start.h < height, `${name}: the field is taller than the dialog\n${frame}`);
      assert.equal(field("after-end")?.h, start.h, `${name}: End resized the field`);
      assert.equal(field("after-home")?.h, start.h, `${name}: Home resized the field`);

      // The edit screen explains movement, names the caret row, and carries no
      // frozen diff: that was already reviewed on the previous screen.
      assert.ok(compact.includes("Message·line1of9"), `${name}: the line counter is missing\n${frame}`);
      assert.ok(compact.includes("Arrowsscroll"), `${name}: scrolling is not explained\n${frame}`);
      assert.ok(compact.includes("Endshowsthetail"), `${name}: End is not explained\n${frame}`);
      assert.ok(compact.includes("Homereturnstothetop"), `${name}: Home is not explained\n${frame}`);
      assert.ok(compact.includes("Enteraddsaline"), `${name}: typing is not explained\n${frame}`);
      assert.ok(compact.includes("Alt+Entersaves"), `${name}: saving is not explained\n${frame}`);
      assert.equal(rowIndexOf(frame, "Frozen diff"), -1, `${name}: the diff still owns edit space\n${frame}`);
      assert.equal(rowIndexOf(frame, "DIFF-ROW-01"), -1, `${name}: diff rows still own edit space\n${frame}`);

      // At rest: the subject is visible, the tail is hidden below, and the
      // controls stay in the fixed footer.
      assert.ok(
        frameLine(frame, "Resolve and disclose"),
        `${name}: the subject is missing\n${frame}`,
      );
      assert.equal(
        rowIndexOf(frame, "LONG-MESSAGE-TAIL-9a4c"),
        -1,
        `${name}: the tail is visible before any movement\n${frame}`,
      );
      assert.ok(
        frameLine(frame, "Save message").includes("Save message"),
        `${name}: Save message left the screen\n${frame}`,
      );
      assert.ok(
        frameLine(frame, "Cancel").includes("Cancel"),
        `${name}: Cancel left the screen\n${frame}`,
      );

      // End reaches the exact tail and the counter names the last logical row;
      // Home restores the subject. No row is replaced by an ellipsis.
      const end = entry.frames["after-end"];
      assert.ok(
        frameLine(end, "LONG-MESSAGE-TAIL-9a4c"),
        `${name}: End did not reach the message tail\n${end}`,
      );
      assert.ok(
        end.replace(/\s+/g, "").includes("Message·line9of9"),
        `${name}: the counter did not follow the caret to the tail\n${end}`,
      );
      assert.doesNotMatch(end, /…/, `${name}: a row was replaced by an ellipsis\n${end}`);
      const home = entry.frames["after-home"];
      assert.ok(
        frameLine(home, "Resolve and disclose"),
        `${name}: Home did not return to the subject\n${home}`,
      );
      assert.equal(
        rowIndexOf(home, "LONG-MESSAGE-TAIL-9a4c"),
        -1,
        `${name}: Home did not return to the top\n${home}`,
      );

      // Saving hands over the entire original text, byte for byte, and lands on
      // the review rather than committing. The saved review still scrolls to
      // the marked tail while Commit stays in the footer.
      const saves = entry.calls.filter(([call]) => call === "saveMessage");
      assert.equal(saves.length, 1, `${name}: the save key never reached the flow`);
      assert.equal(
        entry.git.message,
        entry.gitBefore.message,
        `${name}: the saved message differs from the original`,
      );
      assert.ok(entry.gitBefore.message.length > 1000, `${name}: the fixture is too short`);
      assert.equal(entry.gitBefore.message.split("\n").length, 9, `${name}: the fixture changed shape`);
      assert.equal(entry.git.step, "confirm", `${name}: saving did not open the review`);
      assert.equal(
        entry.calls.some(([call]) => call === "confirm"),
        false,
        `${name}: saving committed by itself`,
      );
      const review = entry.frames["after-save"];
      assert.ok(
        frameLine(review, "Edit message").includes("Commit"),
        `${name}: Commit left the saved review\n${review}`,
      );
      const reviewEnd = entry.frames["after-save-end"];
      assert.ok(
        frameLine(reviewEnd, "LONG-MESSAGE-TAIL-9a4c"),
        `${name}: the saved review cannot reach the tail\n${reviewEnd}`,
      );
      assert.ok(
        frameLine(reviewEnd, "— end of message —").includes("— end of message —"),
        `${name}: the saved review does not mark the message end\n${reviewEnd}`,
      );
      assert.ok(
        frameLine(reviewEnd, "Frozen diff").includes("Frozen diff"),
        `${name}: the saved review does not name the frozen diff\n${reviewEnd}`,
      );
      assert.ok(
        frameLine(reviewEnd, "Edit message").includes("Commit"),
        `${name}: Commit left the saved review while scrolling\n${reviewEnd}`,
      );
    }
  });

  test("the long confirmation states how to scroll and separates message from diff", (t) => {
    if (skipIfNoRenderer(t)) return;
    const sizes = ["git-confirm-long-100x30", "git-confirm-long-70x22", "git-confirm-long-32x26"];
    for (const name of sizes) {
      const entry = measurement(name);
      const before = entry.frames["before-scroll"];
      const compact = before.replace(/\s+/g, "");
      // The scroll affordance is fixed above the viewport, so it cannot scroll
      // away and is visible at the top of the review.
      assert.ok(compact.includes("Scroll:mousewheelorPgUp/PgDn"), `${name}: the scroll hint is missing\n${before}`);
      assert.ok(compact.includes("Endjumpstotheend"), `${name}: End is not explained\n${before}`);
      assert.ok(compact.includes("Homereturnstothetop"), `${name}: Home is not explained\n${before}`);
      assert.ok(
        frameLine(before, "Resolve and disclose"),
        `${name}: the subject is missing\n${before}`,
      );
      assert.equal(
        rowIndexOf(before, "LONG-MESSAGE-TAIL-9a4c"),
        -1,
        `${name}: the tail starts on screen, so scrolling was not tested\n${before}`,
      );
      // The footer wraps instead of running off the right edge, so every
      // control is readable even at 32 columns.
      for (const label of ["Commit", "Edit message", "Back", "Cancel esc"]) {
        assert.ok(
          frameLine(before, label).includes(label),
          `${name}: the footer lost "${label}" below the long message\n${before}`,
        );
      }

      // End shows the tail, the explicit end marker, and the Frozen diff label
      // together: the message end cannot be mistaken for the diff.
      const end = entry.frames["after-end"];
      assert.ok(
        frameLine(end, "LONG-MESSAGE-TAIL-9a4c"),
        `${name}: End did not reach the tail\n${end}`,
      );
      assert.ok(
        frameLine(end, "— end of message —").includes("— end of message —"),
        `${name}: the message end is not marked\n${end}`,
      );
      assert.ok(
        frameLine(end, "Frozen diff").includes("Frozen diff"),
        `${name}: the diff is not labelled after the message\n${end}`,
      );
      assert.ok(
        frameLine(end, "Edit message").includes("Commit"),
        `${name}: Commit left the screen at the tail\n${end}`,
      );

      // Home returns to the subject, and a wheel scroll still reaches the diff
      // tail with the footer intact.
      const home = entry.frames["after-home"];
      assert.ok(
        frameLine(home, "Resolve and disclose"),
        `${name}: Home did not return to the subject\n${home}`,
      );
      assert.equal(
        rowIndexOf(home, "LONG-MESSAGE-TAIL-9a4c"),
        -1,
        `${name}: Home did not return to the top\n${home}`,
      );
      const after = entry.frames["after-scroll"];
      assert.ok(
        frameLine(after, "DIFF-TAIL-4f2e"),
        `${name}: the frozen diff tail is unreachable\n${after}`,
      );
      assert.ok(
        frameLine(after, "Edit message").includes("Commit"),
        `${name}: Commit left the screen while scrolling\n${after}`,
      );
      assert.doesNotMatch(after, /…/, `${name}: a row was replaced by an ellipsis\n${after}`);
      assert.ok(entry.gitBefore.message.length > 1000, `${name}: the fixture is too short`);
    }
  });

  test("the log dialog keeps a finished run's output and states a missing run truthfully", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("log-dialog-lifecycle-70");
    const flat = (frame) => frame.replace(/\s+/g, "");
    const controls = ["Stop s", "Reload r", "Restart R", "Close esc"];

    // A live run draws its label, command, directory, elapsed status, progress
    // and retained output, with every control in the viewport.
    const running = entry.frames.running;
    for (const text of ["Build mobile", "npm run build", "/workspace/demo"]) {
      assert.ok(frameLine(running, text).includes(text), `the live run is missing "${text}"\n${running}`);
    }
    assert.ok(flat(running).includes("running4s·3lines"), `the live status is wrong\n${running}`);
    assert.ok(flat(running).includes("building2/3"), `the progress line is missing\n${running}`);
    for (const line of ["compiling src/app.js", "BUILD-TAIL-4d1e"]) {
      assert.ok(running.includes(line), `the live output is missing "${line}"\n${running}`);
    }
    for (const label of controls) expectInViewport(entry, label, "running");

    // The terminal snapshot keeps the same output. The status changes to
    // finished, and the controls stay in the footer instead of vanishing.
    const terminal = entry.frames.terminal;
    assert.ok(
      flat(terminal).includes("finishedin5s·3lines"),
      `the retained terminal status is wrong\n${terminal}`,
    );
    assert.ok(terminal.includes("BUILD-TAIL-4d1e"), `the terminal output was dropped\n${terminal}`);
    for (const label of controls) expectInViewport(entry, label, "terminal");

    // No snapshot and no manager event: the timer redraws. The fallback must say
    // only that tracking stopped; it must not claim the process exited or that
    // the dialog cleared a finished run.
    const missing = entry.frames.missing;
    assert.ok(
      frameLine(missing, "Runner is no longer tracked.").includes("Runner is no longer tracked."),
      `the missing-run fallback is wrong\n${missing}`,
    );
    assert.doesNotMatch(
      missing,
      /Run finished and was cleared/,
      `the old exit claim is still drawn\n${missing}`,
    );
    assert.doesNotMatch(
      flat(missing),
      /finishedin|stoppedafter|failedafter/,
      `the fallback assumes the runner stopped\n${missing}`,
    );
    assert.ok(!missing.includes("BUILD-TAIL-4d1e"), `stale output survived the missing snapshot\n${missing}`);
    for (const label of ["Stop s", "Reload r", "Restart R"]) expectHidden(entry, label, "missing");
    expectInViewport(entry, "Close esc", "missing");
  });

  test("the log dialog reports its unmount to an optional onClose", (t) => {
    if (skipIfNoRenderer(t)) return;
    const entry = measurement("log-dialog-lifecycle-70");
    assert.equal(entry.logClosed, true, "unmount did not call onClose");
    assert.deepEqual(
      entry.calls.filter(([name]) => name === "dialog.close"),
      [["dialog.close"]],
      `onClose must notify once: ${JSON.stringify(entry.calls)}`,
    );
  });
});
