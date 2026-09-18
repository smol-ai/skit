import type {
  PortableSetEnabledPlan,
  PortableSetEnabledResult,
} from "../workflows/library/portable-set-enabled-contract.js";
import { harnessLabel } from "../harness/catalog.js";

export function renderPortableSetEnabled(
  data: PortableSetEnabledPlan | PortableSetEnabledResult,
  applied: boolean,
): string {
  const verb = applied
    ? data.enabled
      ? "Enabled"
      : "Disabled"
    : data.enabled
      ? "Would enable"
      : "Would disable";
  const skills = data.skills.length ? data.skills.join(", ") : "no Skills";
  const harnesses = data.harnesses.map(harnessLabel).join(", ");
  const destination = data.scope.kind === "global" ? "all projects" : data.scope.root;
  const change = data.changed ? "" : data.enabled ? " · Already enabled" : " · Already disabled";
  const projection =
    "projections" in data
      ? data.projections
          .flatMap((item) =>
            item.status === "deferred"
              ? [`${harnessLabel(item.harness)}: Skills directory unavailable; files not updated`]
              : [],
          )
          .map((notice) => `\n${notice}`)
          .join("")
      : "";
  return `${verb} ${skills} for ${harnesses} (${destination})${change}${projection}`;
}
