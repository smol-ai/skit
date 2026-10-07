# Raw transcript skill-usage spike

Measured 2026-10-08 Melbourne (2026-10-07 UTC). Local spike; no production integration, database, counters, or transcript writes. Only aggregate measurements and synthetic fixtures are stored here.

Seven days are feasible: a complete 3.38 GB scan takes about **6.3 seconds**; an optional file-modification-time filter takes **0.70–0.73 seconds** and matches the full scan's window observations on this machine. Keep full scanning as the correctness baseline. Do not treat the faster filter as safe for imported/restored files.

## Reproduce

Requires Node 22 or newer; no added dependencies. Run from the repository root:

```sh
node scripts/skill-usage-spike/scan.mjs --runs 3
node scripts/skill-usage-spike/scan.mjs --end 2026-10-07T15:49:15Z --runs 3
node scripts/skill-usage-spike/scan.mjs --end 2026-10-07T15:49:15Z --runs 3 --mode buffer
node scripts/skill-usage-spike/scan.mjs --end 2026-10-07T15:49:15Z --runs 3 --recent-files
node --test scripts/skill-usage-spike/scan.test.mjs
```

Default end is captured once at process start. `--codex-home` and `--claude-home` override `CODEX_HOME` and `CLAUDE_CONFIG_DIR`, respectively; defaults are the usual home directories. Output is aggregate JSON, never event content, skill names, transcript filenames, or parser error excerpts. Roots are printed. Errors on unreadable files abort rather than silently implying completeness.

## Exact corpus and interval

Fixed rolling window: **[2026-09-30T15:49:15.000Z, 2026-10-07T15:49:15.000Z)**, 604,800 seconds, selected from the live UTC clock before the benchmark. Selection uses each record's timestamp, not the filename's creation date. This is all retained local projects, not just SKIT.

| Harness | Root | Files | Bytes (first final full-stream run) | Decoded objects | Window objects | Files with window objects |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Codex | `/Users/tim/.codex/sessions` | 1,929 | 3,152,365,358 | 834,412 | 55,856 | 170 |
| Claude | `/Users/tim/.claude/projects` | 248 | 226,805,895 | 74,875 | 11,414 | 58 |
| Total | | 2,177 | 3,379,171,253 | 909,287 | 67,270 | 228 |

`/Users/tim/.codex/archived_sessions` was absent, not an inspected empty archive. Recursive discovery includes Claude subagent JSONL sidecars (44 files in the full inventory). No symlinks or compressed `.jsonl.zst` files were observed; those are diagnosed and skipped, not decoded. Prompt histories, Claude configuration counters, Codex state databases, and Arc data are excluded.

Each run rediscovers files and snapshots each file's byte size before reading; appended bytes beyond that size are excluded. This agent continued writing its own Codex transcript after the fixed window end, so corpus bytes/decoded objects drift slightly between runs. One changed file was observed in the first final stream run. Window counts match across all nine final measured runs. This is not an atomic corpus snapshot: rewrites within an inventoried prefix are not prevented or historically reconstructed. The aggregate [benchmark-results.json](benchmark-results.json) retains each run's exact inventory and diagnostics.

## Observed evidence, not completed workflows

| Category (deduplicated within category) | Codex | Claude |
| --- | ---: | ---: |
| Explicit assistant `Skill` tool invocation | 0 | 4 |
| Native instruction injection envelope | 1 | 6 |
| Recognized skill-document read attempt | 101 | 0 |
| Unparsed wrappers containing `SKILL.md` | 14 | 0 |
| Other message records mentioning skill markers (including inventory/quotes) | 281 | 9 |
| Slash-command wrapper candidates, not counted as skill uses | 0 | 2 |
| Compaction markers/summary records excluded from extraction | 24 | 0 |

The **112 recognized observations** are 4 calls + 7 injections + 101 reads. A tool invocation and its resulting injection can describe the same action; never sum these as unique completed skill workflows. No advertised inventory, commentary announcement, bare `$skill` mention, search result, or compaction summary is usage. Slash commands may be built-ins and are deliberately not credited without a native load/call.

Claude calls require an assistant `tool_use` block named `Skill` with a string `input.skill`. Injections require `isMeta` user content starting `Base directory for this skill:`. Codex injections require an anchored user response-item `<skill>` envelope containing `<name>` then `<path>`; developer inventories and quoted envelopes fail that gate. An independent read-only Python raw-event audit confirmed 4 Claude Skill blocks, 6 Claude native load blocks, and 1 Codex native skill envelope before normalization; no transcript text was emitted.

Read recognition accepts Claude `Read.file_path`, direct JSON tool-call arguments for a few shell tools, and literal `tools.exec_command({cmd: "…"})` calls inside Codex `exec` custom-tool input. Only literal `cat`, `head`, `tail`, and `sed` command segments with `SKILL.md` paths are recognized. Redirections, command substitution, searches, variable-bound JS, single-quoted JS strings, brace expansion, and arbitrary wrappers are not reconstructed. Transcript code is never evaluated. Static wrapper literals do not prove their branch executed; direct calls do not prove the file existed or the skill was followed. Shell parsing is a bounded heuristic, not an interpreter. Reference-document reads are not another skill invocation. Paths are identities; aliases/symlinks are not resolved into canonical skills.

Preliminary broader matching yielded 117 observations; conservatively rejecting shell redirections removed 3 Codex and 2 Claude read candidates. All saved final results use the corrected recognizer.

Deduplication hashes harness + category + native call/message identity + skill identity globally across files. This suppresses copied/forked/subagent event replay without conflating repeated fresh call IDs. If identity is missing, timestamp + skill identity is a heuristic fallback, reported as `missingIdentity`. Final window observations had zero missing IDs and zero duplicate candidates. This does not implement Codex telemetry's once-per-skill-per-turn deduplication. Missing IDs with shifted timestamps, rewritten IDs, or changed path aliases can escape deduplication; identical fallback timestamps may collapse separate events. The tests cover replay and distinct fresh calls.

Full scans found **19,120 undated Claude objects**, zero invalid timestamps, zero malformed/truncated records, and zero non-object records. No recognized candidate lacked a valid timestamp. Undated events are diagnosed and excluded from the window, never assigned a neighboring timestamp. Synthetic tests exercise malformed middle lines, truncated final lines, valid final lines without newline, exact interval boundaries, and records spanning stream chunks.

Codex metadata yielded 587 subagent/role/parent signals and 61 fork/history-base signals across the full retained corpus; these are metadata records, not verified distinct subagent sessions or window usage. Claude sidecars are included; Codex child sessions are discovered normally. The spike counts retained raw evidence across branches, not just a selected conversation DAG. It skips compacted summaries and does not manufacture lost events from recaps. Retention, persistence settings, deleted sessions, other devices, and format changes prevent claims of complete historical use.

## Performance

Node v22.22.3 on Darwin arm64. Runs are sequential per mode in fresh processes; repeats are in the same process. No application object/file cache. Prior inventory/schema inspections and exploratory runs warmed some pages; OS page cache is uncontrolled. These are warm/local measurements, **not cold-disk benchmarks**. Other desktop work was not isolated. Per-event clock instrumentation is included.

| Mode | First run | Warm repeat 1 | Warm repeat 2 | Bytes read (first run) | Process peak RSS after runs 1 / 2 / 3 |
| --- | ---: | ---: | ---: | ---: | --- |
| Full streaming (256 KiB chunks) | 6.289 s | 6.264 s | 6.270 s | 3,379,171,253 | 602 / 689 / 724 MiB |
| Full whole-file buffer | 6.086 s | 6.044 s | 6.082 s | See aggregate artifact | 689 / 723 / 752 MiB |
| Streaming, mtime filter | 0.728 s | 0.714 s | 0.697 s | 345,446,012 | 266 / 300 / 381 MiB |

First final full-stream run: discovery/stat 27.6 ms, synchronous read syscall time 253.2 ms, UTF-8 conversion + JSON decode 5,221.2 ms, window extraction/deduplication 74.9 ms, other processing 712.5 ms. Other includes line splitting, timestamp filtering, allocations/GC, open/close and final stats. These buckets are instrumentation estimates, not a CPU profiler. Out-of-window objects are decoded to establish the full baseline; undated extraction is outside the extraction bucket.

The optional mtime filter skips 1,759 Codex and 187 Claude files, reading 170 + 61 files. Some read Claude files have no dated window event. It reduces input to about 10% while reproducing every window diagnostic and recognized category count. It deliberately does not reproduce full-corpus undated/metadata/object totals. A synthetic restored-file test demonstrates a false negative with an old mtime, so the optimization is opt-in.

Streaming avoids retaining whole files/all parsed records, but the longest individual JSON line and V8's decoded strings still allocate substantially. Peak RSS is process-lifetime and cumulative across repeats; it is not a per-run memory delta or a guaranteed memory bound. Whole-file reads are only slightly faster. Memory behavior deserves profiling before an always-on integration.

## Prior art and design implications

Decision studied: can disk JSONL evidence support a fast seven-day scan without a persistence feature? Local source and raw seams answered this; no external service or work database was queried.

| Source | Exact snapshot | Borrow / boundary |
| --- | --- | --- |
| `~/dev/harness-guide` | HEAD `d277d209fee98f040d3a37b81ee99db8240d5239`; transcript registry updated 2026-09-30 | `docs/research/transcripts.md` and `registry/transcripts.json`: roots, internal/versioned shapes, archived/compressed rollouts, sidecars, lineage. |
| Same working tree | Untracked `docs/research/skill-usage-tracking.md`, inspection date 2026-10-08; not part of that HEAD | Distinguish counters/telemetry from retained invocation evidence. The spike reads no counter file. |
| `~/dev/aux` | HEAD `f5dbf9c39d5f78731e72e083e15be319060767f9` | `src/main/ingest/providers/{jsonl,jsonl-provider,claude,claude-dag,codex}.ts`: malformed-line diagnostics, header discovery, native Claude loads, tool wrappers, UUID replay and fork handling. Borrow evidence rules, not its database/projection layer. |
| SKIT | `packages/skit/src/library/store/state-schema.ts`, `harnesses/catalog.ts`; local checkout | Harness names include Codex, Claude Code, OpenCode, Devin. OpenCode storage variants and Devin transcript evidence need separate work; neither is silently included here. Aux also has pi/Cursor parsers and harness-guide describes their boundaries; those are beyond this bounded Claude/Codex experiment. |

No ready seven-day skill-use benchmark was found in the inspected transcript/provider sources and relevant ingest/JSONL tests. This is a bounded search, not an absence claim about either entire repository. Aux's full-record caching is optimized for repeatedly updated sessions; importing that cache into this scan would change the benchmark and retain unnecessary content. Its DAG flattening answers conversation rendering; observed access counting needs replay suppression without silently discarding sidechains.

Recommendation: a simple read-only scan is already fast enough for an on-demand experiment. Preserve separate evidence categories and diagnostics. Offer file-time filtering only with its import/restore caveat and an occasional full comparison. Before a production feature, improve wrapper recognition from pinned parser/source evidence, decide per-turn versus per-access semantics, profile largest lines, and define how to reconcile tool calls with injections. Do not build persistence or a usage UI on these totals yet.

Validation: five focused Node tests, syntax check, scoped oxlint and formatting checks; native aggregate command smoke/benchmarks; independent raw-event tally; all nine final runs agree on window category/diagnostic counts. No CLI/TUI/server integration changed, so no package or workspace suite was needed. No transcript mutations or external publishing.
