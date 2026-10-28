import stringWidth from "string-width";
import type { UsageReport, UsageRow } from "@smolai/skit-core";

const safe = (value: string) =>
  Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 32 || (code >= 127 && code <= 159) ? " " : char;
  }).join("");

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

export function renderUsage(report: UsageReport): string {
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
    {
      name: string;
      harnesses: Set<string>;
      uses: number;
      explicit: number;
      implicit: number;
      last: string;
    }
  >();
  for (const row of report.rows) {
    if (row.uses === 0 || documentOnly(row)) continue;
    // Summarize labels for display; the underlying evidence identities stay separate.
    const group = groups.get(row.name) ?? {
      name: row.name,
      harnesses: new Set(),
      uses: 0,
      explicit: 0,
      implicit: 0,
      last: row.lastSeenAt,
    };
    group.harnesses.add(row.harness);
    group.uses += row.uses;
    group.explicit += row.explicit;
    group.implicit += row.implicit;
    if (row.lastSeenAt > group.last) group.last = row.lastSeenAt;
    groups.set(row.name, group);
  }
  const sorted = [...groups.values()].sort(
    (a, b) => b.uses - a.uses || b.last.localeCompare(a.last) || a.name.localeCompare(b.name),
  );
  if (!sorted.length) lines.push("No skill activity observed.");
  else {
    const cells = [
      ["Skill", "Harness", "Uses", "Explicit", "Implicit", "Last seen"],
      ...sorted.map((row) => [
        safe(row.name),
        [...row.harnesses].sort().join(", "),
        String(row.uses),
        String(row.explicit),
        String(row.implicit),
        dateLabel(row.last),
      ]),
    ];
    const widths = cells[0].map((_, i) => Math.max(...cells.map((row) => stringWidth(row[i]))));
    for (const [index, row] of cells.entries())
      lines.push(
        row
          .map((cell, i) => {
            const pad = " ".repeat(widths[i] - stringWidth(cell));
            return index > 0 && i >= 2 && i < row.length - 1 ? pad + cell : cell + pad;
          })
          .join("  ")
          .trimEnd(),
      );
  }
  return lines.join("\n");
}
