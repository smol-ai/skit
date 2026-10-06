# Claude listing budget evidence

Observed 2026-10-07 in installed Claude Code 2.1.292.
Executable SHA-256: `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`.
Read-only inspection of the embedded JavaScript; no Claude inference invoked.

The budget function uses an explicit `SLASH_COMMAND_TOOL_CHAR_BUDGET` first.
Otherwise it computes `max(1, floor((contextWindow ?? 200000) * 4 * fraction))`.
The fraction defaults to 0.01 and is overridden by `skillListingBudgetFraction`.
This establishes a default 8000-character fallback and 40000 characters for a 1M model.

Sources for model windows and current Anthropic API aliases:
- https://models.dev/api.json
- https://code.claude.com/docs/en/model-config
- https://code.claude.com/docs/en/skills#skill-descriptions-are-cut-short

The TUI keeps the result estimated: row formatting, partial discovery, session model
switches and provider/version-specific alias mappings can differ from observed native behavior.
