// `src/index.ts` is one top-level-await module with no exports, so these tests replay keys through
// its snapshot mode in a Bun subprocess and observe the Library on disk, never the frame text.
//
// Snapshot key replay does not wait for the host, so only scripts whose every step is synchronous,
// or whose async step the snapshot mode itself awaits (`SKIT_TUI_SNAPSHOT_LIBRARY=confirm` awaits
// its proposal), are deterministic. Scripts that apply a change are not, and are left out.
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem } from "effect";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { skitLayer } from "@smolai/skit-core";
import { tuiLibrary } from "./helpers/library-fixture";

const entry = resolve(import.meta.dirname, "../src/index.ts");
const bun = spawnSync("bun", ["--print", "process.execPath"], { encoding: "utf8" }).stdout.trim();

const replay = Effect.fn("Test.replayTuiKeys")(function* (
  library: Effect.Success<ReturnType<typeof tuiLibrary>>,
  environment: Record<string, string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const frame = join(yield* fs.makeTempDirectoryScoped({ prefix: "skit-tui-frame-" }), "frame");
  const run = spawnSync(
    bun,
    [entry, "--skit-home", library.skitHome, "--home", library.home, "--cwd", library.cwd],
    {
      cwd: library.cwd,
      encoding: "utf8",
      timeout: 60_000,
      env: {
        // No Harness executables: listing budgets would otherwise start the developer's own
        // `codex app-server`, which writes its state under the fixture home. Bun's transpiler
        // cache would land there too.
        PATH: "/usr/bin:/bin",
        BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        HOME: library.home,
        SKIT_TUI_SNAPSHOT: frame,
        ...environment,
      },
    },
  );
  assert.strictEqual(run.status, 0, run.stderr);
  return yield* fs.readFileString(frame);
});

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
  it.effect(`cancelling at ${at} writes nothing`, () =>
    Effect.gen(function* () {
      const library = yield* tuiLibrary({ "alpha-pack": ["one", "two"], "beta-pack": ["three"] });
      const before = yield* library.tree;
      yield* replay(library, { ...environment, SKIT_TUI_SNAPSHOT_KEYS: keys });
      assert.deepStrictEqual(yield* library.tree, before);
    }).pipe(Effect.scoped, Effect.provide(skitLayer)),
  );

// The one rendered check: layout only. A narrow terminal must not overflow its frame.
it.effect("a narrow terminal frame stays within its size", () =>
  Effect.gen(function* () {
    const library = yield* tuiLibrary({ "alpha-pack": ["one", "two"] });
    const frame = yield* replay(library, { SKIT_TUI_SNAPSHOT_SIZE: "60x24" });
    const rows = frame.replace(/\n$/, "").split("\n");
    assert.strictEqual(rows.length, 24);
    assert.isTrue(rows.every((row) => Array.from(row).length <= 60));
  }).pipe(Effect.scoped, Effect.provide(skitLayer)),
);
