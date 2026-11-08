import { Effect, FileSystem, Option, Ref, Schedule, Schema, Stream } from "effect";
import { AuthorWorkspace, AuthorWorkspaceUnsafe } from "./workspace.js";
import { AuthorHistory } from "./history.js";
import { NoRemoteHome } from "./failures.js";
import { nativeIdentityOf, sameNativeIdentity } from "../artifact/tree.js";
import { AuthorSyncResult } from "./sync-result.js";
import { syncAuthorWorkspace } from "./sync.js";
import { makeRemovalGrace } from "./removal-grace.js";
import type { AuthorRegistry } from "./transport.js";

export const AuthorWatchEvent = Schema.Union([
  Schema.Struct({ event: Schema.Literal("watching"), path: Schema.String }),
  Schema.Struct({ event: Schema.Literal("saved_locally"), revision_id: Schema.String }),
  Schema.Struct({ event: Schema.Literal("sync"), result: AuthorSyncResult }),
  Schema.Struct({
    event: Schema.Literal("retrying"),
    operation: Schema.Literals(["observe", "sync", "events"]),
    message: Schema.String,
  }),
]);
export type AuthorWatchEvent = typeof AuthorWatchEvent.Type;

/**
 * One connected workspace's foreground lifetime. Event hints and rescans save observations
 * independently of bounded network passes. Only sync owns the workspace lease and file writes.
 */
export const watchAuthorWorkspace = Effect.fn("Author.watch")(function* <E, R, P, R2>(
  input: string,
  options: { readonly home: string },
  registry: Pick<AuthorRegistry<E, R, P>, "origin" | "connect">,
  report: (event: AuthorWatchEvent) => Effect.Effect<void, never, R2>,
) {
  const fs = yield* FileSystem.FileSystem;
  const workspaces = yield* AuthorWorkspace;
  const history = yield* AuthorHistory;
  const root = yield* workspaces.resolveRoot(input);
  const initial = yield* workspaces.read(root);
  if (initial.connection._tag !== "Connected" || Option.isNone(initial.identity))
    return yield* new NoRemoteHome();
  const remote = initial.connection.remote;
  const workspaceId = initial.identity.value.workspaceId;
  const native = nativeIdentityOf(yield* fs.stat(root));
  const unsafe = () =>
    new AuthorWorkspaceUnsafe({
      path: root,
      reason: "the watched workspace was replaced; restart watch after checking it",
    });
  if (Option.isNone(native)) return yield* unsafe();
  const original = native.value;
  const grace = makeRemovalGrace();
  const previous = yield* Ref.make<string | undefined>(undefined);
  const previousSync = yield* Ref.make<string | undefined>(undefined);
  const checkRoot = Effect.gen(function* () {
    if ((yield* fs.realPath(root)) !== root) return yield* unsafe();
    const current = nativeIdentityOf(yield* fs.stat(root));
    const identity = yield* workspaces.readIdentity(root);
    if (
      !Option.exists(current, (value) => sameNativeIdentity(original, value)) ||
      !Option.exists(identity, (value) => value.workspaceId === workspaceId)
    )
      return yield* unsafe();
  });
  const retrying = (operation: "observe" | "sync" | "events", error: unknown) =>
    grace.reset.pipe(
      Effect.andThen(
        report({
          event: "retrying",
          operation,
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  const observe = Effect.gen(function* () {
    yield* checkRoot;
    const saved = yield* history.refresh(root);
    if ((yield* Ref.getAndSet(previous, saved.id)) !== saved.id)
      yield* report({ event: "saved_locally", revision_id: saved.id });
  }).pipe(Effect.catch((error) => retrying("observe", error)));
  const synchronize = Effect.gen(function* () {
    yield* checkRoot;
    const workspace = yield* workspaces.read(root);
    if (
      workspace.connection._tag !== "Connected" ||
      workspace.connection.remote.origin !== remote.origin ||
      workspace.connection.remote.namespace !== remote.namespace ||
      workspace.connection.remote.skit !== remote.skit
    )
      return yield* unsafe();
    const result = yield* syncAuthorWorkspace(
      root,
      { home: options.home, apply: true, removalGrace: grace },
      registry,
    );
    if ((yield* Ref.getAndSet(previousSync, JSON.stringify(result))) !== JSON.stringify(result))
      yield* report({ event: "sync", result });
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.catch((error) => retrying("sync", error)),
  );
  // Controls/history writes must not retrigger content capture. Periodic rescans also heal
  // missed events, replaced roots and a backend whose native watch temporarily fails.
  const events = fs.watch(root, { recursive: true }).pipe(
    Stream.filter((event) => {
      const path = event.path.replaceAll("\\", "/");
      return (
        path !== ".skit" &&
        !path.startsWith(".skit/") &&
        path !== ".git" &&
        !path.startsWith(".git/") &&
        path !== "skit.remote.json"
      );
    }),
    Stream.debounce("100 millis"),
    Stream.map(() => undefined),
    Stream.catch((error) =>
      Stream.fromEffect(retrying("events", error)).pipe(
        Stream.concat(Stream.fromEffect(Effect.sleep("1 second"))),
      ),
    ),
    Stream.forever,
  );
  yield* report({ event: "watching", path: root });
  yield* observe;
  yield* events.pipe(
    Stream.merge(Stream.tick("1 second")),
    Stream.buffer({ capacity: 1, strategy: "sliding" }),
    Stream.runForEach(() => observe),
    Effect.forkScoped,
  );
  return yield* synchronize.pipe(Effect.repeat(Schedule.spaced("3 seconds")));
}, Effect.scoped);
