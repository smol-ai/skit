import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { makeCollectionId, makeSkillId } from "@smolai/skit-core/universal/consumer";
import { SyncConflicted } from "@smolai/skit-core/library/sync";
import { result } from "../src/commands/result.js";
import { renderResultFrame, defaultTerminalEnvironment } from "../src/commands/output-frame.js";
import { devices } from "./helpers/library-sync-devices.js";
import { testPlatformLayer } from "./helpers/platform.js";
import { captureDisk, assertDiskUnchanged } from "./helpers/disk-snapshot.js";

it.effect(
  "invalid merged paths stop sync before local or Registry writes and remain precise in command output",
  () =>
    Effect.gen(function* () {
      const { a, b, remote, events } = yield* devices;
      const collectionId = makeCollectionId();
      yield* a.edit((state) => ({
        ...state,
        collections: [{ collection_id: collectionId, label: "review-tools" }],
      }));
      yield* a.sync();
      yield* b.sync();
      yield* a.edit((state) => ({
        ...state,
        skills: [
          {
            skill_id: makeSkillId(),
            collection_id: collectionId,
            path: "review",
            name: "review",
            versions: [],
          },
        ],
      }));
      yield* b.edit((state) => ({
        ...state,
        skills: [
          {
            skill_id: makeSkillId(),
            collection_id: collectionId,
            path: "review/child",
            name: "child",
            versions: [],
          },
        ],
      }));
      yield* a.sync();
      const before = yield* captureDisk(b.disk, { identity: true });
      const head = yield* remote;
      const previousEvents = [...events];
      for (const apply of [false, true]) {
        const outcome = yield* b.sync({ apply });
        assert.strictEqual(outcome.status, "conflicted");
        if (outcome.status !== "conflicted") continue;
        const detail = outcome.conflict_details?.[0];
        assert.strictEqual(detail?._tag, "LibraryInvalid");
        if (detail?._tag !== "LibraryInvalid") continue;
        assert.isTrue(Schema.isSchemaError(detail.failure));
        const commandResult = result("librarySync", outcome);
        const human = renderResultFrame(commandResult, {
          ...defaultTerminalEnvironment,
          color: false,
          width: 100,
        });
        assert.strictEqual(human.exitCode, 1);
        assert.strictEqual(human.stderr, "");
        const json = renderResultFrame(commandResult, {
          ...defaultTerminalEnvironment,
          format: "json",
        });
        const wire = JSON.parse(json.stdout).data;
        const stored = yield* Schema.decodeEffect(SyncConflicted)({
          _tag: "Library.SyncConflicted",
          conflicts: wire.conflict_details,
        });
        assert.strictEqual(stored.conflicts[0]?._tag, "LibraryInvalid");
        assert.deepEqual(wire.conflict_details[0].failure.issues[0].reason.check.payload, {
          _tag: "OverlappingSkillPaths",
          collectionId,
          label: "review-tools",
          left: "review",
          right: "review/child",
        });
        assert.notProperty(wire.conflict_details[0], "issue");
        assert.strictEqual(
          (yield* b.sync({ apply, takeRemote: ["manifest:invariants"] })).status,
          "resolution_invalid",
        );
        yield* assertDiskUnchanged(before);
        assert.deepEqual(yield* remote, head);
        assert.deepEqual(events, previousEvents);
      }
    }).pipe(Effect.provide(testPlatformLayer), Effect.scoped),
);
