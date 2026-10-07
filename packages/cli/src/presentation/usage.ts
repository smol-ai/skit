import type { UsageReport } from "@smolai/skit-core";

const safe = (value: string) =>
  Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) ? " " : char;
  }).join("");

export function renderUsage(report: UsageReport): string {
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
