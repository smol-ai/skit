/* oxlint-disable skit/no-promise-wrappers -- Cloudflare test HTTP, migrations, D1 and R2 are native Promise host boundaries; no mocked services. */
import { BrowserCrypto } from "@effect/platform-browser";
import { applyD1Migrations, env, reset, SELF } from "cloudflare:test";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import { HttpApiClient } from "effect/http-api";
import { zipSync } from "fflate";
import {
  AuthoringAuthenticatedApi,
  PublicationAuthenticatedApi,
} from "@smolai/skit-core/universal/api";
import { History } from "@smolai/skit-core/universal/authoring";
import { sha256Hash } from "@smolai/skit-core/universal/consumer";
import { draftRevision, draftTree } from "./fixtures/draft-request.js";

// Real worker HTTP, authentication, D1 and R2. No mocked service or transport.
const origin = "https://registry.test";
const owner = "draft-author";
const params = { owner, slug: "tools" };
let clientAddress = 0;

const signIn = Effect.gen(function* () {
  yield* Effect.promise(() => reset());
  yield* Effect.promise(() => applyD1Migrations(env.DB, env.TEST_MIGRATIONS));
  // Bootstrap and sign-in are rate limited per address, so each test signs in from its own.
  clientAddress += 1;
  const headers = {
    "content-type": "application/json",
    origin,
    "cf-connecting-ip": `192.0.2.${clientAddress}`,
  };
  const bootstrap = yield* Effect.promise(() =>
    SELF.fetch(`${origin}/api/bootstrap`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        token: "skit-bootstrap-test-secret-that-is-at-least-thirty-two-characters",
        username: owner,
        email: "author@example.test",
        password: "correct horse battery staple",
      }),
    }),
  );
  expect(bootstrap.status).toBe(201);
  const signedIn = yield* Effect.promise(() =>
    SELF.fetch(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        email: "author@example.test",
        password: "correct horse battery staple",
      }),
    }),
  );
  expect(signedIn.status).toBe(200);
  const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";", 1)[0];
  const httpClient = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(HttpClientRequest.setHeaders({ cookie, origin })),
  );
  const authoring = yield* HttpApiClient.makeWith(AuthoringAuthenticatedApi, {
    httpClient,
    baseUrl: origin,
  });
  const publishing = yield* HttpApiClient.makeWith(PublicationAuthenticatedApi, {
    httpClient,
    baseUrl: origin,
  });
  return {
    drafts: authoring.drafts,
    skitDelete: authoring.skitDelete,
    publication: publishing.publication,
  };
});

const withRegistry = <A, E, R>(
  body: (registry: Effect.Success<typeof signIn>) => Effect.Effect<A, E, R>,
) =>
  signIn.pipe(
    Effect.flatMap(body),
    Effect.provide([FetchHttpClient.layer, BrowserCrypto.layer]),
    Effect.provideService(FetchHttpClient.Fetch, (input, init) => SELF.fetch(input, init)),
  );

const countRows = (table: string) =>
  Effect.promise(() =>
    env.DB.prepare(`SELECT COUNT(*) count FROM ${table}`).first<{ count: number }>(),
  ).pipe(Effect.map((row) => row?.count));

const base64 = (bytes: Uint8Array) =>
  btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""));

const archiveOf = (tree: History.Tree) =>
  base64(
    zipSync(
      Object.fromEntries(
        tree.flatMap((entry) => (entry.kind === "file" ? [[entry.path, entry.bytes]] : [])),
      ),
    ),
  );

it.effect("creates an empty Draft whose current is null, once", () =>
  withRegistry(({ drafts }) =>
    Effect.gen(function* () {
      expect(yield* drafts.create({ payload: { ...params, visibility: "private" } })).toEqual({
        skit_id: "draft-author/tools",
      });
      expect(yield* drafts.current({ params })).toEqual({
        skit_id: "draft-author/tools",
        current: null,
        visibility: "private",
      });
      expect(
        yield* Effect.flip(drafts.create({ payload: { ...params, visibility: "private" } })),
      ).toEqual({ error: "draft_exists" });
      expect(yield* Effect.flip(drafts.current({ params: { owner, slug: "missing" } }))).toEqual({
        error: "draft_not_found",
      });
    }),
  ),
);

it.effect("records a revision once, reads it back, and never moves current", () =>
  withRegistry(({ drafts }) =>
    Effect.gen(function* () {
      yield* drafts.create({ payload: { ...params, visibility: "private" } });
      const posted = yield* draftRevision();
      expect(yield* drafts.post({ params, payload: posted })).toEqual({
        id: posted.id,
        diagnostics: [],
      });
      expect(yield* drafts.post({ params, payload: posted })).toEqual({
        id: posted.id,
        diagnostics: [],
      });
      expect(yield* countRows("draft_revisions")).toBe(1);
      expect((yield* drafts.current({ params })).current).toBeNull();
      expect(yield* drafts.revision({ params: { ...params, id: posted.id } })).toEqual({
        revision: posted.revision,
        tree: History.sortTree(posted.tree),
        diagnostics: [],
        descriptor: {
          skit: 1,
          id: "draft-author/tools",
          slug: "tools",
          skills: [{ name: "review", path: "skills/review", default_enabled: true }],
        },
      });
      expect(
        yield* Effect.flip(drafts.revision({ params: { owner, slug: "other", id: posted.id } })),
      ).toEqual({ error: "draft_not_found" });
    }),
  ),
);

it.effect("rejects a tree or revision whose identity does not match", () =>
  withRegistry(({ drafts }) =>
    Effect.gen(function* () {
      yield* drafts.create({ payload: { ...params, visibility: "private" } });
      const posted = yield* draftRevision();
      const later = yield* draftRevision(draftTree, [], 2);
      expect(
        yield* Effect.flip(
          drafts.post({
            params,
            payload: { ...posted, tree: [...posted.tree, { path: "notes", kind: "directory" }] },
          }),
        ),
      ).toEqual({ error: "TREE_HASH_MISMATCH" });
      expect(
        yield* Effect.flip(drafts.post({ params, payload: { ...posted, id: later.id } })),
      ).toEqual({ error: "REVISION_ID_MISMATCH" });
      expect(
        yield* Effect.flip(
          drafts.post({
            params,
            payload: yield* draftRevision([...draftTree, { path: "../escape", kind: "directory" }]),
          }),
        ),
      ).toEqual({ error: "UNSAFE_PATH" });
      expect(
        yield* Effect.flip(
          drafts.post({ params, payload: yield* draftRevision(draftTree, [later.id]) }),
        ),
      ).toEqual({ error: "PARENT_MISSING" });
      expect(yield* countRows("draft_revisions")).toBe(0);
    }),
  ),
);

it.effect("moves current only from the revision the caller expects", () =>
  withRegistry(({ drafts }) =>
    Effect.gen(function* () {
      yield* drafts.create({ payload: { ...params, visibility: "private" } });
      const first = yield* draftRevision();
      const second = yield* draftRevision(draftTree, [first.id], 2);
      yield* drafts.post({ params, payload: first });
      yield* drafts.post({ params, payload: second });
      expect(yield* drafts.move({ params, payload: { expected: null, id: first.id } })).toEqual({
        id: first.id,
      });
      expect(
        yield* Effect.flip(drafts.move({ params, payload: { expected: null, id: second.id } })),
      ).toEqual({ error: "REVISION_CONFLICT", current: first.id });
      expect(yield* drafts.move({ params, payload: { expected: first.id, id: first.id } })).toEqual(
        { id: first.id },
      );
      const unknown = yield* draftRevision(draftTree, [], 3);
      expect(
        yield* Effect.flip(
          drafts.move({ params, payload: { expected: first.id, id: unknown.id } }),
        ),
      ).toEqual({ error: "REVISION_MISSING" });
      yield* drafts.move({ params, payload: { expected: first.id, id: second.id } });
      expect((yield* drafts.current({ params })).current).toBe(second.id);
    }),
  ),
);

it.effect("pages the ancestors of a merge, listing each revision once", () =>
  withRegistry(({ drafts }) =>
    Effect.gen(function* () {
      yield* drafts.create({ payload: { ...params, visibility: "private" } });
      const root = yield* draftRevision(draftTree, [], 1);
      const ours = yield* draftRevision(draftTree, [root.id], 2);
      const theirs = yield* draftRevision(draftTree, [root.id], 3);
      const merge = yield* draftRevision(draftTree, [ours.id, theirs.id], 4);
      for (const posted of [root, ours, theirs, merge])
        yield* drafts.post({ params, payload: posted });

      const first = yield* drafts.ancestors({ params, query: { ancestors: merge.id, limit: "3" } });
      expect(first.revisions.map(({ id }) => id)).toEqual([merge.id, theirs.id, ours.id]);
      expect(first.revisions[0]?.revision.parents).toEqual([ours.id, theirs.id]);
      expect(first.next_cursor).not.toBeNull();
      const rest = yield* drafts.ancestors({
        params,
        query: { ancestors: merge.id, limit: "3", cursor: first.next_cursor ?? "" },
      });
      expect(rest).toEqual({
        revisions: [{ id: root.id, revision: root.revision, diagnostics: [] }],
        next_cursor: null,
      });
      expect(
        (yield* drafts.ancestors({ params, query: { ancestors: ours.id } })).revisions.map(
          ({ id }) => id,
        ),
      ).toEqual([ours.id, root.id]);
      expect(
        yield* Effect.flip(
          drafts.ancestors({ params, query: { ancestors: merge.id, cursor: "next" } }),
        ),
      ).toEqual({ error: "invalid_cursor" });
      expect(
        yield* Effect.flip(
          drafts.ancestors({ params, query: { ancestors: merge.id, limit: "1000" } }),
        ),
      ).toEqual({ error: "invalid_request" });
    }),
  ),
);

it.effect("accepts invalid content and unpublishable entries with diagnostics", () =>
  withRegistry(({ drafts }) =>
    Effect.gen(function* () {
      yield* drafts.create({ payload: { ...params, visibility: "private" } });
      const undescribed = yield* draftRevision([draftTree[1]]);
      expect(yield* drafts.post({ params, payload: undescribed })).toEqual({
        id: undescribed.id,
        diagnostics: [expect.objectContaining({ code: "DESCRIPTOR_MISSING", severity: "error" })],
      });
      expect(
        (yield* drafts.revision({ params: { ...params, id: undescribed.id } })).descriptor,
      ).toBeNull();

      const linked = yield* draftRevision([
        ...draftTree,
        { path: "skills/review/link", kind: "symlink", target: "SKILL.md" },
        { path: "skills", kind: "directory" },
        { path: "empty", kind: "directory" },
      ]);
      const recorded = yield* drafts.post({ params, payload: linked });
      expect(recorded.diagnostics.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: "UNPUBLISHABLE_TREE_ENTRY", path: "skills/review/link" },
        { code: "UNPUBLISHABLE_TREE_ENTRY", path: "empty" },
      ]);
      expect((yield* drafts.revision({ params: { ...params, id: linked.id } })).tree).toEqual(
        History.sortTree(linked.tree),
      );
    }),
  ),
);

it.effect("reads back verified blob bytes rather than trusting stored lengths", () =>
  withRegistry(({ drafts }) =>
    Effect.gen(function* () {
      yield* drafts.create({ payload: { ...params, visibility: "private" } });
      const posted = yield* draftRevision();
      yield* drafts.post({ params, payload: posted });
      const skill = draftTree[1];
      if (skill?.kind !== "file") return yield* Effect.die("fixture SKILL.md is a file");
      const hash = yield* sha256Hash(skill.bytes);
      // Same size, wrong content.
      yield* Effect.promise(() =>
        env.SKIT_BLOBS.put(
          `draft-blobs/${hash.slice(7, 9)}/${hash.slice(7)}`,
          "x".repeat(skill.bytes.byteLength),
        ),
      );
      expect(yield* Effect.flip(drafts.revision({ params: { ...params, id: posted.id } }))).toEqual(
        { error: "storage_failure" },
      );
    }),
  ),
);

it.effect("publishes current, and refuses a stale revision or an unpublishable tree", () =>
  withRegistry(({ drafts, publication }) =>
    Effect.gen(function* () {
      yield* drafts.create({ payload: { ...params, visibility: "private" } });
      const published = yield* draftRevision();
      yield* drafts.post({ params, payload: published });
      expect(
        yield* Effect.flip(
          publication.publish({
            params,
            payload: { version: "1.0.0", archive_base64: archiveOf(draftTree) },
          }),
        ),
      ).toEqual({ error: "draft_not_found" });
      yield* drafts.move({ params, payload: { expected: null, id: published.id } });
      const release = yield* publication.publish({
        params,
        payload: {
          version: "1.0.0",
          revision_id: published.id,
          archive_base64: archiveOf(draftTree),
        },
      });
      expect(release.release.revision_id).toBe(published.id);

      const linked = yield* draftRevision(
        [...draftTree, { path: "skills/review/link", kind: "symlink", target: "SKILL.md" }],
        [published.id],
        2,
      );
      yield* drafts.post({ params, payload: linked });
      yield* drafts.move({ params, payload: { expected: published.id, id: linked.id } });
      expect(
        yield* Effect.flip(
          publication.publish({
            params,
            payload: {
              version: "1.0.1",
              revision_id: published.id,
              archive_base64: archiveOf(draftTree),
            },
          }),
        ),
      ).toEqual({ error: "stale_draft_revision" });
      expect(
        yield* Effect.flip(
          publication.publish({
            params,
            payload: { version: "1.0.1", archive_base64: archiveOf(draftTree) },
          }),
        ),
      ).toEqual({
        error: "publish_blocked",
        diagnostics: [
          expect.objectContaining({
            code: "UNPUBLISHABLE_TREE_ENTRY",
            path: "skills/review/link",
          }),
        ],
      });
    }),
  ),
);

it.effect("deleting a Draft removes its revisions and the trees no other Draft records", () =>
  withRegistry(({ drafts, skitDelete }) =>
    Effect.gen(function* () {
      const other = { owner, slug: "other" };
      for (const target of [params, other])
        yield* drafts.create({ payload: { ...target, visibility: "private" } });
      const shared = yield* draftRevision();
      const own = yield* draftRevision(
        [...draftTree, { path: "notes", kind: "directory" }],
        [shared.id],
        2,
      );
      for (const posted of [shared, own]) yield* drafts.post({ params, payload: posted });
      yield* drafts.post({ params: other, payload: shared });
      yield* drafts.move({ params, payload: { expected: null, id: own.id } });

      expect(yield* skitDelete.deletePrivate({ params, query: {} })).toMatchObject({
        status: "deleted",
        draft_revisions: 2,
      });
      expect(yield* countRows("draft_revisions")).toBe(1);
      expect(yield* countRows("draft_revision_parents")).toBe(0);
      expect(yield* countRows("draft_trees")).toBe(1);
      expect(yield* countRows("draft_tree_entries")).toBe(draftTree.length);
      expect(yield* drafts.revision({ params: { ...other, id: shared.id } })).toMatchObject({
        tree: History.sortTree(draftTree),
      });
    }),
  ),
);
