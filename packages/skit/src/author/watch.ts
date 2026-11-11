import * as Library from "../library/library.js";
import * as MachineSettings from "../library/machine-settings.js";
import { LibraryAuditInvalid } from "../library/audit/failures.js";
import { RestoreInvalid } from "../library/restore-failures.js";
import { UpdateFailure } from "../library/update-failures.js";
import { ImportFailure } from "../library/import-failures.js";
import { PluginFailure } from "../sources/plugin-failures.js";
import { DedicatedInstallerRequired } from "../sources/installer-guidance.js";
import { PnpmSkillManaged } from "../installed-skills/pnpm-failures.js";
import { SourceRestoreInvalid } from "../library/source-restore-failures.js";
import { SourceFetchFailure } from "../sources/fetch-failures.js";
import { MachineSettingsFailure } from "../library/machine-settings-failures.js";
import { AuthoredSkillIssue } from "../library/authored-skill-issues.js";
import { Effect, FileSystem, Option, Ref, Schedule, Schema, Stream } from "effect";
import { SchemaFailure } from "../shared/schema-issue.js";
import { isAbsolute, relative } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AuthorHistoryFailure } from "./history-failures.js";
import { WorkspaceFailure } from "./workspace-contracts.js";
import { AuthorFailure } from "./failures.js";
import { StoreError } from "../history/history.js";
import { SyncFailure } from "../sync/failures.js";
import { SkitContractError } from "../api/contracts.js";
import { ApplyFailure } from "../library/apply-failure.js";
import { SourceFailure } from "../sources/failures.js";
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

export const AuthorWatchRetrying = Schema.Struct({
  event: Schema.Literal("retrying"),
  operation: Schema.Literals(["observe", "install", "sync", "events"]),
  failure: Schema.Union([
    AuthorHistoryFailure,
    WorkspaceFailure,
    AuthorFailure,
    StoreError,
    SyncFailure,
    SkitContractError,
    ApplyFailure,
    MachineSettingsFailure,
    SourceFailure,
    SourceFetchFailure,
    LibraryAuditInvalid,
    RestoreInvalid,
    UpdateFailure,
    ImportFailure,
    PluginFailure,
    DedicatedInstallerRequired,
    PnpmSkillManaged,
    SourceRestoreInvalid,
    SchemaFailure,
    // Registry transports and filesystem event streams can fail with native errors.
    Schema.Defect(),
  ]),
});

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
    issues: Schema.Array(AuthoredSkillIssue),
    context: Schema.optionalKey(AuthoredInstallation),
  }),
  Schema.Struct({
    event: Schema.Literal("recovered"),
    operation: Schema.Literals(["observe", "install", "sync", "events"]),
  }),
  AuthorWatchRetrying,
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
      reason: { _tag: "WatchedRootReplaced" },
    });
  if (Option.isNone(native)) return yield* unsafe();
  const original = native.value;
  const previous = yield* Ref.make<{ id: string; tree: readonly TreeEntry[] } | undefined>(
    undefined,
  );
  const failures = yield* Ref.make(new Map<string, unknown>());
  const sameEntry = Option.makeEquivalence(Schema.toEquivalence(TreeEntry));
  const previousSync = yield* Ref.make<string | undefined>(undefined);
  const library = yield* Library.Service;
  let installedInputs: string | undefined;
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
      if (operation === "observe" || operation === "install") {
        installedInputs = undefined;
        yield* history.inventory.reset(root);
      }
      const changed = yield* Ref.modify(
        failures,
        (current) =>
          [
            !current.has(operation) || !isDeepStrictEqual(current.get(operation), error),
            new Map(current).set(operation, error),
          ] as const,
      );
      if (changed) yield* report({ event: "retrying", operation, failure: error });
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
    const saved = yield* Ref.get(previous);
    const inputs = JSON.stringify({
      revision: saved?.id,
      library: (yield* library.read).revision,
      settings: yield* MachineSettings.read(options.home),
    });
    if (inputs === installedInputs) return;
    const result = yield* updateAuthoredSkills(root);
    // Pending removals and failed/conflicted copies still need retries without a file edit.
    installedInputs =
      result.issues.length === 0 &&
      result.status === "unchanged" &&
      result.revision_id === saved?.id
        ? inputs
        : undefined;
    const current = {
      issues: JSON.stringify({
        status: result.status === "updated" ? "unchanged" : result.status,
        issues: result.issues,
      }),
      configuration: JSON.stringify("context" in result ? result.context : undefined),
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
    const result = yield* syncAuthorWorkspace(
      root,
      { home: options.home, apply: true, confirmRemovals: false },
      registry,
    );
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
