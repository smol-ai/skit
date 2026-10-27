import { testPlatformLayer } from "./helpers/platform.js";
import { LinkStat, deterministicTreeHash } from "@smolai/skit-core";
import { systemError } from "effect/PlatformError";
import { manageSetupCopies } from "../src/workflows/library/setup-manage.js";
import {
  recordDuplicateSymlinks,
  checkManageSelection,
  manageCopy,
} from "../src/workflows/library/manage-existing.js";
import { copyConflict } from "../src/workflows/library/setup-decisions.js";
import type { DuplicateScanError } from "../src/projection/duplicates.js";
import { codexSkillAliases } from "../src/workflows/library/doctor-codex.js";
import { it } from "@effect/vitest";
import { Effect, FileSystem, Result } from "effect";
import { join } from "node:path";
import { expect } from "vitest";
import { LibraryStore } from "@smolai/skit-core";
import {
  findDuplicates,
  scanSkillsDirectory,
  readableSkillsDirectories,
} from "../src/projection/duplicates.js";
import { importSource } from "../src/library-application/import-source.js";
import { setLibraryBindings } from "./helpers/binding-changes.js";
import { runSetup, revalidateSetupPlan } from "../src/workflows/library/setup.js";
import { setupCommand } from "../src/handlers/library/setup.js";
import { Renderer } from "../src/presentation/renderer.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import {
  inspectRecoveryOperation,
  listRecoveryOperations,
} from "../src/library-application/recovery-moves.js";
import {
  libraryHome,
  scratch,
  writingTo,
  initializeLibraryMachine,
} from "./helpers/library-home.js";

const fixture = Effect.fn("Test.symlinkFixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(yield* scratch("skit-duplicates-"));
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

it.effect("enable refuses the extra copy before saving intent, and dry-run explains why", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* initializeLibraryMachine(f.home.home);
    yield* f.home.owned(
      writingTo(
        f.home.home,
        Effect.gen(function* () {
          const retained = yield* importSource(f.source);
          const store = yield* LibraryStore;
          const before = yield* store.load;
          if (retained.collection_id === undefined)
            return yield* Effect.die("Expected a retained collection");
          const options = {
            query: retained.collection_id,
            all: false,
            invocation: {
              scope: { kind: "global" as const },
              enabled: true,
              dryRun: false,
            },
            roots: f.home.inventory,
            variantsPath: f.home.variantsPath,
          };
          const preview = yield* setLibraryBindings({
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
          const result = yield* Effect.result(setLibraryBindings(options));
          expect(Result.isFailure(result) && result.failure._tag).toBe(
            "InstalledSkillWouldDuplicate",
          );
          expect((yield* store.load).global_bindings).toEqual(before.global_bindings);
          expect(yield* f.fs.exists(f.destination)).toBe(false);
          yield* setLibraryBindings({ ...options, allowDuplicate: true });
          expect(yield* f.fs.readFileString(join(f.destination, "SKILL.md"))).toBe(
            yield* f.fs.readFileString(join(f.source, "SKILL.md")),
          );
          const policyChange = yield* setLibraryBindings({
            ...options,
            invocation: { ...options.invocation, invocation: "explicit" as const },
          });
          expect(policyChange.value.shadows).toBeUndefined();
          expect((yield* store.load).global_bindings[0].invocation_policies).toBeDefined();
        }),
      ),
    );
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

// Guided setup no longer asks about individual links; `--duplicates` overrides are covered in
// setup-apply-reviewed-plan.test.ts.
it.effect("guided setup preserves an individual link to the selected source without asking", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const interaction = yield* makeScriptedInteraction([["review"], true]);
    yield* f.home.owned(
      writingTo(
        f.home.home,
        setupCommand({
          options: f.options,
          interactive: true,
          dryRun: false,
          manageOptions: { bindings: f.home.bindings },
        }).pipe(Effect.provide(interaction.layer)),
      ),
    );
    expect(yield* interaction.remaining).toBe(0);
    const state = yield* f.home.durable;
    expect(state.skills.map((skill) => skill.name)).toEqual(["review"]);
    expect(state.global_bindings).toHaveLength(1);
    expect(yield* f.fs.exists(f.source)).toBe(true);
    expect(yield* f.fs.exists(f.destination)).toBe(true);
    expect(yield* f.fs.exists(f.alias)).toBe(false);
    const prompts = yield* interaction.prompts;
    expect(prompts).toHaveLength(2);
    expect(prompts[0].choices[0].selected).toBe(false);
    const [operationId] = yield* listRecoveryOperations(f.home.home);
    const recovery = yield* inspectRecoveryOperation(f.home.home, operationId);
    expect(recovery.entries).toEqual([
      expect.objectContaining({ path: f.alias, type: "SymbolicLink", status: "saved" }),
    ]);
    expect(yield* f.fs.readLink(recovery.entries[0].recoveryPath)).toBe(f.source);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
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
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect(
  "observes symlinked roots, preserves aliases, and keeps repository/global checks separate",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const index = yield* scanSkillsDirectory(
        readableSkillsDirectories(f.home.inventory, { kind: "global" }),
      );
      expect(
        codexSkillAliases(join(f.source, "SKILL.md"), join(f.source, "SKILL.md"), index),
      ).toEqual([expect.objectContaining({ path: f.alias, linkTarget: f.source, via: "symlink" })]);
      expect(
        yield* findDuplicates(
          f.home.inventory,
          { kind: "repository", root: join(f.root, "repo") },
          ["review"],
        ),
      ).toEqual([]);
      yield* f.fs.remove(join(f.root, ".codex", "skills"), { recursive: true });
      yield* f.fs.symlink(join(f.root, "Work", "skills"), join(f.root, ".codex", "skills"));
      const rooted = yield* findDuplicates(f.home.inventory, { kind: "global" }, ["review"]);
      expect(rooted[0].aliases[0]).toMatchObject({
        path: f.alias,
        via: "symlink",
        linkPath: join(f.root, ".codex", "skills"),
      });
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
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
            manageSetupCopies(
              { bindings: f.home.bindings },
              observed,
              [{ name: "review", sourcePath: f.source }],
              "new",
            ),
          );
          expect(
            Result.isFailure(result) &&
              result.failure._tag === "SetupManageSelectionInvalid" &&
              result.failure.reason,
          ).toBe("duplicate-action-required");
          const state = yield* (yield* LibraryStore).load;
          expect(state.collections).toEqual([]);
          expect(state.global_bindings).toEqual([]);
          expect(yield* f.fs.readLink(f.alias)).toBe(f.source);
        }),
      ),
    );
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
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
            manageSetupCopies(
              { bindings: f.home.bindings },
              observed,
              [{ name: "review", sourcePath: f.source, duplicateAction: "retire-aliases" }],
              "new",
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
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
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
    const errors: DuplicateScanError[] = [];
    const duplicates = yield* findDuplicates(
      f.home.inventory,
      { kind: "global" },
      ["review"],
      errors,
    ).pipe(Effect.provideService(FileSystem.FileSystem, fs));
    expect(duplicates[0].aliases[0].path).toBe(f.alias);
    expect(errors).toEqual([expect.objectContaining({ path: unrelated })]);
    const blocked = yield* Effect.result(
      findDuplicates(f.home.inventory, { kind: "global" }, ["unrelated"]).pipe(
        Effect.provideService(FileSystem.FileSystem, fs),
      ),
    );
    expect(Result.isFailure(blocked)).toBe(true);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("does not traverse a repository linked into a skills directory", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    yield* f.fs.remove(f.alias);
    const repository = join(f.root, "repository");
    const nested = join(repository, "nested", "review");
    yield* f.fs.makeDirectory(nested, { recursive: true });
    yield* f.fs.copyFile(join(f.source, "SKILL.md"), join(nested, "SKILL.md"));
    yield* f.fs.symlink(repository, join(f.root, ".codex", "skills", "repository"));
    expect(yield* findDuplicates(f.home.inventory, { kind: "global" }, ["review"])).toEqual([]);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
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
          yield* importSource(f.source);
          const result = yield* Effect.result(
            setLibraryBindings({
              query: "review",
              all: false,
              invocation: {
                scope: { kind: "global" },
                enabled: true,
                dryRun: false,
              },
              roots: f.home.inventory,
              variantsPath: f.home.variantsPath,
              allowedDuplicateSymlinks: [
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
          expect(Result.isFailure(result) && result.failure._tag).toBe(
            "InstalledSkillWouldDuplicate",
          );
          expect((yield* (yield* LibraryStore).load).global_bindings).toEqual([]);
          expect(yield* f.fs.readLink(f.alias)).toBe(f.source);
        }),
      ),
    );
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
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
            yield* importSource(f.source);
            const store = yield* LibraryStore;
            yield* setLibraryBindings({
              query: "review",
              all: false,
              allowDuplicate: true,
              invocation: {
                scope: { kind: "global" },
                enabled: true,
                dryRun: false,
              },
              roots: f.home.inventory,
              variantsPath: f.home.variantsPath,
            });
            const state = yield* store.load;
            expect(state.projections.some((projection) => projection.target === "claude")).toBe(
              true,
            );
            yield* store.save(
              {
                ...state,
                projections: state.projections.map((projection) =>
                  projection.target === "claude"
                    ? { ...projection, status: "suppressed", suppression_reason: "native_delete" }
                    : projection,
                ),
              },
              state,
            );
            const duplicates = yield* findDuplicates(
              { ...f.home.inventory, home: aliasHome },
              { kind: "global" },
              ["review"],
            );
            const approvedSymlinks = yield* recordDuplicateSymlinks(f.source, duplicates);
            const selection = yield* checkManageSelection(
              {
                name: "review",
                sourcePath: f.source,
                duplicateAction: "retire-aliases",
                approvedSymlinks,
              },
              {
                kind: "retirable",
                duplicates,
                aliases: approvedSymlinks.map((alias) => alias.path),
                replacesLink: false,
              },
              () => new Error("Expected retirable aliases"),
            );
            const outcome = yield* manageCopy(
              { bindings: { ...f.home.inventory, home: aliasHome } },
              selection,
              {
                kind: "existing",
                subjectId: "review",
                observedHash: yield* deterministicTreeHash(f.source),
              },
            );
            expect(outcome.recoveryDirectories).toHaveLength(1);
            expect(yield* f.fs.exists(f.alias)).toBe(false);
            expect(yield* f.fs.exists(f.destination)).toBe(true);
          }),
        ),
      );
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
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
            const applied = yield* manageSetupCopies(
              { bindings: f.home.bindings },
              observed,
              [
                { name: "review", sourcePath: f.source, duplicateAction: "retire-aliases" },
                { name: "later", sourcePath: later, duplicateAction: "retire-aliases" },
              ],
              "new",
            );
            expect(applied.warnings).toEqual([
              expect.objectContaining({
                name: "review",
                message: expect.stringContaining("have not converged"),
              }),
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
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("guided setup preserves every selected individual link in one operation", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const source = join(f.root, "Work", "skills", "later");
    const alias = join(f.root, ".codex", "skills", "later");
    yield* f.fs.makeDirectory(source, { recursive: true });
    yield* f.fs.writeFileString(
      join(source, "SKILL.md"),
      "---\nname: later\ndescription: Later skill\n---\nLater.\n",
    );
    yield* f.fs.symlink(source, alias);
    const interaction = yield* makeScriptedInteraction([["review", "later"], true]);
    yield* f.home.owned(
      writingTo(
        f.home.home,
        setupCommand({
          options: f.options,
          interactive: true,
          dryRun: false,
          manageOptions: { bindings: f.home.bindings },
        }).pipe(Effect.provide(interaction.layer)),
      ),
    );
    expect(yield* interaction.remaining).toBe(0);
    const state = yield* f.home.durable;
    expect(state.skills).toHaveLength(2);
    expect(state.global_bindings.flatMap((binding) => binding.entries)).toHaveLength(2);
    for (const path of [f.source, source])
      expect(yield* f.fs.exists(join(path, "SKILL.md"))).toBe(true);
    for (const path of [f.alias, alias]) expect(yield* f.fs.exists(path)).toBe(false);
    for (const name of ["review", "later"])
      expect(yield* f.fs.exists(join(f.root, ".agents", "skills", name, "SKILL.md"))).toBe(true);
    const operations = yield* listRecoveryOperations(f.home.home);
    expect(operations).toHaveLength(1);
    const recovery = yield* inspectRecoveryOperation(f.home.home, operations[0]);
    expect(recovery.entries.map((entry) => entry.path).sort()).toEqual([alias, f.alias].sort());
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect.each(["retain-only", "keep-both"] as const)(
  "bulk %s preserves a whole-root symlink",
  (action) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const source = join(f.root, "Work", "skills", "later");
      yield* f.fs.makeDirectory(source, { recursive: true });
      yield* f.fs.writeFileString(
        join(source, "SKILL.md"),
        "---\nname: later\ndescription: Later skill\n---\nLater.\n",
      );
      const aliasRoot = join(f.root, ".codex", "skills");
      yield* f.fs.remove(aliasRoot, { recursive: true });
      yield* f.fs.symlink(join(f.root, "Work", "skills"), aliasRoot);
      const interaction = yield* makeScriptedInteraction([["review", "later"], action, true]);
      yield* f.home.owned(
        writingTo(
          f.home.home,
          setupCommand({
            options: f.options,
            interactive: true,
            dryRun: false,
            manageOptions: { bindings: f.home.bindings },
          }).pipe(Effect.provide(interaction.layer)),
        ),
      );
      expect(yield* interaction.remaining).toBe(0);
      expect(
        (yield* f.home.durable).global_bindings.flatMap((binding) => binding.entries),
      ).toHaveLength(action === "retain-only" ? 0 : 2);
      expect(yield* f.fs.readLink(aliasRoot)).toBe(join(f.root, "Work", "skills"));
      expect(yield* f.fs.exists(f.destination)).toBe(action === "keep-both");
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("preserves selected links and equal copies automatically across add and bind", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const later = join(f.root, "Work", "skills", "later");
    yield* f.fs.makeDirectory(later, { recursive: true });
    yield* f.fs.writeFileString(
      join(later, "SKILL.md"),
      "---\nname: later\ndescription: Later skill\n---\nLater.\n",
    );
    yield* f.fs.symlink(later, join(f.root, ".codex", "skills", "later"));
    for (const name of ["ordinary-one", "ordinary-two"]) {
      const path = join(f.root, ".codex", "skills", name);
      yield* f.fs.makeDirectory(path);
      yield* f.fs.writeFileString(
        join(path, "SKILL.md"),
        `---\nname: ${name}\ndescription: Ordinary skill\n---\nOrdinary.\n`,
      );
    }
    yield* initializeLibraryMachine(f.home.home);
    yield* f.home.owned(writingTo(f.home.home, importSource(f.source)));
    const interaction = yield* makeScriptedInteraction([
      ["review", "later", "ordinary-one", "ordinary-two"],
      true,
    ]);
    yield* f.home.owned(
      writingTo(
        f.home.home,
        setupCommand({
          options: f.options,
          interactive: true,
          dryRun: false,
          manageOptions: { bindings: f.home.bindings },
        }).pipe(Effect.provide(interaction.layer)),
      ),
    );
    expect(yield* interaction.remaining).toBe(0);
    const state = yield* f.home.durable;
    expect(state.skills).toHaveLength(4);
    const enabled = new Set(
      state.global_bindings
        .flatMap((binding) => binding.entries)
        .flatMap((entry) => (entry.kind === "skill" ? [entry.skill_id] : [])),
    );
    expect(
      state.skills
        .filter((skill) => enabled.has(skill.skill_id))
        .map((skill) => skill.name)
        .sort(),
    ).toEqual(["later", "ordinary-one", "ordinary-two", "review"]);
    for (const name of ["review", "later", "ordinary-one", "ordinary-two"]) {
      expect(yield* f.fs.exists(join(f.root, ".codex", "skills", name))).toBe(false);
      expect(yield* f.fs.exists(join(f.root, ".agents", "skills", name, "SKILL.md"))).toBe(true);
    }
    const [operationId] = yield* listRecoveryOperations(f.home.home);
    const recovery = yield* inspectRecoveryOperation(f.home.home, operationId);
    expect(recovery.entries.map((entry) => [entry.name, entry.type, entry.status]).sort()).toEqual([
      ["later", "SymbolicLink", "saved"],
      ["ordinary-one", "Directory", "saved"],
      ["ordinary-two", "Directory", "saved"],
      ["review", "SymbolicLink", "saved"],
    ]);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

for (const operation of ["add", "bind"] as const) {
  it.effect.each(["added", "retargeted", "replaced", "removed", "directory"] as const)(
    `${operation} rejects %s aliases despite a freshly observed plan`,
    (change) =>
      Effect.gen(function* () {
        const f = yield* fixture();
        yield* initializeLibraryMachine(f.home.home);
        yield* f.home.owned(
          writingTo(
            f.home.home,
            Effect.gen(function* () {
              if (operation === "bind") yield* importSource(f.source);
              const setup = { ...f.options, repositoryRoots: [], persistRoots: false };
              const before = yield* (yield* LibraryStore).load;
              const observed = yield* runSetup(setup);
              const conflict = copyConflict(observed, { name: "review", sourcePath: f.source });
              if (conflict.kind !== "retirable")
                return yield* Effect.die("Expected retirable aliases");
              const approvedSymlinks = yield* recordDuplicateSymlinks(
                f.source,
                conflict.duplicates,
              );
              if (change === "added") {
                const root = join(f.root, ".codex", "skills");
                yield* f.fs.makeDirectory(root, { recursive: true });
                yield* f.fs.symlink(f.source, join(root, "review-alias"));
              } else if (change === "removed") {
                yield* f.fs.remove(f.alias);
              } else {
                // Keep the displaced inode alive so a recreated link cannot reuse its identity.
                yield* f.fs.rename(f.alias, join(f.root, "displaced-link"));
                if (change === "directory") yield* f.fs.copy(f.source, f.alias);
                else
                  yield* f.fs.symlink(
                    change === "retargeted" ? "../../Work/skills/review" : f.source,
                    f.alias,
                  );
              }
              const fresh = yield* runSetup(setup);
              const selection = {
                name: "review",
                sourcePath: f.source,
                duplicateAction: "retire-aliases" as const,
                approvedSymlinks,
              };
              const result =
                operation === "add"
                  ? yield* manageSetupCopies(
                      { bindings: f.home.bindings },
                      fresh,
                      [selection],
                      "new",
                    ).pipe(Effect.asVoid, Effect.result)
                  : yield* manageSetupCopies(
                      { bindings: f.home.bindings },
                      fresh,
                      [selection],
                      "existing",
                    ).pipe(Effect.asVoid, Effect.result);
              expect(result._tag === "Failure" && result.failure._tag).toBe("PlanIsStale");
              expect(yield* (yield* LibraryStore).load).toEqual(before);
              expect(yield* f.fs.exists(f.alias)).toBe(change !== "removed");
              expect(yield* f.fs.exists(f.destination)).toBe(false);
              expect(yield* f.fs.exists(join(f.home.home, "removed"))).toBe(false);
            }),
          ),
        );
      }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
  );
}

it.effect("duplicate decisions apply only to copies that setup can enable", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const observed = yield* f.home.owned(
      runSetup({ ...f.options, repositoryRoots: [], persistRoots: false }),
    );
    const selection = { name: "review", sourcePath: f.source };
    expect(copyConflict(observed, selection).kind).toBe("retirable");
    for (const changed of [
      { scope: "project" as const },
      { harnesses: [] },
      { git: { repository: f.root, status: "committed" as const } },
    ]) {
      const ineligible = {
        ...observed,
        instances: observed.instances.map((instance) =>
          instance.path === f.source ? { ...instance, ...changed } : instance,
        ),
      };
      expect(copyConflict(ineligible, selection).kind).toBe("none");
    }
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect("setup keeps retirement consent across its reconnect and add stages", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const later = join(f.root, "Work", "skills", "later");
    const laterAlias = join(f.root, ".codex", "skills", "later");
    const addedAlias = join(f.root, ".codex", "skills", "later-alias");
    yield* f.fs.makeDirectory(later, { recursive: true });
    yield* f.fs.writeFileString(
      join(later, "SKILL.md"),
      "---\nname: later\ndescription: Later skill\n---\nLater.\n",
    );
    yield* f.fs.symlink(later, laterAlias);
    yield* initializeLibraryMachine(f.home.home);
    yield* f.home.owned(writingTo(f.home.home, importSource(f.source)));
    const interaction = yield* makeScriptedInteraction([["review", "later"], true]);
    const result = yield* f.home.owned(
      writingTo(
        f.home.home,
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          return yield* setupCommand({
            options: f.options,
            interactive: true,
            dryRun: false,
            manageOptions: { bindings: f.home.bindings },
          }).pipe(
            Effect.provideService(Renderer, {
              ...renderer,
              withStatus: (message, operation) =>
                renderer
                  .withStatus(message, operation)
                  .pipe(
                    Effect.tap(() =>
                      typeof message === "string" && message.startsWith("Reconnecting")
                        ? f.fs.symlink(later, addedAlias).pipe(Effect.orDie)
                        : Effect.void,
                    ),
                  ),
            }),
            Effect.result,
          );
        }).pipe(Effect.provide(interaction.layer)),
      ),
    );
    expect(Result.isFailure(result) && result.failure._tag).toBe("PlanIsStale");
    // The earlier approved reconnect succeeded; the newly observed links do not authorize an add.
    expect((yield* f.home.durable).skills.map((skill) => skill.name)).toEqual(["review"]);
    expect(yield* f.fs.exists(f.alias)).toBe(false);
    expect(yield* f.fs.exists(f.destination)).toBe(true);
    expect(yield* f.fs.readLink(laterAlias)).toBe(later);
    expect(yield* f.fs.readLink(addedAlias)).toBe(later);
    expect(yield* f.fs.exists(join(f.root, ".agents", "skills", "later"))).toBe(false);
  }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);

it.effect.each(["source", "alias"] as const)(
  "managing rejects a %s changed after the check, before importing or backing up anything",
  (changed) =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* initializeLibraryMachine(f.home.home);
      yield* f.home.owned(
        Effect.gen(function* () {
          const observed = yield* runSetup({
            ...f.options,
            repositoryRoots: [],
            persistRoots: false,
          });
          const input = {
            name: "review",
            sourcePath: f.source,
            duplicateAction: "retire-aliases" as const,
          };
          const selection = yield* checkManageSelection(
            input,
            copyConflict(observed, input),
            () => new Error("Expected retirable aliases"),
          );
          const request = {
            kind: "retain" as const,
            observedHash: yield* deterministicTreeHash(f.source),
            ownership: {
              harnesses: ["codex" as const],
              machineId: observed.machineConfig.machineId,
            },
          };
          expect(yield* f.fs.exists(join(f.home.home, "state.json"))).toBe(false);
          expect(yield* f.fs.exists(f.destination)).toBe(false);
          if (changed === "source") {
            yield* f.fs.writeFileString(
              join(f.source, "SKILL.md"),
              "---\nname: review\ndescription: Changed\n---\nChanged after preparation.\n",
            );
          } else {
            // Keep the old inode alive, then replace the alias with the same target and a new identity.
            yield* f.fs.rename(f.alias, join(f.root, "displaced-alias"));
            yield* f.fs.symlink(f.source, f.alias);
          }
          const result = yield* manageCopy({ bindings: f.home.bindings }, selection, request).pipe(
            Effect.result,
          );
          expect(result._tag === "Failure" && result.failure._tag).toBe("PlanIsStale");
          expect(yield* f.fs.exists(join(f.home.home, "state.json"))).toBe(false);
          expect(yield* f.fs.exists(join(f.home.home, "originals"))).toBe(false);
          expect(yield* f.fs.exists(join(f.home.home, "removed"))).toBe(false);
          expect(yield* f.fs.exists(f.destination)).toBe(false);
          expect(yield* f.fs.readLink(f.alias)).toBe(f.source);
        }),
      );
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
