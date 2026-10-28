// `src/index.ts` is one top-level-await module with no exports, so these tests replay keys through
// its snapshot mode in a Bun subprocess and observe the Library on disk, never the frame text.
// Each replay step waits for the host to settle; `a+b` presses keys before that work can finish.
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { skitLayer } from "@smolai/skit-core";
import { tuiLibrary } from "./helpers/library-fixture";

const entry = resolve(import.meta.dirname, "../src/index.ts");
const bun = spawnSync("bun", ["--print", "process.execPath"], { encoding: "utf8" }).stdout.trim();

type TuiLibrary = Effect.Success<ReturnType<typeof tuiLibrary>>;

/** Each test starts Bun and runs the audit, which a loaded machine can stretch past 5s. */
const subprocessTimeout = 30_000;

/** A hung child is killed with time left for the fixture and assertions inside the test budget. */
const childTimeout = subprocessTimeout - 5_000;

/** Run the TUI over `library` to the end of its key script. */
const replay = Effect.fn("Test.replayTuiKeys")(function* (
  library: TuiLibrary,
  environment: Record<string, string>,
  options: { readonly arguments?: readonly string[]; readonly bin?: string } = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const frame = join(yield* fs.makeTempDirectoryScoped({ prefix: "skit-tui-frame-" }), "frame");
  const run = spawnSync(
    bun,
    [
      entry,
      "--skit-home",
      library.skitHome,
      "--home",
      library.home,
      "--cwd",
      library.cwd,
      ...(options.arguments ?? []),
    ],
    {
      cwd: library.cwd,
      encoding: "utf8",
      timeout: childTimeout,
      env: {
        // Only the Harness executables a test provides: listing budgets would otherwise start
        // the developer's own `codex app-server`, which writes its state under the fixture home.
        // Bun's transpiler cache would land there too.
        PATH: [...(options.bin ? [options.bin] : []), "/usr/bin", "/bin"].join(":"),
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        HOME: library.home,
        SKIT_TUI_SNAPSHOT: frame,
        ...environment,
      },
    },
  );
  return {
    status: run.status,
    stderr: run.stderr,
    frame: (yield* fs.exists(frame)) ? yield* fs.readFileString(frame) : "",
  };
});

/** What the Library binds in `scope`: Collection labels and Skill names. */
const bound = (library: TuiLibrary, scope: "global" | "repository") =>
  Effect.map(library.durable, (state) =>
    (scope === "global" ? [state.enabled] : state.repositories.map((item) => item.enabled))
      .flat()
      .map((item) =>
        "collection" in item
          ? state.collections.find((candidate) => candidate.collection_id === item.collection)
              ?.label
          : state.skills.find((candidate) => candidate.skill_id === item.skill)?.name,
      )
      .sort(),
  );

const cancelled: { at: string; environment: Record<string, string>; keys: string }[] = [
  { at: "the confirmation", environment: { SKIT_TUI_SNAPSHOT_LIBRARY: "confirm" }, keys: "ESCAPE" },
  { at: "the destination question", environment: {}, keys: "e,ESCAPE" },
  { at: "the Skill-or-Collection question", environment: {}, keys: "RETURN,ARROW_DOWN,e,ESCAPE" },
  {
    at: "the destination question after choosing the whole Collection",
    environment: {},
    keys: "RETURN,ARROW_DOWN,e,RETURN,ESCAPE",
  },
];

for (const { at, environment, keys } of cancelled)
  it.effect(
    `cancelling at ${at} writes nothing`,
    () =>
      Effect.gen(function* () {
        const library = yield* tuiLibrary({ "alpha-pack": ["one", "two"], "beta-pack": ["three"] });
        const before = yield* library.tree;
        const run = yield* replay(library, { ...environment, SKIT_TUI_SNAPSHOT_KEYS: keys });
        assert.strictEqual(run.status, 0, run.stderr);
        assert.deepStrictEqual(yield* library.tree, before);
      }).pipe(Effect.scoped, Effect.provide(skitLayer)),
    subprocessTimeout,
  );

const navigated: { through: string; keys: string; global: string[] }[] = [
  {
    // Select beta-pack, open it, and return: Esc reselects the Collection that was open.
    through: "a Collection and back",
    keys: "ARROW_DOWN,RETURN,ESCAPE,e,RETURN,RETURN",
    global: ["beta-pack"],
  },
  {
    // Inside alpha-pack select `two`, then choose "only this Skill" over the whole Collection.
    through: "a Collection's Skills and the enable question",
    keys: "RETURN,ARROW_DOWN,e,ARROW_DOWN,RETURN,RETURN,RETURN",
    global: ["two"],
  },
];

for (const { through, keys, global } of navigated)
  it.effect(
    `navigating through ${through} applies to the selected row`,
    () =>
      Effect.gen(function* () {
        const library = yield* tuiLibrary({ "alpha-pack": ["one", "two"], "beta-pack": ["three"] });
        const run = yield* replay(library, { SKIT_TUI_SNAPSHOT_KEYS: keys });
        assert.strictEqual(run.status, 0, run.stderr);
        assert.deepStrictEqual(yield* bound(library, "global"), global);
        assert.deepStrictEqual(yield* bound(library, "repository"), []);
      }).pipe(Effect.scoped, Effect.provide(skitLayer)),
    subprocessTimeout,
  );

it.effect(
  "a proposal that finishes after the selection moved keeps the newer selection",
  () =>
    Effect.gen(function* () {
      const library = yield* tuiLibrary({ "alpha-pack": ["one", "two"], "beta-pack": ["three"] });
      // `RETURN+ARROW_DOWN` chooses the destination for alpha-pack and moves to beta-pack before
      // the proposal can read the Library. Its preview is still alpha-pack's; the next `e` is
      // beta-pack's.
      const run = yield* replay(library, {
        SKIT_TUI_SNAPSHOT_KEYS: "e,RETURN+ARROW_DOWN,RETURN,e,RETURN,RETURN",
      });
      assert.strictEqual(run.status, 0, run.stderr);
      assert.deepStrictEqual(yield* bound(library, "global"), ["alpha-pack", "beta-pack"]);
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
  subprocessTimeout,
);

/** A detected Codex that answers `--version` and logs every call it receives. */
const loggedCodex = Effect.fn("Test.loggedCodex")(function* (library: TuiLibrary) {
  const fs = yield* FileSystem.FileSystem;
  const bin = join(library.root, "bin");
  const log = join(library.root, "codex.log");
  yield* fs.makeDirectory(bin);
  // An installed Skill is what makes the audit report Codex as detected.
  yield* fs.makeDirectory(join(library.home, ".codex", "skills", "demo"), { recursive: true });
  yield* fs.writeFileString(
    join(library.home, ".codex", "skills", "demo", "SKILL.md"),
    "---\nname: demo\ndescription: Demo.\n---\nDemo\n",
  );
  yield* fs.writeFileString(
    join(bin, "codex"),
    `#!/bin/sh\necho "$*" >> '${log}'\n[ "$1" = "--version" ] || exit 1\necho "codex-cli 1.2.3"\n`,
  );
  yield* fs.chmod(join(bin, "codex"), 0o755);
  return {
    bin,
    probes: Effect.map(fs.readFileString(log), (calls) =>
      calls.split("\n").filter((call) => call === "--version"),
    ),
  };
});

const probed: { keys: string; probes: number }[] = [
  // Back-to-back: the second `p` lands before the first probe can even look up its executable.
  { keys: "p+p", probes: 1 },
  { keys: "p,p", probes: 2 },
];

for (const { keys, probes } of probed)
  it.effect(
    `probe keys ${keys} run ${probes} probe${probes === 1 ? "" : "s"}`,
    () =>
      Effect.gen(function* () {
        const library = yield* tuiLibrary({});
        const codex = yield* loggedCodex(library);
        const run = yield* replay(
          library,
          { SKIT_TUI_SNAPSHOT_KEYS: keys },
          { arguments: ["--view", "harnesses", "--item", "codex"], bin: codex.bin },
        );
        assert.strictEqual(run.status, 0, run.stderr);
        assert.strictEqual((yield* codex.probes).length, probes);
      }).pipe(Effect.scoped, Effect.provide(skitLayer)),
    subprocessTimeout,
  );

// BUG characterization: quitting while a confirmed change is applying should exit cleanly. Today
// `q` disposes the host, which interrupts the apply, and the TUI exits 1 on the unhandled
// rejection from `applyPending`. The interrupted apply writes nothing, so no Binding scope is
// half-removed and no bytes are lost; the decomposition must keep that, and fix the exit.
it.effect(
  "BUG: quitting while a confirmed change applies exits 1, and writes nothing",
  () =>
    Effect.gen(function* () {
      const library = yield* tuiLibrary({ "alpha-pack": ["one", "two"] });
      yield* library.bind("alpha-pack", [
        { kind: "global" },
        { kind: "repository", root: library.cwd },
      ]);
      const before = yield* library.tree;
      // Disable in "All shown" destinations, then apply and quit before the apply can read.
      const run = yield* replay(library, { SKIT_TUI_SNAPSHOT_KEYS: "d,RETURN,RETURN+q" });
      assert.strictEqual(run.status, 1);
      assert.deepStrictEqual(yield* library.tree, before);
      assert.deepStrictEqual(yield* bound(library, "global"), ["alpha-pack"]);
      assert.deepStrictEqual(yield* bound(library, "repository"), ["alpha-pack"]);
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
  subprocessTimeout,
);

it.effect(
  "quitting after a confirmed change applied removes it from every destination",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const library = yield* tuiLibrary({ "alpha-pack": ["one", "two"] });
      yield* library.bind("alpha-pack", [
        { kind: "global" },
        { kind: "repository", root: library.cwd },
      ]);
      const run = yield* replay(library, { SKIT_TUI_SNAPSHOT_KEYS: "d,RETURN,RETURN,q" });
      assert.strictEqual(run.status, 0, run.stderr);
      assert.deepStrictEqual(yield* bound(library, "global"), []);
      assert.deepStrictEqual(yield* bound(library, "repository"), []);
      assert.isFalse(yield* fs.exists(join(library.home, ".agents", "skills", "one")));
      assert.isFalse(yield* fs.exists(join(library.cwd, ".agents", "skills", "one")));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
  subprocessTimeout,
);

// The one rendered check: layout only. A narrow terminal must not overflow its frame.
it.effect(
  "a narrow terminal frame stays within its size",
  () =>
    Effect.gen(function* () {
      const library = yield* tuiLibrary({ "alpha-pack": ["one", "two"] });
      const run = yield* replay(library, { SKIT_TUI_SNAPSHOT_SIZE: "60x24" });
      assert.strictEqual(run.status, 0, run.stderr);
      const rows = run.frame.replace(/\n$/, "").split("\n");
      assert.strictEqual(rows.length, 24);
      assert.isTrue(rows.every((row) => Array.from(row).length <= 60));
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
  subprocessTimeout,
);
