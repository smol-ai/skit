import type { HistoryResult } from "./output.js";

const renderLibraryHistoryEvent = (event: HistoryResult["events"][number]) => {
  const actions = new Map<string, number>();
  for (const change of event.changes)
    actions.set(change.action, (actions.get(change.action) ?? 0) + 1);
  const summary = [...actions.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([action, count]) => `${count} ${action}`)
    .join(" | ");
  const count = `${event.changes.length} ${event.changes.length === 1 ? "change" : "changes"}`;
  return `${event.occurredAt}  ${event.type}  ${count}${summary ? ` | ${summary}` : ""}`;
};

export const renderLibraryHistory = (data: HistoryResult) =>
  data.events.length
    ? data.events.map(renderLibraryHistoryEvent).join("\n")
    : "No Library history recorded.";
