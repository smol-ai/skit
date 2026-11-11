import { Block } from "../../terminal/blocks.js";
import type { CheckResult } from "./output.js";
import { skillsShReason, skillsShStatus } from "./reasons.js";

export function renderCheck(data: CheckResult): Block[] {
  if (data.length === 0)
    return [Block.Status({ tone: "info", text: ["The Library has no Collections or Skills."] })];
  return data.flatMap((item): Block[] => {
    const originalIntact = item.collection_versions.every((tree) => tree.original_intact);
    const members = item.skills_sh?.members ?? [];
    const updates = members.filter((member) => member.status === "update-available").length;
    const problems = members.filter(
      (member) => !["current", "update-available", "not-applicable"].includes(member.status),
    );
    if (
      originalIntact &&
      item.unresolved_skill_selections === 0 &&
      item.source_status === "not-applicable" &&
      problems.length === 0
    )
      return [];
    if (
      originalIntact &&
      item.unresolved_skill_selections === 0 &&
      ["current", "not-applicable"].includes(item.source_status) &&
      updates === 0 &&
      problems.length === 0
    )
      return [Block.Status({ tone: "ok", text: [`${item.label} is up to date`] })];
    if (originalIntact && updates > 0 && problems.length === 0)
      return [
        Block.Status({
          tone: "info",
          text: [
            `${item.label} has updates available${members.length > 1 ? ` (${updates} of ${members.length} Skills)` : ""}`,
          ],
        }),
      ];
    if (!originalIntact)
      return [
        Block.Status({ tone: "error", text: [`${item.label} has a damaged Collection Version`] }),
      ];
    if (problems.length)
      return [
        Block.Status({ tone: "warn", text: [`${item.label} needs attention`] }),
        ...problems.map((member) =>
          Block.Group({
            title: member.skill_name,
            children: [
              Block.Note({ text: [skillsShStatus[member.status]] }),
              ...(member.reason ? skillsShReason(member.reason) : []),
            ],
          }),
        ),
      ];
    if (item.source_status === "changed")
      return [Block.Status({ tone: "info", text: [`${item.label} has updates available`] })];
    return [Block.Status({ tone: "warn", text: [`${item.label} could not be fully checked`] })];
  });
}
