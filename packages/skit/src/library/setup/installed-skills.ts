import { stepError } from "../store/step-error.js";
import { basename } from "node:path";
import { Effect } from "effect";
import { hashParts } from "../../artifact/descriptor.js";
import type { Interface } from "../library.js";
import { reviewInstalledSkillChanges } from "../installed-skill-review.js";
import { emptyLibraryState } from "../library-state.js";
import type { Snapshot } from "../snapshot.js";
import { type InstalledSkillChange } from "./contract.js";

/** What updating every installed copy would do, as setup reviews it. Changes nothing. */
export const planInstalledSkillChanges = Effect.fn("Setup.planInstalledSkillChanges")(function* (
  owner: Pick<Interface, "plan">,
  base: Snapshot,
) {
  const state = base._tag === "Present" ? base.state : emptyLibraryState();
  return yield* owner.plan({ _tag: "Install" }, { base }).pipe(
    Effect.map(reviewInstalledSkillChanges),
    // Setup still discovers when the Library cannot plan its copies, and touches none of them.
    Effect.catch((error) =>
      Effect.succeed(
        state.installed_skills.flatMap((copy): InstalledSkillChange[] => [
          {
            installedSkillId: copy.installed_skill_id,
            skillId: copy.skill_id,
            name:
              state.skills.find((skill) => skill.skill_id === copy.skill_id)?.name ??
              basename(copy.path),
            path: copy.path,
            destination: copy.destination,
            baselineHash: copy.expected_hash,
            evidence: hashParts([copy.path, "unplanned"]),
            status: "protected",
            reason: { _tag: "PlanningFailed", error: stepError(error) },
            metadataChanged: false,
          },
        ]),
      ),
    ),
  );
});
