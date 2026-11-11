import type { Inline } from "../terminal/blocks.js";
import { describeFailure } from "../terminal/failure.js";
import type { FailureDescription } from "../terminal/failure.js";
import { Block } from "../terminal/blocks.js";
import {
  SourceFetchFailure,
  SourcePolicyViolationReason,
  type SourceLimitResource,
} from "@smolai/skit-core/library/source/failures";
import { errorMessage } from "@smolai/skit-core/shared";
import { Match } from "effect";
import { schemaFailureMessages } from "../platform/schema-failure.js";

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

const sourcePolicyReason = (
  reason: Exclude<
    SourcePolicyViolationReason,
    { readonly _tag: "ProcessFailed" | "GitRevisionUnavailable" | "DiscoveryIndexInvalid" }
  >,
): string =>
  Match.value(reason).pipe(
    Match.tagsExhaustive({
      TransportFailure: ({ failure }) => `Source transport failed: ${errorMessage(failure)}`,
      HttpStatus: ({ url, status }) => `Source download returned HTTP ${status}: ${url}`,
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
        `Locked Skill path is missing from the Source files: ${path}`,
      LockedPathsAbsent: () => "None of the locked Skill paths exist in the Source files",
      GitPathOutsideCheckout: ({ path, resolved }) =>
        `Selected Git path ${path} resolves outside the checkout: ${resolved}`,
      GitPathMissing: ({ path }) =>
        `Selected Git path is missing or its symlink target is unavailable: ${path}`,
      DiscoveryBaseInvalid: ({ origin }) =>
        `Discovery Source requires a safe HTTPS base URL: ${origin}`,
      DiscoverySelectionInvalid: ({ names }) =>
        `Discovery selection contains an invalid Skill name: ${names.join(", ")}`,
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
      GitLocatorRequired: ({ kind }) =>
        `A pinned Git revision requires a Git locator; received ${kind}`,
      GitCommitMissing: ({ locator }) => `Git source ${locator} has no recorded commit`,
      RegistryVersionInvalid: ({ requested, reported }) =>
        `Registry download did not identify an immutable Release version for ${requested}${reported === undefined ? "" : `: received ${reported}`}`,
      RegistryVersionMismatch: ({ requested, actual }) =>
        `Registry served Release ${actual} when ${requested} was requested`,
      RegistryArchiveRequired: () => "Registry download must be a ZIP archive",
    }),
  );

const policyNext = (reason: SourcePolicyViolationReason): readonly Inline[] => {
  switch (reason._tag) {
    case "TransportFailure":
    case "HttpStatus":
      return ["Check that the source is reachable and that you can access it, then retry."];
    case "GitCommitMissing":
      return [
        "Run ",
        { code: "skit update" },
        " on the device that has this Version, then sync it before importing on another device.",
      ];
    case "GitRevisionUnavailable":
      return [
        "Restore access to that revision, or run ",
        { code: "skit update" },
        " on the device that has this Version, then sync again. No newer revision was substituted.",
      ];
    case "GitPathMissing":
      return ["Verify the selected directory and its link target, then retry."];
    case "RegistryVersionInvalid":
      return ["Upgrade the Registry or select an explicit immutable Release version."];
    case "RegistryVersionMismatch":
      return ["Check the Registry's Release download response before retrying."];
    default:
      return ["Correct the reported source, selection or pin, then retry."];
  }
};

export const sourceContentFailure: (error: SourceFetchFailure) => FailureDescription =
  Match.type<SourceFetchFailure>().pipe(
    Match.tagsExhaustive({
      CommandFailed: ({ command, exitCode, stderr }) =>
        describeFailure({
          summary: [{ code: command }, ` failed (exit ${exitCode})`],
          details: stderr ? [Block.Verbatim({ text: stderr })] : [],
          next: ["Check the command's output above, then retry."],
        }),
      SourcePolicyViolation: ({ reason }) =>
        Match.value(reason).pipe(
          Match.tag("ProcessFailed", ({ failure }) => sourceContentFailure(failure)),
          Match.tag("GitRevisionUnavailable", ({ revision, remote, failure }) =>
            describeFailure({
              summary: [
                "Cannot read Git revision ",
                { code: revision },
                " from ",
                { code: remote },
              ],
              details: [
                Block.Group({
                  title: "Command failed",
                  children: sourceContentFailure(failure).explanation,
                }),
              ],
              next: policyNext(reason),
            }),
          ),
          Match.tag("DiscoveryIndexInvalid", ({ url, failure }) =>
            describeFailure({
              summary: ["Invalid discovery index at ", { code: url }],
              details: [
                Block.List({
                  items: schemaFailureMessages(failure).map((message) => ({ text: [message] })),
                }),
              ],
              next: policyNext(reason),
            }),
          ),
          Match.orElse((reason) =>
            describeFailure({
              summary: [sourcePolicyReason(reason)],
              next: policyNext(reason),
            }),
          ),
        ),
      "SourceProcess.OutputTooLarge": ({ invocation, stream, limit }) =>
        describeFailure({
          summary: [{ code: invocation }, ` produced more than ${limit} bytes on ${stream}`],
          next: ["Choose a smaller source, then retry."],
        }),
      "SourceProcess.TimedOut": ({ invocation, timeoutMs }) =>
        describeFailure({
          summary: [{ code: invocation }, ` timed out after ${timeoutMs}ms`],
          next: ["Check that the source is reachable, then retry."],
        }),
    }),
  );
