import type { WorkspaceClaim } from "../library/queries.js";
import { Option, Schema } from "effect";
import { WorkspaceId } from "./workspace.js";

/** Reuse the first authored identity claimed at this root when workspace.json has gone (A3). */
export const workspaceIdFromClaims = (sameRoot: readonly WorkspaceClaim[]) =>
  Option.flatMap(
    Option.fromUndefinedOr(
      sameRoot.map((claim) => claim.workspaceId).find((id) => id !== undefined),
    ),
    Schema.decodeUnknownOption(WorkspaceId),
  );
