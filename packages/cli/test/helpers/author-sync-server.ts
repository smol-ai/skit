import { NodeCrypto } from "@effect/platform-node";
import { Deferred, Effect, Ref, Schema } from "effect";
import { HttpClientError, type HttpClientRequest } from "effect/http";
import * as History from "@smolai/skit-core/history";
import {
  CurrentMoveRequest,
  SkitCreateRequest,
  RevisionPage,
  RevisionPostRequest,
  RevisionReadResponse,
} from "@smolai/skit-core/universal/authoring";
import type { TestHttpHandler } from "./http-test-client.js";

export type AuthorDevice = "a" | "b" | "c";
type Boundary =
  | "before-create"
  | "after-create"
  | "before-current"
  | "before-post"
  | "after-post"
  | "before-move"
  | "after-move";
type Fault = {
  readonly device: AuthorDevice;
  readonly boundary: Boundary;
  readonly action:
    | { readonly kind: "drop-response" }
    | {
        readonly kind: "gate";
        readonly entered: Deferred.Deferred<void>;
        readonly released: Deferred.Deferred<void>;
      };
};

/** A revision the server recorded, and the device whose credential posted it. */
export interface StoredRevision {
  readonly id: History.RevisionId;
  readonly revision: History.Revision;
  readonly tree: History.Tree;
  readonly device: AuthorDevice;
}

const decode = <S extends Schema.Top>(schema: S, request: HttpClientRequest.HttpClientRequest) =>
  request.body._tag !== "Uint8Array"
    ? Effect.die(new Error("Expected an encoded SKIT request"))
    : Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.toCodecJson(schema)))(
        new TextDecoder().decode(request.body.body),
      ).pipe(Effect.orDie);

interface SkitState {
  readonly created: boolean;
  readonly requestId?: string;
  readonly visibility?: string;
  readonly current: History.RevisionId | null;
  readonly revisions: ReadonlyArray<StoredRevision>;
}

/**
 * A wire-level SKIT server for `swyx/tools`: revisions by identity and one `current` pointer.
 * It checks identities and parents like the Registry, but not validation, authorization, D1/R2
 * or crash durability; those need real server tests. It keeps every revision, so an independent
 * oracle can inspect what is recoverable.
 */
export const makeAuthorSyncServer = Effect.fn("Test.makeAuthorSyncServer")(function* () {
  const skit = yield* Ref.make<SkitState>({ created: false, current: null, revisions: [] });
  const offline = yield* Ref.make<ReadonlySet<AuthorDevice>>(new Set());
  const faults = yield* Ref.make<ReadonlyArray<Fault>>([]);
  const events = yield* Ref.make<ReadonlyArray<string>>([]);

  // An unused injection is a test error: it cannot count as exercising a failure boundary.
  yield* Effect.addFinalizer(() =>
    Ref.get(faults).pipe(
      Effect.flatMap((pending) =>
        pending.length === 0
          ? Effect.void
          : Effect.die(
              new Error(
                `Unreached author-sync faults: ${JSON.stringify(pending.map(({ device, boundary }) => ({ device, boundary })))}`,
              ),
            ),
      ),
    ),
  );

  const transportError = (request: HttpClientRequest.HttpClientRequest) =>
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({ request, cause: "Injected disconnection" }),
    });

  const checkpoint = Effect.fn("Test.authorSyncCheckpoint")(function* (
    device: AuthorDevice,
    boundary: Boundary,
    request: HttpClientRequest.HttpClientRequest,
  ) {
    yield* Ref.update(events, (items) => [...items, `${device}:${boundary}`]);
    const fault = yield* Ref.modify(faults, (pending) => {
      const index = pending.findIndex(
        (item) => item.device === device && item.boundary === boundary,
      );
      return index < 0
        ? [undefined, pending]
        : [pending[index], pending.filter((_, position) => position !== index)];
    });
    if (fault?.action.kind === "drop-response") return yield* transportError(request);
    if (fault?.action.kind === "gate") {
      yield* Deferred.succeed(fault.action.entered, undefined);
      yield* Deferred.await(fault.action.released);
    }
  });

  const notFound = () => Response.json({ error: "skit_not_found" }, { status: 404 });
  const prefix = "/api/skits/swyx/tools";

  const transport = (device: AuthorDevice): TestHttpHandler =>
    Effect.fn("Test.authorSyncTransport")(function* (request, url) {
      if ((yield* Ref.get(offline)).has(device)) return yield* transportError(request);
      const state = yield* Ref.get(skit);
      if (request.method === "POST" && url.pathname === "/api/skits") {
        const input = yield* decode(SkitCreateRequest, request);
        yield* checkpoint(device, "before-create", request);
        const accepted = yield* Ref.modify(skit, (current) => [
          !current.created ||
            (input.request_id !== undefined &&
              current.requestId === input.request_id &&
              current.visibility === input.visibility),
          current.created
            ? current
            : {
                ...current,
                created: true,
                requestId: input.request_id,
                visibility: input.visibility,
              },
        ]);
        if (!accepted) return Response.json({ error: "skit_exists" }, { status: 409 });
        yield* checkpoint(device, "after-create", request);
        return Response.json({ skit_id: "swyx/tools" }, { status: 201 });
      }
      if (!state.created) return notFound();
      if (request.method === "GET" && url.pathname === `${prefix}/current`) {
        yield* checkpoint(device, "before-current", request);
        const { current } = yield* Ref.get(skit);
        return Response.json({ skit_id: "swyx/tools", current, visibility: "private" });
      }
      if (request.method === "POST" && url.pathname === `${prefix}/revisions`) {
        const input = yield* decode(RevisionPostRequest, request);
        yield* checkpoint(device, "before-post", request);
        const [tree, id] = yield* Effect.all([
          History.treeHash(input.tree),
          History.revisionId(input.revision),
        ]).pipe(Effect.provide(NodeCrypto.layerDigest));
        if (tree !== input.revision.tree || id !== input.id)
          return Response.json({ error: "REVISION_ID_MISMATCH" }, { status: 400 });
        const response = yield* Ref.modify(skit, (current): [Response, SkitState] => {
          const known = new Set(current.revisions.map((entry) => entry.id));
          if (input.revision.parents.some((parent) => !known.has(parent)))
            return [Response.json({ error: "PARENT_MISSING" }, { status: 400 }), current];
          const response = Response.json({ id, diagnostics: [] });
          return known.has(id)
            ? [response, current]
            : [
                response,
                {
                  ...current,
                  revisions: [
                    ...current.revisions,
                    { id, revision: input.revision, tree: History.sortTree(input.tree), device },
                  ],
                },
              ];
        });
        if (response.ok) yield* checkpoint(device, "after-post", request);
        return response;
      }
      if (request.method === "PUT" && url.pathname === `${prefix}/current`) {
        const input = yield* decode(CurrentMoveRequest, request);
        yield* checkpoint(device, "before-move", request);
        // One synchronous Ref.modify is the server's compare-and-swap boundary.
        const response = yield* Ref.modify(skit, (current): [Response, SkitState] => {
          if (!current.revisions.some((entry) => entry.id === input.id))
            return [Response.json({ error: "REVISION_MISSING" }, { status: 400 }), current];
          if (current.current !== input.expected)
            return [
              Response.json(
                { error: "REVISION_CONFLICT", current: current.current },
                { status: 409 },
              ),
              current,
            ];
          return [Response.json({ id: input.id }), { ...current, current: input.id }];
        });
        if (response.ok) yield* checkpoint(device, "after-move", request);
        return response;
      }
      const byId = new Map<string, StoredRevision>(
        state.revisions.map((entry) => [entry.id, entry]),
      );
      if (request.method === "GET" && url.pathname.startsWith(`${prefix}/revisions/`)) {
        const found = byId.get(
          decodeURIComponent(url.pathname.slice(`${prefix}/revisions/`.length)),
        );
        return found === undefined
          ? notFound()
          : Response.json(
              Schema.encodeSync(Schema.toCodecJson(RevisionReadResponse))({
                revision: found.revision,
                tree: found.tree,
                diagnostics: [],
                descriptor: null,
              }),
            );
      }
      if (request.method === "GET" && url.pathname === `${prefix}/revisions`) {
        const start = url.searchParams.get("ancestors") ?? "";
        if (!byId.has(start)) return notFound();
        // Breadth first from `start`, each revision once, as the Registry pages them.
        const reach = (
          queue: ReadonlyArray<string>,
          seen: ReadonlyArray<StoredRevision>,
        ): ReadonlyArray<StoredRevision> => {
          const [next, ...rest] = queue;
          if (next === undefined) return seen;
          const entry = byId.get(next);
          return entry === undefined || seen.includes(entry)
            ? reach(rest, seen)
            : reach([...rest, ...entry.revision.parents], [...seen, entry]);
        };
        const order = reach([start], []);
        const offset = Number(url.searchParams.get("cursor") ?? "0");
        const page = order.slice(offset, offset + 2);
        return Response.json(
          Schema.encodeSync(Schema.toCodecJson(RevisionPage))({
            revisions: page.map(({ id, revision }) => ({ id, revision, diagnostics: [] })),
            next_cursor: offset + 2 < order.length ? String(offset + 2) : null,
          }),
        );
      }
      return yield* Effect.die(new Error(`Unexpected SKIT request: ${request.method} ${url}`));
    });

  return {
    transport,
    /** Every revision the server recorded, in the order it first accepted them. */
    revisions: () => Ref.get(skit).pipe(Effect.map((state) => state.revisions)),
    /** Only current's ancestry, in acceptance order; archival observations remain in revisions(). */
    currentHistory: () =>
      Ref.get(skit).pipe(
        Effect.map((state) => {
          const revisions = new Map(state.revisions.map((revision) => [revision.id, revision]));
          const seen = new Set<History.RevisionId>();
          const pending = state.current === null ? [] : [state.current];
          for (let index = 0; index < pending.length; index++) {
            const id = pending[index]!;
            if (seen.has(id)) continue;
            seen.add(id);
            pending.push(...(revisions.get(id)?.revision.parents ?? []));
          }
          return state.revisions.filter(({ id }) => seen.has(id));
        }),
      ),
    current: () => Ref.get(skit).pipe(Effect.map((state) => state.current)),
    events: () => Ref.get(events),
    setOnline: (device: AuthorDevice, online: boolean) =>
      Ref.update(offline, (devices) => {
        const next = new Set(devices);
        if (online) next.delete(device);
        else next.add(device);
        return next;
      }),
    /** The next request at `boundary` takes effect, but its response is lost. */
    dropNextResponse: (device: AuthorDevice, boundary: Boundary = "after-move") =>
      Ref.update(faults, (pending): ReadonlyArray<Fault> => [
        ...pending,
        { device, boundary, action: { kind: "drop-response" } },
      ]),
    gate: Effect.fn("Test.gateAuthorSync")(function* (device: AuthorDevice, boundary: Boundary) {
      const entered = yield* Deferred.make<void>();
      const released = yield* Deferred.make<void>();
      yield* Ref.update(faults, (pending): ReadonlyArray<Fault> => [
        ...pending,
        { device, boundary, action: { kind: "gate", entered, released } },
      ]);
      return {
        reached: () => Deferred.await(entered),
        release: () => Deferred.succeed(released, undefined),
      };
    }),
  };
});
