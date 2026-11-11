import { EditImportFailure, EditImportMissingReason } from "@smolai/skit-core/library/edit";
import { Match } from "effect";

export const editImportFailure = Match.type<EditImportFailure>().pipe(
  Match.tagsExhaustive({
    "Library.EditImportMissing": ({ reason }) => ({
      message: EditImportMissingReason.match(reason, {
        SkillNotFound: ({ query }) => `No Skill matches ${query}`,
        InstalledSkillNotFound: ({ selector }) => `No installed skill matches ${selector}`,
        LibraryVersionMissing: ({ skill }) => `${skill} has no selected Library Version`,
        ContentUnchanged: ({ path }) => `${path} has not changed from its Library Version`,
      }),
      remediation: "Inspect the changed installed skills.",
    }),
    "Library.EditImportAmbiguous": ({ kind, query, matches }) => ({
      message: `More than one ${kind === "skill" ? "Skill" : "installed skill"} matches ${query}: ${matches.join(", ")}`,
      remediation:
        kind === "skill"
          ? "Use an exact Skill ID to select one Skill."
          : "Use an exact installed Skill ID or path to select one installed copy.",
    }),
  }),
);
