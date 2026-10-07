# Skill context budgets

Harnesses list skill metadata in the model's context before it chooses which skills to use.
This listing has its own budget. It does not include full `SKILL.md` bodies, references, or
scripts loaded when a skill is selected.

SKIT estimates full listing demand and compares it with the harness's allowance. Full demand
means the listing before budget trimming; a fitted listing can hide descriptions that no
longer reach the model. Budget diagnostics live in core and are displayed by `skit doctor` and the TUI's
Harnesses view. They do not change Library health or doctor's exit status.

## Doctor output

`skit doctor` shows demand, allowance, percentage, and overflow warnings for Codex and Claude.
It lists skills whose pre-budget-trimming listing cost is strictly greater than 1% of the
harness's allowance, including when the overall listing fits. Costs include row metadata;
they are not measurements of the description alone.

Use `--detail full` for source provenance, coverage notes, and paths. JSON output uses
`skit.doctor.v6` and exposes the shared results in `listing_budgets`. Codex budget and
native-discovery diagnostics reuse one app-server process; Claude budget discovery reads
filesystem metadata and settings.

## Budget rules

| Harness | Default allowance | Unknown context window | Explicit override |
| --- | --- | --- | --- |
| Codex | `floor(contextWindow × 0.02)` budget tokens | 8,000 characters | `skills.max_context_tokens`, capped at 10,000 |
| Claude Code | `max(1, floor(contextWindow × 4 × 0.01))` characters | Uses a 200,000-token window: 8,000 characters at the default fraction | `SLASH_COMMAND_TOOL_CHAR_BUDGET` |

These are versioned implementation facts. Codex behavior was researched against 0.160.1;
Claude behavior was inspected in 2.1.292. They should be rechecked when the native behavior changes.

## Codex accounting and overflow

The Codex estimate ports the native skill-listing renderer's allocation behavior:

- A rendered row includes its name, description, file path, separators, and newline.
- Budget-token cost is `ceil(UTF-8 bytes / 4)` per row. These are approximate budget units,
  not tokenizer results or billable token counts.
- Descriptions longer than 1,024 Unicode characters are first capped to a 1,021-character
  prefix followed by `...`.
- When full rows exceed the budget, names and paths are reserved first. Remaining space
  is allocated one description character at a time, round-robin.
- Budget trimming produces raw prefixes, with no word-boundary adjustment or ellipsis.
- If minimum rows cannot fit, descriptions are removed and some skills are omitted.
- Absolute and aliased path plans are compared. The roots table contributes shared overhead;
  the estimator prefers fewer omissions, then fewer removed characters, then lower cost.

Native discovery uses `skills/list` and `config/read` through Codex's app-server. It includes
native discoverable built-ins and enabled skills, excludes explicit-only metadata policies,
and deduplicates canonical paths. The alias plan is estimated rather than captured from an
actual model prompt.

Implementation: [Codex allocator](../packages/skit/src/harnesses/skill-listing/codex-allocation.ts).
Versioned source: [Codex 0.160.1](https://github.com/openai/codex/tree/rust-v0.160.1).

## Claude Code's character allowance

The [Claude skills documentation](https://code.claude.com/docs/en/skills#skill-descriptions-are-cut-short)
describes a character budget that scales at 1% of the model's context window. It documents
`skillListingBudgetFraction` and the fixed character override, but does not explain the
characters-per-token conversion.

The installed Claude Code 2.1.292 executable contains the following behavior:

```text
if an explicit SLASH_COMMAND_TOOL_CHAR_BUDGET is set:
    use it
otherwise:
    max(1, floor((contextWindow ?? 200000) × 4 × fraction))

fraction = skillListingBudgetFraction ?? 0.01
```

The factor **4 is native implementation behavior**, not a calibration inferred from one
skill's `/skills` token estimate. It also is not an exact tokenizer conversion.

At the default fraction:

| Model context window | Listing allowance |
| --- | ---: |
| 200,000 tokens | 8,000 characters |
| 1,000,000 tokens | 40,000 characters |

For example, a 13,033-character listing uses 32.6% of a 40,000-character allowance.
`skillListingBudgetFraction: 0.02` doubles the default allowance; the explicit character
budget takes precedence over this calculation.

### Inspection provenance

- Observed: 2026-10-07.
- Claude Code version: 2.1.292.
- Executable SHA-256: `97a01e5bc74a199e67189435d0331ea3a24eac2e07db4b76d9148c5b0386138f`.
- Method: read-only inspection of embedded JavaScript. No inference call was made.
- Observed constants: default fraction `0.01`, characters-per-token factor `4`, fallback
  context window `200000`, and default combined description cap `1536`.

This establishes the formula for that version; it is not a public compatibility guarantee.

### Listing visibility and overflow

Claude's combined `description` and `when_to_use` text has a 1,536-character default cap,
overridable with `skillListingMaxDescChars`. Budget overflow drops whole descriptions in
invocation-frequency order while retaining names. SKIT cannot observe that order offline,
so it computes a range for how many descriptions are at risk.

The documented `skillOverrides` states are:

| State | Listed to Claude | Slash menu |
| --- | --- | --- |
| `on` | Name and description | Yes |
| `name-only` | Name only | Yes |
| `user-invocable-only` | No | Yes |
| `off` | No | No |

Absent entries default to `on`. Plugin skills are unaffected by these overrides. SKIT matches
names and records the assumption of per-key merging when multiple settings files contain
override maps. Managed alias matching is not modelled.

Source: [Claude skill visibility overrides](https://code.claude.com/docs/en/skills#override-skill-visibility-from-settings).
Implementation: [Claude adapter](../packages/skit/src/harnesses/skill-listing/claude.ts).

## Repo-owned model facts

Context windows are bundled in the schema-backed
[model catalog](../packages/skit/src/models/model-context-windows.json), with per-provider
source timestamps. OpenAI facts came from the observed Codex model catalog; Anthropic facts
came from [models.dev](https://models.dev/api.json).

Lookup matches exact model IDs or explicitly recorded aliases. Claude alias mappings come
from the [model configuration documentation](https://code.claude.com/docs/en/model-config)
and assume the current Anthropic API mapping. Provider-specific or older-client mappings
can differ. `ANTHROPIC_DEFAULT_*_MODEL` settings can pin those aliases to another model.

The application does not read native model caches to recover context windows or invoke
Claude for budget measurements.

## Estimation limits

Claude discovery reads settings and local skill/plugin files. Built-in, synced, remote,
legacy-command, or dynamically loaded skills can add demand that this scan does not see.
Native separators and duplicate-description precedence are also only estimated. Session
model changes and remote managed settings are not observable offline.

The numeric allowance therefore supports an estimated comparison, not a claim that SKIT
captured the complete prompt. Per-skill `~tok` values from Claude's `/skills` are separate
measurements and should not be directly compared with character counts.
