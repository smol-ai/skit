# Local skill activity

`skit usage` reports observed activity from retained Claude Code and Codex transcripts on this machine. It scans all local projects over a rolling seven-day window by default.

```sh
skit usage
skit usage --days 30
skit usage --harness codex
skit usage --harness claude-code --project .
skit usage --details
skit usage --json
```

The categories stay separate:

- **Calls**: an assistant dispatched Claude's `Skill` tool.
- **Loads**: the harness recorded a native skill instruction injection.
- **Reads**: a recognized command or tool attempted to read a `SKILL.md` document.

A call and its resulting load can describe the same invocation. Reads do not establish successful execution or a completed skill workflow. Advertised inventories, quoted examples, ordinary mentions, slash commands without a native load/call, and compaction summaries do not count.

The default terminal view groups observations by displayed skill name into one compact table, with separate Reads, Calls, Loads, and Last seen columns. Paths, individual evidence rows, and scan diagnostics are available with `--details`. Read-only unresolved documents and unmanaged test-fixture documents are omitted from the summary; they remain in the details and JSON output.

Detailed evidence rows include their harness, observed path where available, current identity match, and last observed timestamp. SKIT matches known projection paths and their currently resolved filesystem aliases to Library skill IDs. Evidence identities remain separate even when the human summary groups their displayed names. Name-only invocations, unmanaged skills, ambiguous projection matches, and unresolved documents remain visible. Current filesystem resolution cannot establish what a symlink pointed to in the past.

`--project` selects events whose recorded working directory resolves to that directory. Codex session metadata and turn contexts provide working directories; Claude records can carry their own. Events without project attribution are reported as unknown when filtering. Subagent sidecars and independently retained child transcripts are included; replayed native event identities are suppressed across files. Separate calls remain separate. Missing native IDs use a timestamp/identity fallback and are diagnosed; shifted timestamps or rewritten IDs can defeat replay detection.

## Sources and coverage

Codex discovery includes `$CODEX_HOME/sessions` and `$CODEX_HOME/archived_sessions`, defaulting to `~/.codex`. Claude discovery recursively scans `$CLAUDE_CONFIG_DIR/projects`, defaulting to `~/.claude/projects`. Prompt history, Claude precomputed counters, Codex state databases, and Arc databases are not inputs.

`--codex-home` and `--claude-home` override transcript homes independently of SKIT's `--home` Library directory. `--end` accepts a timestamp for a reproducible end-exclusive window. The start is inclusive and is exactly `--days` × 24 hours earlier. The end is captured once before discovery; modification times do not filter events.

JSON uses the versioned `skit.usage.v1` contract. It includes per-root availability, bytes and record counts, replay counts, unsupported wrappers, unreadable/skipped/changed files, undated candidates, and an `incomplete` flag. Partial results are returned with diagnostics; an invalid window/project is an argument error. Missing roots remain visible and are not proof of zero historical usage. Even a scan without diagnosed failures is limited by transcript retention and format support.

Records larger than 16 MiB are skipped with a diagnostic. Compressed transcripts and transcript symlinks are also skipped. The scanner reads only the inventoried byte prefix and reports changes detected through final metadata; it is not an atomic snapshot and cannot recover overwritten content. Individual malformed or truncated records do not discard the rest of the transcript. Undated evidence is never assigned a neighboring timestamp.

Codex JavaScript wrappers are parsed with a pinned Acorn parser, never evaluated. Recognition is bounded to literal eager `tools.exec_command` arguments and simple constant string bindings. Calls inside functions, conditional/short-circuit expressions, dynamic arguments, shell expansions/redirections, and more complicated wrappers are not reconstructed. Shell recognition covers literal read operands for a small set of commands. Results are read attempts, not success counts. JSON output contains aggregate skill identities and paths, not prompts, instruction bodies, tool results, or raw parser errors.

The scanner is an on-demand Effect service with cancellable streaming reads and bounded record buffering. Progress goes through the existing terminal renderer and does not contaminate JSON output. It writes neither transcripts nor usage state; no cache, background process, sync feature, or TUI integration is introduced.

The original performance experiment and its fixed historical aggregate measurements remain in [the spike](../scripts/skill-usage-spike/README.md). Production recognition is intentionally more conservative than its original regex and may produce different read counts.
