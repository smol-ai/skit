import { Result } from "effect";
import type { SkitBindingScope as Scope } from "@smolai/skit-core";
import { type InvocationOption } from "../../invocation/policy.js";
import { OptionCombinationInvalid } from "../../handlers/failures.js";

export interface SetEnabledInvocation {
  scope: Scope;
  enabled: boolean;
  invocation?: InvocationOption;
  dryRun: boolean;
}

export function validateSetEnabledInvocation(
  invocation: SetEnabledInvocation,
): Result.Result<void, OptionCombinationInvalid> {
  if (invocation.invocation !== undefined && !invocation.enabled)
    return Result.fail(
      new OptionCombinationInvalid({
        detail: "--invocation applies only when enabling a Projection",
      }),
    );
  return Result.succeed(undefined);
}
