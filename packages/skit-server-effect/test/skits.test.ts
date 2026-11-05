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
import { revisionRequest, skillTree } from "./fixtures/revision-request.js";

// Real worker HTTP, authentication, D1 and R2. No mocked service or transport.
const origin = "https://registry.test";
const owner = "skit-author";
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
    cookie,
    skits: authoring.skits,
    authorInventory: authoring.authorInventory,
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

it.effect("rejects a session write from another site but serves its reads", () =>
  withRegistry(({ cookie }) =>
    Effect.gen(function* () {
      for (const headers of [{ cookie, origin: "https://evil.test" }, { cookie }]) {
        const httpClient = (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest(HttpClientRequest.setHeaders(headers)),
        );
        const { skits, authorInventory } = yield* HttpApiClient.makeWith(
          AuthoringAuthenticatedApi,
          { httpClient, baseUrl: origin },
        );
        expect(
          yield* Effect.flip(skits.create({ payload: { ...params, visibility: "private" } })),
        ).toEqual({ error: "forbidden_origin" });
        // Browsers do not always send Origin on a same-site GET, so reads are not checked.
        expect((yield* authorInventory.read({ query: {} })).skits).toEqual([]);
      }
      expect(yield* countRows("skits")).toBe(0);
    }),
  ),
);

it.effect("creation replays only its saved request and never resets a current revision", () =>
  withRegistry(({ skits }) =>
    Effect.gen(function* () {
      const payload = {
        ...params,
        visibility: "private" as const,
        request_id: "device-creation-request",
      };
      yield* skits.create({ payload });
      const request = yield* revisionRequest(skillTree);
      yield* skits.post({ params, payload: request });
      yield* skits.move({ params, payload: { expected: null, id: request.id } });
      expect(yield* skits.create({ payload })).toEqual({ skit_id: "skit-author/tools" });
      expect((yield* skits.current({ params })).current).toBe(request.id);
      for (const other of [
        { ...params, visibility: "private" as const },
        { ...payload, request_id: "other-device" },
        { ...payload, visibility: "public" as const },
      ])
        expect(yield* Effect.flip(skits.create({ payload: other }))).toMatchObject({
          error: "skit_exists",
        });
      expect(yield* countRows("skits")).toBe(1);
    }),
  ),
);

it.effect("creates an empty SKIT whose current is null, once", () =>
  withRegistry(({ skits }) =>
    Effect.gen(function* () {
      expect(yield* skits.create({ payload: { ...params, visibility: "private" } })).toEqual({
        skit_id: "skit-author/tools",
      });
      expect(yield* skits.current({ params })).toEqual({
        skit_id: "skit-author/tools",
        current: null,
        visibility: "private",
      });
      expect(
        yield* Effect.flip(skits.create({ payload: { ...params, visibility: "private" } })),
      ).toEqual({ error: "skit_exists" });
      expect(yield* Effect.flip(skits.current({ params: { owner, slug: "missing" } }))).toEqual({
        error: "skit_not_found",
      });
    }),
  ),
);

it.effect("records a revision once, reads it back, and never moves current", () =>
  withRegistry(({ skits }) =>
    Effect.gen(function* () {
      yield* skits.create({ payload: { ...params, visibility: "private" } });
      const posted = yield* revisionRequest();
      expect(yield* skits.post({ params, payload: posted })).toEqual({
        id: posted.id,
        diagnostics: [],
      });
      expect(yield* skits.post({ params, payload: posted })).toEqual({
        id: posted.id,
        diagnostics: [],
      });
      expect(yield* countRows("revisions")).toBe(1);
      expect((yield* skits.current({ params })).current).toBeNull();
      expect(yield* skits.revision({ params: { ...params, id: posted.id } })).toEqual({
        revision: posted.revision,
        tree: History.sortTree(posted.tree),
        diagnostics: [],
        descriptor: {
          skit: 1,
          id: "skit-author/tools",
          slug: "tools",
          skills: [{ name: "review", path: "skills/review", default_enabled: true }],
        },
      });
      expect(
        yield* Effect.flip(skits.revision({ params: { owner, slug: "other", id: posted.id } })),
      ).toEqual({ error: "skit_not_found" });
    }),
  ),
);

it.effect("rejects a tree or revision whose identity does not match", () =>
  withRegistry(({ skits }) =>
    Effect.gen(function* () {
      yield* skits.create({ payload: { ...params, visibility: "private" } });
      const posted = yield* revisionRequest();
      const later = yield* revisionRequest(skillTree, [], 2);
      expect(
        yield* Effect.flip(
          skits.post({
            params,
            payload: { ...posted, tree: [...posted.tree, { path: "notes", kind: "directory" }] },
          }),
        ),
      ).toEqual({ error: "TREE_HASH_MISMATCH" });
      expect(
        yield* Effect.flip(skits.post({ params, payload: { ...posted, id: later.id } })),
      ).toEqual({ error: "REVISION_ID_MISMATCH" });
      expect(
        yield* Effect.flip(
          skits.post({
            params,
            payload: yield* revisionRequest([
              ...skillTree,
              { path: "../escape", kind: "directory" },
            ]),
          }),
        ),
      ).toEqual({ error: "UNSAFE_PATH" });
      expect(
        yield* Effect.flip(
          skits.post({ params, payload: yield* revisionRequest(skillTree, [later.id]) }),
        ),
      ).toEqual({ error: "PARENT_MISSING" });
      expect(yield* countRows("revisions")).toBe(0);
    }),
  ),
);

it.effect("moves current only from the revision the caller expects", () =>
  withRegistry(({ skits }) =>
    Effect.gen(function* () {
      yield* skits.create({ payload: { ...params, visibility: "private" } });
      const first = yield* revisionRequest();
      const second = yield* revisionRequest(skillTree, [first.id], 2);
      yield* skits.post({ params, payload: first });
      yield* skits.post({ params, payload: second });
      expect(yield* skits.move({ params, payload: { expected: null, id: first.id } })).toEqual({
        id: first.id,
      });
      expect(
        yield* Effect.flip(skits.move({ params, payload: { expected: null, id: second.id } })),
      ).toEqual({ error: "REVISION_CONFLICT", current: first.id });
      expect(yield* skits.move({ params, payload: { expected: first.id, id: first.id } })).toEqual({
        id: first.id,
      });
      const unknown = yield* revisionRequest(skillTree, [], 3);
      expect(
        yield* Effect.flip(skits.move({ params, payload: { expected: first.id, id: unknown.id } })),
      ).toEqual({ error: "REVISION_MISSING" });
      yield* skits.move({ params, payload: { expected: first.id, id: second.id } });
      expect((yield* skits.current({ params })).current).toBe(second.id);
    }),
  ),
);

it.effect("pages the ancestors of a merge, listing each revision once", () =>
  withRegistry(({ skits }) =>
    Effect.gen(function* () {
      yield* skits.create({ payload: { ...params, visibility: "private" } });
      const root = yield* revisionRequest(skillTree, [], 1);
      const ours = yield* revisionRequest(skillTree, [root.id], 2);
      const theirs = yield* revisionRequest(skillTree, [root.id], 3);
      const merge = yield* revisionRequest(skillTree, [ours.id, theirs.id], 4);
      for (const posted of [root, ours, theirs, merge])
        yield* skits.post({ params, payload: posted });

      const first = yield* skits.ancestors({ params, query: { ancestors: merge.id, limit: "3" } });
      expect(first.revisions.map(({ id }) => id)).toEqual([merge.id, theirs.id, ours.id]);
      expect(first.revisions[0]?.revision.parents).toEqual([ours.id, theirs.id]);
      expect(first.next_cursor).not.toBeNull();
      const rest = yield* skits.ancestors({
        params,
        query: { ancestors: merge.id, limit: "3", cursor: first.next_cursor ?? "" },
      });
      expect(rest).toEqual({
        revisions: [{ id: root.id, revision: root.revision, diagnostics: [] }],
        next_cursor: null,
      });
      expect(
        (yield* skits.ancestors({ params, query: { ancestors: ours.id } })).revisions.map(
          ({ id }) => id,
        ),
      ).toEqual([ours.id, root.id]);
      expect(
        yield* Effect.flip(
          skits.ancestors({ params, query: { ancestors: merge.id, cursor: "next" } }),
        ),
      ).toEqual({ error: "invalid_cursor" });
      expect(
        yield* Effect.flip(
          skits.ancestors({ params, query: { ancestors: merge.id, limit: "1000" } }),
        ),
      ).toEqual({ error: "invalid_request" });
    }),
  ),
);

it.effect("accepts invalid content and unpublishable entries with diagnostics", () =>
  withRegistry(({ skits }) =>
    Effect.gen(function* () {
      yield* skits.create({ payload: { ...params, visibility: "private" } });
      const undescribed = yield* revisionRequest([skillTree[1]]);
      expect(yield* skits.post({ params, payload: undescribed })).toEqual({
        id: undescribed.id,
        diagnostics: [expect.objectContaining({ code: "DESCRIPTOR_MISSING", severity: "error" })],
      });
      expect(
        (yield* skits.revision({ params: { ...params, id: undescribed.id } })).descriptor,
      ).toBeNull();

      const linked = yield* revisionRequest([
        ...skillTree,
        { path: "skills/review/link", kind: "symlink", target: "SKILL.md" },
        { path: "skills", kind: "directory" },
        { path: "empty", kind: "directory" },
      ]);
      const recorded = yield* skits.post({ params, payload: linked });
      expect(recorded.diagnostics.map(({ code, path }) => ({ code, path }))).toEqual([
        { code: "UNPUBLISHABLE_TREE_ENTRY", path: "skills/review/link" },
        { code: "UNPUBLISHABLE_TREE_ENTRY", path: "empty" },
      ]);
      expect((yield* skits.revision({ params: { ...params, id: linked.id } })).tree).toEqual(
        History.sortTree(linked.tree),
      );
    }),
  ),
);

it.effect("reads back verified blob bytes rather than trusting stored lengths", () =>
  withRegistry(({ skits }) =>
    Effect.gen(function* () {
      yield* skits.create({ payload: { ...params, visibility: "private" } });
      const posted = yield* revisionRequest();
      yield* skits.post({ params, payload: posted });
      const skill = skillTree[1];
      if (skill?.kind !== "file") return yield* Effect.die("fixture SKILL.md is a file");
      const hash = yield* sha256Hash(skill.bytes);
      // Same size, wrong content.
      yield* Effect.promise(() =>
        env.SKIT_BLOBS.put(
          `draft-blobs/${hash.slice(7, 9)}/${hash.slice(7)}`,
          "x".repeat(skill.bytes.byteLength),
        ),
      );
      expect(yield* Effect.flip(skits.revision({ params: { ...params, id: posted.id } }))).toEqual({
        error: "storage_failure",
      });
    }),
  ),
);

it.effect("publishes current, and refuses a stale revision or an unpublishable tree", () =>
  withRegistry(({ skits, publication, authorInventory }) =>
    Effect.gen(function* () {
      yield* skits.create({ payload: { ...params, visibility: "private" } });
      const published = yield* revisionRequest();
      yield* skits.post({ params, payload: published });
      expect(
        yield* Effect.flip(
          publication.publish({
            params,
            payload: { version: "1.0.0", archive_base64: archiveOf(skillTree) },
          }),
        ),
      ).toEqual({ error: "current_revision_missing" });
      yield* skits.move({ params, payload: { expected: null, id: published.id } });
      expect((yield* authorInventory.read({ query: {} })).skits[0]).toMatchObject({
        current_revision_id: published.id,
        current_revision_published: false,
      });
      const release = yield* publication.publish({
        params,
        payload: {
          version: "1.0.0",
          revision_id: published.id,
          archive_base64: archiveOf(skillTree),
        },
      });
      expect(release.release.revision_id).toBe(published.id);
      expect((yield* authorInventory.read({ query: {} })).skits[0]).toMatchObject({
        current_revision_id: published.id,
        current_revision_published: true,
      });

      const linked = yield* revisionRequest(
        [...skillTree, { path: "skills/review/link", kind: "symlink", target: "SKILL.md" }],
        [published.id],
        2,
      );
      yield* skits.post({ params, payload: linked });
      yield* skits.move({ params, payload: { expected: published.id, id: linked.id } });
      expect((yield* authorInventory.read({ query: {} })).skits[0]).toMatchObject({
        current_revision_id: linked.id,
        current_revision_published: false,
        most_recent_release_version: "1.0.0",
      });
      expect(
        yield* Effect.flip(
          publication.publish({
            params,
            payload: {
              version: "1.0.1",
              revision_id: published.id,
              archive_base64: archiveOf(skillTree),
            },
          }),
        ),
      ).toEqual({ error: "stale_revision" });
      expect(
        yield* Effect.flip(
          publication.publish({
            params,
            payload: { version: "1.0.1", archive_base64: archiveOf(skillTree) },
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
      yield* skits.move({ params, payload: { expected: linked.id, id: published.id } });
      expect(
        (yield* authorInventory.read({ query: {} })).skits[0]?.current_revision_published,
      ).toBe(true);
    }),
  ),
);

it.effect("conceals deletion and previews from a non-owner despite a legacy admin grant", () =>
  withRegistry(({ skits, cookie }) =>
    Effect.gen(function* () {
      yield* skits.create({ payload: { ...params, visibility: "private" } });
      yield* Effect.promise(() =>
        env.DB.batch([
          env.DB.prepare(`INSERT INTO resource_grants
          (grant_id, subject_kind, subject_id, resource_kind, resource_id, permission, created_at)
          SELECT 'delete_admin_probe', 'principal', subject_id, 'skit', ?, 'admin', '2026-11-05'
          FROM namespaces WHERE namespace_slug = ?`).bind(`${owner}/tools`, owner),
          env.DB.prepare(
            "UPDATE namespaces SET subject_id = 'principal_elsewhere' WHERE namespace_slug = ?",
          ).bind(owner),
        ]),
      );
      for (const suffix of ["?dry_run=true", ""]) {
        const response = yield* Effect.promise(() =>
          SELF.fetch(`${origin}/api/skits/${owner}/tools${suffix}`, {
            method: "DELETE",
            headers: { cookie, origin },
          }),
        );
        expect(response.status).toBe(404);
        expect(yield* Effect.promise(() => response.json())).toEqual({ error: "skit_not_found" });
      }
      expect(yield* countRows("skits")).toBe(1);
      expect(yield* countRows("resource_grants")).toBe(1);
    }),
  ),
);

it.effect("deleting a SKIT removes its revisions and the trees no other SKIT records", () =>
  withRegistry(({ skits, skitDelete }) =>
    Effect.gen(function* () {
      const other = { owner, slug: "other" };
      for (const target of [params, other])
        yield* skits.create({ payload: { ...target, visibility: "private" } });
      const shared = yield* revisionRequest();
      const own = yield* revisionRequest(
        [...skillTree, { path: "notes", kind: "directory" }],
        [shared.id],
        2,
      );
      for (const posted of [shared, own]) yield* skits.post({ params, payload: posted });
      yield* skits.post({ params: other, payload: shared });
      yield* skits.move({ params, payload: { expected: null, id: own.id } });

      expect(yield* skitDelete.deletePrivate({ params, query: { dry_run: "true" } })).toMatchObject(
        { status: "delete_ready", changed: false, revisions: 2 },
      );
      expect(yield* countRows("revisions")).toBe(3);
      expect(yield* countRows("skits")).toBe(2);

      expect(yield* skitDelete.deletePrivate({ params, query: {} })).toMatchObject({
        status: "deleted",
        revisions: 2,
      });
      expect(yield* countRows("revisions")).toBe(1);
      expect(yield* countRows("revision_parents")).toBe(0);
      expect(yield* countRows("revision_trees")).toBe(1);
      expect(yield* countRows("revision_tree_entries")).toBe(skillTree.length);
      expect(yield* skits.revision({ params: { ...other, id: shared.id } })).toMatchObject({
        tree: History.sortTree(skillTree),
      });
    }),
  ),
);
