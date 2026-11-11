import { pinnedCollections } from "./storybook-fixtures.js";
import { Effect, FileSystem, Layer, Ref, Schema } from "effect";
import { Digest } from "effect/crypto";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import { join } from "node:path";
import * as History from "@smolai/skit-core/history";
import {
  CurrentMoveRequest,
  RevisionPage,
  RevisionPostRequest,
  RevisionReadResponse,
  SkitCreateRequest,
  releasePublishRequestSchema,
} from "@smolai/skit-core/universal/authoring";
import { registryHttpLayer } from "../registry/registry-http.js";

/** The fixture Registry's origin; its credential is given to the journey alone. */
export const authorPublishOrigin = "https://registry.example";
const prefix = "/api/skits/swyx/skill-cutter";

interface StoredRevision {
  readonly id: History.RevisionId;
  readonly revision: History.Revision;
  readonly tree: History.Tree;
}

interface RegistryState {
  readonly visibility?: string;
  readonly requestId?: string;
  readonly current: History.RevisionId | null;
  readonly revisions: ReadonlyArray<StoredRevision>;
  readonly releases: ReadonlyArray<string>;
}

/**
 * One SKIT, `swyx/skill-cutter`, on an in-memory Registry: create, revisions, a compare-and-swap
 * `current` pointer and immutable releases. It checks parents and versions like the Registry, but
 * not validation, authorization or storage.
 */
const makeAuthorRegistry = Effect.gen(function* () {
  const digest = yield* Digest.Digest;
  const skit = yield* Ref.make<RegistryState | undefined>(undefined);
  const read = <S extends Schema.Top>(schema: S, request: HttpClientRequest.HttpClientRequest) =>
    Schema.decodeEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(
      request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "",
    );
  const notFound = () => Response.json({ error: "skit_not_found" }, { status: 404 });
  return HttpClient.make((request, url) =>
    Effect.gen(function* () {
      const path = url.pathname;
      const state = yield* Ref.get(skit);
      let response: Response;
      if (path.startsWith("/.well-known/")) {
        response = new Response(null, { status: 404 });
      } else if (request.method === "POST" && path === "/api/skits") {
        const input = yield* read(SkitCreateRequest, request);
        const replay =
          state !== undefined &&
          input.request_id !== undefined &&
          state.requestId === input.request_id;
        if (state === undefined)
          yield* Ref.set(skit, {
            visibility: input.visibility,
            requestId: input.request_id,
            current: null,
            revisions: [],
            releases: [],
          });
        response =
          state === undefined || replay
            ? Response.json({ skit_id: "swyx/skill-cutter" }, { status: 201 })
            : Response.json({ error: "skit_exists" }, { status: 409 });
      } else if (state === undefined) {
        response = notFound();
      } else if (request.method === "GET" && path === `${prefix}/current`) {
        response = Response.json({
          skit_id: "swyx/skill-cutter",
          current: state.current,
          visibility: state.visibility,
        });
      } else if (request.method === "POST" && path === `${prefix}/revisions`) {
        const input = yield* read(RevisionPostRequest, request);
        const known = new Set(state.revisions.map((entry) => entry.id));
        if (input.revision.parents.some((parent) => !known.has(parent))) {
          response = Response.json({ error: "PARENT_MISSING" }, { status: 400 });
        } else {
          if (!known.has(input.id))
            yield* Ref.set(skit, {
              ...state,
              revisions: [
                ...state.revisions,
                { id: input.id, revision: input.revision, tree: input.tree },
              ],
            });
          response = Response.json({ id: input.id, diagnostics: [] });
        }
      } else if (request.method === "PUT" && path === `${prefix}/current`) {
        const input = yield* read(CurrentMoveRequest, request);
        if (!state.revisions.some((entry) => entry.id === input.id)) {
          response = Response.json({ error: "REVISION_MISSING" }, { status: 400 });
        } else if (state.current !== input.expected) {
          response = Response.json(
            { error: "REVISION_CONFLICT", current: state.current },
            { status: 409 },
          );
        } else {
          yield* Ref.set(skit, { ...state, current: input.id });
          response = Response.json({ id: input.id });
        }
      } else if (request.method === "GET" && path.startsWith(`${prefix}/revisions/`)) {
        const id = decodeURIComponent(path.slice(`${prefix}/revisions/`.length));
        const found = state.revisions.find((entry) => entry.id === id);
        response =
          found === undefined
            ? notFound()
            : Response.json(
                yield* Schema.encodeEffect(Schema.toCodecJson(RevisionReadResponse))({
                  revision: found.revision,
                  tree: found.tree,
                  diagnostics: [],
                  descriptor: null,
                }),
              );
      } else if (request.method === "GET" && path === `${prefix}/revisions`) {
        // Every revision reachable from `ancestors`, breadth first, on one page.
        const reached: StoredRevision[] = [];
        const queue = [url.searchParams.get("ancestors") ?? ""];
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          const entry = state.revisions.find((candidate) => candidate.id === next);
          if (entry === undefined || reached.includes(entry)) continue;
          reached.push(entry);
          queue.push(...entry.revision.parents);
        }
        response =
          reached.length === 0
            ? notFound()
            : Response.json(
                yield* Schema.encodeEffect(Schema.toCodecJson(RevisionPage))({
                  revisions: reached.map(({ id, revision }) => ({
                    id,
                    revision,
                    diagnostics: [],
                  })),
                  next_cursor: null,
                }),
              );
      } else if (request.method === "POST" && path === `${prefix}/releases`) {
        const input = yield* read(releasePublishRequestSchema, request);
        if (state.current === null) {
          response = Response.json({ error: "CURRENT_REVISION_MISSING" }, { status: 409 });
        } else if (state.releases.includes(input.version)) {
          response = Response.json({ error: "release_exists" }, { status: 409 });
        } else {
          yield* Ref.set(skit, { ...state, releases: [...state.releases, input.version] });
          const hex = yield* digest.digestHex(
            Digest.sha256,
            Buffer.from(input.archive_base64, "base64"),
          );
          response = Response.json(
            {
              release: {
                release_id: `release_${input.version}`,
                version: input.version,
                revision_id: state.current,
                archive_digest: `sha256:${hex}`,
                download_path: `${prefix}/releases/${input.version}/archive`,
              },
            },
            { status: 201 },
          );
        }
      } else {
        response = new Response(`Unexpected fixture request: ${request.method} ${path}`, {
          status: 501,
        });
      }
      return HttpClientResponse.fromWeb(request, response);
    }).pipe(Effect.orDie),
  );
});

/**
 * A disposable author: a folder holding swyxio/skills' skill-cutter, pinned in
 * test/fixtures/collections/manifest.json, an empty SKIT home and agent account, and an empty
 * in-memory Registry.
 */
export const makeAuthorPublishFixture = Effect.fn("Storybook.makeAuthorPublishFixture")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const collections = yield* pinnedCollections;
  const workspace = join(root, "skill-cutter");
  yield* fs.makeDirectory(join(workspace, "skills"), { recursive: true });
  yield* fs.copy(
    join(collections, "swyxio", "skill-cutter"),
    join(workspace, "skills", "skill-cutter"),
  );
  return {
    workspace,
    home: join(root, "skit-home"),
    account: join(root, "account"),
    registry: registryHttpLayer(Layer.succeed(HttpClient.HttpClient, yield* makeAuthorRegistry)),
  };
});
