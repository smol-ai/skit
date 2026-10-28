import { BrowserCrypto } from "@effect/platform-browser";
import { D1Client } from "@effect/sql-d1";
import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { zipSync } from "fflate";
import { readArchive, verifyReleaseArchive } from "../src/publication/archive.js";
import { sha256Hash } from "@smolai/skit-core/universal/consumer";
import { Bindings, databaseLayer } from "../src/platform/cloudflare.js";

const bytes = (value: string) => new TextEncoder().encode(value);
const bindingsLayer = Layer.merge(
  Layer.succeed(Bindings, { database: env.DB, blobs: env.SKIT_BLOBS }),
  databaseLayer(env.DB),
);
const testLayer = Layer.merge(bindingsLayer, BrowserCrypto.layer);

/**
 * One validated `a.txt`, plus a second `a.txt` record the end record hides: it counts one entry for
 * the preflight but `entriesOnDisk` for an inflater that reads that field, and the hidden record sits
 * between the declared central directory and the end record.
 */
const smuggledArchive = (entriesOnDisk: number, hiddenInGap: boolean) => {
  const parts = (content: string) => {
    const archive = zipSync({ "a.txt": [bytes(content), { level: 0 }] });
    const view = new DataView(archive.buffer);
    const end = archive.byteLength - 22;
    const central = view.getUint32(end + 16, true);
    return {
      local: archive.subarray(0, central),
      central: archive.slice(central, central + view.getUint32(end + 12, true)),
      end: archive.slice(end),
    };
  };
  const visible = parts("visible");
  const hidden = parts("smuggled");
  new DataView(hidden.central.buffer).setUint32(42, visible.local.byteLength, true);
  const end = new DataView(visible.end.buffer);
  end.setUint16(8, entriesOnDisk, true);
  end.setUint32(16, visible.local.byteLength + hidden.local.byteLength, true);
  if (!hiddenInGap) end.setUint32(12, visible.central.byteLength + hidden.central.byteLength, true);
  const archive = new Uint8Array(
    [visible.local, hidden.local, visible.central, hidden.central, visible.end].reduce(
      (length, part) => length + part.byteLength,
      0,
    ),
  );
  let offset = 0;
  for (const part of [visible.local, hidden.local, visible.central, hidden.central, visible.end]) {
    archive.set(part, offset);
    offset += part.byteLength;
  }
  return archive;
};

/** A valid one-entry stored archive with one end-record or central-record field overwritten. */
const storedArchiveWith = (record: "end" | "central", field: number, value: number) => {
  const archive = zipSync({ "a.txt": [bytes("visible"), { level: 0 }] });
  const view = new DataView(archive.buffer);
  const end = archive.byteLength - 22;
  const offset = record === "end" ? end : view.getUint32(end + 16, true);
  view.setUint16(offset + field, value, true);
  return archive;
};

describe("Publication release archives", () => {
  for (const [label, record, field, value] of [
    ["a second disk", "end", 4, 1],
    ["a central directory on another disk", "end", 6, 1],
    ["more entries on this disk than in total", "end", 8, 2],
    // An inflater copies a stored entry at its compressed size, not the uncompressed size budgeted.
    ["a stored entry claiming no uncompressed bytes", "central", 24, 0],
  ] as const)
    it.effect(`rejects an archive with ${label}`, () =>
      Effect.gen(function* () {
        const outcome = yield* Effect.result(readArchive(storedArchiveWith(record, field, value)));

        expect(outcome._tag).toBe("Failure");
        if (outcome._tag === "Failure") expect(outcome.failure.code).toBe("INVALID_ARCHIVE");
      }),
    );

  for (const [entriesOnDisk, hiddenInGap] of [
    [2, true],
    [1, true],
    [2, false],
  ] as const)
    it.effect(
      `rejects a record the end record hides (entries on disk ${entriesOnDisk}, ${hiddenInGap ? "in a gap" : "inside the directory"})`,
      () =>
        Effect.gen(function* () {
          const outcome = yield* Effect.result(
            readArchive(smuggledArchive(entriesOnDisk, hiddenInGap)),
          );

          expect(outcome._tag).toBe("Failure");
          if (outcome._tag === "Failure") expect(outcome.failure.code).toBe("INVALID_ARCHIVE");
        }),
    );

  it.effect("reads an archive whose end record describes exactly its directory", () =>
    Effect.gen(function* () {
      const { names, files } = yield* readArchive(
        zipSync({ "a.txt": bytes("visible"), "b/c.txt": [bytes("stored"), { level: 0 }] }),
      );

      expect(names).toEqual(["a.txt", "b/c.txt"]);
      expect(new TextDecoder().decode(files["a.txt"])).toBe("visible");
      expect(new TextDecoder().decode(files["b/c.txt"])).toBe("stored");
    }),
  );

  it.effect("rejects traversal paths even when the inflater accepts them", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(readArchive(zipSync({ "../escape": bytes("no") })));

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure.code).toBe("INVALID_ARCHIVE");
    }),
  );

  it.effect("rejects empty ZIP files", () =>
    Effect.gen(function* () {
      const outcome = yield* Effect.result(readArchive(zipSync({})));

      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure.code).toBe("INVALID_ARCHIVE");
    }),
  );

  it.effect("verifies the archive against its persisted draft revision and rejects drift", () =>
    Effect.gen(function* () {
      const descriptor = {
        skit: 1,
        id: "alice/tools",
        slug: "tools",
        skills: [{ name: "review", path: "skills/review", default_enabled: true }],
      };
      const contents = new Map([
        [
          "skit.json",
          bytes(
            JSON.stringify({
              slug: "tools",
              skills: [{ name: "review", path: "skills/review", default_enabled: true }],
            }),
          ),
        ],
        ["skills/review/SKILL.md", bytes("---\nname: review\n---\n# Review\n")],
      ]);
      yield* Effect.flatMap(D1Client.D1Client, (sql) =>
        sql.batch([
          sql`DROP TABLE IF EXISTS draft_files`,
          sql`DROP TABLE IF EXISTS draft_revisions`,
          sql`CREATE TABLE draft_revisions (
            revision_id TEXT PRIMARY KEY, owner_slug TEXT, skit_slug TEXT, descriptor_json TEXT
          )`,
          sql`CREATE TABLE draft_files (
            revision_id TEXT, path TEXT, blob_digest TEXT, byte_length INTEGER,
            media_type TEXT, executable INTEGER
          )`,
          sql`INSERT INTO draft_revisions
              VALUES ('draft_test', 'alice', 'tools', ${JSON.stringify(descriptor)})`,
        ]),
      );
      for (const [path, content] of contents) {
        const digest = yield* sha256Hash(content);
        yield* Effect.flatMap(
          D1Client.D1Client,
          (sql) =>
            sql`INSERT INTO draft_files
                VALUES ('draft_test', ${path}, ${digest}, ${content.byteLength}, 'text/plain', 0)`,
        );
      }

      expect(
        yield* verifyReleaseArchive("draft_test", zipSync(Object.fromEntries(contents))),
      ).toEqual([]);
      const drifted = yield* Effect.result(
        verifyReleaseArchive(
          "draft_test",
          zipSync({ ...Object.fromEntries(contents), "skills/review/SKILL.md": bytes("changed") }),
        ),
      );
      expect(drifted._tag).toBe("Failure");
      if (drifted._tag === "Failure")
        expect(drifted.failure).toMatchObject({ code: "ARCHIVE_MANIFEST_MISMATCH" });
    }).pipe(Effect.provide(testLayer)),
  );
});
