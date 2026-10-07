/** Read-only, aggregate-only spike. Never evaluate transcript tool code. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const hash = (s) => crypto.createHash("sha256").update(s).digest("hex");
const strings = (content) =>
  typeof content === "string"
    ? [content]
    : Array.isArray(content)
      ? content
          .filter((x) => x?.type === "text" || x?.type === "input_text")
          .map((x) => x.text ?? "")
      : [];
const skillPaths = (s) =>
  [...s.matchAll(/(?:[^\s"'`;|<>]+\/)?[^\s/"'`;|<>]+\/SKILL\.md\b/g)].map((x) => x[0]);
const event = (kind, identity, id) => ({ kind, identity, id });

// Deliberately limited: literal reads, not search results, echoes, arbitrary shell
// semantics, or dynamic JS. These are attempts; no result-success inference.
export function readAttempts(name, input) {
  if (name === "Read" && typeof input?.file_path === "string") return skillPaths(input.file_path);
  if (!["exec_command", "shell_command", "Bash", "shell"].includes(name)) return [];
  const cmd = input?.cmd ?? input?.command;
  if (typeof cmd !== "string" || /\$\(|`|[<>]/.test(cmd)) return [];
  return [...cmd.matchAll(/(?:^|[;\n]|&&|\|\|)\s*(?:cat|head|tail|sed)\s+([^;\n&|]+)/g)].flatMap(
    (m) => skillPaths(m[1]),
  );
}

export function extract(harness, r) {
  const uses = [];
  const diagnostics = { wrapperUnparsed: 0, compaction: 0, slashCommands: 0, mentionRecords: 0 };
  const p = r.payload ?? {};
  const message = r.message ?? {};
  if (
    r.type === "compacted" ||
    r.isCompactSummary ||
    (r.type === "system" && r.subtype === "compact_boundary")
  ) {
    diagnostics.compaction++;
    return { uses, diagnostics };
  }
  const tool = (name, input, id) => {
    if (harness === "claude" && name === "Skill" && typeof input?.skill === "string")
      uses.push(event("explicitToolInvocation", input.skill, id));
    for (const identity of new Set(readAttempts(name, input)))
      uses.push(event("documentReadAttempt", identity, id));
  };
  if (harness === "claude") {
    if (r.type === "assistant" && Array.isArray(message.content))
      for (const b of message.content) if (b?.type === "tool_use") tool(b.name, b.input, b.id);
    if (r.type === "user")
      for (const text of strings(message.content)) {
        if (r.isMeta && text.startsWith("Base directory for this skill:"))
          uses.push(event("instructionInjection", text.split(/\r?\n/, 1)[0], r.uuid));
        if (/^<command-message>[\s\S]*?<command-name>\//.test(text)) diagnostics.slashCommands++;
      }
  } else if (r.type === "response_item") {
    if (p.type === "message" && p.role === "user")
      for (const text of strings(p.content)) {
        // Anchor to the native injected envelope; inventories/quoted mentions fail.
        if (/^<skill>\s*<name>[^<]+<\/name>\s*<path>[^<]+<\/path>[\s\S]*<\/skill>\s*$/.test(text))
          uses.push(event("instructionInjection", text.match(/<path>([^<]+)<\/path>/)[1], p.id));
      }
    if (p.type === "function_call") {
      try {
        tool(p.name?.replace(/^functions\./, ""), JSON.parse(p.arguments), p.call_id);
      } catch {
        diagnostics.wrapperUnparsed++;
      }
    }
    if (p.type === "custom_tool_call" && ["exec", "functions.exec"].includes(p.name)) {
      // Recover only JSON string literals directly assigned to cmd/command.
      // No evaluation or claim that every literal was executed.
      const code = p.input ?? "";
      let recognized = 0;
      if (typeof code === "string")
        for (const m of code.matchAll(
          /\btools\.exec_command\s*\(\s*\{\s*"?cmd"?\s*:\s*("(?:\\.|[^"\\])*")/g,
        )) {
          try {
            tool("exec_command", { cmd: JSON.parse(m[1]) }, p.call_id);
            recognized++;
          } catch {
            /* bounded syntax */
          }
        }
      if (!recognized && typeof code === "string" && code.includes("SKILL.md"))
        diagnostics.wrapperUnparsed++;
    }
  }
  const texts =
    harness === "claude"
      ? strings(message.content)
      : p.type === "message"
        ? strings(p.content)
        : [];
  if (!uses.length && texts.some((s) => /SKILL\.md|<skill>|Base directory for this skill:/.test(s)))
    diagnostics.mentionRecords++;
  return { uses, diagnostics };
}

export function discover(roots) {
  const files = [];
  const skipped = { missingRoots: 0, compressedFiles: 0, symlinks: 0 };
  function walk(dir, harness) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        skipped.symlinks++;
        continue;
      }
      if (entry.isDirectory()) walk(file, harness);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stat = fs.statSync(file);
        files.push({ file, harness, bytes: stat.size, mtimeMs: stat.mtimeMs, inode: stat.ino });
      } else if (entry.name.endsWith(".jsonl.zst")) skipped.compressedFiles++;
    }
  }
  for (const { root, harness } of roots) {
    if (fs.existsSync(root)) walk(root, harness);
    else skipped.missingRoots++;
  }
  return { files: files.sort((a, b) => a.file.localeCompare(b.file)), skipped };
}

// Fixed-size snapshot reads: append activity is excluded beyond inventoried size.
// Streaming keeps one 256KiB chunk plus the longest record, not whole files.
function* lines(file, size, mode, timing) {
  const fd = fs.openSync(file, "r");
  try {
    const chunkSize = mode === "buffer" ? Math.max(size, 1) : 256 * 1024;
    const chunk = Buffer.allocUnsafe(chunkSize);
    let offset = 0;
    let pending = Buffer.alloc(0);
    while (offset < size) {
      const t = performance.now();
      const n = fs.readSync(fd, chunk, 0, Math.min(chunkSize, size - offset), offset);
      timing.readMs += performance.now() - t;
      if (!n) break;
      offset += n;
      timing.bytesRead += n;
      const bytes = pending.length
        ? Buffer.concat([pending, chunk.subarray(0, n)])
        : chunk.subarray(0, n);
      let start = 0;
      let end;
      while ((end = bytes.indexOf(10, start)) !== -1) {
        yield { bytes: bytes.subarray(start, end), trailing: false };
        start = end + 1;
      }
      pending = Buffer.from(bytes.subarray(start));
    }
    if (pending.length) yield { bytes: pending, trailing: true };
  } finally {
    fs.closeSync(fd);
  }
}

export function scan({ roots, start, end, mode = "stream", recentFiles = false }) {
  const begin = performance.now();
  const inventory = discover(roots);
  const discoveryMs = performance.now() - begin;
  const timing = { discoveryMs, readMs: 0, decodeMs: 0, extractionMs: 0, bytesRead: 0 };
  const counts = {};
  const seen = new Set();
  for (const harness of ["codex", "claude"])
    counts[harness] = {
      files: 0,
      bytes: 0,
      filesWithWindowEvents: 0,
      subagentFiles: 0,
      records: 0,
      windowRecords: 0,
      missingTimestamp: 0,
      invalidTimestamp: 0,
      malformed: 0,
      malformedTrailing: 0,
      nonObject: 0,
      duplicates: 0,
      missingIdentity: 0,
      undatedRecognized: 0,
      wrapperUnparsed: 0,
      compaction: 0,
      slashCommands: 0,
      mentionRecords: 0,
      explicitToolInvocation: 0,
      instructionInjection: 0,
      documentReadAttempt: 0,
      changedFiles: 0,
      skippedOldFiles: 0,
      skippedOldBytes: 0,
      subagentMetadata: 0,
      forkMetadata: 0,
    };
  for (const f of inventory.files) {
    const c = counts[f.harness];
    c.files++;
    c.bytes += f.bytes;
    if (recentFiles && f.mtimeMs < start) {
      c.skippedOldFiles++;
      c.skippedOldBytes += f.bytes;
      continue;
    }
    if (f.file.includes("/subagents/")) c.subagentFiles++;
    let hasWindow = false;
    let ordinal = 0;
    for (const { bytes, trailing } of lines(f.file, f.bytes, mode, timing)) {
      ordinal++;
      if (!bytes.length) continue;
      const t = performance.now();
      let r;
      try {
        r = JSON.parse(bytes.toString("utf8"));
      } catch {
        c.malformed++;
        if (trailing) c.malformedTrailing++;
        timing.decodeMs += performance.now() - t;
        continue;
      }
      timing.decodeMs += performance.now() - t;
      if (!r || typeof r !== "object" || Array.isArray(r)) {
        c.nonObject++;
        continue;
      }
      c.records++;
      if (r.type === "session_meta") {
        if (
          r.payload?.source?.subagent ||
          r.payload?.parent_thread_id ||
          r.payload?.agent_role ||
          r.payload?.agent_type
        )
          c.subagentMetadata++;
        if (r.payload?.forked_from_id || r.payload?.history_base) c.forkMetadata++;
      }
      const stamp = typeof r.timestamp === "string" ? Date.parse(r.timestamp) : NaN;
      if (!Number.isFinite(stamp)) {
        if (r.timestamp == null) c.missingTimestamp++;
        else c.invalidTimestamp++;
        c.undatedRecognized += extract(f.harness, r).uses.length;
        continue;
      }
      if (stamp < start || stamp >= end) continue;
      hasWindow = true;
      c.windowRecords++;
      const e = performance.now();
      const { uses, diagnostics } = extract(f.harness, r);
      for (const [k, v] of Object.entries(diagnostics)) c[k] += v;
      for (const use of uses) {
        // Global tool IDs remove replay across fork/subagent/copy files. Injection
        // without a native ID uses timestamp+identity (heuristic, counted separately).
        const id = use.id ?? `${r.timestamp}:${use.identity}`;
        if (!use.id) c.missingIdentity++;
        const key = hash(`${f.harness}:${use.kind}:${id}:${use.identity}`);
        if (seen.has(key)) c.duplicates++;
        else {
          seen.add(key);
          c[use.kind]++;
        }
      }
      timing.extractionMs += performance.now() - e;
    }
    if (hasWindow) c.filesWithWindowEvents++;
    const after = fs.statSync(f.file);
    if (after.size !== f.bytes || after.mtimeMs !== f.mtimeMs || after.ino !== f.inode)
      c.changedFiles++;
  }
  const totalMs = performance.now() - begin;
  return {
    mode,
    recentFiles,
    window: {
      start: new Date(start).toISOString(),
      end: new Date(end).toISOString(),
      semantics: "start inclusive, end exclusive; event timestamp",
    },
    roots,
    skipped: inventory.skipped,
    counts,
    timing: {
      ...timing,
      totalMs,
      otherMs: totalMs - discoveryMs - timing.readMs - timing.decodeMs - timing.extractionMs,
    },
    memory: {
      rssBytes: process.memoryUsage().rss,
      processPeakRssBytes: process.resourceUsage().maxRSS * 1024,
    },
    recognizedObservations: seen.size,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const args = process.argv.slice(2);
  const value = (name, fallback) => {
    const i = args.indexOf(name);
    return i < 0 ? fallback : args[i + 1];
  };
  const end = Date.parse(value("--end", new Date().toISOString()));
  const runs = Number(value("--runs", "3"));
  const mode = value("--mode", "stream");
  if (
    !Number.isFinite(end) ||
    !Number.isInteger(runs) ||
    runs < 1 ||
    !["buffer", "stream"].includes(mode)
  )
    throw new Error("Invalid --end, --runs or --mode");
  const home = os.homedir();
  const codex = value("--codex-home", process.env.CODEX_HOME ?? path.join(home, ".codex"));
  const claude = value(
    "--claude-home",
    process.env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
  );
  const roots = [
    { harness: "codex", root: path.join(codex, "sessions") },
    { harness: "codex", root: path.join(codex, "archived_sessions") },
    { harness: "claude", root: path.join(claude, "projects") },
  ];
  const results = [];
  for (let i = 0; i < runs; i++)
    results.push(
      scan({
        roots,
        start: end - 7 * 86400000,
        end,
        mode,
        recentFiles: args.includes("--recent-files"),
      }),
    );
  console.log(
    JSON.stringify(
      {
        runtime: process.version,
        platform: `${process.platform}/${process.arch}`,
        cache:
          "No application cache; OS page cache uncontrolled. Repeats in same process; process peak RSS cumulative.",
        results,
      },
      null,
      2,
    ),
  );
}
