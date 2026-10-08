import { assert, it } from "@effect/vitest";
import { Cause, Effect, Exit, FileSystem } from "effect";
import { systemError } from "effect/PlatformError";
import { HttpClient, HttpClientResponse } from "effect/http";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { InvalidLibraryState, LibraryStore, libraryStoreLayer, skitLayer } from "@smolai/skit-core";
import { addLibrarySourceEffect } from "../src/workflows/library/add.js";
import { updateSubjectsEffect } from "../src/workflows/library/update.js";
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
      const commandResult = result("update", outputContracts.update, outcomes, 1);
      const human = renderResultFrame(commandResult, defaultTerminalEnvironment)!;
      assert.include(human.stdout, "1 Source updated; 1 failed");
      assert.include(human.stdout, 'duplicate Skill name "broken"');
      assert.strictEqual(human.exitCode, 1);
      const json = renderResultFrame(commandResult, {
        ...defaultTerminalEnvironment,
        format: "json",
      })!;
      assert.strictEqual(JSON.parse(json.stdout).data[0].status, "failed");
      assert.strictEqual(json.exitCode, 1);
    }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "reports a retained source when projection fails and continues to the next Collection",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      f.bodies.set(f.urls[0]!, yield* f.archive("broken", false, "after"));
      const outcomes = yield* f.run(
        updateSubjectsEffect(f.before, f.options).pipe(
          Effect.provide(
            rendererTestLayer({
              withStatus: (status, operation) =>
                typeof status !== "string" &&
                status.pending === `${f.before.collections[0]!.label} · Updating projected Skills`
                  ? operation.pipe(
                      Effect.ensuring(
                        Effect.die(
                          systemError({
                            _tag: "PermissionDenied",
                            module: "FileSystem",
                            method: "makeTempDirectoryScoped",
                            pathOrDescriptor: join(f.root, "projection-temp"),
                          }),
                        ),
                      ),
                    )
                  : operation,
            }),
          ),
        ),
      );
      assert.isTrue("status" in outcomes[0]!);
      if (!("status" in outcomes[0]!)) return;
      assert.strictEqual(outcomes[0].phase, "projection");
      assert.strictEqual(outcomes[0].source_retained, true);
      assert.isTrue("changed" in outcomes[1]! && outcomes[1].changed);
      const after = yield* f.run(Effect.flatMap(LibraryStore, (store) => store.load));
      assert.strictEqual(after.skills.find((s) => s.name === "broken")!.versions.length, 2);
    }).pipe(Effect.provide(skitLayer)),
);

for (const kind of ["library", "defect", "interrupt"] as const) {
  it.effect(`does not recover ${kind} failures as Collection failures`, () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const failure =
        kind === "library"
          ? Effect.die(
              new InvalidLibraryState({
                path: join(f.home, "state.json"),
                detail: "invalid state",
              }),
            )
          : kind === "defect"
            ? Effect.die(new Error("programming defect"))
            : Effect.interrupt;
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
    const denied = systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "writeFile",
      pathOrDescriptor: join(f.home, "state.json"),
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
