import { LinkStat } from "@smolai/skit-core";
import { systemError } from "effect/PlatformError";
import {
  applySetupLocalCustody,
  planSetupAliasRetirement,
  retireSetupAliases,
} from "../src/workflows/library/setup-local-custody.js";
import type { ShadowObservationError } from "../src/projection/harness-shadows.js";
import { codexSkillAliases } from "../src/workflows/library/doctor-codex.js";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { skitLayer, LibraryStore } from "@smolai/skit-core";
import {
  observeHarnessShadows,
  observeHarnessSkills,
  readableHarnessRoots,
} from "../src/projection/harness-shadows.js";
import { addLibrarySourceEffect } from "../src/workflows/library/add.js";
import { applyLibraryBindings } from "../src/workflows/library/set-enabled.js";
import { runSetup, revalidateSetupPlan } from "../src/workflows/library/setup.js";
import { setupCommand } from "../src/handlers/library/setup.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import {
  libraryHome,
  scratch,
  writingTo,
  initializeLibraryMachine,
} from "./helpers/library-home.js";

const fixture = Effect.fn("Test.symlinkFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* scratch("skit-shadow-"));
  const source = join(root, "Work", "skills", "review");
  const alias = join(root, ".codex", "skills", "review");
  const destination = join(root, ".agents", "skills", "review");
  yield* fs.makeDirectory(source, { recursive: true });
  yield* fs.makeDirectory(join(root, ".codex", "skills"), { recursive: true });
  yield* fs.writeFileString(
    join(source, "SKILL.md"),
    "---\nname: review\ndescription: Review code\n---\nReview code.\n",
  );
  yield* fs.symlink(source, alias);
  const home = yield* libraryHome({ home: join(root, "library"), inventoryHome: root });
  const options = {
    libraryHome: home.home,
    inventory: home.inventory,
    probePath: "",
    skillsStateHome: join(root, "state"),
  };
  return { fs, root, source, alias, destination, home, options };
});

it.effect("enable refuses the extra copy before publishing intent, and dry-run explains why", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* initializeLibraryMachine(f.home.home);
    yield* f.home.owned(
      writingTo(
        f.home.home,
        Effect.gen(function* () {
          const retained = yield* addLibrarySourceEffect(f.source);
          const store = yield* LibraryStore;
          const before = yield* store.load;
          if (retained.collection_id === undefined)
            return yield* Effect.die("Expected a retained collection");
          const options = {
            query: retained.collection_id,
            all: false,
            invocation: {
              subjects: ["review"],
              scope: { kind: "global" as const },
              enabled: true,
              dryRun: false,
            },
            roots: f.home.inventory,
            variantsPath: f.home.bindings.variantsPath,
          };
          const preview = yield* applyLibraryBindings(before, {
            ...options,
            invocation: { ...options.invocation, dryRun: true },
          });
          expect(preview.value.shadows).toEqual([
            expect.objectContaining({
              name: "review",
              harness: "codex",
              aliases: [expect.objectContaining({ path: f.alias, via: "symlink" })],
            }),
          ]);
          const result = yield* Effect.result(applyLibraryBindings(before, options));
          expect(Result.isFailure(result) && result.failure._tag).toBe("ProjectionWouldDuplicate");
          expect((yield* store.load).global_bindings).toEqual(before.global_bindings);
          expect(yield* f.fs.exists(f.destination)).toBe(false);
          yield* applyLibraryBindings(before, { ...options, allowDuplicate: true });
          expect(yield* f.fs.readFileString(join(f.destination, "SKILL.md"))).toBe(
            yield* f.fs.readFileString(join(f.source, "SKILL.md")),
          );
          const policyChange = yield* applyLibraryBindings(yield* store.load, {
            ...options,
            invocation: { ...options.invocation, invocation: "explicit" as const },
          });
          expect(policyChange.value.shadows).toBeUndefined();
          expect((yield* store.load).global_bindings[0].invocation_policies).toBeDefined();
        }),
      ),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect.each(["retain-only", "retire-aliases", "keep-both"] as const)(
  "setup duplicate choice: %s",
  (action) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const interaction = yield* makeScriptedInteraction([["review"], action, true]);
      yield* f.home.owned(
        writingTo(
          f.home.home,
          setupCommand({
            options: f.options,
            cwd: f.root,
            interactive: true,
            dryRun: false,
            localCustody: { acquisition: f.home.addOptions, bindings: f.home.bindings },
          }).pipe(Effect.provide(interaction.layer)),
        ),
      );
      const state = yield* f.home.durable;
      expect(state.skills.map((skill) => skill.name)).toEqual(["review"]);
      expect(yield* f.fs.exists(f.source)).toBe(true);
      expect(yield* f.fs.exists(f.destination)).toBe(action !== "retain-only");
      expect(yield* f.fs.exists(f.alias)).toBe(action !== "retire-aliases");
      expect(state.global_bindings.length).toBe(action === "retain-only" ? 0 : 1);
      const prompts = yield* interaction.prompts;
      expect(prompts[0].choices[0].selected).toBe(false);
      expect(prompts[1].choices.map((choice) => choice.value)).toEqual([
        "retire-aliases",
        "retain-only",
        "keep-both",
      ]);
      if (action === "retire-aliases") {
        const removed = join(f.home.home, "removed");
        const receipt = JSON.parse(
          yield* f.fs.readFileString(
            join(removed, (yield* f.fs.readDirectory(removed))[0], "receipt.json"),
          ),
        );
        expect(receipt.entries).toEqual([
          expect.objectContaining({
            path: f.alias,
            linkTarget: f.source,
            type: "SymbolicLink",
            moved: true,
          }),
        ]);
        expect(yield* f.fs.readLink(receipt.entries[0].recoveryPath)).toBe(f.source);
      }
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("setup consent becomes stale if the alias target changes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.home.owned(
      Effect.gen(function* () {
        const plan = yield* runSetup({ ...f.options, repositoryRoots: [], persistRoots: false });
        yield* f.fs.remove(f.alias);
        yield* f.fs.symlink("../../Work/skills/review", f.alias);
        const result = yield* Effect.result(
          revalidateSetupPlan(
            { ...f.options, repositoryRoots: [], persistRoots: false },
            plan.onboarding.planId,
          ),
        );
        expect(Result.isFailure(result)).toBe(true);
      }),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "observes symlinked roots, preserves aliases, and keeps repository/global checks separate",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const index = yield* observeHarnessSkills(
        readableHarnessRoots(f.home.inventory, { kind: "global" }),
      );
      expect(
        codexSkillAliases(join(f.source, "SKILL.md"), join(f.source, "SKILL.md"), index),
      ).toEqual([expect.objectContaining({ path: f.alias, linkTarget: f.source, via: "symlink" })]);
      expect(
        yield* observeHarnessShadows(
          f.home.inventory,
          { kind: "repository", root: join(f.root, "repo") },
          ["review"],
        ),
      ).toEqual([]);
      yield* f.fs.remove(join(f.root, ".codex", "skills"), { recursive: true });
      yield* f.fs.symlink(join(f.root, "Work", "skills"), join(f.root, ".codex", "skills"));
      const rooted = yield* observeHarnessShadows(f.home.inventory, { kind: "global" }, ["review"]);
      expect(rooted[0].aliases[0]).toMatchObject({
        path: f.alias,
        via: "symlink",
        linkPath: join(f.root, ".codex", "skills"),
      });
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("setup requires a duplicate decision before retaining any selected source", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* initializeLibraryMachine(f.home.home);
    yield* f.home.owned(
      writingTo(
        f.home.home,
        Effect.gen(function* () {
          const options = { ...f.options, repositoryRoots: [], persistRoots: false };
          const observed = yield* runSetup(options);
          const result = yield* Effect.result(
            applySetupLocalCustody(
              {
                setup: options,
                adoption: { acquisition: f.home.addOptions, bindings: f.home.bindings },
              },
              observed.onboarding.planId,
              [{ name: "review", sourcePath: f.source }],
            ),
          );
          expect(
            Result.isFailure(result) &&
              result.failure._tag === "SetupLocalCustodySelectionInvalid" &&
              result.failure.reason,
          ).toBe("duplicate-action-required");
          const state = yield* (yield* LibraryStore).load;
          expect(state.collections).toEqual([]);
          expect(state.global_bindings).toEqual([]);
          expect(yield* f.fs.readLink(f.alias)).toBe(f.source);
        }),
      ),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a failed replacement keeps the original alias available", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* initializeLibraryMachine(f.home.home);
    yield* f.home.owned(
      writingTo(
        f.home.home,
        Effect.gen(function* () {
          const options = { ...f.options, repositoryRoots: [], persistRoots: false };
          const observed = yield* runSetup(options);
          const fs = FileSystem.FileSystem.of({
            ...f.fs,
            rename: (from, to) =>
              to === f.destination
                ? Effect.fail(
                    systemError({
                      _tag: "PermissionDenied",
                      module: "FileSystem",
                      method: "rename",
                      pathOrDescriptor: to,
                    }),
                  )
                : f.fs.rename(from, to),
          });
          const result = yield* Effect.result(
            applySetupLocalCustody(
              {
                setup: options,
                adoption: { acquisition: f.home.addOptions, bindings: f.home.bindings },
              },
              observed.onboarding.planId,
              [{ name: "review", sourcePath: f.source, duplicateAction: "retire-aliases" }],
            ).pipe(Effect.provideService(FileSystem.FileSystem, fs)),
          );
          expect(Result.isFailure(result)).toBe(true);
          expect((yield* (yield* LibraryStore).load).skills).toHaveLength(1);
          expect(yield* f.fs.readLink(f.alias)).toBe(f.source);
          expect(yield* f.fs.readFileString(join(f.alias, "SKILL.md"))).toContain("Review code.");
          expect(yield* f.fs.exists(join(f.home.home, "removed"))).toBe(false);
        }),
      ),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("unreadable unrelated entries warn without dropping readable aliases", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const unrelated = join(f.root, ".codex", "skills", "unrelated");
    yield* f.fs.makeDirectory(unrelated);
    const inaccessible = join(unrelated, "SKILL.md");
    const fs = FileSystem.FileSystem.of({
      ...f.fs,
      readFileString: (path, ...args) =>
        path === inaccessible
          ? Effect.fail(
              systemError({
                _tag: "PermissionDenied",
                module: "FileSystem",
                method: "readFile",
                pathOrDescriptor: path,
              }),
            )
          : f.fs.readFileString(path, ...args),
    });
    const errors: ShadowObservationError[] = [];
    const shadows = yield* observeHarnessShadows(
      f.home.inventory,
      { kind: "global" },
      ["review"],
      errors,
    ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    expect(shadows[0].aliases[0].path).toBe(f.alias);
    expect(errors).toEqual([expect.objectContaining({ path: unrelated })]);
    const blocked = yield* Effect.result(
      observeHarnessShadows(f.home.inventory, { kind: "global" }, ["unrelated"]).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
    );
    expect(Result.isFailure(blocked)).toBe(true);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("does not traverse a repository linked into a skill root", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.fs.remove(f.alias);
    const repository = join(f.root, "repository");
    const nested = join(repository, "nested", "review");
    yield* f.fs.makeDirectory(nested, { recursive: true });
    yield* f.fs.copyFile(join(f.source, "SKILL.md"), join(nested, "SKILL.md"));
    yield* f.fs.symlink(repository, join(f.root, ".codex", "skills", "repository"));
    expect(yield* observeHarnessShadows(f.home.inventory, { kind: "global" }, ["review"])).toEqual(
      [],
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("setup's alias allowance does not permit an unapproved copy", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* initializeLibraryMachine(f.home.home);
    const info = yield* (yield* LinkStat).identity.lstat(f.alias);
    const other = join(f.root, ".codex", "skills", "other");
    yield* f.fs.makeDirectory(other);
    yield* f.fs.copyFile(join(f.source, "SKILL.md"), join(other, "SKILL.md"));
    yield* f.home.owned(
      writingTo(
        f.home.home,
        Effect.gen(function* () {
          yield* addLibrarySourceEffect(f.source);
          const state = yield* (yield* LibraryStore).load;
          const result = yield* Effect.result(
            applyLibraryBindings(state, {
              query: "review",
              all: false,
              invocation: {
                subjects: ["review"],
                scope: { kind: "global" },
                enabled: true,
                dryRun: false,
              },
              roots: f.home.inventory,
              variantsPath: f.home.bindings.variantsPath,
              allowedShadowAliases: [
                {
                  path: f.alias,
                  canonicalPath: f.source,
                  dev: info.dev,
                  ino: info.ino,
                  linkTarget: f.source,
                },
              ],
            }),
          );
          expect(Result.isFailure(result) && result.failure._tag).toBe("ProjectionWouldDuplicate");
          expect((yield* (yield* LibraryStore).load).global_bindings).toEqual([]);
          expect(yield* f.fs.readLink(f.alias)).toBe(f.source);
        }),
      ),
    );
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "retires Codex aliases despite an unrelated suppressed Claude target and aliased root spelling",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* initializeLibraryMachine(f.home.home);
      yield* f.fs.makeDirectory(join(f.root, ".claude"));
      const aliasHome = join(f.root, "home-alias");
      yield* f.fs.symlink(f.root, aliasHome);
      yield* f.home.owned(
        writingTo(
          f.home.home,
          Effect.gen(function* () {
            yield* addLibrarySourceEffect(f.source);
            const store = yield* LibraryStore;
            yield* applyLibraryBindings(yield* store.load, {
              query: "review",
              all: false,
              allowDuplicate: true,
              invocation: {
                subjects: ["review"],
                scope: { kind: "global" },
                enabled: true,
                dryRun: false,
              },
              roots: f.home.inventory,
              variantsPath: f.home.bindings.variantsPath,
            });
            const state = yield* store.load;
            expect(state.projections.some((projection) => projection.target === "claude")).toBe(
              true,
            );
            yield* store.publish({
              ...state,
              projections: state.projections.map((projection) =>
                projection.target === "claude"
                  ? { ...projection, status: "suppressed", suppression_reason: "native_delete" }
                  : projection,
              ),
            });
            const shadows = yield* observeHarnessShadows(f.home.inventory, { kind: "global" }, [
              "review",
            ]);
            const retirement = yield* planSetupAliasRetirement(
              f.home.home,
              "review",
              f.source,
              shadows,
            );
            const outcome = yield* retireSetupAliases(
              { ...f.home.inventory, home: aliasHome },
              "review",
              "review",
              retirement,
            );
            expect(outcome.kind).toBe("retired");
            expect(yield* f.fs.exists(f.alias)).toBe(false);
            expect(yield* f.fs.exists(f.destination)).toBe(true);
          }),
        ),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "preserves an alias with a blocked replacement and continues later setup selections",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* initializeLibraryMachine(f.home.home);
      yield* f.fs.makeDirectory(f.destination, { recursive: true });
      yield* f.fs.writeFileString(
        join(f.destination, "SKILL.md"),
        "---\nname: foreign\ndescription: Another skill\n---\nForeign content.\n",
      );
      const later = join(f.root, "Work", "skills", "later");
      const laterAlias = join(f.root, ".codex", "skills", "later");
      yield* f.fs.makeDirectory(later);
      yield* f.fs.writeFileString(
        join(later, "SKILL.md"),
        "---\nname: later\ndescription: Later skill\n---\nLater content.\n",
      );
      yield* f.fs.symlink(later, laterAlias);
      yield* f.home.owned(
        writingTo(
          f.home.home,
          Effect.gen(function* () {
            const options = { ...f.options, repositoryRoots: [], persistRoots: false };
            const observed = yield* runSetup(options);
            const applied = yield* applySetupLocalCustody(
              {
                setup: options,
                adoption: { acquisition: f.home.addOptions, bindings: f.home.bindings },
              },
              observed.onboarding.planId,
              [
                { name: "review", sourcePath: f.source, duplicateAction: "retire-aliases" },
                { name: "later", sourcePath: later, duplicateAction: "retire-aliases" },
              ],
            );
            expect(applied.warnings).toEqual([
              expect.objectContaining({
                name: "review",
                message: expect.stringContaining("not installed"),
              }),
            ]);
            expect(yield* f.fs.readLink(f.alias)).toBe(f.source);
            expect(yield* f.fs.exists(laterAlias)).toBe(false);
            expect(
              yield* f.fs.readFileString(join(f.root, ".agents", "skills", "later", "SKILL.md")),
            ).toContain("Later content.");
            expect((yield* (yield* LibraryStore).load).skills).toHaveLength(2);
          }),
        ),
      );
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
