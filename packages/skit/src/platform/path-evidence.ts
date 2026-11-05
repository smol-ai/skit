import { Effect } from "effect";
import { dirname, resolve } from "node:path";
import { LinkStat } from "./link-stat.js";

/** An entry's own identity, including a symlink's target, without hashing its children. */
export const pathEntryIdentity = Effect.fn("Path.entryIdentity")(function* (path: string) {
  const links = yield* LinkStat;
  return yield* links.identity.lstat(path).pipe(
    Effect.flatMap((info) =>
      info.type === "SymbolicLink"
        ? links.identity.stat(path).pipe(
            Effect.map(
              (target) =>
                `${info.type}:${info.dev}:${info.ino}->${target.type}:${target.dev}:${target.ino}`,
            ),
            Effect.catchReason("PlatformError", "NotFound", () =>
              Effect.succeed(`${info.type}:${info.dev}:${info.ino}->absent`),
            ),
          )
        : Effect.succeed(`${info.type}:${info.dev}:${info.ino}`),
    ),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("absent")),
  );
});
/** Physical identities from this entry to the filesystem root, including absent components. */
export const pathChain = Effect.fn("Path.chain")(function* (path: string) {
  const entries: { path: string; evidence: string }[] = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    entries.push({ path: at, evidence: yield* pathEntryIdentity(at) });
    if (at === dirname(at)) break;
  }
  return entries;
});

/** Creating a missing directory is the only permitted identity change during preparation. */
export const samePathChain = (
  before: readonly { readonly path: string; readonly evidence: string }[],
  after: readonly { readonly path: string; readonly evidence: string }[],
  allowCreation: boolean,
) =>
  before.length === after.length &&
  before.every((entry, index) => {
    const current = after[index];
    return (
      current?.path === entry.path &&
      (current.evidence === entry.evidence ||
        (allowCreation && entry.evidence === "absent" && current.evidence.startsWith("Directory:")))
    );
  });
