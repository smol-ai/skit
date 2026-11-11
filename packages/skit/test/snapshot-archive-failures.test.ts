import { it } from "@effect/vitest";
import { expect } from "vitest";
import { Effect, Schema } from "effect";
import { createHash } from "node:crypto";
import {
  CollectionVersionArchiveInvalid,
  verifySnapshotArchive,
} from "../src/library/snapshot-archive-universal.js";
import { skitLayer } from "../src/platform/layer.js";

const digest = `sha256:${"0".repeat(64)}`;
it.effect("snapshot refusal facts retain paths, link targets and missing hierarchy", () =>
  Effect.gen(function* () {
    for (const [entries, reason] of [
      [
        [{ path: "skill", kind: "symlink", target: "../outside" }],
        { _tag: "UnsafeSymlink", path: "skill", target: "../outside" },
      ],
      [
        [
          { path: "skill", kind: "directory" },
          { path: "skill", kind: "directory" },
        ],
        { _tag: "DuplicatePath", path: "skill" },
      ],
      [[{ path: "missing/child", kind: "directory" }], { _tag: "MissingParent", unreachable: 1 }],
      [
        [{ path: "skill", kind: "file", mode: 0o644, content_base64: "?" }],
        { _tag: "InvalidBase64", path: "skill" },
      ],
      [
        [
          { path: "skill", kind: "file", mode: 0o644, content_base64: "" },
          { path: "skill/child", kind: "directory" },
        ],
        { _tag: "ChildOfNonDirectory", path: "skill" },
      ],
    ] as const) {
      const failure = yield* Effect.flip(
        verifySnapshotArchive({ profile: "verbatim/v1", digest, entries }),
      );
      expect(failure.reason).toEqual(reason);
      expect(failure.code).toBe("OPERATION_FAILED");
      const encoded = Schema.encodeSync(CollectionVersionArchiveInvalid)(failure);
      expect(encoded).not.toHaveProperty("message");
      expect(encoded).not.toHaveProperty("remediation");
      expect(
        Schema.decodeUnknownSync(CollectionVersionArchiveInvalid)(
          JSON.parse(JSON.stringify(encoded)),
        ),
      ).toEqual(failure);
    }
  }).pipe(Effect.provide(skitLayer)),
);

it.effect(
  "snapshot digest mismatches keep both hashes and valid empty snapshots still verify",
  () =>
    Effect.gen(function* () {
      const actual = `sha256:${createHash("sha256").digest("hex")}`;
      const failure = yield* Effect.flip(
        verifySnapshotArchive({ profile: "verbatim/v1", digest, entries: [] }),
      );
      expect(failure.reason).toEqual({
        _tag: "HashMismatch",
        kind: "archive",
        expected: digest,
        actual,
      });
      expect(
        (yield* verifySnapshotArchive({ profile: "verbatim/v1", digest: actual, entries: [] }))
          .entries,
      ).toEqual([]);
      const badPath = yield* Effect.flip(
        verifySnapshotArchive({
          profile: "verbatim/v1",
          digest,
          entries: [{ path: "../escape", kind: "directory" }],
        }),
      );
      expect(badPath.reason).toMatchObject({
        _tag: "InvalidShape",
        failure: expect.objectContaining({ _tag: "SchemaError" }),
      });
      const stored = Schema.encodeSync(CollectionVersionArchiveInvalid)(badPath);
      expect(stored.reason).toMatchObject({
        _tag: "InvalidShape",
        failure: {
          issues: expect.arrayContaining([
            expect.objectContaining({ path: ["entries", 0, "path"] }),
          ]),
        },
      });
    }).pipe(Effect.provide(skitLayer)),
);
