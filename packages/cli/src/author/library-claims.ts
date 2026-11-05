import type { WorkspaceClaim } from "@smolai/skit-core/library/session";
import { Option, Schema } from "effect";
import { WorkspaceId } from "@smolai/skit-core/author";

/** Reuse the first authored identity claimed at this root when workspace.json has gone (A3). */
export const adoptFrom = (sameRoot: readonly WorkspaceClaim[]) =>
  Option.flatMap(
    Option.fromUndefinedOr(
      sameRoot.map((claim) => claim.workspaceId).find((id) => id !== undefined),
    ),
    Schema.decodeUnknownOption(WorkspaceId),
  );
