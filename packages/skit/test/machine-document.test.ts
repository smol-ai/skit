import { Effect, Schema } from "effect";
import { assert, it } from "@effect/vitest";
import {
  LegacyMachineId,
  MachineDocumentJson,
  makeMachineId,
  migratedMachineId,
} from "../src/index.js";

const legacyMachineId = LegacyMachineId.make("018f47de-6c9a-7b21-8000-000000000001");

const decode = (document: unknown) =>
  Schema.decodeUnknownEffect(MachineDocumentJson)(JSON.stringify(document));

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
      assert.deepStrictEqual(yield* decode(document), document);
    }),
  );
}
