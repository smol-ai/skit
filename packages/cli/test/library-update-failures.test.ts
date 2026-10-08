import { assert, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem } from "effect";
import { systemError } from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/http";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { InvalidLibraryState, LibraryStore, libraryStoreLayer, skitLayer } from "@smolai/skit-core";
import { retainedTreePath } from "@smolai/skit-core";
import { applyLibraryBindings } from "../src/workflows/library/set-enabled.js";
import { writingTo } from "./helpers/library-home.js";
import { addLibrarySourceEffect } from "../src/workflows/library/add.js";
import { updateSubjectsEffect, updateExitCode } from "../src/workflows/library/update.js";
import { rendererTestLayer } from "./helpers/renderer.js";
import { defaultTerminalEnvironment, renderResultFrame } from "../src/presentation/output-frame.js";
import { result } from "../src/handlers/contracts.js";
import { outputContracts } from "../src/commands/output-contracts.js";

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-update-failures-" });
  const home = join(root, "library");
  const body = (name: string, content: string) =>
    `---\nname: ${name}\ndescription: Test Skill\n---\n\n${content}\n`;
  const archive = (name: string, duplicate: boolean, content: string) =>
    Effect.gen(function* () {
      const directory = join(root, name);
      yield* fs.makeDirectory(join(directory, "a"), { recursive: true });
      yield* fs.writeFileString(join(directory, "a", "SKILL.md"), body(name, content));
      if (!duplicate) yield* fs.remove(join(directory, "b"), { recursive: true, force: true });
      if (duplicate) {
        yield* fs.makeDirectory(join(directory, "b"));
        yield* fs.writeFileString(join(directory, "b", "SKILL.md"), body(name, content));
      }
      const path = join(root, `${name}.tar`);
      yield* Effect.sync(() => execFileSync("tar", ["-cf", path, "-C", directory, "."]));
      return yield* fs.readFile(path);
    });
  const urls = ["https://fixtures.test/broken.tar", "https://fixtures.test/healthy.tar"];
  const bodies = new Map<string, Uint8Array>([
    [urls[0]!, yield* archive("broken", false, "before")],
    [urls[1]!, yield* archive("healthy", false, "before")],
  ]);
  const requests: string[] = [];
  const client = HttpClient.make((request) => {
    requests.push(request.url);
    return Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(new Uint8Array(bodies.get(request.url)!), {
          headers: { "content-type": "application/x-tar" },
        }),
      ),
    );
  });
  const run = <A, E, R>(operation: Effect.Effect<A, E, R>) =>
    operation.pipe(
      Effect.provide(libraryStoreLayer({ home })),
      Effect.provideService(HttpClient.HttpClient, client),
    );
  for (const url of urls) yield* run(addLibrarySourceEffect({ type: "archive", url }));
  const before = yield* run(Effect.flatMap(LibraryStore, (store) => store.load));
  bodies.set(urls[0]!, yield* archive("broken", true, "after"));
  bodies.set(urls[1]!, yield* archive("healthy", false, "after"));
  requests.length = 0;
  const options = {
    roots: { home: root, configHome: join(root, "config"), overrides: {} },
    variantsPath: join(home, "variants"),
  };
  return { fs, root, home, urls, bodies, requests, before, run, options, archive };
});

it.effect(
  "continues after invalid imports and cleanup failures, preserving successful updates",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const cleanup = systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "makeTempDirectoryScoped",
        syscall: "unlink",
        pathOrDescriptor: join(f.root, "source-temp"),
      });
      const outcomes = yield* f.run(
        updateSubjectsEffect(f.before, f.options).pipe(
          Effect.provide(
            rendererTestLayer({
              withStatus: (status, operation) =>
                typeof status !== "string" &&
                status.pending.startsWith(f.before.collections[0]!.label)
                  ? operation.pipe(Effect.ensuring(Effect.die(cleanup)))
                  : operation,
            }),
          ),
        ),
      );
      assert.strictEqual(outcomes.length, 2);
      assert.isTrue("status" in outcomes[0]!);
      if (!("status" in outcomes[0]!)) return;
      assert.strictEqual(outcomes[0].error.code, "VALIDATION_FAILED");
      assert.include(outcomes[0].error.message, 'duplicate Skill name "broken"');
      assert.include(outcomes[0].error.message, "Additional failure: PermissionDenied");
      assert.strictEqual(outcomes[0].source, f.urls[0]);
      assert.isTrue("changed" in outcomes[1]! && outcomes[1].changed);
      const after = yield* f.run(Effect.flatMap(LibraryStore, (store) => store.load));
      assert.strictEqual(after.skills.find((s) => s.name === "broken")!.versions.length, 1);
      assert.strictEqual(after.skills.find((s) => s.name === "healthy")!.versions.length, 2);
      assert.strictEqual(updateExitCode(outcomes), 1);
      assert.strictEqual(updateExitCode([outcomes[0]]), 65);
      const commandResult = result(
        "update",
        outputContracts.update,
        outcomes,
        updateExitCode(outcomes),
      );
      const human = renderResultFrame(commandResult, defaultTerminalEnvironment)!;
      assert.strictEqual(human.exitCode, 1);
      const json = renderResultFrame(commandResult, {
        ...defaultTerminalEnvironment,
        format: "json",
      })!;
      assert.strictEqual(JSON.parse(json.stdout).data[0].status, "failed");
      assert.strictEqual(json.exitCode, 1);
    }).pipe(Effect.provide(skitLayer)),
);

for (const failurePhase of ["projection", "source-cleanup"] as const) {
  it.effect(`repairs bound projections after ${failurePhase} failure with a current Source`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const roots = { ...f.options.roots, overrides: { codex: join(f.root, "codex") } };
      const options = { ...f.options, roots };
      const collection = f.before.collections[0]!;
      yield* writingTo(
        f.home,
        f.run(
          applyLibraryBindings(f.before, {
            query: collection.collection_id,
            all: true,
            roots,
            variantsPath: options.variantsPath,
            invocation: {
              subjects: [collection.collection_id],
              scope: { kind: "global" },
              enabled: true,
              dryRun: false,
            },
          }),
        ),
      );
      const before = yield* f.run(Effect.flatMap(LibraryStore, (store) => store.load));
      const projectionPath = join(f.root, "codex", "broken", "SKILL.md");
      const original = yield* f.fs.readFileString(projectionPath);
      f.bodies.set(f.urls[0]!, yield* f.archive("broken", false, "after"));
      let failed = false;
      const outcomes = yield* f.run(
        updateSubjectsEffect(before, options).pipe(
          Effect.provide(
            rendererTestLayer({
              withStatus: (status, operation) =>
                failurePhase === "source-cleanup" &&
                typeof status !== "string" &&
                status.pending === `${collection.label} · Fetching and inspecting Source`
                  ? operation.pipe(
                      Effect.ensuring(
                        Effect.gen(function* () {
                          failed = true;
                          return yield* Effect.die(
                            systemError({
                              _tag: "PermissionDenied",
                              module: "FileSystem",
                              method: "makeTempDirectoryScoped",
                              pathOrDescriptor: join(f.root, "source-temp"),
                            }),
                          );
                        }),
                      ),
                    )
                  : operation,
            }),
          ),
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            makeTempDirectoryScoped: (input) =>
              failurePhase === "projection" && input?.prefix === ".skit-stage-" && !failed
                ? Effect.gen(function* () {
                    failed = true;
                    return yield* Effect.fail(
                      systemError({
                        _tag: "PermissionDenied",
                        module: "FileSystem",
                        method: "makeTempDirectoryScoped",
                        pathOrDescriptor: join(f.root, "projection-stage"),
                      }),
                    );
                  })
                : f.fs.makeTempDirectoryScoped(input),
          }),
        ),
      );
      assert.isTrue(failed);
      assert.isTrue("status" in outcomes[0]!);
      if (!("status" in outcomes[0]!)) return;
      assert.strictEqual(
        outcomes[0].phase,
        failurePhase === "projection" ? "projection" : "source",
      );
      assert.strictEqual(outcomes[0].source_retained, true);
      assert.isTrue("changed" in outcomes[1]! && outcomes[1].changed);
      assert.strictEqual(yield* f.fs.readFileString(projectionPath), original);
      const retained = yield* f.run(Effect.flatMap(LibraryStore, (store) => store.load));
      const retry = yield* writingTo(
        f.home,
        f.run(updateSubjectsEffect(retained, options).pipe(Effect.provide(rendererTestLayer()))),
      );
      assert.isTrue("changed" in retry[0]! && !retry[0].changed && retry[0].projected === 1);
      assert.include(yield* f.fs.readFileString(projectionPath), "after");
      const after = yield* f.run(Effect.flatMap(LibraryStore, (store) => store.load));
      assert.strictEqual(after.acquisitions.length, retained.acquisitions.length);
      const unchanged = yield* writingTo(
        f.home,
        f.run(updateSubjectsEffect(after, options).pipe(Effect.provide(rendererTestLayer()))),
      );
      assert.isTrue(
        unchanged.every((item) => "changed" in item && !item.changed && item.projected === 0),
      );
    }).pipe(Effect.provide(skitLayer)),
  );
}

for (const kind of ["defect", "interrupt"] as const) {
  it.effect(`does not recover ${kind} failures as Collection failures`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const failure =
        kind === "defect" ? Effect.die(new Error("programming defect")) : Effect.interrupt;
      const exit = yield* Effect.exit(
        f.run(
          updateSubjectsEffect(f.before, f.options).pipe(
            Effect.provide(rendererTestLayer({ withStatus: () => failure })),
          ),
        ),
      );
      assert.isTrue(Exit.isFailure(exit));
      if (Exit.isFailure(exit) && kind === "interrupt")
        assert.isTrue(Cause.hasInterruptsOnly(exit.cause));
      assert.deepStrictEqual(f.requests, []);
    }).pipe(Effect.provide(skitLayer)),
  );
}

it.effect("stops on typed filesystem errors in shared Library storage", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const alias = join(f.root, "library-alias");
    yield* f.fs.symlink(f.home, alias);
    const denied = systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "writeFile",
      pathOrDescriptor: join(alias, "state.json"),
    });
    const exit = yield* Effect.exit(
      f.run(
        updateSubjectsEffect(f.before, f.options).pipe(
          Effect.provide(rendererTestLayer()),
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            readFileString: (path, options) =>
              path.includes("skit-source-")
                ? Effect.fail(denied)
                : f.fs.readFileString(path, options),
          }),
        ),
      ),
    );
    assert.isTrue(Exit.isFailure(exit));
    assert.deepStrictEqual(f.requests, [f.urls[0]]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("keeps candidate manifest validation failures local to their Collection", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    // The old path keeps its historical name, while a new path declares that same name.
    // The observed names are distinct, but the candidate portable manifest is invalid.
    yield* f.fs.writeFileString(
      join(f.root, "broken", "a", "SKILL.md"),
      "---\nname: renamed\ndescription: Test Skill\n---\n\nafter\n",
    );
    const archivePath = join(f.root, "candidate.tar");
    yield* Effect.sync(() =>
      execFileSync("tar", ["-cf", archivePath, "-C", join(f.root, "broken"), "."]),
    );
    f.bodies.set(f.urls[0]!, yield* f.fs.readFile(archivePath));
    const outcomes = yield* f.run(
      updateSubjectsEffect(f.before, f.options).pipe(Effect.provide(rendererTestLayer())),
    );
    assert.isTrue("status" in outcomes[0]!);
    if (!("status" in outcomes[0]!)) return;
    assert.strictEqual(outcomes[0].error.code, "VALIDATION_FAILED");
    assert.include(outcomes[0].error.message, "portable manifest");
    assert.isTrue("changed" in outcomes[1]! && outcomes[1].changed);
    const after = yield* f.run(Effect.flatMap(LibraryStore, (store) => store.load));
    assert.strictEqual(after.skills.find((s) => s.name === "broken")!.versions.length, 1);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("aborts the batch on typed shared state failures", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const exit = yield* f.run(
      Effect.gen(function* () {
        const store = yield* LibraryStore;
        return yield* Effect.exit(
          updateSubjectsEffect(f.before, f.options).pipe(
            Effect.provide(rendererTestLayer()),
            Effect.provideService(LibraryStore, {
              ...store,
              load: Effect.fail(
                new InvalidLibraryState({
                  path: join(f.home, "state.json"),
                  detail: "invalid state",
                }),
              ),
            }),
          ),
        );
      }),
    );
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit))
      assert.isTrue(
        exit.cause.reasons.some(
          (r) => Cause.isFailReason(r) && r.error._tag === "InvalidLibraryState",
        ),
      );
    // A source fetch may precede the store load inside retention; no subsequent Source runs.
    assert.isFalse(f.requests.includes(f.urls[1]!));
  }).pipe(Effect.provide(skitLayer)),
);

it.effect("stops on corruption of an existing retained object", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const copy = f.before.retained_copies.find(
      (copy) => copy.retained_copy_id === f.before.acquisitions[0]!.retained_copy_id,
    )!;
    yield* f.fs.writeFileString(
      join(retainedTreePath(join(f.home, "originals"), copy.digest), "a", "SKILL.md"),
      "corrupted",
    );
    f.bodies.set(f.urls[0]!, yield* f.archive("broken", false, "before"));
    const exit = yield* Effect.exit(
      f.run(updateSubjectsEffect(f.before, f.options).pipe(Effect.provide(rendererTestLayer()))),
    );
    assert.isTrue(Exit.isFailure(exit));
    if (Exit.isFailure(exit))
      assert.isTrue(
        exit.cause.reasons.some(
          (r) => Cause.isFailReason(r) && r.error._tag === "ContentAddressCollision",
        ),
      );
    assert.deepStrictEqual(f.requests, [f.urls[0]]);
  }).pipe(Effect.provide(skitLayer)),
);
