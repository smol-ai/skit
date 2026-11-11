import { Clock, Effect, Result, Schema } from "effect";
import type { TreeEntry } from "../artifact/tree-entry.js";
import {
  hasSkitReadmeDeclaration,
  parseSkitConfig,
  parseSkitReadme,
} from "../artifact/descriptor.js";

/** Inventory keys use the normalized paths consumed by sync and Library; history stays verbatim.
 * Accepted membership is independent of raw history and of the Registry checkpoint. */
export const AuthorInventory = Schema.Struct({
  files: Schema.Array(Schema.String),
  members: Schema.Array(Schema.String),
});
export type AuthorInventory = typeof AuthorInventory.Type;
export const AuthorRemovalState = Schema.Struct({
  inventory: AuthorInventory,
  removedFiles: Schema.Array(Schema.String),
  removedMembers: Schema.Array(Schema.String),
});
export type AuthorRemovalState = typeof AuthorRemovalState.Type;

export interface RemovalDecision {
  readonly status: "accepted" | "waiting" | "blocked";
  readonly heldFiles: readonly string[];
  readonly heldMembers: readonly string[];
  readonly inventory: AuthorInventory;
  readonly membershipReadable: boolean;
  readonly removedFiles: readonly string[];
  readonly removedMembers: readonly string[];
  readonly allowAllRemovals: boolean;
}

/** Decode only preserved bytes. A present directory without SKILL.md is invalid, not removed. */
export const scanAuthorInventory = Effect.fn("Author.scanInventory")(function* (
  tree: readonly TreeEntry[],
  previous: AuthorInventory | undefined,
) {
  const text = (path: string) => {
    const file = tree.find((entry) => entry.kind === "file" && entry.path === path);
    return file?.kind === "file" ? new TextDecoder().decode(file.bytes) : undefined;
  };
  const config = text("skit.json");
  const readme = text("README.md");
  const declared =
    config !== undefined || (readme !== undefined && hasSkitReadmeDeclaration(readme));
  const descriptor = declared
    ? yield* (config === undefined ? parseSkitReadme(readme!) : parseSkitConfig(config)).pipe(
        Effect.result,
      )
    : undefined;
  const membershipReadable = descriptor === undefined || Result.isSuccess(descriptor);
  const members =
    descriptor === undefined
      ? tree
          .filter((entry) => entry.kind === "file" && /^[^./][^/]*\/SKILL\.md$/.test(entry.path))
          .map((entry) => entry.path.slice(0, -9).normalize("NFC"))
      : Result.isSuccess(descriptor)
        ? descriptor.success.skills.map((skill) => skill.path.normalize("NFC"))
        : [...(previous?.members ?? [])];
  if (!declared)
    for (const member of previous?.members ?? [])
      if (
        !members.includes(member) &&
        tree.some((entry) => entry.path.normalize("NFC") === member && entry.kind === "directory")
      )
        members.push(member);
  return {
    inventory: {
      files: tree
        .filter((entry) => entry.kind !== "directory")
        .map((entry) => entry.path.normalize("NFC"))
        .sort(),
      members: members.sort(),
    },
    membershipReadable,
  };
});

const isBulkRemoval = (removed: number, known: number) =>
  removed > 0 && (removed === known || (removed > 5 && removed > known / 2));

type RemovalCheckState =
  | { readonly _tag: "Clear" }
  | { readonly _tag: "Confirming"; readonly key: string; readonly since: bigint }
  | { readonly _tag: "Blocked" }
  | { readonly _tag: "Unreadable" };

/** Only Confirming carries elapsed time; a pause cannot resume an earlier grace period. */
const checkMissingInputs = (
  state: RemovalCheckState,
  missing: { readonly key: string; readonly at: bigint; readonly bulk: boolean },
  allowLargeDeletion: boolean,
): RemovalCheckState => {
  if (allowLargeDeletion) return { _tag: "Clear" };
  if (missing.bulk) return { _tag: "Blocked" };
  switch (state._tag) {
    case "Confirming":
      if (state.key === missing.key)
        return missing.at - state.since >= 10_000_000_000n ? { _tag: "Clear" } : state;
      return { _tag: "Confirming", key: missing.key, since: missing.at };
    case "Clear":
    case "Blocked":
    case "Unreadable":
      return { _tag: "Confirming", key: missing.key, since: missing.at };
  }
};

/** Pending time belongs to this runtime only; restart and unreadability restart the grace.
 * Persistence of the accepted baseline belongs to AuthorHistory, under the workspace lease. */
export const makeRemovalCheck = () => {
  const checks = new Map<string, RemovalCheckState>();
  return {
    reset: (workspaceId: string) =>
      Effect.sync(() => {
        checks.delete(workspaceId);
      }),
    check: Effect.fn("Author.checkRemovals")(function* (
      workspaceId: string,
      previous: AuthorRemovalState | undefined,
      observed: { inventory: AuthorInventory; membershipReadable: boolean },
      allowLargeDeletion = false,
      known?: AuthorInventory,
    ) {
      const { inventory, membershipReadable } = observed;
      const baseline = {
        files: [
          ...new Set([
            ...(previous?.inventory.files ?? []),
            ...(known?.files ?? []).filter((path) => !previous?.removedFiles.includes(path)),
          ]),
        ],
        members: [
          ...new Set([
            ...(previous?.inventory.members ?? []),
            ...(known?.members ?? []).filter((path) => !previous?.removedMembers.includes(path)),
          ]),
        ],
      };
      const removedFiles = baseline.files.filter((path) => !inventory.files.includes(path));
      const removedMembers = baseline.members.filter((path) => !inventory.members.includes(path));
      const isBulk =
        isBulkRemoval(removedFiles.length, baseline.files.length) ||
        isBulkRemoval(removedMembers.length, baseline.members.length);
      let next: RemovalCheckState;
      if (!membershipReadable) {
        // Invalid membership is backed up, but cannot grant any removal authority.
        next = { _tag: "Unreadable" };
      } else if (removedFiles.length || removedMembers.length) {
        next = checkMissingInputs(
          checks.get(workspaceId) ?? { _tag: "Clear" },
          {
            key: JSON.stringify({ files: removedFiles, members: removedMembers }),
            at: yield* Clock.monotonicTimeNanos,
            bulk: isBulk,
          },
          allowLargeDeletion,
        );
      } else next = { _tag: "Clear" };
      if (next._tag === "Clear") checks.delete(workspaceId);
      else checks.set(workspaceId, next);
      const status: RemovalDecision["status"] =
        next._tag === "Clear" ? "accepted" : next._tag === "Blocked" ? "blocked" : "waiting";
      const heldFiles = status === "accepted" ? [] : removedFiles;
      const heldMembers = status === "accepted" ? [] : removedMembers;
      const accepted: AuthorRemovalState = {
        inventory: {
          files: [...new Set([...inventory.files, ...heldFiles])].sort(),
          members: [...new Set([...inventory.members, ...heldMembers])].sort(),
        },
        removedFiles: [
          ...new Set([
            ...(previous?.removedFiles ?? []),
            ...(status === "accepted" ? removedFiles : []),
          ]),
        ]
          .filter((path) => !inventory.files.includes(path))
          .sort(),
        removedMembers: [
          ...new Set([
            ...(previous?.removedMembers ?? []),
            ...(status === "accepted" ? removedMembers : []),
          ]),
        ]
          .filter((path) => !inventory.members.includes(path))
          .sort(),
      };
      return {
        decision: {
          status,
          heldFiles,
          heldMembers,
          inventory,
          membershipReadable,
          removedFiles: accepted.removedFiles,
          removedMembers: accepted.removedMembers,
          allowAllRemovals: allowLargeDeletion && membershipReadable,
        } satisfies RemovalDecision,
        accepted,
      };
    }),
  };
};
