import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import {
  SourceFetchFailure,
  SourcePolicyViolation,
  SourcePolicyViolationReason,
  CommandFailed,
  SourceProcessOutputTooLarge,
  SourceProcessTimedOut,
} from "@smolai/skit-core/library/source/failures";
import { SourceRestoreInvalid } from "@smolai/skit-core/library/source-restore/failures";
import { HarnessProbeFailure } from "@smolai/skit-core/harnesses/probe-failures";
import { AuditProbeFailure } from "@smolai/skit-core/auditing/probe-failures";
import { classifyFailure } from "../src/commands/failure-classification.js";
import { harnessProbeFailure, auditProbeFailure } from "../src/platform/probe-failures.js";

it.effect(
  "keeps every Source fetch reason structured across JSON and formats it at the CLI boundary",
  () =>
    Effect.gen(function* () {
      const schemaError = yield* Effect.flip(Schema.decodeUnknownEffect(Schema.Int)("bad"));
      const command = new CommandFailed({
        command: "git",
        exitCode: 128,
        stderr: "revision unavailable",
      });
      const process = new SourceProcessOutputTooLarge({
        invocation: "git status",
        stream: "stdout",
        limit: 100,
        actual: 101,
      });
      const native = new Error("connection reset", { cause: new Error("socket closed") });
      const cases: {
        [K in SourcePolicyViolationReason["_tag"]]: Extract<
          SourcePolicyViolationReason,
          { _tag: K }
        >;
      } = {
        TransportFailure: { _tag: "TransportFailure", failure: native },
        HttpStatus: { _tag: "HttpStatus", url: "https://source.test/archive", status: 403 },
        ProcessFailed: { _tag: "ProcessFailed", failure: process },
        LimitExceeded: {
          _tag: "LimitExceeded",
          resource: "source-download-bytes",
          limit: 256,
          actual: 257,
        },
        ArchiveEntryUnsupported: {
          _tag: "ArchiveEntryUnsupported",
          path: "link",
          kind: "SymbolicLink",
        },
        ArchiveLink: { _tag: "ArchiveLink", format: "zip" },
        LockedPathInvalid: { _tag: "LockedPathInvalid", path: "../outside", rule: "relative" },
        LockedPathMissing: { _tag: "LockedPathMissing", path: "review/SKILL.md" },
        LockedPathsAbsent: { _tag: "LockedPathsAbsent", paths: ["review/SKILL.md"] },
        GitPathOutsideCheckout: {
          _tag: "GitPathOutsideCheckout",
          path: "review",
          resolved: "/outside/review",
          checkout: "/checkout",
        },
        GitPathMissing: { _tag: "GitPathMissing", path: "review" },
        DiscoveryBaseInvalid: { _tag: "DiscoveryBaseInvalid", origin: "http://insecure.test" },
        DiscoverySelectionInvalid: { _tag: "DiscoverySelectionInvalid", names: ["Not valid"] },
        DiscoveryIndexInvalid: {
          _tag: "DiscoveryIndexInvalid",
          url: "https://source.test/index.json",
          failure: schemaError,
        },
        DiscoverySchemaUnsupported: { _tag: "DiscoverySchemaUnsupported", schema: "unknown" },
        DiscoverySkillCountInvalid: {
          _tag: "DiscoverySkillCountInvalid",
          actual: 0,
          minimum: 1,
          maximum: 1000,
        },
        DiscoverySkillMissing: { _tag: "DiscoverySkillMissing", name: "review" },
        DiscoveryNameInvalid: { _tag: "DiscoveryNameInvalid", name: "Not valid" },
        DiscoveryNameDuplicate: { _tag: "DiscoveryNameDuplicate", name: "review" },
        DiscoveryHashInvalid: { _tag: "DiscoveryHashInvalid", name: "review", digest: "bad" },
        DiscoveryUrlUnsafe: {
          _tag: "DiscoveryUrlUnsafe",
          name: "review",
          url: "http://insecure.test",
        },
        DiscoveryHashMismatch: {
          _tag: "DiscoveryHashMismatch",
          name: "review",
          expected: "sha256:expected",
          actual: "sha256:actual",
        },
        DiscoveryArchiveUnsupported: { _tag: "DiscoveryArchiveUnsupported", name: "review" },
        DiscoverySkillDocumentUnlisted: {
          _tag: "DiscoverySkillDocumentUnlisted",
          name: "review",
          files: ["notes.md"],
        },
        DiscoverySkillDocumentMissing: { _tag: "DiscoverySkillDocumentMissing", name: "review" },
        DiscoveryFilePathUnsafe: { _tag: "DiscoveryFilePathUnsafe", path: "../outside" },
        DiscoveryFilePathDuplicate: { _tag: "DiscoveryFilePathDuplicate", path: "SKILL.md" },
        GitPinInvalid: { _tag: "GitPinInvalid", commit: "not-a-commit" },
        GitTrackingRefMismatch: { _tag: "GitTrackingRefMismatch", expected: "main", actual: "dev" },
        GitCommitMismatch: { _tag: "GitCommitMismatch", expected: "expected", actual: "actual" },
        GitRevisionUnavailable: {
          _tag: "GitRevisionUnavailable",
          revision: "expected",
          remote: "https://git.test/review",
          failure: command,
        },
        GitLocatorRequired: { _tag: "GitLocatorRequired", kind: "local" },
        GitCommitMissing: { _tag: "GitCommitMissing", locator: "https://git.test/review" },
        RegistryVersionInvalid: {
          _tag: "RegistryVersionInvalid",
          requested: "latest",
          reported: "invalid",
        },
        RegistryVersionMismatch: {
          _tag: "RegistryVersionMismatch",
          requested: "1.0.0",
          actual: "1.0.1",
        },
        RegistryArchiveRequired: { _tag: "RegistryArchiveRequired" },
      };
      for (const reason of Object.values(cases)) {
        const failure = new SourcePolicyViolation({ reason });
        expect(failure.reason).toEqual(reason);
        if (failure.reason._tag === "TransportFailure") expect(failure.reason.failure).toBe(native);
        if (failure.reason._tag === "DiscoveryIndexInvalid")
          expect(failure.reason.failure).toBe(schemaError);
        const wire = Schema.encodeSync(Schema.toCodecJson(SourceFetchFailure))(failure);
        expect(wire).not.toHaveProperty("message");
        expect(wire).not.toHaveProperty("remediation");
        const stored = Schema.decodeUnknownSync(SourceFetchFailure)(
          JSON.parse(JSON.stringify(wire)),
        );
        const formatted = classifyFailure(stored);
        expect(formatted.message.length).toBeGreaterThan(12);
        expect(formatted.message).not.toBe("SourcePolicyViolation");
        expect(formatted.remediation.length).toBeGreaterThan(12);
      }
      expect(
        classifyFailure(new SourcePolicyViolation({ reason: cases.GitRevisionUnavailable }))
          .message,
      ).toContain("revision unavailable");
      expect(
        classifyFailure(new SourcePolicyViolation({ reason: cases.DiscoveryHashMismatch })).message,
      ).toContain("sha256:actual");
      const restore = new SourceRestoreInvalid({
        hash: "sha256:retained",
        reason: {
          _tag: "SourceFetchFailed",
          failure: new SourcePolicyViolation({ reason: cases.DiscoveryHashMismatch }),
        },
      });
      expect(classifyFailure(restore).message).toContain("sha256:actual");
    }),
);

it("keeps probe refusal and process-limit facts visible in both probe formatters", () => {
  const timeout = new SourceProcessTimedOut({ invocation: "codex --version", timeoutMs: 5000 });
  const harness: HarnessProbeFailure[] = [
    { _tag: "ExecutableMissing", command: "codex" },
    { _tag: "ExitCode", command: "codex", exitCode: 1 },
    { _tag: "ProcessFailed", failure: timeout },
  ];
  const audit: AuditProbeFailure[] = [
    { _tag: "UndeclaredInvocation", invocation: "codex plugin list --json" },
    { _tag: "UnsupportedHarness", harness: "example" },
    { _tag: "ExitCode", invocation: "codex plugin list --json", exitCode: 1 },
    {
      _tag: "InvalidJson",
      invocation: "codex plugin list --json",
      failure: new SyntaxError("bad JSON"),
    },
    { _tag: "ProcessFailed", failure: timeout },
  ];
  for (const failure of harness) expect(harnessProbeFailure(failure).length).toBeGreaterThan(12);
  for (const failure of audit) expect(auditProbeFailure(failure).length).toBeGreaterThan(12);
  expect(harnessProbeFailure(harness[2])).toContain("5000ms");
  expect(auditProbeFailure(audit[3])).toContain("did not return JSON");
});
