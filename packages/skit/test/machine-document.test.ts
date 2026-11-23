import { Effect, FileSystem } from "effect";
import { assert, it } from "@effect/vitest";
import * as MachineSettings from "../src/library/machine-settings.js";
import { LegacyMachineId, makeMachineId, migratedMachineId } from "../src/library/entity-ids.js";
import { loadMachineFile } from "../src/library/store/machine-file.js";
import { skitLayer } from "../src/platform/layer.js";

import { join } from "node:path";

const legacyMachineId = LegacyMachineId.make("018f47de-6c9a-7b21-8000-000000000001");

const decode = (document: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-machine-document-" });
    const path = join(home, "machine.json");
    yield* fs.writeFileString(path, JSON.stringify(document));
    return yield* loadMachineFile(path);
  }).pipe(Effect.provide(skitLayer), Effect.scoped);

it.effect("normalizes every persisted machine document version to one current shape", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* decode({ schemaVersion: 1, repositoryRoots: ["/v1"] }), {
      schemaVersion: 5,
      discoveryRoots: ["/v1"],
      repositories: [],
      repositoryDecisionsInitialized: false,
    });

    assert.deepStrictEqual(
      yield* decode({
        schemaVersion: 2,
        machineId: legacyMachineId,
        displayName: "legacy",
        repositoryRoots: ["/v2"],
      }),
      {
        schemaVersion: 5,
        machineId: migratedMachineId(legacyMachineId, legacyMachineId),
        legacyMachineId,
        displayName: "legacy",
        discoveryRoots: ["/v2"],
        repositories: [],
        repositoryDecisionsInitialized: false,
      },
    );

    const machineId = makeMachineId();
    assert.deepStrictEqual(
      yield* decode({
        schemaVersion: 3,
        machineId,
        displayName: "prior",
        repositoryRoots: ["/v3"],
      }),
      {
        schemaVersion: 5,
        machineId,
        displayName: "prior",
        discoveryRoots: ["/v3"],
        repositories: [],
        repositoryDecisionsInitialized: false,
      },
    );

    const current = {
      schemaVersion: 4,
      machineId,
      displayName: "current",
      discoveryRoots: ["/v4"],
      repositories: [{ path: "/v4/repo", status: "watched" }],
    } as const;
    assert.deepStrictEqual(yield* decode(current), {
      ...current,
      schemaVersion: 5,
      repositoryDecisionsInitialized: true,
    });
  }),
);

for (const initialized of [false, true]) {
  it.effect(`v5 preserves explicit repository decision initialization: ${initialized}`, () =>
    Effect.gen(function* () {
      const document = {
        schemaVersion: 5,
        machineId: makeMachineId(),
        displayName: "Current machine",
        discoveryRoots: ["/projects"],
        repositories: [],
        repositoryDecisionsInitialized: initialized,
      } as const;
      assert.deepStrictEqual(yield* decode(document), {
        ...document,
        schemaVersion: 5,
      });
    }),
  );
}

it.effect("refuses unreleased v6 settings without rewriting them", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-machine-v6-" });
    const path = join(home, "machine.json");
    const bytes = JSON.stringify({
      schemaVersion: 6,
      machineId: makeMachineId(),
      displayName: "Unreleased",
      discoveryRoots: [],
      repositories: [],
      repositoryDecisionsInitialized: false,
      setups: [],
      undoneSetups: [],
    });
    yield* fs.writeFileString(path, bytes);
    const failure = yield* Effect.flip(MachineSettings.read(home));
    assert.strictEqual(failure._tag, "MachineSettingsUnusable");
    if (failure._tag === "MachineSettingsUnusable")
      assert.deepStrictEqual(failure.reason, {
        _tag: "UnsupportedVersion",
        version: 6,
        supported: [1, 2, 3, 4, 5],
      });
    assert.strictEqual(yield* fs.readFileString(path), bytes);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
