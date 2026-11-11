import {
  SetupApplyStage,
  SetupProgress,
  type SetupApplyOptions,
} from "@smolai/skit-core/library/setup";
import type { RendererShape } from "../../terminal/renderer.js";

const plural = (count: number, one: string, many: string) => (count === 1 ? one : many);

const stageMessage = (stage: SetupApplyStage): string =>
  SetupApplyStage.match(stage, {
    Import: ({ collections, skills }) =>
      `importing ${collections} installed ${plural(collections, "Collection", "Collections")} (${skills} ${plural(skills, "Skill", "Skills")})`,
    ManageExisting: ({ reconnects }) =>
      reconnects
        ? `reconnecting ${reconnects} existing Library ${plural(reconnects, "match", "matches")}`
        : "keeping existing Library matches without enabling",
    ManageNew: ({ skills }) =>
      `managing ${skills} existing local ${plural(skills, "Skill", "Skills")}`,
    Remove: ({ copies }) => `removing ${copies} installed ${plural(copies, "copy", "copies")}`,
  });

export const setupProgressMessage = (progress: SetupProgress): string =>
  SetupProgress.match(progress, {
    RevalidatePlan: () => "Revalidating the approved setup plan",
    ApplyPlan: ({ stages }) =>
      stages.length
        ? `Applying setup: ${stages.map(stageMessage).join(", ")}`
        : "Recording this machine's setup",
    SaveDiscoveryRoots: () => "Saving this machine's discovery roots",
  });

export const setupStage =
  (renderer: Pick<RendererShape, "withStatus">): SetupApplyOptions["withStage"] =>
  (progress, operation) =>
    renderer.withStatus(setupProgressMessage(progress), operation);
