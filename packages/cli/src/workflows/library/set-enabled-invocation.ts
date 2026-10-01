import { Result } from "effect";
import type { SkitBindingScope as Scope } from "@smolai/skit-core";
import { type InvocationOption } from "../../invocation/policy.js";
import { MissingRequirement, OptionCombinationInvalid } from "../../handlers/failures.js";

export {
  invocationOptions,
  invocationSelectionFor,
  parseInvocationOption,
  type InvocationOption,
} from "../../invocation/policy.js";

export interface SetEnabledInvocation {
  subjects: readonly string[];
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
  if (invocation.invocation !== undefined && !invocation.enabled)
    return Result.fail(
      new OptionCombinationInvalid({
        detail: "--invocation applies only when enabling a Projection",
      }),
    );
  return Result.succeed(undefined);
}
