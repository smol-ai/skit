# Experimental local skill activity

This command is experimental; its interface and evidence rules may change or be removed.

`skit usage` reports observed activity from retained Claude Code and Codex transcripts on this machine. It scans all local projects over a rolling seven-day window by default.

```sh
skit usage
skit usage --days 30
skit usage --harness codex
skit usage --harness claude-code --project .
skit usage --json
```

The JSON evidence categories stay separate:

- **Calls**: an assistant dispatched Claude's `Skill` tool.
- **Loads**: the harness recorded a native skill instruction injection.
- **Reads**: a recognized command or tool attempted to read a `SKILL.md` document.

A call and its resulting load can describe the same invocation. Reads do not establish successful execution or a completed skill workflow. Advertised inventories, quoted examples, ordinary mentions, slash commands without corroborating native skill activity, and compaction summaries do not count.

The default terminal view groups activity by displayed skill name, with **Skill**, **Harness**, **Uses**, **Explicit**, **Implicit**, and **Last seen** columns. Uses are ordered highest first, with recency breaking ties. Reads, calls, and instruction loads are internal evidence categories, not separate terminal counters.

A use means observed skill activity in one conversation turn. Multiple observations of the same skill identity in that turn count once; distinct same-name identities can contribute more than one to the grouped terminal row. This measures activation frequency, not completed workflows. Explicit selection takes precedence when a turn also contains agent access to the same skill. Different skills and different sessions remain separate. Without turn metadata, native event IDs and Claude tool-call links are used; otherwise observations remain separate rather than guessing a turn. Counts can therefore be higher for older or incomplete transcripts.

The table is grouped by skill name across harnesses. Terminal output contains no footer, Unknown column, raw paths, identity labels, or scan counters. JSON retains unknown attribution and diagnostics. Uses includes unknown activity, so Explicit plus Implicit can be less than Uses. JSON retains the raw evidence counters as diagnostics as well as the invocation counts. An evidence row whose activity was attributed to a linked path identity can have zero uses; these rows are omitted from terminal output. Uncorroborated slash commands with no skill evidence are omitted from JSON as well.

Read-only unresolved documents and unmanaged test-fixture documents are omitted from both terminal views; they remain in JSON. Name grouping is only presentation: two distinct skill paths are not merged by the correlator merely because their names match. SKIT matches known projection paths and their currently resolved filesystem aliases to Library skill IDs. Current filesystem resolution cannot establish what a symlink pointed to in the past.

`--project` selects events whose recorded working directory resolves to that directory. Codex session metadata and turn contexts provide working directories; Claude records can carry their own. Events without project attribution are reported as unknown when filtering. Subagent sidecars and independently retained child transcripts are included; replayed native event identities are suppressed across files within the native session when available. Missing native IDs use a timestamp/identity fallback and are diagnosed; shifted timestamps or rewritten IDs can defeat replay detection.

## Explicit and implicit invocation

These labels describe the invocation path, not an inference about the user's intent in natural-language prose:

- **Explicit:** a Codex native selected-skill injection, or a Claude user slash-command marker corroborated by native skill activity in the same turn. An unrelated slash command alone is not skill usage.
- **Implicit:** a Claude agent `Skill` call, including its linked instruction expansion; or best-effort Codex access to a recognized managed/unmanaged skill document in an attributed turn, from a command accessing only one distinct skill document.
- **Unknown:** activity without sufficient attribution evidence, including isolated Claude instruction expansions, unresolved Codex document access, and Codex document access without a turn.

Claude slash markers accept both current name-first and older message-first tag order, including whitespace and command arguments. Standalone Claude document reads do not establish activation and contribute no uses; they remain raw diagnostic evidence.

Claude `sourceToolUseID` links a native instruction expansion to its originating call. When that link exists, the path identity receives the use and the name-only call does not receive another. Within a known turn, a name-only observation can be associated with a unique matching path; ambiguous same-name paths stay separate. A namespaced slash selection can also match a unique bare-name Skill call in the same turn when no instruction expansion was retained. Claude nested Skill invocations are included in implicit counts; this transcript report does not distinguish proactive from nested calls.

Codex session and turn IDs and Claude session/agent IDs and user prompt boundaries provide correlation scope. Tool results and meta instruction expansions do not begin new user turns. Compaction boundaries clear inherited turn attribution. Selection evidence from a different turn or session never classifies current activity.

Codex commands reading multiple distinct skill documents are treated as inspection and contribute no uses, while preserving raw read counts. Codex implicit classification is still best effort: single-document inspection can resemble activation, and unsupported access mechanisms can be missed. Advertised skill lists and ordinary name mentions are never selections. No telemetry exporter, hooks, state database, or background collector is required.

The harness behavior was researched against Codex source revision `a9b0815167c27ab13719dd12d13b63e02b70d221` and current Claude documentation:

- [Codex explicit selection and instruction injection](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/ext/skills/src/extension.rs).
- [Codex explicit and implicit invocation telemetry](https://github.com/openai/codex/blob/a9b0815167c27ab13719dd12d13b63e02b70d221/codex-rs/core/src/skills.rs).
- [Claude skill activation triggers](https://code.claude.com/docs/en/monitoring-usage#skill-activated-event) and [direct invocation hooks](https://code.claude.com/docs/en/hooks#userpromptexpansion).

## Counting ownership

```text
Before
transcript grammar → scanner: resolve identities, suppress replays, total raw categories
CLI renderer → sum raw categories (overlapping observations)

After
transcript grammar → native evidence and tool-call links
scanner → session/turn context, project/window filtering, identity resolution, replay suppression
correlateInvocations → linked identities, turn deduplication, invocation attribution and totals
CLI renderer → display uses and optional attribution breakdown
```

The correlator owns count semantics. The renderer no longer needs to know how calls, expansions, and document accesses overlap. Discovery, streaming, filesystem resolution, and coverage diagnostics remain scanner responsibilities.

## Sources and coverage

Codex discovery includes `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`, defaulting to `~/.codex`. Claude discovery recursively scans `$CLAUDE_CONFIG_DIR/projects`, defaulting to `~/.claude/projects`. Prompt history, Claude precomputed counters, Codex state databases, and Arc databases are not inputs.

`--codex-home` and `--claude-home` override transcript homes independently of SKIT's `--home` Library directory. `--end` accepts a timestamp for a reproducible end-exclusive window. The start is inclusive and is exactly `--days` × 24 hours earlier. The end is captured once before discovery; modification times do not filter events.

JSON uses the versioned `skit.usage.v3` contract. It includes per-root availability, bytes and record counts, replay counts, unsupported wrappers, unreadable/skipped/changed files, undated candidates, and an `incomplete` flag. Partial results are returned with diagnostics; an invalid window/project is an argument error. Missing roots remain visible and are not proof of zero historical usage. Even a scan without diagnosed failures is limited by transcript retention and format support.

Plain `.jsonl` and Zstandard-compressed `.jsonl.zst` transcripts are streamed through the same scanner. Transcript symlinks are skipped. Bytes and byte-read counters measure the on-disk input before decompression. Decoder errors count as unreadable files, preserving results from other files. Node 22's native Zstandard decoder can accept truncated frames without an error, so this is not a strict compressed-file integrity check. The scanner reads only the inventoried byte prefix and reports changes detected through final metadata; it is not an atomic snapshot and cannot recover overwritten content. Individual malformed or truncated records do not discard the rest of the transcript. Undated evidence is never assigned a neighboring timestamp.

Codex JavaScript wrappers are parsed with a pinned Acorn parser, never evaluated. Recognition is bounded to literal eager `tools.exec_command` arguments and simple constant string bindings. Calls inside function bodies or uncertain branches, dynamic arguments, and more complicated wrappers are not reconstructed. Unsupported-wrapper diagnostics concern unresolved exec calls or parser failures; filename mentions in patches, searches, and messages, and unrelated output callbacks do not trigger them. Constant lookup respects block declarations and shadowing. Shell recognition covers literal read operands for a small set of commands, including legacy array-form shell calls shaped as `[shell, "-c" | "-lc", script]`. Unsupported shell syntax suppresses only its own command segment, so a literal read alongside an unrelated expansion or redirect can still be counted. Nested substitutions, function bodies, and heredoc contents are never interpreted as read commands. Other command array shapes are diagnosed as unsupported. Current document recognition expects POSIX path spellings; Windows-style document paths are not yet covered. Results are read attempts, not success counts. JSON output contains aggregate skill identities and paths, not prompts, instruction bodies, tool results, or raw parser errors.

The scanner is an on-demand Effect service with cancellable streaming reads. Effect decodes UTF-8 across chunks and splits lines; each complete record is parsed without a record-size cutoff. Progress goes through the existing terminal renderer and does not contaminate JSON output. It writes neither transcripts nor usage state; no cache, background process, sync feature, or TUI integration is introduced.

A local warm scan of approximately 3.39 GB across 2,183 retained files took 7.9 seconds on Node 22.22.3 / Darwin arm64. For the fixed seven-day interval [2026-09-30T15:49:15Z, 2026-10-07T15:49:15Z), it found 4 calls, 7 loads, and 81 read attempts. These are historical measurements from before legacy shell-array support; the OS page cache was uncontrolled. There is no modification-time prefilter because imported or restored files can carry recent events with old modification times.

## Interactive doctor cleanup spike

In a terminal, `skit doctor` now offers cleanup when a measured Codex or Claude
skill listing exceeds its estimated budget. It scans all local projects over 30
rolling days and suggests managed, enabled skills with no observed activity.
Observed activity in either harness protects a skill, including raw document
reads and conservatively matched name-only activity. Unmanaged skills are not
changed.

```sh
skit doctor --dry-run       # choose skills and inspect the disable preview
skit doctor --days 60       # use a longer observation window
skit doctor --report-only  # diagnostics without the cleanup flow
skit doctor --json         # existing noninteractive diagnostic contract
pnpm --filter @smolai/skit stories journey/doctor/cleanup-preview
```

Suggestions are ranked by their fraction of the affected listing budgets, largest
first. Current and after-selection budget bars update as skills are checked, with
a fixed marker for each harness limit. The picker shows at most eight choices at
a time (fewer on short terminals), with a visible range and selection count. All
candidates remain available through scrolling and filtering; hidden selections
still contribute to the budget preview. The picker preselects only enough candidates to cover the estimated excess.
Scan gaps are reported once above the picker and do not prevent preselection
when the harness has usable transcript history in the observation window.
Missing optional roots such as `archived_sessions` do not invalidate available
history. A harness with no available records in the window leaves its suggestions
unselected. No activity is evidence about retained
transcripts, not proof that a skill is unnecessary. A long scan can still be
cancelled; there is no usage cache.

The picker shows the affected scope. A global disable affects every project and
agent. Selected skills remain retained in the Library. Disabling individual
members of a followed collection keeps its other current members individually;
that scope stops following future additions to the collection. The existing
binding preview is displayed before a final confirmation. Escape, declining, and
`--dry-run` leave bindings unchanged.

Budget savings subtract the selected entries' current listing costs. This is an
estimate: removing one copy can expose another through native discovery
precedence. After applying, doctor runs its checks again and displays the actual
new estimate. Cleanup currently requires exact managed document paths; aliases
that cannot be matched conservatively are omitted. JSON and redirected command
runs remain diagnostic-only; this spike does not add machine-readable suggestions.

The ownership change relative to `d662d595f` is:

```text
Before
CLI doctor → refresh inventory → native discovery and listing budget report
CLI disable → held binding selection → preview one collection → apply captured plan

After
CLI doctor → refresh inventory → native discovery and listing budget report
           → cleanup workflow
             ├─ usage scanner: transcript evidence and coverage
             ├─ suggestion policy: managed path/scope matching, protection, ranking
             ├─ picker and confirmation outside the Library writer
             └─ held binding selection.previewMany → apply captured plan
                ├─ owns expansion of intents into per-scope requests
                ├─ previews later requests against earlier binding intent
                └─ owns revision validation, writer and projection reconciliation
```

The cleanup caller supplies collection/member/scope intent. It does not construct
binding entries, coordinate separate writes per collection, or implement stale
plan recovery. Sequential previews are necessary when multiple selected
collections change the same scope. Apply retains its existing ordered writer
lifecycle; this does not introduce rollback across projection failures.
