import type { UsageReport, UsageRow } from "@smolai/skit-core/library/usage";
import { Block } from "../../terminal/blocks.js";

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

export function renderUsage(report: UsageReport): Block[] {
  const days = Math.round(
    (Date.parse(report.window.end) - Date.parse(report.window.start)) / 86400000,
  );
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
  return [
    Block.Heading({ text: `Skill activity (${days} ${days === 1 ? "day" : "days"})` }),
    Block.Note({
      text: [{ dim: `${dateLabel(report.window.start)} – ${dateLabel(report.window.end)} (UTC)` }],
    }),
    ...(report.project
      ? [Block.Fields({ rows: [{ label: "Project", value: [report.project] }] })]
      : []),
    sorted.length
      ? Block.Table({
          columns: [
            { title: "Skill" },
            { title: "Harness" },
            { title: "Uses", align: "end" },
            { title: "Explicit", align: "end" },
            { title: "Implicit", align: "end" },
            { title: "Last seen" },
          ],
          rows: sorted.map((row) => [
            [row.name],
            [[...row.harnesses].sort().join(", ")],
            [String(row.uses)],
            [String(row.explicit)],
            [String(row.implicit)],
            [dateLabel(row.last)],
          ]),
        })
      : Block.Note({ text: ["No skill activity found."] }),
  ];
}
