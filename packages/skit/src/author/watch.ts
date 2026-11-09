import { Effect, FileSystem, Option, Ref, Schedule, Schema, Stream } from "effect";
import { isAbsolute, relative } from "node:path";
import { AuthorWorkspace, AuthorWorkspaceUnsafe } from "./workspace.js";
import { AuthorHistory } from "./history.js";
import { NoRemoteHome } from "./failures.js";
import { nativeIdentityOf, sameNativeIdentity } from "../artifact/tree.js";
import { AuthorSyncResult } from "./sync-result.js";
import { syncAuthorWorkspace } from "./sync.js";
import type { AuthorRegistry } from "./transport.js";
import { updateAuthoredSkills } from "./operations.js";
import { TreeEntry } from "../artifact/tree-entry.js";
import { AuthoredInstallation, AuthoredInstalledCopy } from "../library/update-authored-skills.js";

export const AuthorWatchEvent = Schema.Union([
  Schema.Struct({ event: Schema.Literal("watching"), path: Schema.String }),
  Schema.Struct({
    event: Schema.Literal("saved_locally"),
    revision_id: Schema.String,
    trigger: Schema.Literals(["filesystem", "rescan"]),
    paths: Schema.Array(Schema.String),
  }),
  Schema.Struct({ event: Schema.Literal("sync"), result: AuthorSyncResult }),
  Schema.Struct({
    event: Schema.Literal("installation"),
    path: Schema.String,
    reason: Schema.Literals([
      "startup",
      "copies-updated",
      "issues-changed",
      "configuration-changed",
    ]),
    revision_id: Schema.optionalKey(Schema.String),
    status: Schema.Literals(["unregistered", "held", "unchanged", "updated"]),
    installed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    installed_copies: Schema.Array(AuthoredInstalledCopy),
    messages: Schema.Array(Schema.String),
    context: Schema.optionalKey(AuthoredInstallation),
  }),
  Schema.Struct({
    event: Schema.Literal("recovered"),
    operation: Schema.Literals(["observe", "install", "sync", "events"]),
  }),
  Schema.Struct({
    event: Schema.Literal("retrying"),
    operation: Schema.Literals(["observe", "install", "sync", "events"]),
    message: Schema.String,
  }),
]);
export type AuthorWatchEvent = typeof AuthorWatchEvent.Type;

/**
 * One connected workspace's foreground lifetime. Event hints and rescans save observations
 * independently of bounded network passes. One foreground loop orders installation before sync;
 * a separate history-only observer can keep saving while that loop waits for the network.
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
  const previous = yield* Ref.make<{ id: string; tree: readonly TreeEntry[] } | undefined>(
    undefined,
  );
  const failures = yield* Ref.make(new Map<string, string>());
  const sameEntry = Option.makeEquivalence(Schema.toEquivalence(TreeEntry));
  const previousSync = yield* Ref.make<string | undefined>(undefined);
  const previousInstall = yield* Ref.make<{ issues: string; configuration: string } | undefined>(
    undefined,
  );
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
  const recovered = (operation: "observe" | "install" | "sync" | "events") =>
    Effect.gen(function* () {
      const hadFailure = yield* Ref.modify(failures, (current) => {
        const next = new Map(current);
        next.delete(operation);
        return [current.has(operation), next] as const;
      });
      if (hadFailure) yield* report({ event: "recovered", operation });
    });
  const retrying = (operation: "observe" | "install" | "sync" | "events", error: unknown) =>
    Effect.gen(function* () {
      if (operation === "observe" || operation === "install") yield* history.inventory.reset(root);
      const message = error instanceof Error ? error.message : String(error);
      const changed = yield* Ref.modify(
        failures,
        (current) =>
          [current.get(operation) !== message, new Map(current).set(operation, message)] as const,
      );
      if (changed) yield* report({ event: "retrying", operation, message });
    });
  const observe = (trigger: "filesystem" | "rescan") =>
    Effect.gen(function* () {
      yield* checkRoot;
      const saved = yield* history.refresh(root);
      const before = yield* Ref.get(previous);
      if (before?.id !== saved.id) {
        const tree = yield* history.engineStore.tree(saved.treeHash);
        yield* Ref.set(previous, { id: saved.id, tree });
        if (before !== undefined) {
          const from = new Map(before.tree.map((entry) => [entry.path, entry]));
          const to = new Map(tree.map((entry) => [entry.path, entry]));
          const paths = [...new Set([...from.keys(), ...to.keys()])]
            .filter(
              (path) =>
                !sameEntry(
                  Option.fromNullishOr(from.get(path)),
                  Option.fromNullishOr(to.get(path)),
                ),
            )
            .sort();
          if (paths.length)
            yield* report({ event: "saved_locally", revision_id: saved.id, trigger, paths });
        }
      }
      yield* recovered("observe");
    }).pipe(Effect.catch((error) => retrying("observe", error)));
  const install = Effect.gen(function* () {
    yield* checkRoot;
    const result = yield* updateAuthoredSkills(root);
    const current = {
      issues: JSON.stringify({
        status: result.status === "updated" ? "unchanged" : result.status,
        messages: result.messages,
      }),
      configuration: JSON.stringify(result.context),
    };
    const before = yield* Ref.getAndSet(previousInstall, current);
    const reason =
      before === undefined
        ? ("startup" as const)
        : before.configuration !== current.configuration
          ? ("configuration-changed" as const)
          : result.installed > 0
            ? ("copies-updated" as const)
            : ("issues-changed" as const);
    if (
      result.installed > 0 ||
      before?.issues !== current.issues ||
      before?.configuration !== current.configuration
    )
      yield* report({ event: "installation", path: root, reason, ...result });
    yield* recovered("install");
  }).pipe(Effect.catch((error) => retrying("install", error)));
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
    const result = yield* syncAuthorWorkspace(root, { home: options.home, apply: true }, registry);
    const key = JSON.stringify(result);
    const before = yield* Ref.getAndSet(previousSync, key);
    if (result.status !== "up_to_date" && before !== key) yield* report({ event: "sync", result });
    yield* recovered("sync");
  }).pipe(
    Effect.timeout("30 seconds"),
    Effect.catch((error) => retrying("sync", error)),
  );
  // Controls/history writes must not retrigger content capture. Periodic rescans also heal
  // missed events, replaced roots and a backend whose native watch temporarily fails.
  const events = fs.watch(root, { recursive: true }).pipe(
    Stream.filter((event) => {
      const path = (isAbsolute(event.path) ? relative(root, event.path) : event.path).replaceAll(
        "\\",
        "/",
      );
      return (
        path !== ".skit" &&
        !path.startsWith(".skit/") &&
        path !== ".git" &&
        !path.startsWith(".git/") &&
        path !== "skit.remote.json"
      );
    }),
    Stream.debounce("100 millis"),
    Stream.tap(() => recovered("events")),
    Stream.map(() => "filesystem" as const),
    Stream.catch((error) =>
      Stream.fromEffect(
        retrying("events", error).pipe(
          Effect.andThen(Effect.sleep("1 second")),
          Effect.as("rescan" as const),
        ),
      ),
    ),
    Stream.forever,
  );
  yield* report({ event: "watching", path: root });
  yield* observe("rescan");
  yield* events.pipe(
    Stream.merge(Stream.tick("1 second").pipe(Stream.map(() => "rescan" as const))),
    Stream.buffer({ capacity: 1, strategy: "sliding" }),
    Stream.runForEach(observe),
    Effect.forkScoped,
  );
  return yield* install.pipe(
    Effect.andThen(synchronize),
    Effect.repeat(Schedule.spaced("3 seconds")),
  );
}, Effect.scoped);
