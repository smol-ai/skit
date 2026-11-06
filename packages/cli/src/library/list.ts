import { SkitConfiguration } from "@smolai/skit-core/platform";
import { readLibraryList } from "@smolai/skit-core/library/queries";
import { Effect } from "effect";
import { listOutputContracts } from "./list/output.js";
import { Renderer } from "../terminal/renderer.js";
import { encodeResult as result } from "../commands/encode-result.js";

export const presentListCommand = Effect.fn("CLI.list.present")(function* () {
  const view = yield* readLibraryList((yield* SkitConfiguration).skitHome);
  const subjects = view.subjects;
  const value = {
    subjects: subjects.map((subject) => ({
      subject_id: subject.id,
      subject_kind: subject.kind,
      label: subject.label,
      skills: subject.skills.map((skill) => ({
        source: skill.source,
        revision: skill.revision,
        source_updated_at: skill.source_updated_at,
        imported_at: skill.imported_at,
        name: skill.name,
        skill_id: skill.id,
        ...(skill.versionId === undefined ? {} : { selected_skill_version_id: skill.versionId }),
        versions: skill.versions.map((version) => ({
          skill_version_id: version.id,
          artifact_hash: version.hash,
        })),
      })),
    })),
    enabled: view.enabledEverywhere.items,
    enabled_skills: view.enabledEverywhere.skills,
  };
  const renderer = yield* Renderer;
  yield* renderer.result(result("list", listOutputContracts.list, value));
});

export { listOutputContracts } from "./list/output.js";

export { renderLibraryList } from "./list/present.js";
export { browseLibrary } from "./list/browse.js";
