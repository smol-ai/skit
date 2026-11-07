import { systemError } from "effect/PlatformError";
import { hostname } from "node:os";
import { assert, it } from "@effect/vitest";
import { Effect, FileSystem, Option } from "effect";
import { join } from "node:path";
import * as MachineSettings from "../src/library/machine-settings.js";
import {
  LegacyMachineId,
  makeMachineId,
  makeOperationId,
  migratedMachineId,
} from "../src/library/entity-ids.js";
import { withLock as withHomeLock } from "../src/platform/home-lock.js";
import { skitLayer } from "../src/platform/layer.js";
import { lockFile } from "../src/platform/file-lock.js";

it.effect("reading missing settings creates no files or directories", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-read-" });
    const home = join(root, "missing");
    const settings = yield* MachineSettings.read(home);
    assert.strictEqual(settings.machineId, undefined);
    assert.deepStrictEqual(settings.discoveryRoots, []);
    assert.deepStrictEqual(settings.repositories, []);
    assert.strictEqual(settings.repositoryDecisionsInitialized, false);
    assert.strictEqual(yield* fs.exists(home), false);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const version of [1, 2, 3] as const) {
  it.effect(`reads v${version} without writing, preserving its identity and discovery roots`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-legacy-" });
      const legacyId = LegacyMachineId.make("018f47de-6c9a-7b21-8000-000000000001");
      const machineId = makeMachineId();
      const document =
        version === 1
          ? { schemaVersion: 1, repositoryRoots: ["/saved"] }
          : {
              schemaVersion: version,
              machineId: version === 2 ? legacyId : machineId,
              displayName: "Existing name",
              repositoryRoots: ["/saved"],
            };
      const path = join(home, "machine.json");
      const bytes = JSON.stringify(document);
      yield* fs.writeFileString(path, bytes);
      const settings = yield* MachineSettings.read(home);
      assert.deepStrictEqual(settings.discoveryRoots, ["/saved"]);
      assert.strictEqual(settings.repositoryDecisionsInitialized, false);
      assert.strictEqual(yield* fs.readFileString(path), bytes);
      const identity = yield* MachineSettings.ensureIdentity(home);
      if (version !== 1) {
        assert.strictEqual(
          identity,
          version === 2 ? migratedMachineId(legacyId, legacyId) : machineId,
        );
        assert.strictEqual(yield* fs.readFileString(path), bytes);
      }
      const identified = yield* MachineSettings.read(home);
      assert.strictEqual(identified.repositoryDecisionsInitialized, false);
      assert.deepStrictEqual(identified.discoveryRoots, ["/saved"]);
      assert.deepStrictEqual(identified.repositories, []);
      yield* MachineSettings.setRepositoryDecision(home, "/repo", "watched");
      const updated = yield* MachineSettings.read(home);
      assert.strictEqual(JSON.parse(yield* fs.readFileString(path)).schemaVersion, 6);
      assert.strictEqual(updated.machineId, identity);
      assert.strictEqual(updated.displayName, version === 1 ? hostname() : "Existing name");
      assert.deepStrictEqual(updated.discoveryRoots, ["/saved"]);
      assert.deepStrictEqual(updated.repositories, [{ path: "/repo", status: "watched" }]);
      assert.strictEqual(updated.repositoryDecisionsInitialized, true);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
}

it.effect(
  "serializes settings changes sharing a writer, without opening Library state or history",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-concurrent-" });
      // Configuration remains usable even if Library metadata is corrupt.
      const corruptState = "not a Library document\n";
      yield* fs.writeFileString(join(home, "state.json"), corruptState);
      const [identity, discovery, repository] = yield* withHomeLock(
        home,
        Effect.all(
          [
            MachineSettings.ensureIdentity(home),
            MachineSettings.updateDiscovery(home, {
              discoveryRoots: ["/second", "/first", "/second"],
              repositories: [{ path: "/one", status: "watched" }],
              displayName: "Discovery name",
            }),
            MachineSettings.setRepositoryDecision(home, "/two", "ignored"),
          ],
          { concurrency: "unbounded" },
        ),
      );
      const final = yield* MachineSettings.read(home);
      assert.strictEqual(discovery.machineId, identity);
      assert.strictEqual(repository.machineId, identity);
      assert.strictEqual(final.machineId, identity);
      assert.deepStrictEqual(final.discoveryRoots, ["/first", "/second"]);
      assert.deepStrictEqual(final.repositories, [
        { path: "/one", status: "watched" },
        { path: "/two", status: "ignored" },
      ]);
      yield* MachineSettings.updateDiscovery(home, { displayName: "Another name" });
      assert.deepStrictEqual(
        (yield* MachineSettings.read(home)).discoveryRoots,
        final.discoveryRoots,
      );
      assert.deepStrictEqual((yield* MachineSettings.read(home)).repositories, final.repositories);
      yield* MachineSettings.setRepositoryDecision(home, "/one", undefined);
      assert.deepStrictEqual((yield* MachineSettings.read(home)).repositories, [
        { path: "/two", status: "ignored" },
      ]);
      assert.strictEqual(yield* fs.readFileString(join(home, "state.json")), corruptState);
      assert.strictEqual(yield* fs.exists(join(home, "audit.jsonl")), false);
      assert.isTrue(yield* Effect.isSuccess(Effect.scoped(lockFile(join(home, "lock.sqlite")))));
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("refuses an occupied root lock before replacing settings", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-locked-" });
    yield* MachineSettings.ensureIdentity(home);
    const path = join(home, "machine.json");
    const before = yield* fs.readFileString(path);
    // Another holder, as another process would be.
    yield* lockFile(join(home, "lock.sqlite"));
    const error = yield* MachineSettings.setRepositoryDecision(home, "/repo", "ignored").pipe(
      Effect.flip,
    );
    assert.strictEqual(error._tag, "HomeBusy");
    assert.strictEqual(yield* fs.readFileString(path), before);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

for (const content of ["invalid JSON", JSON.stringify({ schemaVersion: 99 })]) {
  it.effect(`refuses to replace invalid or unsupported settings: ${content}`, () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-invalid-" });
      const path = join(home, "machine.json");
      yield* fs.writeFileString(path, content);
      const error = yield* MachineSettings.ensureIdentity(home).pipe(Effect.flip);
      assert.strictEqual(error._tag, "MachineSettingsUnusable");
      assert.strictEqual(yield* fs.readFileString(path), content);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
  );
}

it.effect("does not interpret an unreadable document as missing settings", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-unreadable-" });
    const path = join(home, "machine.json");
    yield* fs.makeDirectory(path);
    const error = yield* MachineSettings.ensureIdentity(home).pipe(Effect.flip);
    assert.strictEqual(error._tag, "MachineSettingsUnusable");
    assert.strictEqual((yield* fs.stat(path)).type, "Directory");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("explicit names override a saved default and survive later unnamed mutations", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-name-" });
    const identity = yield* MachineSettings.ensureIdentity(home);
    assert.strictEqual((yield* MachineSettings.read(home)).displayName, hostname());
    yield* MachineSettings.updateDiscovery(home, { displayName: "My workstation" });
    yield* MachineSettings.setRepositoryDecision(home, "/repo", "watched");
    yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/projects"] });
    yield* MachineSettings.ensureIdentity(home);
    const settings = yield* MachineSettings.read(home);
    assert.strictEqual(settings.machineId, identity);
    assert.strictEqual(settings.displayName, "My workstation");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("v4 reads stay read-only and preserve an initialized empty repository selection", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-v4-" });
    const path = join(home, "machine.json");
    const machineId = makeMachineId();
    const bytes = JSON.stringify({
      schemaVersion: 4,
      machineId,
      displayName: "Saved machine",
      discoveryRoots: ["/projects"],
      repositories: [],
    });
    yield* fs.writeFileString(path, bytes);
    assert.strictEqual(yield* MachineSettings.ensureIdentity(home), machineId);
    assert.strictEqual(yield* fs.readFileString(path), bytes);
    const prior = yield* MachineSettings.read(home);
    assert.strictEqual(prior.repositoryDecisionsInitialized, true);
    yield* MachineSettings.updateDiscovery(home, { displayName: "Renamed machine" });
    const updated = yield* MachineSettings.read(home);
    assert.strictEqual(updated.machineId, machineId);
    assert.strictEqual(updated.repositoryDecisionsInitialized, true);
    assert.deepStrictEqual(updated.discoveryRoots, ["/projects"]);
    assert.deepStrictEqual(updated.repositories, []);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

// Non-interactive `skit setup --work-dir` saves a root without deciding about any repository. If
// that marked decisions initialized, inventory would inspect only watched repositories: none.
it.effect("saving discovery roots alone leaves repository decisions undecided", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-machine-roots-" });
    yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/work"] });
    assert.strictEqual((yield* MachineSettings.read(home)).repositoryDecisionsInitialized, false);
    yield* MachineSettings.updateDiscovery(home, {
      repositories: [{ path: "/work/app", status: "watched" }],
    });
    assert.strictEqual((yield* MachineSettings.read(home)).repositoryDecisionsInitialized, true);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("saves no settings when pre-save inverse evidence fails", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-evidence-" });
    yield* MachineSettings.updateDiscovery(home, {
      discoveryRoots: ["/before"],
      displayName: "Prior name",
    });
    const path = join(home, "machine.json");
    const bytes = yield* fs.readFileString(path);
    const failure = yield* Effect.flip(
      MachineSettings.updateDiscovery(home, { discoveryRoots: ["/after"] }, (before, after) =>
        Effect.gen(function* () {
          assert.deepStrictEqual(before.discoveryRoots, ["/before"]);
          assert.deepStrictEqual(after.discoveryRoots, ["/after"]);
          assert.strictEqual(yield* fs.readFileString(path), bytes);
          return yield* Effect.fail("inverse-refused");
        }),
      ),
    );
    assert.strictEqual(failure, "inverse-refused");
    assert.strictEqual(yield* fs.readFileString(path), bytes);
    assert.isTrue(yield* Effect.isSuccess(Effect.scoped(lockFile(join(home, "lock.sqlite")))));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "evidence callbacks cannot redirect validated settings and inverse writes guard the reviewed settings",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-inverse-" });
      const before = yield* MachineSettings.updateDiscovery(home, {
        discoveryRoots: ["/before"],
        repositories: [{ path: "/original", status: "watched" }],
        displayName: "Original name",
      });
      const after = yield* MachineSettings.updateDiscovery(
        home,
        { discoveryRoots: ["/after"] },
        (_prior, next) =>
          Effect.sync(() => {
            // Callback inputs are evidence copies, not writable references to the publication.
            Object.assign(next, { discoveryRoots: [], path: join(home, "redirected.json") });
          }),
      );
      assert.deepStrictEqual(after.discoveryRoots, ["/after"]);
      const restored = yield* MachineSettings.restoreDiscovery(home, after, before);
      assert.deepStrictEqual(restored.discoveryRoots, ["/before"]);
      assert.strictEqual(restored.machineId, before.machineId);
      assert.deepStrictEqual(restored.repositories, [{ path: "/original", status: "watched" }]);
      yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/newer"] });
      const stale = yield* Effect.flip(MachineSettings.restoreDiscovery(home, after, before));
      assert.strictEqual(stale._tag, "LibraryChanged");
      assert.deepStrictEqual((yield* MachineSettings.read(home)).discoveryRoots, ["/newer"]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a setup's discovery save records what it replaced, keyed by the setup", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-setup-record-" });
    const machineId = yield* MachineSettings.ensureIdentity(home);
    yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/before"] });
    const operationId = makeOperationId();

    const saved = yield* MachineSettings.updateDiscovery(
      home,
      { discoveryRoots: ["/after"] },
      undefined,
      operationId,
    );

    assert.deepStrictEqual(saved.discoveryRoots, ["/after"]);
    assert.deepStrictEqual(
      yield* MachineSettings.setupRecord(home, operationId),
      Option.some({
        operationId,
        before: { discoveryRoots: ["/before"], machineId },
        expectedAfter: { discoveryRoots: ["/after"], machineId },
      }),
    );
    assert.isTrue(Option.isNone(yield* MachineSettings.setupRecord(home, makeOperationId())));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("restoring a setup's discovery folders keeps the identity, name and repositories", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-setup-restore-" });
    yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/before"] });
    const operationId = makeOperationId();
    yield* MachineSettings.updateDiscovery(
      home,
      {
        discoveryRoots: ["/after"],
        repositories: [{ path: "/after/repo", status: "watched" }],
        displayName: "Renamed by setup",
      },
      undefined,
      operationId,
    );
    const after = yield* MachineSettings.read(home);

    assert.strictEqual(yield* MachineSettings.restoreSetupDiscovery(home, operationId), "restored");
    const restored = yield* MachineSettings.read(home);
    assert.deepStrictEqual(restored, {
      ...after,
      discoveryRoots: ["/before"],
      undoneSetups: [operationId],
    });
    // Restoring again finds it already restored and writes nothing.
    const bytes = yield* fs.readFileString(join(home, "machine.json"));
    assert.strictEqual(
      yield* MachineSettings.restoreSetupDiscovery(home, operationId),
      "unchanged",
    );
    assert.strictEqual(yield* fs.readFileString(join(home, "machine.json")), bytes);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("restoring refuses discovery folders changed since the setup, and a later setup's", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-setup-refuse-" });
    const first = makeOperationId();
    yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/first"] }, undefined, first);
    yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/edited"] });

    const changed = yield* Effect.flip(MachineSettings.restoreSetupDiscovery(home, first));
    assert.strictEqual(changed._tag, "LibraryChanged");
    assert.deepStrictEqual((yield* MachineSettings.read(home)).discoveryRoots, ["/edited"]);

    const second = makeOperationId();
    yield* MachineSettings.updateDiscovery(
      home,
      { discoveryRoots: ["/second"] },
      undefined,
      second,
    );
    const replaced = yield* Effect.flip(MachineSettings.restoreSetupDiscovery(home, first));
    assert.strictEqual(replaced._tag, "MachineSettings.SetupNotRecorded");
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("v5 settings read without writing and with no setup records", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-v5-" });
    const text = JSON.stringify({
      schemaVersion: 5,
      machineId: makeMachineId(),
      displayName: "Current machine",
      discoveryRoots: ["/projects"],
      repositories: [],
      repositoryDecisionsInitialized: true,
    });
    yield* fs.writeFileString(join(home, "machine.json"), text);

    assert.deepStrictEqual((yield* MachineSettings.read(home)).setups, []);
    assert.strictEqual(yield* fs.readFileString(join(home, "machine.json")), text);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a discovery undo preview is passive and missing settings stay absent", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-undo-preview-" });
    const home = join(root, "absent");
    const plan = yield* MachineSettings.planRestoreDiscovery(home, makeOperationId());
    assert.isFalse(plan.changed);
    assert.isFalse(plan.recorded);
    assert.deepStrictEqual(plan.conflicts, []);
    assert.isFalse(yield* fs.exists(home));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a completed discovery inverse cannot later undo independent roots again", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-undo-complete-" });
    yield* MachineSettings.updateDiscovery(home, { discoveryRoots: ["/before"] });
    const operationId = makeOperationId();
    yield* MachineSettings.updateDiscovery(
      home,
      { discoveryRoots: ["/after"] },
      undefined,
      operationId,
    );
    const before = yield* MachineSettings.read(home);
    const plan = yield* MachineSettings.planRestoreDiscovery(home, operationId);
    assert.isTrue(plan.changed);
    assert.strictEqual(yield* MachineSettings.applyRestoreDiscovery(home, plan), "restored");
    const restored = yield* MachineSettings.read(home);
    assert.deepStrictEqual(restored.discoveryRoots, ["/before"]);
    assert.deepStrictEqual(restored.undoneSetups, [operationId]);
    assert.strictEqual(restored.machineId, before.machineId);
    // A later edit may deliberately reuse the same roots the setup had chosen.
    yield* MachineSettings.updateDiscovery(home, {
      discoveryRoots: ["/after"],
      repositories: [{ path: "/independent", status: "watched" }],
    });
    const bytes = yield* fs.readFileString(join(home, "machine.json"));
    const repeated = yield* MachineSettings.planRestoreDiscovery(home, operationId);
    assert.isFalse(repeated.changed);
    assert.strictEqual(yield* MachineSettings.applyRestoreDiscovery(home, repeated), "unchanged");
    assert.strictEqual(yield* fs.readFileString(join(home, "machine.json")), bytes);
    assert.isFalse(yield* fs.exists(join(home, "state.json")));
    assert.isFalse(yield* fs.exists(join(home, "audit.jsonl")));
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect("a discovery inverse refuses stale or edited review data before publication", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-undo-stale-" });
    const operationId = makeOperationId();
    yield* MachineSettings.updateDiscovery(
      home,
      { discoveryRoots: ["/after"] },
      undefined,
      operationId,
    );
    const plan = yield* MachineSettings.planRestoreDiscovery(home, operationId);
    const path = join(home, "machine.json");
    const bytes = yield* fs.readFileString(path);
    const forged = { ...plan, after: { ...plan.after, discoveryRoots: ["/unreviewed"] } };
    assert.strictEqual(
      (yield* Effect.flip(MachineSettings.applyRestoreDiscovery(home, forged)))._tag,
      "LibraryChanged",
    );
    assert.strictEqual(yield* fs.readFileString(path), bytes);
    yield* MachineSettings.setRepositoryDecision(home, "/later", "watched");
    const edited = yield* fs.readFileString(path);
    assert.strictEqual(
      (yield* Effect.flip(MachineSettings.applyRestoreDiscovery(home, plan)))._tag,
      "LibraryChanged",
    );
    assert.strictEqual(yield* fs.readFileString(path), edited);
    const refreshed = yield* MachineSettings.planRestoreDiscovery(home, operationId);
    yield* MachineSettings.applyRestoreDiscovery(home, refreshed);
    assert.deepStrictEqual((yield* MachineSettings.read(home)).repositories, [
      { path: "/later", status: "watched" },
    ]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);

it.effect(
  "a failed discovery inverse publication keeps its completion unrecorded and retryable",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-settings-undo-failure-" });
      const operationId = makeOperationId();
      yield* MachineSettings.updateDiscovery(
        home,
        { discoveryRoots: ["/after"] },
        undefined,
        operationId,
      );
      const plan = yield* MachineSettings.planRestoreDiscovery(home, operationId);
      const path = join(home, "machine.json");
      const bytes = yield* fs.readFileString(path);
      const failure = yield* MachineSettings.applyRestoreDiscovery(home, plan).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: (from, to) =>
            to === path
              ? Effect.fail(
                  systemError({
                    _tag: "PermissionDenied",
                    module: "FileSystem",
                    method: "rename",
                    pathOrDescriptor: to,
                  }),
                )
              : fs.rename(from, to),
        }),
        Effect.flip,
      );
      assert.strictEqual(failure._tag, "PlatformError");
      assert.strictEqual(yield* fs.readFileString(path), bytes);
      assert.deepStrictEqual((yield* MachineSettings.read(home)).undoneSetups, []);
      yield* MachineSettings.applyRestoreDiscovery(home, plan);
      assert.deepStrictEqual((yield* MachineSettings.read(home)).undoneSetups, [operationId]);
    }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
