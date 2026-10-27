// The TUI's key handlers run each Library action as one transition on its host:
// `e`/`d`/`i` propose, Enter in the confirmation applies `confirmLibraryChange(state)`, and Esc
// applies `cancelLibraryChange`. These tests drive that same sequence on the production layer and
// observe the Library on disk, so they hold while the handlers move out of `src/index.ts`.
// The host is a Promise boundary, so like `library-host.test.ts` they drive it with await.
import { Effect, Exit, FileSystem, Layer, Scope } from "effect";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { expect, onTestFinished, test } from "vitest";
import { skitLayer } from "@smolai/skit-core";
import {
  cancelLibraryChange,
  confirmLibraryChange,
  probeHarness,
  proposeLibraryCollectionChange,
} from "../../cli/src/front-end";
import { tuiLibrary } from "./helpers/library-fixture";

/**
 * Run fixture work from outside the host's runtime.
 *
 * The fixture plays the operator's disk and a second front end, so it must not share the host's
 * runtime; that boundary is the subject under test, not debt.
 */
const outside = <A, E>(
  effect: Effect.Effect<A, E, Layer.Success<typeof skitLayer> | Scope.Scope>,
) =>
  // oxlint-disable-next-line skit/no-nested-runtime
  Effect.runPromise(Effect.scoped(effect).pipe(Effect.provide(skitLayer)));

async function fixture(collections: Record<string, readonly string[]>) {
  const scope = Scope.makeUnsafe();
  onTestFinished(() => outside(Scope.close(scope, Exit.void)));
  const library = await outside(Scope.provide(scope)(tuiLibrary(collections)));
  const host = library.host();
  onTestFinished(() => host.dispose());
  return { library, host };
}

test("cancelling a previewed change writes nothing and leaves nothing to confirm", async () => {
  const { library, host } = await fixture({ "alpha-pack": ["one", "two"] });
  const before = await outside(library.tree);
  const session = await host.open();
  const previewed = await host.transition((state) =>
    proposeLibraryCollectionChange(
      state,
      library.configuration,
      session.skills[0]!.collectionId,
      true,
      [{ kind: "global" }],
    ),
  );
  expect(previewed?.kind).toBe("preview");
  const cancelled = await host.transition((state) => Effect.succeed(cancelLibraryChange(state)));
  expect(cancelled?.kind).toBe("cancelled");
  expect(host.state?.pending).toBeUndefined();
  // A stray Enter after Esc reaches confirm with no pending change.
  const confirmed = await host.transition((state) => confirmLibraryChange(state));
  expect(confirmed?.kind).toBe("cancelled");
  expect(await outside(library.tree)).toEqual(before);
});

test("a confirmation applies only at the previewed revision, and the session recovers", async () => {
  const { library, host } = await fixture({ "alpha-pack": ["one", "two"], "beta-pack": ["three"] });
  const propose = (collectionId: string) =>
    host.transition((state) =>
      proposeLibraryCollectionChange(state, library.configuration, collectionId, true, [
        { kind: "global" },
      ]),
    );
  const confirm = () => host.transition((state) => confirmLibraryChange(state));
  const session = await host.open();
  const alpha = session.skills.find((row) => row.heading === "alpha-pack")!.collectionId;

  expect((await propose(alpha))?.kind).toBe("preview");
  // Another front end changes the Library between the preview and the confirmation.
  await outside(library.retain("gamma-pack", ["four"]));
  const refused = await confirm();
  expect(refused).toMatchObject({ kind: "failed", failure: { code: "CONFLICT" } });
  const afterRefusal = await outside(library.durable);
  expect(afterRefusal.global_bindings).toEqual([]);
  expect(afterRefusal.collections.map((collection) => collection.label).sort()).toEqual([
    "alpha-pack",
    "beta-pack",
    "gamma-pack",
  ]);
  expect(host.state?.pending).toBeUndefined();
  expect(host.state?.skills.map((row) => row.name)).toContain("four");

  // The refusal left a usable session: previewing again picks up the new revision.
  expect((await propose(alpha))?.kind).toBe("preview");
  expect((await confirm())?.kind).toBe("applied");
  expect((await outside(library.durable)).global_bindings).toEqual([
    { entries: [{ kind: "collection", collection_id: alpha }], scope: { kind: "global" } },
  ]);
  expect(host.state?.pending).toBeUndefined();
});

test("disposing the host kills a Harness probe that is still running", async () => {
  const { library, host } = await fixture({});
  const bin = join(library.root, "bin");
  const started = join(library.root, "started");
  expect(spawnSync("mkfifo", [started]).status).toBe(0);
  // The fake Harness reports its pid through the FIFO, then never answers `--version`.
  await outside(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(bin);
      yield* fs.writeFileString(
        join(bin, "codex"),
        `#!/bin/sh\necho $$ > '${started}'\nexec /bin/sleep 600\n`,
      );
      yield* fs.chmod(join(bin, "codex"), 0o755);
    }),
  );
  const probe = host.run(probeHarness("codex", { path: bin })).then(
    () => "completed",
    () => "interrupted",
  );
  const pid = Number(
    await outside(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(started))),
  );
  await host.dispose();
  expect(await probe).toBe("interrupted");
  expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
}, 30_000);
