import * as Library from "@smolai/skit-core/library";
import { describe } from "@effect/vitest";
import { withLibraryOwner } from "./helpers/library-owner.js";
import { join } from "node:path";
import { Effect, FileSystem } from "effect";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import { systemError } from "effect/PlatformError";

import { skitLayer } from "@smolai/skit-core/platform";
import { setupApplyCommand } from "../src/library/setup/apply.js";
import { runSetup } from "@smolai/skit-core/library/setup";
import { makeScriptedInteraction } from "../src/storybook/interaction-recorder.js";
import { libraryHome, scratch } from "./helpers/library-home.js";
import { homeLockIsFree } from "./helpers/home-lock.js";

const fixture = Effect.fn("Test.setupOperationFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* scratch("skit-setup-operation-"));
  const source = join(root, "agents", "review");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.writeFileString(
    join(source, "SKILL.md"),
    "---\nname: review\ndescription: review\n---\n\nOriginal bytes\n",
  );
  const home = yield* libraryHome({
    home: join(root, "library"),
    inventoryHome: root,
    roots: { codex: [join(root, "agents")], "claude-code": [join(root, "claude")] },
  });
  const options = {
    libraryHome: home.home,
    inventory: home.inventory,
    probePath: "",
    skillsStateHome: join(root, "state"),
  };
  const scan = yield* home.owned(runSetup({ ...options, persistRoots: false }));
  const interaction = yield* makeScriptedInteraction([]);
  const apply = setupApplyCommand({
    options,
    manageOptions: { installOptions: home.installOptions },
    planId: scan.onboarding.planId,
  }).pipe(withLibraryOwner(home.inventory), Effect.provide(interaction.layer));
  return { fs, root, source, home, apply };
});

/** The operation facts exposed by the owner. */
const operations = (records: Effect.Success<Library.Interface["history"]>["operations"]) =>
  records.map((operation) => ({
    _tag: operation._tag,
    operationId: operation.operationId,
    steps: operation.steps.map((recorded) => ({
      tag: recorded.step._tag,
      status: recorded.status,
      sources:
        recorded.step._tag === "Manage"
          ? recorded.before
              .filter((evidence) => evidence._tag !== "Absent")
              .map((evidence) => evidence.path)
          : [],
    })),
  }));

describe("skit setup", () => {
  describe("Keeping files recoverable", () => {
    describe("Setup moves no selected files until its recovery steps are saved.", () => {
      it.effect(
        "setup records its steps before managing the selected folder, with discovery folders under the same operation",
        () =>
          Effect.gen(function* () {
            const f = yield* fixture();
            const observer = yield* f.home.owned(Library.Service);
            let recorded: ReturnType<typeof operations> | undefined;
            const applied = yield* f.home.owned(
              f.apply.pipe(
                Effect.provideService(FileSystem.FileSystem, {
                  ...f.fs,
                  rename: (from, to) =>
                    Effect.gen(function* () {
                      if (to === join(f.source, ".skit-ownership.json")) {
                        recorded = operations((yield* observer.history).operations);
                        expect(yield* f.fs.exists(to)).toBe(false);
                      }
                      yield* f.fs.rename(from, to);
                    }),
                }),
              ),
            );
            if (!applied.operationId)
              return yield* Effect.die(new Error("Missing setup operation"));
            expect(recorded).toEqual([
              {
                _tag: "Pending",
                operationId: applied.operationId,
                steps: [{ tag: "Manage", status: "Pending", sources: [f.source] }],
              },
            ]);
            expect(
              operations(
                (yield* f.home.owned(Effect.flatMap(Library.Service, (library) => library.history)))
                  .operations,
              ),
            ).toEqual([
              {
                _tag: "Done",
                operationId: applied.operationId,
                steps: [{ tag: "Manage", status: "Done", sources: [f.source] }],
              },
            ]);
            // Setup created this machine's identity, so it saved the discovery folders it observed.
            const settings = (yield* f.home.owned(
              Effect.flatMap(Library.Service, (library) => library.history),
            )).operations.find((row) => row.operationId === applied.operationId)?.setup?.discovery;
            expect(settings?.before.discoveryRoots).toEqual([]);
            expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toContain(
              "Original bytes",
            );
            expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(true);
          }).pipe(Effect.provide(skitLayer)),
      );

      it.effect("a refused setup record changes no skill and saves no discovery folders", () =>
        Effect.gen(function* () {
          const f = yield* fixture();
          const failure = yield* Effect.flip(
            f.home.owned(
              f.apply.pipe(
                Effect.provideService(FileSystem.FileSystem, {
                  ...f.fs,
                  chmod: (path, mode) =>
                    path === join(f.home.home, "library.sqlite")
                      ? Effect.fail(
                          systemError({
                            _tag: "PermissionDenied",
                            module: "FileSystem",
                            method: "chmod",
                            pathOrDescriptor: path,
                          }),
                        )
                      : f.fs.chmod(path, mode),
                }),
              ),
            ),
          );
          expect(failure._tag).toBe("PlatformError");
          expect((yield* f.home.snapshot)._tag).toBe("Absent");
          expect(
            (yield* f.home.owned(Effect.flatMap(Library.Service, (library) => library.history)))
              .operations,
          ).toEqual([]);
          expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(false);
          expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toContain(
            "Original bytes",
          );
        }).pipe(Effect.provide(skitLayer)),
      );
    });
  });
});

describe("skit setup", () => {
  describe("Keeping files recoverable", () => {
    describe("An interrupted setup keeps the remaining files recoverable.", () => {
      it.effect(
        "a setup interrupted after its record is saved is finished by the next Library",
        () =>
          Effect.gen(function* () {
            const f = yield* fixture();
            const observer = yield* f.home.owned(Library.Service);
            const exit = yield* Effect.exit(
              f.home.owned(
                f.apply.pipe(
                  Effect.provideService(FileSystem.FileSystem, {
                    ...f.fs,
                    rename: (from, to) =>
                      to === join(f.source, ".skit-ownership.json")
                        ? Effect.interrupt
                        : f.fs.rename(from, to),
                  }),
                ),
              ),
            );
            expect(exit._tag).toBe("Failure");
            expect(yield* homeLockIsFree(f.home.home)).toBe(true);
            // As saved: reading it through a Library would already have recovered it.
            const [pending] = (yield* observer.history).operations;
            expect(pending?._tag).toBe("Pending");
            // The next command's Library finishes it at startup, routed as the setup recorded.
            expect(
              operations(
                (yield* f.home.owned(Effect.flatMap(Library.Service, (library) => library.history)))
                  .operations,
              ),
            ).toEqual([
              {
                _tag: "Done",
                operationId: pending?.operationId,
                steps: [{ tag: "Manage", status: "Done", sources: [f.source] }],
              },
            ]);
            expect(yield* f.fs.exists(join(f.source, ".skit-ownership.json"))).toBe(true);
          }).pipe(Effect.provide(skitLayer)),
      );
    });
  });
});
