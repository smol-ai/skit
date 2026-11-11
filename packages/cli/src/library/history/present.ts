import { Block } from "../../terminal/blocks.js";
import type { HistoryResult } from "./output.js";

// Stored audit names also occur in historical records; translate them only for terminal output.
const eventLabels: Readonly<Record<string, string>> = {
  "library.synced": "Library synced",
  "library.unchanged": "Library unchanged",
  "custody.adopted": "Existing skills managed",
  "collection.retained": "Collection imported",
  "collection.updated": "Collection updated",
  "collection.removed": "Collection removed",
  "skill.version-selected": "Skill version selected",
  "binding.enabled": "Skills enabled",
  "binding.disabled": "Skills disabled",
  "binding.skills-changed": "Enabled skills changed",
  "binding.invocation-changed": "Invocation settings changed",
  "projection.native-deletion-observed": "Missing skill folder recorded",
  "projection.projected": "Skill folder installed",
  "projection.retired": "Skill folder uninstalled",
  "version.retained": "Skill version imported",
};

const actionLabels: Readonly<Record<string, string>> = {
  retained: "imported",
  projected: "installed",
  reprojected: "reinstalled",
  retired: "uninstalled",
  "version-selected": "version selected",
  "skills-changed": "enabled skills changed",
  "invocation-changed": "invocation settings changed",
};

export const renderLibraryHistory = (data: HistoryResult): Block[] =>
  data.events.length
    ? [
        Block.Table({
          columns: [
            { title: "Occurred" },
            { title: "Event" },
            { title: "Changes", align: "end" },
            { title: "Actions" },
          ],
          rows: data.events.map((event) => {
            const actions = new Map<string, number>();
            for (const change of event.changes)
              actions.set(change.action, (actions.get(change.action) ?? 0) + 1);
            return [
              [{ dim: event.occurredAt }],
              [eventLabels[event.type] ?? event.type],
              [`${event.changes.length}`],
              [
                [...actions.entries()]
                  .sort(([left], [right]) => left.localeCompare(right))
                  .map(([action, count]) => `${count} ${actionLabels[action] ?? action}`)
                  .join(", "),
              ],
            ];
          }),
        }),
      ]
    : [Block.Status({ tone: "info", text: ["No Library history recorded."] })];
