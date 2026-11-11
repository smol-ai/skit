import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { RestoreInvalid, RestoreInvalidReason } from "@smolai/skit-core/library/restore/failures";
import { LibraryAuditInvalid } from "@smolai/skit-core/library/audit/failures";
import {
  makeCollectionVersionId,
  makeInstalledSkillId,
  makeSkillId,
  makeSkillVersionId,
  makeOperationId,
} from "@smolai/skit-core/universal/consumer";
import { Hash } from "@smolai/skit-core/shared";
import { classifyFailure } from "../src/commands/failure-classification.js";

it.effect("keeps every restore refusal as facts through JSON and formats it in the CLI", () =>
  Effect.gen(function* () {
    const native = yield* Effect.flip(
      Schema.decodeUnknownEffect(Schema.Struct({ enabled: Schema.Boolean }))({ enabled: "bad" }),
    );
    const hash = Hash.make(`sha256:${"a".repeat(64)}`);
    const other = Hash.make(`sha256:${"b".repeat(64)}`);
    const id = makeCollectionVersionId();
    const skill = makeSkillId();
    const reasons: {
      [K in RestoreInvalidReason["_tag"]]: Extract<RestoreInvalidReason, { _tag: K }>;
    } = {
      CopiesUnavailable: { _tag: "CopiesUnavailable", ids: [id] },
      SyncContentChanged: { _tag: "SyncContentChanged", hash },
      ForeignCopy: { _tag: "ForeignCopy", hash },
      DownloadForSourceCopy: { _tag: "DownloadForSourceCopy", hash },
      UnknownCopy: { _tag: "UnknownCopy", id },
      SourceRestoreUnavailable: { _tag: "SourceRestoreUnavailable", hash },
      CopyNotAvailable: { _tag: "CopyNotAvailable", hash },
      DownloadTransportMissing: { _tag: "DownloadTransportMissing", hashes: [hash] },
      ReusableCopyMissing: { _tag: "ReusableCopyMissing", hash, path: "/originals/retained" },
      DownloadHashMismatch: { _tag: "DownloadHashMismatch", expected: hash, actual: "not-a-hash" },
      MemberHashMismatch: {
        _tag: "MemberHashMismatch",
        path: "review",
        expected: hash,
        actual: other,
      },
      StateInvalid: { _tag: "StateInvalid", stage: "target-manifest", failure: native },
      OwnershipWouldBeStranded: {
        _tag: "OwnershipWouldBeStranded",
        conflicts: [
          {
            _tag: "InstalledVersionMissing",
            installedSkillId: makeInstalledSkillId(),
            skillId: skill,
            versionId: makeSkillVersionId(),
            path: "/skills/review",
          },
          { _tag: "RepositorySelectionMissing", root: "/work/review", selection: { skill } },
        ],
      },
    };
    for (const reason of Object.values(reasons)) {
      const failure = new RestoreInvalid({ reason });
      if (failure.reason._tag === "StateInvalid") expect(failure.reason.failure).toBe(native);
      const wire = Schema.encodeSync(Schema.toCodecJson(RestoreInvalid))(failure);
      expect(wire).not.toHaveProperty("message");
      expect(wire).not.toHaveProperty("remediation");
      const stored = Schema.decodeUnknownSync(RestoreInvalid)(JSON.parse(JSON.stringify(wire)));
      const formatted = classifyFailure(stored);
      expect(formatted.message).toContain("Cannot restore the Library:");
      expect(formatted.remediation).toContain("skit doctor");
    }
    const ownership = classifyFailure(
      new RestoreInvalid({ reason: reasons.OwnershipWouldBeStranded }),
    );
    expect(ownership.message).toContain("/skills/review");
    expect(ownership.message).toContain("/work/review");
    expect(ownership.remediation).toContain("Keep the installed Skill files");
    expect(
      classifyFailure(new RestoreInvalid({ reason: reasons.MemberHashMismatch })).message,
    ).toContain(other);
  }),
);

it.effect(
  "keeps conflicting audit events and native schema failures across the JSON boundary",
  () =>
    Effect.gen(function* () {
      const event = {
        schemaVersion: 1 as const,
        eventId: makeOperationId(),
        occurredAt: "2026-11-10T00:00:00Z",
        type: "binding.enabled",
        workflow: "test",
        changes: [],
      };
      const native = yield* Effect.flip(Schema.decodeUnknownEffect(Schema.Int)("bad"));
      for (const failure of [
        new LibraryAuditInvalid({
          path: "/audit.jsonl",
          line: 2,
          reason: { _tag: "SchemaInvalid", failure: native },
        }),
        new LibraryAuditInvalid({
          path: "/audit.jsonl",
          reason: {
            _tag: "EventIdentityChanged",
            eventId: event.eventId,
            expected: event,
            actual: { ...event, workflow: "different" },
          },
        }),
      ]) {
        if (failure.reason._tag === "SchemaInvalid") expect(failure.reason.failure).toBe(native);
        const wire = Schema.encodeSync(Schema.toCodecJson(LibraryAuditInvalid))(failure);
        expect(wire).not.toHaveProperty("message");
        expect(wire).not.toHaveProperty("remediation");
        const decoded = Schema.decodeUnknownSync(LibraryAuditInvalid)(
          JSON.parse(JSON.stringify(wire)),
        );
        expect(classifyFailure(decoded).message).toContain("/audit.jsonl");
        if (decoded.reason._tag === "EventIdentityChanged") {
          expect(decoded.reason.expected.workflow).toBe("test");
          expect(decoded.reason.actual.workflow).toBe("different");
          expect(classifyFailure(decoded).remediation).toContain("Keep the audit log");
        }
      }
    }),
);
