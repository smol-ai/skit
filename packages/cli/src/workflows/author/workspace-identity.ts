import { LibraryStore, withLibraryWriter } from "@smolai/skit-core";
import { Effect, FileSystem } from "effect";
import { resolve } from "node:path";
import {
  planAuthorWorkspace,
  prepareAuthorWorkspaceMetadata,
  writeAuthorWorkspace,
  type AuthorWorkspaceOptions,
} from "../../library/author-workspace.js";
import { refreshAuthorHistory } from "./history.js";

/**
 * Establish only identity and initial raw recovery history. Live per-skill import
 * will consume this connection; it must not make backup depend on valid content.
 */
export const ensureAuthorWorkspaceIdentity = Effect.fn("Author.ensureWorkspaceIdentity")(function* (
  input: string,
  options: Pick<AuthorWorkspaceOptions, "register" | "workspaceId"> = {},
) {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.realPath(resolve(input));
  const store = yield* LibraryStore;
  return yield* withLibraryWriter(
    Effect.gen(function* () {
      const plan = yield* planAuthorWorkspace(root, yield* store.load, options);
      if (plan.workspace.registration === "removed" && !options.register)
        return { status: "removed" as const, root, workspace_id: plan.workspace.workspace_id };
      yield* prepareAuthorWorkspaceMetadata(root, plan);
      // The existing journal owns ID/root aliases and rejects a live copied ID,
      // including before this workspace has any valid Library Collection.
      const saved = yield* refreshAuthorHistory(root, store.home);
      yield* writeAuthorWorkspace(root, { ...plan.workspace, registration: "registered" });
      return {
        status: "ready" as const,
        root,
        workspace_id: plan.workspace.workspace_id,
        revision_id: saved.id,
      };
    }),
  );
});
