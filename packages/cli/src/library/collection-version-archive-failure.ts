import { describeFailure } from "../terminal/failure.js";
import {
  CollectionVersionArchiveInvalid,
  CollectionVersionArchiveInvalidReason,
} from "@smolai/skit-core/universal/consumer";
import { schemaFailure } from "../platform/schema-failure.js";

export const collectionVersionArchiveFailure = ({ reason }: CollectionVersionArchiveInvalid) =>
  describeFailure({
    summary: [
      `Invalid Collection Version archive: ${CollectionVersionArchiveInvalidReason.match(reason, {
        InvalidShape: ({ failure }) => schemaFailure(failure),
        InvalidBase64: ({ path }) => `invalid file base64 at ${path}`,
        DuplicatePath: ({ path }) => `duplicate path: ${path}`,
        ByteLimitExceeded: ({ kind, path, limit, actual }) =>
          `${kind === "tree" ? "Tree" : "Encoded file"} exceeds byte limit (${actual} > ${limit}) at ${path}`,
        UnsafeSymlink: ({ path, target }) => `unsafe symlink: ${path} -> ${target}`,
        ChildOfNonDirectory: ({ path }) => `child of non-directory: ${path}`,
        MissingParent: ({ unreachable }) =>
          `missing parent directory (${unreachable} unreachable entries)`,
        HashMismatch: ({ kind, expected, actual }) =>
          `${kind === "archive" ? "Archive" : "Written tree"} hash mismatch: expected ${expected}, got ${actual}`,
      })}`,
    ],
    next: [
      "Run ",
      { code: "skit sync" },
      " again; if it persists, the stored Collection Version archive is damaged.",
    ],
  });
