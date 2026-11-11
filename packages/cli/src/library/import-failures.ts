import { describeFailure } from "../terminal/failure.js";
import {
  ImportFailure,
  ImportRequestInvalidReason,
} from "@smolai/skit-core/library/import/failures";
import { Match } from "effect";
import { schemaFailure } from "../platform/schema-failure.js";
import { validationDiagnostic } from "../platform/validation-diagnostic.js";

const importRequestReason = (reason: ImportRequestInvalidReason): string =>
  ImportRequestInvalidReason.match(reason, {
    EmptyCollection: () => "empty Collection",
    UnsafeSkillPath: ({ skill, path }) =>
      `unsafe Skill path ${JSON.stringify(path)} for ${JSON.stringify(skill)}`,
    DuplicateSkillName: ({ name, paths }) =>
      `duplicate Skill name ${JSON.stringify(name)} at ${paths.map((path) => JSON.stringify(path)).join(" and ")}`,
    OverlappingSkillPaths: ({ skills }) =>
      `overlapping Skill paths ${skills.map(({ name, path }) => `${JSON.stringify(path)} (${JSON.stringify(name)})`).join(" and ")}`,
    ObservedContentChanged: ({ skill, expected, actual }) =>
      `imported Skill ${skill} changed: expected ${expected}, found ${actual}`,
    StateInvalid: ({ kind, failure }) =>
      `${kind === "library-state" ? "imported Collection failed validation" : "imported Collection would violate the portable manifest"}: ${schemaFailure(failure)}`,
    AuthoredContentInvalid: ({ diagnostics }) =>
      `authored Descriptor or Skill content is invalid: ${diagnostics
        .filter((diagnostic) => diagnostic.severity === "error")
        .map((diagnostic) => `${diagnostic.path}: ${validationDiagnostic(diagnostic)}`)
        .join("; ")}`,
    AuthoredIdentityMissing: ({ skill }) => `authored Skill ${skill} has no validation identity`,
  });
export const importFailure = Match.type<ImportFailure>().pipe(
  Match.tagsExhaustive({
    "Library.ImportRequestInvalid": ({ reason }) =>
      describeFailure({
        summary: [`Cannot import Collection: ${importRequestReason(reason)}`],
        next: ["Inspect the reported Skill paths in the source, correct the content, and retry."],
      }),
    "Library.InstalledSkillChanged": ({ path }) =>
      describeFailure({
        summary: [`Installed skill changed after it was checked: ${path}`],
        next: ["Preview importing the installed skill's changes again."],
      }),
  }),
);
