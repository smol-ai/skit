import { basename, join } from "node:path";
import { Effect, FileSystem } from "effect";
import { systemError } from "effect/PlatformError";
import { it } from "@effect/vitest";
import { expect } from "vitest";
import {
  LinkStat,
  LibraryStore,
  libraryStateRevision,
  MachineSettings,
  skitLayer,
} from "@smolai/skit-core";
import { inspectSetupOperation } from "../src/library-application/setup-operation.js";
import {
  inspectRecoveryOperation,
  listRecoveryOperations,
} from "../src/library-application/recovery-moves.js";
import { setupApplyCommand } from "../src/handlers/library/setup-machine.js";
import { runSetup } from "../src/workflows/library/setup.js";
import { makeScriptedInteraction } from "../src/presentation/interaction-recorder.js";
import { libraryHome, scratch } from "./helpers/library-home.js";

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
  const observed = yield* home.owned(runSetup({ ...options, persistRoots: false }));
  const interaction = yield* makeScriptedInteraction([]);
  const apply = setupApplyCommand({
    options,
    localCustody: { bindings: home.bindings },
    planId: observed.onboarding.planId,
  }).pipe(Effect.provide(interaction.layer));
  return { fs, root, source, home, apply };
});
const refuse = (path: string) =>
  Effect.fail(
    systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "link",
      pathOrDescriptor: path,
    }),
  );

it.effect(
  "real setup persists each typed inverse before publication and captures original file custody",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const links = yield* LinkStat;
      let settingsChecked = false;
      let publications = 0;
      const applied = yield* f.home.owned(
        f.apply.pipe(
          Effect.provideServiceEffect(
            LibraryStore,
            Effect.map(LibraryStore, (store) => ({
              ...store,
              publish: (next, base) =>
                Effect.gen(function* () {
                  yield* Effect.gen(function* () {
                    const [id] = yield* listRecoveryOperations(f.home.home);
                    const saved = yield* inspectSetupOperation(f.home.home, id);
                    const last = saved.changes.at(-1);
                    expect(last?.published).toBe(false);
                    if (last?.change.kind !== "library")
                      return yield* Effect.die(
                        new Error("Missing pre-publication Library inverse"),
                      );
                    expect(last.change.beforeRevision).toBe(libraryStateRevision(base));
                    expect(last.change.afterRevision).toBe(libraryStateRevision(next));
                    expect(libraryStateRevision(yield* store.load)).toBe(
                      libraryStateRevision(base),
                    );
                    publications++;
                  }).pipe(
                    Effect.provideService(FileSystem.FileSystem, f.fs),
                    Effect.provideService(LinkStat, links),
                    Effect.orDie,
                  );
                  yield* store.publish(next, base);
                }),
            })),
          ),
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            rename: (from, to) =>
              Effect.gen(function* () {
                if (basename(to) === "machine.json") {
                  yield* Effect.gen(function* () {
                    const [id] = yield* listRecoveryOperations(f.home.home);
                    const saved = yield* inspectSetupOperation(f.home.home, id);
                    expect(saved.changes[0].change.kind).toBe("settings");
                    expect(saved.changes[0].published).toBe(false);
                    expect(yield* f.fs.exists(to)).toBe(false);
                    settingsChecked = true;
                  }).pipe(
                    Effect.provideService(FileSystem.FileSystem, f.fs),
                    Effect.provideService(LinkStat, links),
                    Effect.orDie,
                  );
                }
                yield* f.fs.rename(from, to);
              }),
          }),
        ),
      );
      expect(settingsChecked).toBe(true);
      expect(publications).toBeGreaterThan(1);
      if (!applied.operationId)
        return yield* Effect.die(new Error("Missing setup operation identity"));
      const saved = yield* inspectSetupOperation(f.home.home, applied.operationId);
      expect(saved.changes.every((entry) => entry.published)).toBe(true);
      expect(saved.complete).toBeDefined();
      expect(saved.operation.before.global).toEqual([]);
      expect(saved.operation.files.find((entry) => entry.path === f.source)?.entry?.marker).toBe(
        null,
      );
      expect(
        saved.operation.files.find((entry) => entry.path === join(f.root, "claude", "review"))
          ?.entry,
      ).toBe(null);
      expect(saved.complete?.intent.global[0].entries).toHaveLength(1);
      expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toContain("Original bytes");
      expect((yield* inspectRecoveryOperation(f.home.home, applied.operationId)).entries).toEqual(
        [],
      );
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("a refused inverse receipt prevents the settings and Library effects it describes", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    const failure = yield* Effect.flip(
      f.home.owned(
        f.apply.pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...f.fs,
            link: (from, to) =>
              to.endsWith("changes/00000001.json") ? refuse(to) : f.fs.link(from, to),
          }),
        ),
      ),
    );
    expect(failure._tag).toBe("PlatformError");
    expect(yield* f.fs.exists(join(f.home.home, "machine.json"))).toBe(false);
    expect(yield* f.fs.exists(join(f.home.home, "state.json"))).toBe(false);
    expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toContain("Original bytes");
    const [id] = yield* listRecoveryOperations(f.home.home);
    const saved = yield* inspectSetupOperation(f.home.home, id);
    expect(saved.changes).toEqual([]);
    expect(saved.complete).toBeUndefined();
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "a lost publication acknowledgement leaves an explicit uncertain step and all retained bytes",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const failure = yield* Effect.flip(
        f.home.owned(
          f.apply.pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...f.fs,
              link: (from, to) =>
                to.endsWith("changes/00000002.published.json") ? refuse(to) : f.fs.link(from, to),
            }),
          ),
        ),
      );
      expect(failure._tag).toBe("PlatformError");
      const [id] = yield* listRecoveryOperations(f.home.home);
      const saved = yield* inspectSetupOperation(f.home.home, id);
      expect(saved.complete).toBeUndefined();
      expect(saved.changes.map((entry) => entry.published)).toEqual([true, false]);
      const last = saved.changes.at(-1);
      if (last?.change.kind !== "library")
        return yield* Effect.die(new Error("Expected an uncertain Library publication"));
      expect(libraryStateRevision(yield* f.home.durable)).toBe(last.change.afterRevision);
      expect((yield* f.home.durable).skills.map((skill) => skill.name)).toEqual(["review"]);
      expect((yield* f.home.durable).global_bindings).toEqual([]);
      expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toContain("Original bytes");
    }).pipe(Effect.provide(skitLayer)),
);

it.effect("completion never claims a later machine decision as a setup-owned effect", () =>
  Effect.gen(function* () {
    const f = yield* fixture();
    let changed = false;
    const applied = yield* f.home.owned(
      f.apply.pipe(
        Effect.provideServiceEffect(
          LibraryStore,
          Effect.map(LibraryStore, (store) => ({
            ...store,
            publish: (next, base) =>
              Effect.gen(function* () {
                yield* store.publish(next, base);
                if (!changed) {
                  changed = true;
                  yield* MachineSettings.setRepositoryDecision(
                    f.home.home,
                    "/later/repository",
                    "watched",
                  ).pipe(Effect.provideService(FileSystem.FileSystem, f.fs), Effect.orDie);
                }
              }),
          })),
        ),
      ),
    );
    if (!applied.operationId) return yield* Effect.die(new Error("Missing operation"));
    const saved = yield* inspectSetupOperation(f.home.home, applied.operationId);
    expect(saved.complete?.settings.repositories).toEqual([]);
    expect((yield* MachineSettings.read(f.home.home)).repositories).toEqual([
      { path: "/later/repository", status: "watched" },
    ]);
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "interruption after inverse intent publication is inspectable without applying the described settings",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const exit = yield* Effect.exit(
        f.home.owned(
          f.apply.pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...f.fs,
              link: (from, to) =>
                f.fs
                  .link(from, to)
                  .pipe(
                    Effect.andThen(
                      to.endsWith("changes/00000001.json") ? Effect.interrupt : Effect.void,
                    ),
                  ),
            }),
          ),
        ),
      );
      expect(exit._tag).toBe("Failure");
      const [id] = yield* listRecoveryOperations(f.home.home);
      const saved = yield* inspectSetupOperation(f.home.home, id);
      expect(saved.changes.map((entry) => entry.published)).toEqual([false]);
      expect(saved.changes[0].change.kind).toBe("settings");
      expect(saved.complete).toBeUndefined();
      expect((yield* MachineSettings.read(f.home.home)).machineId).toBeUndefined();
      expect(yield* f.fs.exists(join(f.home.home, "state.json"))).toBe(false);
      expect(yield* f.fs.exists(join(f.home.home, ".lock"))).toBe(false);
      expect(yield* f.fs.readFileString(join(f.source, "SKILL.md"))).toContain("Original bytes");
    }).pipe(Effect.provide(skitLayer)),
);
