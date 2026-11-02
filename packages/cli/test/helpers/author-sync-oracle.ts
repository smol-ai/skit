import type { AuthorDevice } from "./author-sync-server.js";

export interface AuthorEdit {
  readonly id: number;
  readonly device: AuthorDevice;
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly recovery: "anywhere" | "local-history" | "remote";
}

export interface AuthorCopy {
  readonly location: string;
  readonly kind: "workspace" | "local-history" | "remote";
  readonly files: ReadonlyArray<{ readonly path: string; readonly bytes: Uint8Array }>;
}

/**
 * Conservation oracle. It knows editor input and readable copies, not the production merger,
 * hashes, ancestry, or what the transport intended to send. This is deliberately weaker than
 * a restore proof: a remote copy here is a revision in the test server, not a public restore API.
 */
export const missingAuthorVersions = (
  edits: ReadonlyArray<AuthorEdit>,
  copies: ReadonlyArray<AuthorCopy>,
): ReadonlyArray<AuthorEdit> =>
  edits.filter(
    (edit) =>
      !copies.some(
        (copy) =>
          (edit.recovery === "anywhere" || copy.kind === edit.recovery) &&
          copy.files.some(
            (file) => file.path === edit.path && Buffer.from(file.bytes).equals(edit.bytes),
          ),
      ),
  );
