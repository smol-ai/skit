import { Effect } from "effect";
import type { ScopeChoice } from "@smolai/skit-core/library/session";
import { scopeChoices } from "@smolai/skit-core/library/session";
import { DESTINATION_QUESTION, scopeChoiceLabels } from "./invocation.js";
import { Prompter } from "../../terminal/prompter.js";

export const promptForScope = Effect.fn("CLI.promptForScope")(function* (
  cwd: string,
  available: readonly ScopeChoice[] = scopeChoices(cwd),
) {
  if (available.length === 1) return available[0].scope;
  const prompter = yield* Prompter;
  const choice = yield* prompter.select<ScopeChoice["value"]>(
    DESTINATION_QUESTION,
    available.map((item) => ({
      value: item.value,
      label: scopeChoiceLabels[item.value],
      ...(item.scope.kind === "repository" ? { hint: item.scope.root } : {}),
    })),
  );
  const selected = available.find((item) => item.value === choice);
  if (!selected) return yield* Effect.die(`Unknown destination choice: ${choice}`);
  return selected.scope;
});
