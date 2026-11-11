import type { SetEnabledChange, SetEnabledResult } from "@smolai/skit-core/library/enable";
import { Block } from "../../terminal/blocks.js";
import { applyFailure } from "../apply-failure.js";
import { duplicateScanIssue } from "../duplicate-scan.js";
import { collectionIdentity } from "../presentation/collection-source.js";

export function renderSetEnabled(
  data: SetEnabledChange | SetEnabledResult,
  applied: boolean,
): Block[] {
  const application = "application" in data ? data.application : undefined;
  const incomplete = applied && application?.status === "incomplete";
  const verb = incomplete
    ? application.intent === "saved"
      ? "Library choice saved for"
      : "Library choice unchanged for"
    : applied
      ? data.action === "enable"
        ? "Enabled"
        : "Disabled"
      : data.action === "enable"
        ? "Would enable"
        : "Would disable";
  const skills =
    data.skills.length > 3
      ? `${data.skills.length} skills`
      : data.skills.length
        ? data.skills.join(", ")
        : "no skills";
  const headline = `${verb} ${skills}${data.scope.kind === "global" ? "" : ` in ${data.scope.root}`}`;
  const unchanged = !incomplete && !data.changed;
  const duplicates = data.duplicates ?? [];
  const notInstalled =
    "installed_skills" in data && data.action === "enable"
      ? data.installed_skills.filter((copy) => copy.status !== "installed")
      : [];
  const unmanaged = applied ? [] : (data.unmanaged_destinations ?? []);
  const failure =
    application?.failure === undefined ? undefined : applyFailure(application.failure.cause);
  return [
    ...(data.collection_label === undefined
      ? []
      : collectionIdentity(data.collection_label, data.collection_source)),
    unchanged
      ? Block.Status({ tone: "info", text: [headline] })
      : applied
        ? Block.Status({ tone: incomplete ? "warn" : "ok", text: [headline] })
        : Block.Changes({
            items: [{ action: data.action === "enable" ? "add" : "remove", label: headline }],
          }),
    ...(unchanged
      ? [
          Block.Status({
            tone: "info",
            text: [data.action === "enable" ? "Already enabled" : "Already disabled"],
          }),
        ]
      : []),
    ...(unchanged && data.repair
      ? [
          applied
            ? Block.Status({ tone: "ok", text: ["Copies repaired"] })
            : Block.Status({ tone: "warn", text: ["Copies need repair"] }),
        ]
      : []),
    ...(duplicates.length
      ? [
          Block.Status({
            tone: "warn",
            text: applied
              ? ["Allowed duplicate copies"]
              : ["Blocked unless ", { code: "--allow-duplicate" }],
          }),
          Block.Table({
            columns: [
              { title: "Skill" },
              { title: "Harness" },
              { title: "Path" },
              { title: "Copy" },
            ],
            rows: duplicates.flatMap((duplicate) =>
              duplicate.aliases.map((alias) => [
                [duplicate.name],
                [duplicate.harness],
                [{ dim: alias.path }],
                alias.via === "symlink"
                  ? ["symlink → ", { dim: duplicate.canonicalPath }]
                  : ["directory"],
              ]),
            ),
          }),
        ]
      : []),
    ...(unmanaged.length
      ? [
          Block.Note({
            text: [
              "A folder SKIT does not manage is already there; enable manages it only if it is identical, otherwise it is left in place:",
            ],
          }),
          Block.Table({
            columns: [{ title: "Destination" }, { title: "Path" }],
            rows: unmanaged.map((folder) => [[folder.destination], [{ dim: folder.path }]]),
          }),
        ]
      : []),
    ...(notInstalled.length
      ? [
          Block.Status({ tone: "warn", text: ["Destinations not recorded installed:"] }),
          Block.Table({
            columns: [{ title: "Destination" }, { title: "Status" }, { title: "Path" }],
            rows: notInstalled.map((copy) => [
              [copy.destination],
              [copy.status],
              [{ dim: copy.path }],
            ]),
          }),
        ]
      : []),
    ...(data.warnings ?? []).map((warning) =>
      Block.Status({
        tone: "warn",
        text: [
          "Could not inspect ",
          { dim: warning.path },
          `: ${duplicateScanIssue(warning.reason)}`,
        ],
      }),
    ),
    ...(incomplete
      ? [
          Block.Status({
            tone: "warn",
            text: ["Installed copies need attention."],
          }),
          ...(failure
            ? [
                Block.Group({
                  title: data.action === "enable" ? "Installation failed" : "Removal failed",
                  children: failure.explanation,
                }),
                Block.Fields({ rows: [{ label: "Next", value: failure.next }] }),
              ]
            : [
                Block.Note({
                  text: [
                    "Installing did not complete. Inspect the copies, then preview and retry.",
                  ],
                }),
              ]),
        ]
      : []),
  ];
}
