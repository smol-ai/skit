import { expect } from "vitest";
import { it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { systemError } from "effect/PlatformError";
import {
  EditImportFailure,
  EditImportMissing,
  EditImportAmbiguous,
} from "@smolai/skit-core/library/edit";
import { SyncLocalChanged } from "@smolai/skit-core/library/sync";
import {
  MachineSettingsFailure,
  Unusable,
  SetupNotRecorded,
} from "@smolai/skit-core/machine-settings/failures";
import { classifyFailure } from "../src/commands/failure-classification.js";

it("preserves all local edit refusal facts across JSON and formats them in the frontend", () => {
  const failures = [
    new EditImportMissing({ reason: { _tag: "SkillNotFound", query: "review" } }),
    new EditImportMissing({ reason: { _tag: "InstalledSkillNotFound", selector: "/work/review" } }),
    new EditImportMissing({ reason: { _tag: "LibraryVersionMissing", skill: "review" } }),
    new EditImportMissing({ reason: { _tag: "ContentUnchanged", path: "/work/review" } }),
    new EditImportAmbiguous({ kind: "skill", query: "review", matches: ["skill-a", "skill-b"] }),
    new EditImportAmbiguous({
      kind: "installed-skill",
      query: "review",
      matches: ["/a/review", "/b/review"],
    }),
  ];
  for (const failure of failures) {
    const wire = Schema.encodeSync(Schema.toCodecJson(EditImportFailure))(failure);
    expect(wire).not.toHaveProperty("message");
    expect(wire).not.toHaveProperty("remediation");
    const stored = Schema.decodeUnknownSync(EditImportFailure)(JSON.parse(JSON.stringify(wire)));
    expect(classifyFailure(stored).message).toContain("review");
    expect(classifyFailure(stored).remediation).not.toBe("Check the reported failure and retry.");
  }
  expect(classifyFailure(new SyncLocalChanged()).message).toBe(
    "The local Library changed while sync was running",
  );
});

it.effect("preserves settings read and schema failure details until the output boundary", () =>
  Effect.gen(function* () {
    const native = systemError({
      _tag: "PermissionDenied",
      module: "FileSystem",
      method: "readFileString",
      pathOrDescriptor: "/state/machine.json",
    });
    const schemaError = yield* Effect.flip(
      Schema.decodeUnknownEffect(Schema.Struct({ schemaVersion: Schema.Literal(6) }))({
        schemaVersion: 99,
      }),
    );
    const failures = [
      new Unusable({
        path: "/state/machine.json",
        reason: { _tag: "ReadFailed", failure: native },
      }),
      new Unusable({
        path: "/state/machine.json",
        reason: { _tag: "InvalidData", failure: schemaError },
      }),
      new Unusable({
        path: "/state/machine.json",
        reason: { _tag: "UnsupportedVersion", version: 99, supported: [1, 2, 3, 4, 5, 6] },
      }),
      new SetupNotRecorded({ path: "/state/machine.json", operationId: "old-setup" }),
    ];
    const read = failures[0];
    const invalid = failures[1];
    expect(
      read._tag === "MachineSettingsUnusable" &&
        read.reason._tag === "ReadFailed" &&
        read.reason.failure,
    ).toBe(native);
    expect(
      invalid._tag === "MachineSettingsUnusable" &&
        invalid.reason._tag === "InvalidData" &&
        invalid.reason.failure,
    ).toBe(schemaError);
    for (const failure of failures) {
      const wire = Schema.encodeSync(Schema.toCodecJson(MachineSettingsFailure))(failure);
      expect(wire).not.toHaveProperty("message");
      const stored = Schema.decodeUnknownSync(MachineSettingsFailure)(
        JSON.parse(JSON.stringify(wire)),
      );
      expect(classifyFailure(stored).message).toContain("/state/machine.json");
      expect(classifyFailure(stored).remediation).toContain("skit setup");
    }
  }),
);
