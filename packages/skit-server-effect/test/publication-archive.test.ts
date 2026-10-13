import { BrowserCrypto } from "@effect/platform-browser";
import { D1Client } from "@effect/sql-d1";
import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { zipSync } from "fflate";
import { readArchive, verifyReleaseArchive } from "../src/publication/archive.js";
import { sha256Digest } from "@smolai/skit-core/universal/consumer";
import { Bindings, databaseLayer } from "../src/platform/cloudflare.js";

const bytes = (value: string) => new TextEncoder().encode(value);
const bindingsLayer = Layer.merge(
  Layer.succeed(Bindings, { database: env.DB, blobs: env.SKIT_BLOBS }),
  databaseLayer(env.DB),
);
const testLayer = Layer.merge(bindingsLayer, BrowserCrypto.layer);

describe("Publication release archives", () => {
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
        const digest = yield* sha256Digest(content);
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
