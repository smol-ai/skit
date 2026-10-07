import stringWidth from "string-width";
import type { UsageReport, UsageRow } from "@smolai/skit-core";

const safe = (value: string) =>
  Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) ? " " : char;
  }).join("");

function renderUsageDetails(report: UsageReport): string {
  const lines = [
    "Observed skill activity",
    `${report.window.start} → ${report.window.end} (end exclusive)`,
    ...(report.project ? [`Project: ${safe(report.project)}`] : []),
    "",
  ];
  if (!report.rows.length) lines.push("No activity observed.");
  else {
    lines.push("Skill | Harness | Calls | Loads | Reads | Last observed");
    for (const row of report.rows) {
      lines.push(
        `${safe(row.name)} | ${row.harness} | ${row.calls} | ${row.loads} | ${row.reads} | ${row.lastObservedAt}`,
      );
      lines.push(`  ${row.identity}${row.path ? ` · ${safe(row.path)}` : ""}`);
    }
  }
  lines.push(
    "",
    "Calls and instruction loads can describe the same invocation. Reads are attempts, not completed workflows.",
  );
  const files = report.coverage.reduce((n, c) => n + c.files, 0);
  const bytes = report.coverage.reduce((n, c) => n + c.bytesRead, 0);
  lines.push(
    `${files} files · ${bytes.toLocaleString("en-US")} bytes read · ${(report.durationMs / 1000).toFixed(2)}s`,
  );
  for (const c of report.coverage) {
    lines.push(`${c.harness}: ${safe(c.root)} (${c.status})`);
    const diagnostics = [
      [c.malformed, "malformed records"],
      [c.undated, "undated records"],
      [c.undatedCandidates, "undated activity candidates"],
      [c.unsupported, "unsupported tool wrappers"],
      [c.oversizedLines, "oversized records"],
      [c.skippedFiles, "skipped files"],
      [c.unreadableFiles, "unreadable files/directories"],
      [c.changedFiles, "changed files"],
      [c.unknownProjectRecords, "records without project attribution"],
      [c.missingIds, "activity candidates without native IDs"],
      [c.duplicates, "replayed activity candidates"],
    ] as const;
    const present = diagnostics.filter(([n]) => n > 0).map(([n, label]) => `${n} ${label}`);
    if (present.length) lines.push(`  ${present.join(" · ")}`);
  }
  if (report.incomplete)
    lines.push("Some evidence could not be read or recognized; this report is incomplete.");
  lines.push(
    "Coverage is limited to retained local transcripts. Identity matches describe current SKIT projections.",
  );
  return lines.join("\n");
}

const dateLabel = (value: string) =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" }).format(
    new Date(value),
  );

const documentOnly = (row: UsageRow) =>
  row.calls === 0 &&
  row.loads === 0 &&
  (row.identity === "unresolved" ||
    (row.identity !== "managed" &&
      row.path !== null &&
      /(?:^|\/)(?:test|tests)\/fixtures(?:\/|$)/.test(row.path)));

export function renderUsage(report: UsageReport, details = false): string {
  if (details) return renderUsageDetails(report);
  const days = Math.round(
    (Date.parse(report.window.end) - Date.parse(report.window.start)) / 86400000,
  );
  const lines = [
    `Skill activity · ${days} ${days === 1 ? "day" : "days"}`,
    `${dateLabel(report.window.start)} – ${dateLabel(report.window.end)} (UTC)`,
    ...(report.project ? [`Project: ${safe(report.project)}`] : []),
    "",
  ];
  const groups = new Map<
    string,
    { name: string; calls: number; loads: number; reads: number; last: string }
  >();
  for (const row of report.rows) {
    if (documentOnly(row)) continue;
    // Summarize labels for display; the underlying evidence identities stay separate.
    const group = groups.get(row.name) ?? {
      name: row.name,
      calls: 0,
      loads: 0,
      reads: 0,
      last: row.lastObservedAt,
    };
    group.calls += row.calls;
    group.loads += row.loads;
    group.reads += row.reads;
    if (row.lastObservedAt > group.last) group.last = row.lastObservedAt;
    groups.set(row.name, group);
  }
  const sorted = [...groups.values()].sort(
    (a, b) =>
      b.calls + b.loads + b.reads - (a.calls + a.loads + a.reads) || a.name.localeCompare(b.name),
  );
  if (!sorted.length) lines.push("No skill activity observed.");
  else {
    const cells = [
      ["Skill", "Reads", "Calls", "Loads", "Last seen"],
      ...sorted.map((row) => [
        safe(row.name),
        row.reads ? String(row.reads) : "–",
        row.calls ? String(row.calls) : "–",
        row.loads ? String(row.loads) : "–",
        dateLabel(row.last),
      ]),
    ];
    const widths = cells[0].map((_, i) => Math.max(...cells.map((row) => stringWidth(row[i]))));
    for (const [index, row] of cells.entries())
      lines.push(
        row
          .map((cell, i) => {
            const pad = " ".repeat(widths[i] - stringWidth(cell));
            return i > 0 && i < 4 && index > 0 ? pad + cell : cell + pad;
          })
          .join("  ")
          .trimEnd(),
      );
    lines.push("", "Reads are document access attempts; calls and loads can overlap.");
  }
  if (report.incomplete)
    lines.push("Some activity could not be recognized. Use --details for scan coverage.");
  else lines.push("Use --details for evidence and scan coverage.");
  return lines.join("\n");
}
