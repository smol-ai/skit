import { BrowserCrypto } from "@effect/platform-browser";
import { D1Client } from "@effect/sql-d1";
import { env } from "cloudflare:test";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import type { DraftCreateRequest } from "../src/drafts/contracts.js";
import { Drafts, layer as draftsLayer } from "../src/drafts/service.js";
import { Bindings, databaseLayer } from "../src/platform/cloudflare.js";

const bindings = { database: env.DB, blobs: env.SKIT_BLOBS };
const bindingsLayer = Layer.merge(Layer.succeed(Bindings, bindings), databaseLayer(env.DB));
const testLayer = draftsLayer.pipe(
  Layer.provideMerge(Layer.merge(bindingsLayer, BrowserCrypto.layer)),
);
const base64 = (value: string) => btoa(value);

const prepareDatabase = Effect.flatMap(D1Client.D1Client, (sql) =>
  sql.batch([
    sql`DROP TABLE IF EXISTS draft_files`,
    sql`DROP TABLE IF EXISTS draft_revisions`,
    sql`DROP TABLE IF EXISTS drafts`,
    sql`CREATE TABLE drafts (
      owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT, visibility TEXT NOT NULL, current_revision_id TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (owner_slug, skit_slug)
    )`,
    sql`CREATE TABLE draft_revisions (
      revision_id TEXT PRIMARY KEY, owner_slug TEXT NOT NULL, skit_slug TEXT NOT NULL,
      parent_revision_id TEXT, bundle_digest TEXT NOT NULL, descriptor_json TEXT NOT NULL,
      diagnostics_json TEXT NOT NULL, created_at TEXT NOT NULL
    )`,
    sql`CREATE TABLE draft_files (
      revision_id TEXT NOT NULL, path TEXT NOT NULL, blob_digest TEXT NOT NULL,
      byte_length INTEGER NOT NULL, media_type TEXT NOT NULL, executable INTEGER NOT NULL,
      object_key TEXT NOT NULL, PRIMARY KEY (revision_id, path)
    )`,
  ]),
);

const request = {
  owner: "alice",
  slug: "tools",
  title: "Tools",
  description: "Useful tools",
  visibility: "private",
  descriptor: {
    skit: 1,
    id: "alice/tools",
    slug: "tools",
    skills: [{ name: "review", path: "skills/review", default_enabled: true }],
  },
  files: [
    {
      path: "skit.json",
      content_base64: base64(
        JSON.stringify({
          slug: "tools",
          skills: [{ name: "review", path: "skills/review", default_enabled: true }],
        }),
      ),
      media_type: "application/json",
    },
    {
      path: "skills/review/SKILL.md",
      content_base64: base64("---\nname: review\n---\n# Review\n"),
      media_type: "text/markdown",
    },
  ],
} satisfies DraftCreateRequest;

describe("Drafts", () => {
  it.effect("writes, reads, and advances immutable revisions", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const drafts = yield* Drafts;

      const created = yield* drafts.create(request);
      expect(created.skit_id).toBe("alice/tools");
      expect(created.revision_id).toMatch(/^draft_[a-f0-9]{32}$/);
      expect(created.files).toHaveLength(2);
      expect(created.diagnostics).toEqual([]);

      const stored = yield* drafts.read("alice", "tools");
      expect(stored?.draft.title).toBe("Tools");
      expect(stored?.draft.descriptor).toEqual(request.descriptor);
      expect(stored?.draft.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: "skills/review/SKILL.md",
            content_base64: request.files[1].content_base64,
          }),
        ]),
      );

      const advanced = yield* drafts.write({
        ...request,
        title: "Tools 2",
        expected_revision_id: created.revision_id,
      });
      expect(advanced.revision_id).not.toBe(created.revision_id);
      expect((yield* drafts.read("alice", "tools"))?.draft.title).toBe("Tools 2");
    }).pipe(Effect.provide(testLayer)),
  );

  it.effect("rejects a stale expected revision", () =>
    Effect.gen(function* () {
      yield* prepareDatabase;
      const drafts = yield* Drafts;
      const created = yield* drafts.create(request);
      const outcome = yield* Effect.result(
        drafts.write({ ...request, expected_revision_id: "draft_stale" }),
      );

      expect(created.revision_id).not.toBe("draft_stale");
      expect(outcome._tag).toBe("Failure");
      if (outcome._tag === "Failure") expect(outcome.failure._tag).toBe("Draft.RevisionConflict");
      const revisions = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) => sql`SELECT COUNT(*) AS count FROM draft_revisions`,
      );
      const files = yield* Effect.flatMap(
        D1Client.D1Client,
        (sql) => sql`SELECT COUNT(*) AS count FROM draft_files`,
      );
      expect(revisions[0]).toEqual({ count: 1 });
      expect(files[0]).toEqual({ count: 2 });
    }).pipe(Effect.provide(testLayer)),
  );
});
