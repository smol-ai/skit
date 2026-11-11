import {
  SourceFetchFailure,
  SourcePolicyViolationReason,
  type SourceLimitResource,
} from "@smolai/skit-core/library/source/failures";
import { errorMessage } from "@smolai/skit-core/shared";
import { Match } from "effect";
import { schemaFailure } from "./schema-failure";

const resourceNames: Record<SourceLimitResource, string> = {
  "archive-files": "Archive file count",
  "archive-bytes": "Extracted archive size in bytes",
  "discovery-directories": "Source discovery directory count",
  "http-response-bytes": "Discovery response size in bytes",
  "discovery-download-bytes": "Total discovery download size in bytes",
  "discovery-file-bytes": "Total discovery file size in bytes",
  "source-download-bytes": "Source download size in bytes",
  "direct-skill-bytes": "SKILL.md download size in bytes",
};

const sourceFetchReason = (reason: SourcePolicyViolationReason): string =>
  SourcePolicyViolationReason.match(reason, {
    TransportFailure: ({ failure }) => `Source transport failed: ${errorMessage(failure)}`,
    HttpStatus: ({ url, status }) => `Source download returned HTTP ${status}: ${url}`,
    ProcessFailed: ({ failure }) => sourceFetchFailure(failure).message,
    LimitExceeded: ({ resource, limit, actual }) =>
      `${resourceNames[resource]} exceeds ${limit}: received ${actual}`,
    ArchiveEntryUnsupported: ({ path, kind }) =>
      `Archive contains an unsupported ${kind.toLowerCase()} entry: ${path}`,
    ArchiveLink: ({ format }) => `${format} archive contains a link`,
    LockedPathInvalid: ({ path, rule }) =>
      rule === "relative"
        ? `Locked Skill path must be safe and relative: ${path}`
        : `Locked Skill path must end in SKILL.md: ${path}`,
    LockedPathMissing: ({ path }) =>
      `Locked Skill path is missing from the downloaded Source: ${path}`,
    LockedPathsAbsent: () => "None of the locked Skill paths exist in the downloaded Source",
    GitPathOutsideCheckout: ({ path, resolved }) =>
      `Selected Git path ${path} resolves outside the checkout: ${resolved}`,
    GitPathMissing: ({ path }) =>
      `Selected Git path is missing or its symlink target is unavailable: ${path}`,
    DiscoveryBaseInvalid: ({ origin }) =>
      `Discovery Source requires a safe HTTPS base URL: ${origin}`,
    DiscoverySelectionInvalid: ({ names }) =>
      `Discovery selection contains an invalid Skill name: ${names.join(", ")}`,
    DiscoveryIndexInvalid: ({ url, failure }) =>
      `Invalid discovery index at ${url}: ${schemaFailure(failure)}`,
    DiscoverySchemaUnsupported: ({ schema }) => `Unsupported discovery schema: ${schema}`,
    DiscoverySkillCountInvalid: ({ actual, minimum, maximum }) =>
      `Discovery index must contain ${minimum}–${maximum} Skills; received ${actual}`,
    DiscoverySkillMissing: ({ name }) => `Selected discovery Skill is absent upstream: ${name}`,
    DiscoveryNameInvalid: ({ name }) => `Invalid discovery Skill name: ${name}`,
    DiscoveryNameDuplicate: ({ name }) => `Duplicate discovery Skill name: ${name}`,
    DiscoveryHashInvalid: ({ name, digest }) => `Invalid discovery hash for ${name}: ${digest}`,
    DiscoveryUrlUnsafe: ({ name, url }) => `Unsafe discovery artifact URL for ${name}: ${url}`,
    DiscoveryHashMismatch: ({ name, expected, actual }) =>
      `Discovery artifact hash disagrees for ${name}: expected ${expected}, received ${actual}`,
    DiscoveryArchiveUnsupported: ({ name }) => `Unsupported discovery archive for ${name}`,
    DiscoverySkillDocumentUnlisted: ({ name }) =>
      `Legacy discovery Skill ${name} must list SKILL.md`,
    DiscoverySkillDocumentMissing: ({ name }) => `Discovery Skill ${name} has no root SKILL.md`,
    DiscoveryFilePathUnsafe: ({ path }) => `Unsafe legacy discovery file path: ${path}`,
    DiscoveryFilePathDuplicate: ({ path }) => `Duplicate legacy discovery file path: ${path}`,
    GitPinInvalid: ({ commit }) => `Invalid pinned Git commit: ${commit}`,
    GitTrackingRefMismatch: ({ expected, actual }) =>
      `Pinned Git tracking ref ${actual ?? "(default branch)"} disagrees with locator ref ${expected ?? "(default branch)"}`,
    GitCommitMismatch: ({ expected, actual }) =>
      `Git returned ${actual} instead of pinned commit ${expected}`,
    GitRevisionUnavailable: ({ revision, remote, failure }) =>
      `Cannot acquire Git revision ${revision} from ${remote}: ${sourceFetchFailure(failure).message}`,
    GitLocatorRequired: ({ kind }) =>
      `A pinned Git revision requires a Git locator; received ${kind}`,
    GitCommitMissing: ({ locator }) => `Git source ${locator} has no recorded commit`,
    RegistryVersionInvalid: ({ requested, reported }) =>
      `Registry download did not identify an immutable Release version for ${requested}${reported === undefined ? "" : `: received ${reported}`}`,
    RegistryVersionMismatch: ({ requested, actual }) =>
      `Registry served Release ${actual} when ${requested} was requested`,
    RegistryArchiveRequired: () => "Registry download must be a ZIP archive",
  });

const policyRemediation = (reason: SourcePolicyViolationReason): string => {
  switch (reason._tag) {
    case "TransportFailure":
    case "HttpStatus":
      return "Check that the source is reachable and that you can access it, then retry.";
    case "ProcessFailed":
      return sourceFetchFailure(reason.failure).remediation;
    case "GitCommitMissing":
      return "Update the Collection on the device holding its files and sync it before importing on another device.";
    case "GitRevisionUnavailable":
      return "Restore access to that revision, or update the Collection on the device holding its files and sync again. No newer revision was substituted.";
    case "GitPathMissing":
      return "Verify the selected directory and its link target, then retry.";
    case "RegistryVersionInvalid":
      return "Upgrade the Registry or select an explicit immutable Release version.";
    case "RegistryVersionMismatch":
      return "Check the Registry's Release download response before retrying.";
    default:
      return "Correct the reported source, selection or pin, then retry.";
  }
};

export const sourceFetchFailure: (error: SourceFetchFailure) => {
  message: string;
  remediation: string;
} = Match.type<SourceFetchFailure>().pipe(
  Match.tagsExhaustive({
    CommandFailed: ({ command, exitCode, stderr }) => ({
      message: `${command} failed (${exitCode}): ${stderr}`,
      remediation: "Check the command's output above, then retry.",
    }),
    SourcePolicyViolation: ({ reason }) => ({
      message: sourceFetchReason(reason),
      remediation: policyRemediation(reason),
    }),
    "SourceProcess.OutputTooLarge": ({ invocation, stream, limit }) => ({
      message: `${invocation} produced more than ${limit} bytes on ${stream}`,
      remediation: "Choose a smaller source, then retry.",
    }),
    "SourceProcess.TimedOut": ({ invocation, timeoutMs }) => ({
      message: `${invocation} timed out after ${timeoutMs}ms`,
      remediation: "Check that the source is reachable, then retry.",
    }),
  }),
);
