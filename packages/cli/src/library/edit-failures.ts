import { describeFailure } from "../terminal/failure.js";
import { EditImportFailure, EditImportMissingReason } from "@smolai/skit-core/library/edit";
import { Match } from "effect";

export const editImportFailure = Match.type<EditImportFailure>().pipe(
  Match.tagsExhaustive({
    "Library.EditImportMissing": ({ reason }) =>
      describeFailure({
        summary: [
          EditImportMissingReason.match(reason, {
            SkillNotFound: ({ query }) => `No Skill matches ${query}`,
            InstalledSkillNotFound: ({ selector }) => `No installed skill matches ${selector}`,
            LibraryVersionMissing: ({ skill }) => `${skill} has no selected Library Version`,
            ContentUnchanged: ({ path }) => `${path} has not changed from its Library Version`,
          }),
        ],
        next: ["Run ", { code: "skit doctor" }, " to inspect changed installed skills."],
      }),
    "Library.EditImportAmbiguous": ({ kind, query, matches }) =>
      describeFailure({
        summary: [
          `More than one ${kind === "skill" ? "Skill" : "installed skill"} matches ${query}: ${matches.join(", ")}`,
        ],
        next:
          kind === "skill"
            ? ["Use an exact Skill ID to select one Skill."]
            : ["Use the installed skill folder path with ", { code: "--from" }, "."],
      }),
  }),
);
