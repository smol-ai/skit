import { authoredSkillIssueLines } from "../library/authored-skill-issues.js";
import { Effect } from "effect";
import type { AuthorVisibility } from "@smolai/skit-core/author";

import { Renderer } from "../terminal/renderer.js";
import { syncInstalledWorkspace } from "@smolai/skit-core/author";
import { SkitConfiguration } from "@smolai/skit-core/platform";
import { authorRegistry } from "../registry/author-sync.js";

export const authorSyncCommand = Effect.fn("CLI.authorSync")(function* (options: {
  readonly root?: string;
  readonly apply: boolean;
  readonly allowLargeDeletion?: boolean;
  readonly home?: string;
  readonly to?: string;
  readonly visibility?: AuthorVisibility;
}) {
  const renderer = yield* Renderer;
  const home = options.home ?? (yield* SkitConfiguration).skitHome;
  return yield* renderer.withStatus(
    "Synchronizing skit",
    Effect.scoped(
      syncInstalledWorkspace(
        options.root ?? ".",
        {
          apply: options.apply,
          allowLargeDeletion: options.allowLargeDeletion,
          home,
          to: options.to,
          visibility: options.visibility,
        },
        authorRegistry(home),
      ).pipe(
        Effect.map((value) =>
          "issues" in value
            ? { ...value.result, installation_issues: authoredSkillIssueLines(value.issues) }
            : value.result,
        ),
      ),
    ),
  );
});
