import { Result } from "effect";
import type { HarnessName as Harness, SkitBindingScope as Scope } from "@smolai/skit-core";
import { harnessLabel } from "../../harness/catalog.js";
import { harnessSupportsScope } from "../../library/read-model.js";
import { invocationHarnesses, type InvocationOption } from "../../invocation/policy.js";
import { MissingRequirement, OptionCombinationInvalid } from "../../handlers/failures.js";

export {
  invocationHarnesses,
  invocationOptions,
  invocationSelectionFor,
  parseInvocationOption,
  type InvocationOption,
} from "../../invocation/policy.js";

export interface SetEnabledInvocation {
  subjects: readonly string[];
  harnesses: readonly Harness[];
  scope: Scope;
  enabled: boolean;
  invocation?: InvocationOption;
  dryRun: boolean;
}

export function validateSetEnabledInvocation(
  invocation: SetEnabledInvocation,
): Result.Result<void, MissingRequirement | OptionCombinationInvalid> {
  const action = invocation.enabled ? "enable" : "disable";
  if (!invocation.subjects.length)
    return Result.fail(new MissingRequirement({ command: action, requires: "a skill" }));
  if (!invocation.harnesses.length)
    return Result.fail(
      new MissingRequirement({ command: action, requires: "at least one harness" }),
    );
  const unreachable = invocation.harnesses.filter(
    (harness) => !harnessSupportsScope(harness, invocation.scope.kind),
  );
  if (unreachable.length)
    return Result.fail(
      new OptionCombinationInvalid({
        detail: `${unreachable.map(harnessLabel).join(", ")} reads skills only from a repository, so it has no ${invocation.scope.kind === "global" ? "global" : "repository"} destination`,
      }),
    );
  if (invocation.invocation === undefined) return Result.succeed(undefined);
  if (!invocation.enabled)
    return Result.fail(
      new OptionCombinationInvalid({
        detail: "--invocation applies only when enabling a Projection",
      }),
    );
  const unsupported = invocation.harnesses.filter(
    (harness) => !(invocationHarnesses as readonly Harness[]).includes(harness),
  );
  if (unsupported.length)
    return Result.fail(
      new OptionCombinationInvalid({
        detail:
          "--invocation is supported only for Claude Code, Codex, OpenCode and Devin projections",
      }),
    );
  return Result.succeed(undefined);
}
