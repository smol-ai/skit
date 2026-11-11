import { commandFailure } from "../../commands/failure-classification.js";
import { authoredSkillIssueLines } from "../authored-skill-issues.js";
import { Block, type Change } from "../../terminal/blocks.js";
import type { UpdatePlan, UpdateResult } from "./output.js";
import { plural, sourceDiagnostics } from "../presentation/source.js";

/** One Source's effect on this device: enabled, changed, retired, kept, and available Skills. */
function skillChanges(
  item: Pick<UpdatePlan[number], "enabled" | "updated" | "removed" | "kept" | "new_available">,
): Block[] {
  const changes: Change[] = [
    ...item.enabled.map((label): Change => ({ action: "add", label })),
    ...item.updated.map((label): Change => ({ action: "update", label })),
    ...item.removed.map((label): Change => ({ action: "remove", label })),
  ];
  return [
    ...(changes.length ? [Block.Changes({ items: changes })] : []),
    ...item.kept.map((name) =>
      Block.Status({
        tone: "warn",
        text: [`${name} was deleted upstream; kept because it is enabled on its own`],
      }),
    ),
    ...(item.new_available
      ? [Block.Note({ text: [`${plural(item.new_available, "new Skill")} available to enable`] })]
      : []),
  ];
}

export function renderUpdate(data: UpdateResult): Block[] {
  if (!data.length)
    return [Block.Status({ tone: "info", text: ["No device-local Sources to update"] })];
  const failures = data.filter((item) => "status" in item);
  const successful = data.filter((item) => "changed" in item);
  const updated = successful.filter((item) => item.changed);
  const current = successful.length - updated.length;
  const syncFailed = successful.some((item) => item.sync_error !== undefined);
  const hasWarnings = successful.some(
    (item) =>
      item.installation_error !== undefined ||
      item.diagnostics?.length ||
      item.issues?.length ||
      item.sync_status === "blocked" ||
      item.sync_status === "waiting_for_removal",
  );
  // What each successful Source has to say beyond its Skill changes.
  const sources = (changes: (item: (typeof successful)[number]) => Block[]) =>
    successful.flatMap((item) => {
      const children = [
        ...changes(item),
        ...sourceDiagnostics(item.diagnostics),
        ...authoredSkillIssueLines(item.issues).map((message) =>
          Block.Status({ tone: "warn", text: [message] }),
        ),
        ...(item.installation_error === undefined
          ? []
          : [
              Block.Group({
                title:
                  "Installed skills could not be checked again after sync; earlier updates were kept",
                children: commandFailure(item.installation_error.cause).presentation,
              }),
            ]),
        ...(item.sync_error === undefined
          ? []
          : [
              Block.Group({
                title: "Registry sync failed after the local update",
                children: commandFailure(item.sync_error.cause).presentation,
              }),
            ]),
        ...(item.sync_status === "blocked" || item.sync_status === "waiting_for_removal"
          ? [
              Block.Status({
                tone: "warn",
                text: [
                  `Registry sync ${item.sync_status === "blocked" ? "paused for removal approval" : "waiting for removal confirmation"}`,
                ],
              }),
            ]
          : []),
      ];
      return children.length ? [Block.Group({ title: item.label, children })] : [];
    });
  if (updated.length === 0 && failures.length === 0)
    return [
      ...(syncFailed
        ? [
            Block.Status({
              tone: "warn",
              text: ["Local updates complete; Registry sync failed"],
            }),
          ]
        : hasWarnings
          ? [
              Block.Status({ tone: "warn", text: ["Update checks found issues"] }),
              Block.Note({
                text: [`${plural(current, "Source")} checked; no Collection Versions changed.`],
              }),
              ...(successful.some((item) => item.installed > 0)
                ? [Block.Note({ text: ["Installed skills updated."] })]
                : []),
            ]
          : successful.some((item) => item.installed > 0)
            ? [
                Block.Status({
                  tone: "ok",
                  text: ["Sources are current; installed skills updated"],
                }),
                Block.Note({
                  text: [`${plural(current, "Source")} checked; no Collection Versions changed.`],
                }),
              ]
            : [
                Block.Status({ tone: "ok", text: ["Everything is current"] }),
                Block.Note({
                  text: [
                    `${plural(current, "Source")} checked; no Collection Versions or installed skills changed.`,
                  ],
                }),
              ]),
      ...sources(() => []),
    ];
  return [
    failures.length
      ? Block.Status({ tone: "error", text: ["Update finished with failures"] })
      : syncFailed
        ? Block.Status({ tone: "warn", text: ["Local updates complete; Registry sync failed"] })
        : hasWarnings
          ? Block.Status({ tone: "warn", text: ["Update completed with issues"] })
          : Block.Status({ tone: "ok", text: ["Update complete"] }),
    ...sources((item) => (item.changed ? skillChanges(item) : [])),
    ...failures.map((item) => {
      const failure = commandFailure(item.error.cause);
      return Block.Group({
        title: item.label,
        children: [
          Block.Status({
            tone: "error",
            text: [
              `Failed while ${item.phase === "source" ? "fetching or importing Source" : "updating installed skills"}`,
            ],
          }),
          Block.Fields({ rows: [{ label: "Source", value: [{ dim: item.source }] }] }),
          ...(item.source_imported
            ? [
                Block.Note({
                  text: [
                    "New Collection Version imported; this Collection did not finish updating.",
                  ],
                }),
              ]
            : []),
          ...failure.explanation,
          Block.Fields({
            rows: [
              {
                label: "Next",
                value: [
                  ...failure.next,
                  ...(item.source_imported
                    ? [
                        " Then run ",
                        { code: `skit update ${item.subject_id}` },
                        " again to finish updating its installed skills.",
                      ]
                    : []),
                ],
              },
            ],
          }),
        ],
      });
    }),
    Block.Note({
      text: [
        `${plural(updated.length, "Source")} updated${current ? `; ${current} unchanged` : ""}${failures.length ? `; ${failures.length} failed` : ""}.`,
      ],
    }),
  ];
}

export function renderUpdatePlan(data: UpdatePlan): Block[] {
  if (!data.length)
    return [Block.Status({ tone: "info", text: ["No device-local Sources to update"] })];
  const updates = data.filter((item) => item.changed).length;
  const hasWarnings = data.some((item) => item.diagnostics?.length || item.issues?.length);
  return [
    Block.Heading({ text: "Update plan" }),
    ...data.map((item) =>
      Block.Group({
        title: item.label,
        children: [
          Block.Note({
            text: [
              {
                dim: item.changed
                  ? "update available"
                  : item.diagnostics?.length || item.issues?.length
                    ? "no selected changes"
                    : "current",
              },
            ],
          }),
          ...skillChanges(item),
          ...sourceDiagnostics(item.diagnostics),
          ...authoredSkillIssueLines(item.issues).map((message) =>
            Block.Status({ tone: "warn", text: [message] }),
          ),
        ],
      }),
    ),
    updates
      ? Block.Status({
          tone: "info",
          text: [
            `${plural(updates, "Source")} can be updated. No changes applied; run `,
            { code: "skit update" },
            " to apply.",
          ],
        })
      : hasWarnings
        ? Block.Status({ tone: "warn", text: ["No selected changes; review the reported issues."] })
        : Block.Status({ tone: "ok", text: ["Everything is current."] }),
  ];
}
