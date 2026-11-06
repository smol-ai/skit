import { Effect, FileSystem } from "effect";
import { join, resolve } from "node:path";
import { createSkitArchive } from "../artifact/archive.js";
import { readSkitDescriptor, validateSkitDirectory } from "../artifact/skit.js";
import { readAuthorWorkspace } from "./operations.js";
import { NoRemoteHome, PublicationBlocked } from "./failures.js";
import type { AuthorRegistry } from "./transport.js";

export const publishAuthorWorkspace = Effect.fn("Author.publish")(function* <E, R, P>(
  root: string,
  options: { readonly version: string; readonly revision?: string },
  registry: Pick<AuthorRegistry<E, R, P>, "publish">,
) {
  const { version, revision } = options;
  const absolute = resolve(root);
  yield* readSkitDescriptor(absolute);
  // One read: the portable remote is the authority; a leftover checkpoint beside it does not matter.
  const { connection } = yield* readAuthorWorkspace(absolute);
  if (connection._tag !== "Connected") return yield* new NoRemoteHome();
  const remote = connection.remote;
  // Only this remote's credential: an environment token for another Registry is never sent.
  const publish = yield* registry.publish(remote);
  // Reject drift locally, before an archive exists: a published Skill's own contents must already
  // satisfy its Descriptor, so a consumer installing it directly honours the author's declaration.
  const validation = yield* validateSkitDirectory(absolute, version, {
    assessmentContext: "publish",
  });
  const blocking = validation.diagnostics.filter((item) => item.severity === "error");
  if (blocking.length)
    return yield* Effect.fail(
      new PublicationBlocked({
        reason: "content",
        detail: blocking.map((item) => `  ${item.message}`).join("\n"),
      }),
    );
  const fs = yield* FileSystem.FileSystem;
  // Cleanup failure is a defect, visible to the command boundary, never silently ignored.
  const temporary = yield* Effect.acquireRelease(
    fs.makeTempDirectory({ prefix: "skit-publish-" }),
    (path) => fs.remove(path, { recursive: true, force: true }).pipe(Effect.orDie),
  );
  const archive = join(temporary, "release.zip");
  yield* createSkitArchive(absolute, archive);
  const bytes = yield* fs.readFile(archive);
  return yield* publish({ version, revision, archive: bytes });
}, Effect.scoped);
