import {
  ListingProvenance,
  ClaudeModelSource,
  ClaudeLimitSource,
  type ListingBudget,
} from "@smolai/skit-core/harnesses/listing-contracts";
import { Block } from "../../terminal/blocks.js";

const amount = (value: number) => value.toLocaleString("en-US");

/** The estimator supplies inputs and observations; the CLI explains their limits. */
export function renderListingProvenance(
  budget: Exclude<ListingBudget, { _tag: "Unavailable" }>,
): Block {
  const lines = ListingProvenance.match(budget.provenance, {
    CodexAllocation: ({
      contextWindow,
      maxContextTokens,
      fraction,
      fallbackCharacters,
      tokenCap,
    }) => [
      contextWindow === null && maxContextTokens === undefined
        ? `Context window unknown; using Codex's ${amount(fallbackCharacters)}-character fallback.`
        : `${budget.model ?? "Model unspecified"} | context ${contextWindow === null ? "unknown" : amount(contextWindow)}; ${maxContextTokens === undefined ? `listing budget fraction ${fraction}` : `configured token budget ${amount(maxContextTokens)}, capped at ${amount(tokenCap)}`}.`,
      "Includes native discoverable built-ins and other enabled skills. Path aliases are estimated; full instructions loaded later are additional.",
    ],
    ClaudeFilesystem: ({
      modelSource,
      limitSource,
      descriptionCap,
      overrideSources,
      configuredFraction,
    }) => [
      `${budget.model ?? "Model unspecified"} (${ClaudeModelSource.match(modelSource, {
        Environment: ({ name }) => name,
        SettingsFile: ({ path }) => path,
        Unconfigured: () => "not configured",
      })})`,
      ClaudeLimitSource.match(limitSource, {
        Environment: ({ name, value }) => `${name}: ${amount(value)} characters.`,
        Unavailable: () => "Limit unavailable: no context conversion recorded.",
        ContextConversion: ({
          contextWindow,
          source,
          charactersPerToken,
          fraction,
          clientVersion,
        }) =>
          `Estimated from ${source === "fallback" ? "native fallback" : (budget.model ?? "configured model")} context ${amount(contextWindow)} × ${charactersPerToken} characters/token × ${fraction} (Claude Code ${clientVersion}).`,
      }),
      `Combined description and when_to_use text is capped at ${descriptionCap} characters per entry.`,
      "Counts name, description and when_to_use with estimated row separators; native row formatting and invocation order are not observable.",
      "Identical named descriptions are counted once across copies; native precedence for differing descriptions is not predicted.",
      "Built-in skills, legacy commands, remote/synced and dynamically loaded nested skills may add demand. This is a partial filesystem estimate; full instructions loaded later are additional.",
      ...(overrideSources > 1
        ? [
            "skillOverrides merging across settings files is assumed to be per-key; native merge semantics are unverified.",
          ]
        : []),
      "Overrides match names only; managed alias matching is not modelled.",
      ...(configuredFraction === undefined
        ? []
        : [
            `Configured fraction ${configuredFraction.value}${configuredFraction.path ? ` (${configuredFraction.path})` : ""}; ${limitSource._tag === "Environment" ? "using the explicit character override" : "using native context conversion"}.`,
          ]),
      "Model aliases assume the current Anthropic API mapping; provider/version-specific mappings and session model/flags are not observable offline.",
    ],
  });
  return Block.List({
    items: [
      ...lines,
      ...budget.skippedPaths.map((path) => `Skipped unavailable skill path: ${path}`),
    ].map((line) => ({ text: [{ dim: line }] })),
  });
}
