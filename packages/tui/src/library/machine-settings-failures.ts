import {
  MachineSettingsFailure,
  MachineSettingsInvalidReason,
} from "@smolai/skit-core/machine-settings/failures";
import { errorMessage } from "@smolai/skit-core/shared";
import { Match } from "effect";
import { schemaFailure } from "./schema-failure";

const invalidReason = (reason: MachineSettingsInvalidReason): string =>
  MachineSettingsInvalidReason.match(reason, {
    ReadFailed: ({ failure }) => errorMessage(failure),
    InvalidData: ({ failure }) => schemaFailure(failure),
    UnsupportedVersion: ({ version, supported }) =>
      `machine settings version ${version}; this SKIT supports versions ${supported.join(", ")}`,
  });

export const machineSettingsFailure = Match.type<MachineSettingsFailure>().pipe(
  Match.tagsExhaustive({
    MachineSettingsUnusable: ({ path, reason }) => ({
      message: `${reason._tag === "ReadFailed" ? "Cannot read" : "Invalid"} SKIT machine settings at ${path}: ${invalidReason(reason)}`,
      remediation: `Correct or move aside ${path}, then review setup again.`,
    }),
    "MachineSettings.SetupNotRecorded": ({ path, operationId }) => ({
      message: `No discovery folders are recorded for setup ${operationId} in ${path}`,
      remediation: "Review the discovery folders in setup.",
    }),
  }),
);
