import { describeFailure } from "../terminal/failure.js";
import {
  MachineSettingsFailure,
  MachineSettingsInvalidReason,
} from "@smolai/skit-core/machine-settings/failures";
import { errorMessage } from "@smolai/skit-core/shared";
import { Match } from "effect";
import { schemaFailure } from "../platform/schema-failure.js";

const invalidReason = (reason: MachineSettingsInvalidReason): string =>
  MachineSettingsInvalidReason.match(reason, {
    ReadFailed: ({ failure }) => errorMessage(failure),
    InvalidData: ({ failure }) => schemaFailure(failure),
    UnsupportedVersion: ({ version, supported }) =>
      `machine settings version ${version}; this SKIT supports versions ${supported.join(", ")}`,
  });

export const machineSettingsFailure = Match.type<MachineSettingsFailure>().pipe(
  Match.tagsExhaustive({
    MachineSettingsUnusable: ({ path, reason }) =>
      describeFailure({
        summary: [
          `${reason._tag === "ReadFailed" ? "Cannot read" : "Invalid"} SKIT machine settings at ${path}: ${invalidReason(reason)}`,
        ],
        next: ["Correct or move aside " + path + ", then run ", { code: "skit setup" }, " again."],
      }),
    "MachineSettings.SetupNotRecorded": ({ path, operationId }) =>
      describeFailure({
        summary: [`No discovery folders are recorded for setup ${operationId} in ${path}`],
        next: ["Review the discovery folders with ", { code: "skit setup" }, "."],
      }),
  }),
);
