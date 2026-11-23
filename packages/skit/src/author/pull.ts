import { Effect, FileSystem, Path } from "effect";
import { COLLECTION_CONTROL_DIRECTORY } from "../artifact/control-files.js";
import { parseAuthorDestination, skitLocator } from "./destination.js";
import { NoRevisionToPull, PullDirectoryNotEmpty } from "./failures.js";
import { syncAuthorWorkspace } from "./sync.js";
import { normalizeRemote, type AuthorRemoteHome } from "./remote.js";
import type { AuthorRegistry } from "./transport.js";
import { AuthorWorkspace } from "./workspace.js";

/**
 * `skit author pull`: make a new Author Workspace from a SKIT that already has a remote home.
 * The directory must hold nothing, and the sync it runs can only receive: it has no way to record
 * a revision or move the Registry's `current`. It does not touch the Library: a second Collection
 * for a SKIT that Library sync already delivered would duplicate it. Later changes go through
 * `skit author sync`.
 */
export const pullAuthorSkit = Effect.fn("Author.pull")(function* <E, R, P>(
  source: string | AuthorRemoteHome,
  options: {
    /** Defaults to a directory named after the SKIT, under the current directory. */
    readonly directory?: string;
    /** The SKIT home whose Registry credentials and history the workspace uses. */
    readonly home: string;
  },
  registry: Pick<AuthorRegistry<E, R, P>, "origin" | "connect">,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const workspaces = yield* AuthorWorkspace;
  // A bare `namespace/skit` names a SKIT on the ambient Registry.
  const remote =
    typeof source === "string"
      ? yield* parseAuthorDestination(
          source,
          /^(?:skit:\/\/|https?:\/\/)/.test(source) ? undefined : yield* registry.origin,
        )
      : yield* normalizeRemote(source);
  const locator = skitLocator(remote);
  const folder = path.resolve(options.directory ?? remote.skit);
  // The lease creates the control directory; nothing else may be there.
  const occupied = (directory: string) =>
    fs.readDirectory(directory).pipe(
      Effect.map((entries) => entries.some((entry) => entry !== COLLECTION_CONTROL_DIRECTORY)),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
    );
  if (yield* occupied(folder)) return yield* new PullDirectoryNotEmpty({ path: folder });
  // Nothing is created until the Registry has a revision to give.
  const api = yield* registry.connect({ remote, locator, requireAuthentication: true });
  if ((yield* api.remote.current) === null) return yield* new NoRevisionToPull({ locator });

  yield* fs.makeDirectory(folder, { recursive: true });
  const root = yield* workspaces.resolveRoot(folder);
  const lease = yield* workspaces.acquire(root);
  // Checked again under the lease, on the resolved folder, before it is given a remote home.
  if (yield* occupied(root)) return yield* new PullDirectoryNotEmpty({ path: root });
  yield* lease.transition({ from: { _tag: "Unconnected" }, to: { _tag: "Connected", remote } });
  const synced = yield* syncAuthorWorkspace(
    root,
    { apply: true, home: options.home, receiveOnly: true },
    registry,
    lease,
  );
  // An empty workspace with no saved base receives; an empty remote tree is already the same.
  // Every other outcome sends, which a receive-only sync has already refused.
  if (synced.status !== "pulled" && synced.status !== "up_to_date")
    return yield* new PullDirectoryNotEmpty({ path: root });
  return {
    identity: locator,
    directory: root,
    revision_id: synced.revision_id,
    paths: synced.status === "pulled" ? synced.paths : [],
  };
}, Effect.scoped);
