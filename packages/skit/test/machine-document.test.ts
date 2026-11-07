import { Effect, FileSystem, Schema } from "effect";
import { assert, it } from "@effect/vitest";
import * as MachineSettings from "../src/library/machine-settings.js";
import {
  LegacyMachineId,
  makeMachineId,
  makeOperationId,
  migratedMachineId,
} from "../src/library/entity-ids.js";
import { MachineDocumentJson } from "../src/library/machine-document.js";
import { skitLayer } from "../src/platform/layer.js";

import { join } from "node:path";

const legacyMachineId = LegacyMachineId.make("018f47de-6c9a-7b21-8000-000000000001");

const decode = (document: unknown) =>
  Schema.decodeEffect(MachineDocumentJson)(JSON.stringify(document));

it.effect("normalizes every persisted machine document version to one current shape", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* decode({ schemaVersion: 1, repositoryRoots: ["/v1"] }), {
      schemaVersion: 6,
      discoveryRoots: ["/v1"],
      repositories: [],
      repositoryDecisionsInitialized: false,
      setups: [],
      undoneSetups: [],
    });

    assert.deepStrictEqual(
      yield* decode({
        schemaVersion: 2,
        machineId: legacyMachineId,
        displayName: "legacy",
        repositoryRoots: ["/v2"],
      }),
      {
        schemaVersion: 6,
        machineId: migratedMachineId(legacyMachineId, legacyMachineId),
        legacyMachineId,
        displayName: "legacy",
        discoveryRoots: ["/v2"],
        repositories: [],
        repositoryDecisionsInitialized: false,
        setups: [],
        undoneSetups: [],
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
        schemaVersion: 6,
        machineId,
        displayName: "prior",
        discoveryRoots: ["/v3"],
        repositories: [],
        repositoryDecisionsInitialized: false,
        setups: [],
        undoneSetups: [],
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
      schemaVersion: 6,
      repositoryDecisionsInitialized: true,
      setups: [],
      undoneSetups: [],
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
        schemaVersion: 6,
        setups: [],
        undoneSetups: [],
      });
    }),
  );
}

it.effect("current setup evidence reads without rewriting and records its inverse", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "skit-machine-v6-" });
    const operationId = makeOperationId();
    const machineId = makeMachineId();
    const document = {
      schemaVersion: 6,
      undoneSetups: [],
      machineId,
      displayName: "Current machine",
      discoveryRoots: ["/after"],
      repositories: [],
      repositoryDecisionsInitialized: true,
      setups: [
        {
          operationId,
          before: { discoveryRoots: ["/before"], machineId },
          expectedAfter: { discoveryRoots: ["/after"], machineId },
        },
      ],
    };
    const path = join(home, "machine.json");
    const bytes = JSON.stringify(document);
    yield* fs.writeFileString(path, bytes);
    const settings = yield* MachineSettings.read(home);
    assert.deepStrictEqual(settings.setups, document.setups);
    assert.deepStrictEqual(settings.undoneSetups, []);
    assert.strictEqual(yield* fs.readFileString(path), bytes);
    const plan = yield* MachineSettings.planRestoreDiscovery(home, operationId);
    yield* MachineSettings.applyRestoreDiscovery(home, plan);
    const saved = JSON.parse(yield* fs.readFileString(path));
    assert.strictEqual(saved.schemaVersion, 6);
    assert.deepStrictEqual(saved.discoveryRoots, ["/before"]);
    assert.deepStrictEqual(saved.undoneSetups, [operationId]);
  }).pipe(Effect.provide(skitLayer), Effect.scoped),
);
