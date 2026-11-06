import { AuthorWorkspace } from "./workspace.js";
import { openRemoveSession } from "../library/session.js";
import { Effect, Option } from "effect";

export interface RemoveOptions {
  readonly query: string;
  readonly dryRun: boolean;
}

export const removeAuthorCollection = Effect.fn("Author.removeCollection")(function* (
  home: string,
  options: RemoveOptions,
) {
  const selection = yield* openRemoveSession(home, options.query);
  if (options.dryRun) return { kind: "plan" as const, value: selection.summary };
  const remove = selection.apply();
  // A15: Author composes Library removal with the AuthorWorkspace lease and registration.
  const workspaces = yield* AuthorWorkspace;
  const root =
    selection.workspace?.path === undefined
      ? Option.none()
      : yield* workspaces.resolveRoot(selection.workspace.path).pipe(
          Effect.map(Option.some),
          Effect.catchTag("AuthorWorkspaceRootInvalid", () => Effect.succeedNone),
        );
  const outcome = Option.isNone(root)
    ? yield* remove
    : yield* Effect.scoped(
        Effect.gen(function* () {
          const lease = yield* workspaces.acquire(root.value);
          const identity = yield* workspaces.readIdentity(root.value);
          if (
            Option.isNone(identity) ||
            identity.value.workspaceId !== selection.workspace?.workspaceId
          )
            return yield* remove;
          const { registration } = identity.value;
          const removing =
            registration === "IdentityOnly" || registration === "Registered"
              ? yield* lease.register({ from: { ...identity.value, registration }, to: "Removing" })
              : identity.value;
          const removed = yield* remove;
          if (removing.registration === "Removing")
            yield* lease.register({
              from: { ...removing, registration: "Removing" },
              to: "Removed",
            });
          return removed;
        }),
      );
  return { kind: "removed" as const, value: outcome };
});
