import { dirname, join, relative, resolve } from "node:path";
import { Effect } from "effect";
import { LinkStat } from "@smolai/skit-core";
import { leavePnpmSkill } from "../projection/pnpm-skills.js";
import { PlanIsStale } from "../library/failures.js";

/** A registered marker cannot override repository, authored or package-manager ownership. */
export const checkSetupGlobalContent = Effect.fn("Setup.checkGlobalContent")(function* (
  path: string,
) {
  const links = yield* LinkStat;
  yield* leavePnpmSkill(path);
  const present = (entry: string) =>
    links.lstat(entry).pipe(
      Effect.as(true),
      Effect.catchTag("PlatformError", (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(error),
      ),
    );
  if (yield* present(join(path, ".skit"))) return yield* new PlanIsStale();
  // A configured root alias must not hide protection above its physical destination.
  let ancestor = dirname(path);
  let physical = path;
  for (;;) {
    const actual = yield* links
      .realPathNative(ancestor)
      .pipe(
        Effect.catchTag("PlatformError", (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(undefined) : Effect.fail(error),
        ),
      );
    if (actual !== undefined) {
      physical = resolve(actual, relative(ancestor, path));
      break;
    }
    if (ancestor === dirname(ancestor)) return yield* new PlanIsStale();
    ancestor = dirname(ancestor);
  }
  for (const coordinate of new Set([path, physical])) {
    for (let parent = coordinate; ; parent = dirname(parent)) {
      for (const marker of [".git", "skit.json", "skit.remote.json"])
        if (yield* present(join(parent, marker))) return yield* new PlanIsStale();
      if (parent === dirname(parent)) break;
    }
  }
});
