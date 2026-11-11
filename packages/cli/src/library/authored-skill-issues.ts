import { AuthoredSkillIssue } from "@smolai/skit-core/library/update";
import { applyFailure } from "./apply-failure.js";
import { libraryFailure } from "./failures.js";
import { validationDiagnostic } from "../platform/validation-diagnostic.js";

/** Author installation decisions acquire their wording only when the CLI presents them. */
export const authoredSkillIssue = (issue: AuthoredSkillIssue): string =>
  AuthoredSkillIssue.match(issue, {
    DescriptorHeld: ({ failure }) => `Descriptor held: ${applyFailure(failure).message}`,
    ReservedInputPath: ({ path }) => `${path} is reserved for input provenance`,
    MembershipRemovalPending: ({ skill }) =>
      `Keeping ${skill}: membership removal awaits confirmation`,
    InputRemovalPending: ({ skill, paths }) =>
      `${skill}: ${paths.map((path) => `Input removal awaits confirmation: ${path}`).join("; ")}`,
    ValidationHeld: ({ skill, diagnostics }) =>
      `${skill}: ${diagnostics.map(validationDiagnostic).join("; ")}`,
    MetadataHeld: ({ skill, reports }) =>
      `${skill}: ${reports.flatMap((report) => report.issues.filter((item) => item.severity === "error").map((item) => `${report.harness}: ${item.code}${item.field === null ? "" : ` (${item.field})`}`)).join("; ")}`,
    PreparationFailed: ({ skill, failure }) =>
      `${skill}: ${failure._tag === "Library.SkillMaterializationInvalid" ? libraryFailure(failure).message : applyFailure(failure).message}`,
    UninstallBlocked: ({ skill, failure }) => `${skill}: ${applyFailure(failure).message}`,
    CopyFailed: ({ skill, path, failure }) =>
      `${skill} at ${path}: ${applyFailure(failure).message}`,
    CopyConflicted: ({ skill, path }) =>
      `${skill} at ${path}: copy conflicts with the Library version; left unchanged`,
    CopyPending: ({ skill, path }) => `${skill} at ${path}: installation is pending`,
    InstallationFailed: ({ skill, paths, failure }) =>
      `${skill}${paths.length ? ` at ${paths.join(", ")}` : ""}: ${applyFailure(failure).message}`,
  });

export const authoredSkillIssueLines = (issues: readonly AuthoredSkillIssue[] = []): string[] =>
  issues.map(authoredSkillIssue);
