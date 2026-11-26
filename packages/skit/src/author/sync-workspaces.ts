import { Effect, FileSystem, Option, Path, Result } from "effect";
import * as Library from "../library/library.js";
import { AuthorHistory } from "./history.js";
import { AuthorWorkspace } from "./workspace.js";
import { parseAuthorDestination, skitLocator } from "./destination.js";
import { pullAuthorSkit } from "./pull.js";
import { syncAuthorWorkspace } from "./sync.js";
import { updateAuthorWorkspace } from "./operations.js";
import type { AuthorRegistry } from "./transport.js";

export const syncAuthorWorkspaces = Effect.fn("Author.syncWorkspaces")(function* <
  E,
  R,
  P,
  ListError,
  ListRequirements,
>(
  {
    home,
    userHome,
    apply,
  }: { readonly home: string; readonly userHome: string; readonly apply: boolean },
  registry: Pick<AuthorRegistry<E, R, P>, "origin" | "connect"> &
    Pick<AuthorRegistry<ListError, ListRequirements>, "list">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const history = yield* AuthorHistory;
  const workspaces = yield* AuthorWorkspace;
  const library = yield* Library.Service;
  const seen = new Set<string>();
  const syncRecorded = Effect.fn("Author.syncRecordedWorkspace")(function* (
    entry: Effect.Success<typeof history.workspaces>[number],
  ) {
    let identity: string = entry.workspace_id;
    const outcome = yield* Effect.gen(function* () {
      if (!(yield* fs.exists(entry.root))) return undefined;
      const root = yield* workspaces.resolveRoot(entry.root);
      if (root !== entry.root) return undefined;
      const registered = yield* workspaces.readIdentity(root);
      if (Option.getOrUndefined(registered)?.workspaceId !== entry.workspace_id) return undefined;
      const workspace = yield* workspaces.read(root);
      if (workspace.connection._tag === "Connected") {
        identity = skitLocator(workspace.connection.remote);
        seen.add(identity);
      }
      const claims = yield* library.workspaceClaims(root);
      const imported = claims.atRoot.some((claim) => claim.workspaceId === entry.workspace_id);
      if (!imported && workspace.connection._tag !== "Connected") return undefined;
      if (!apply && workspace.connection._tag === "Unconnected")
        return { status: "unconnected" as const };
      if (!apply)
        return {
          status: "sync" as const,
          sync: yield* syncAuthorWorkspace(root, { home, apply: false, readOnly: true }, registry),
        };

      const lease = yield* workspaces.acquire(root);
      const current = yield* workspaces.read(root);
      if (Option.getOrUndefined(current.identity)?.workspaceId !== entry.workspace_id)
        return undefined;
      if (!imported)
        return {
          status: "sync" as const,
          sync: yield* syncAuthorWorkspace(root, { home, apply: true }, registry, lease),
        };

      const updated = yield* updateAuthorWorkspace(root, { home }, registry, lease);
      return {
        status: "updated" as const,
        ...(updated.installation._tag === "Failure"
          ? { installation_failure: updated.installation.failure }
          : {
              installation: updated.installation.success.status,
              installation_issues: updated.installation.success.issues,
              ...("installation_error" in updated && updated.installation_error
                ? { installation_failure: updated.installation_error }
                : {}),
            }),
        ...(updated.sync?._tag === "Failure"
          ? { sync_failure: updated.sync.failure }
          : updated.sync === undefined
            ? {}
            : { sync: updated.sync.success }),
      };
    }).pipe(Effect.scoped, Effect.result);
    if (Result.isFailure(outcome))
      return {
        identity,
        directory: entry.root,
        status: "failed" as const,
        failure: outcome.failure,
      };
    return outcome.success === undefined
      ? undefined
      : { identity, directory: entry.root, ...outcome.success };
  });

  const recorded = yield* history.workspaces.pipe(Effect.result);
  if (Result.isFailure(recorded))
    return { author_workspaces: [], author_inventory_failure: recorded.failure };
  const folders = (yield* Effect.forEach(recorded.success, syncRecorded)).filter(
    (folder) => folder !== undefined,
  );
  const inventory = yield* registry.list.pipe(Effect.result);
  if (Result.isFailure(inventory))
    return { author_workspaces: folders, author_inventory_failure: inventory.failure };
  const locators = yield* history.syncLocators.pipe(Effect.result);
  if (Result.isFailure(locators))
    return { author_workspaces: folders, author_inventory_failure: locators.failure };
  for (const locator of locators.success) seen.add(locator);
  const pulledFolders = yield* Effect.forEach(inventory.success.skits, (skit) =>
    Effect.gen(function* () {
      if (skit.current_revision_id === null) return undefined;
      const remote = yield* parseAuthorDestination(skit.skit_id, inventory.success.origin).pipe(
        Effect.result,
      );
      if (Result.isFailure(remote)) {
        return { identity: skit.skit_id, status: "failed" as const, failure: remote.failure };
      }
      const identity = skitLocator(remote.success);
      if (seen.has(identity)) return undefined;
      const directory = path.join(
        userHome,
        "skit",
        new URL(remote.success.origin).host.replaceAll(":", "_"),
        remote.success.namespace,
        remote.success.skit,
      );
      if (!apply) {
        return { identity, directory, status: "pull_ready" as const };
      }
      const pulled = yield* pullAuthorSkit(remote.success, { directory, home }, registry).pipe(
        Effect.result,
      );
      seen.add(identity);
      return Result.isFailure(pulled)
        ? { identity, directory, status: "failed" as const, failure: pulled.failure }
        : {
            identity,
            directory: pulled.success.directory,
            status: "pulled" as const,
            revision_id: pulled.success.revision_id,
          };
    }),
  );
  return {
    author_workspaces: [...folders, ...pulledFolders.filter((folder) => folder !== undefined)],
  };
});
