import { harnessLabel } from "@smolai/skit-core/harnesses";
import type { HarnessSkillOrigin, SetupSkillInstance } from "@smolai/skit-core/library/setup";

const origins = {
  system: "system",
  "bundled-plugin": "bundled",
  "runtime-plugin": "runtime",
  "curated-plugin": "curated",
} satisfies Record<HarnessSkillOrigin, string>;

export const harnessOrigin = (
  owner: Extract<SetupSkillInstance["owner"], { kind: "harness" }>,
): string => `${harnessLabel(owner.harness)} ${origins[owner.origin]}`;
